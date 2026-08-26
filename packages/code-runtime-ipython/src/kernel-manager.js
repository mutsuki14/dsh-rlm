// packages/code-runtime-ipython/src/kernel-manager.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
var KernelManager = class {
  sessionId;
  host;
  proc = null;
  buf = "";
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  chain = Promise.resolve();
  pythonRootDir;
  stderrBuf = "";
  constructor(sessionId, host, pythonRootDir) {
    this.sessionId = sessionId;
    this.host = host;
    this.pythonRootDir = pythonRootDir;
  }
  async start() {
    const root = this.pythonRootDir ?? pythonRoot();
    const worker = join(root, "repl_worker.py");
    const tried = [];
    for (const c of pythonCandidates()) {
      const label = [c.bin, ...c.prefix].join(" ");
      try {
        await this.attach(c.bin, [...c.prefix, "-u", worker], root);
        await Promise.race([
          this.rpc("ping"),
          new Promise(
            (_, rej) => setTimeout(() => rej(new Error("ping timeout")), 8e3)
          )
        ]);
        return;
      } catch (err) {
        tried.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        await this.detach();
        if (!isMissingBin(err)) {
          throw new Error(
            `kernel start failed with ${label}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
    throw new Error(
      `kernel start failed: no Python 3 on PATH (${tried.join("; ")}). Install Python 3 or set DSH_RLM_PYTHON to the executable (Windows: py or python). Exit 9009 means the command was not found.`
    );
  }
  async installBindings(bindings) {
    const spec = bindings.map((b) => ({
      global: b.global,
      names: b.names ?? Object.keys(b.functions ?? {})
    }));
    await this.rpc("bind", { spec });
  }
  async execute(program, signal) {
    const result = await this.rpc("execute", { program }, signal);
    if (result.error && typeof result.error === "object") {
      const err = result.error;
      return {
        logs: Array.isArray(result.logs) ? result.logs : [],
        error: { kind: err.kind ?? "Error", message: err.message ?? "execute failed" }
      };
    }
    return {
      logs: Array.isArray(result.logs) ? result.logs : [],
      value: result.value
    };
  }
  async snapshotNamespace() {
    const result = await this.rpc("snapshot");
    return Buffer.from(JSON.stringify(result.value ?? {}));
  }
  async inspectNamespace() {
    const result = await this.rpc("inspect");
    return result.value ?? {};
  }
  async injectNamespace(values) {
    await this.rpc("inject", { values });
  }
  async shutdown() {
    try {
      await Promise.race([
        this.rpc("shutdown"),
        new Promise((r) => setTimeout(r, 500))
      ]);
    } catch {
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.stdin?.end();
      proc.kill("SIGTERM");
    }
  }
  attach(bin, args, root) {
    return new Promise((resolve, reject) => {
      this.buf = "";
      this.stderrBuf = "";
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: root, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
        windowsHide: true
      });
      this.proc = proc;
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk) => this.onData(chunk));
      proc.stderr?.on("data", (chunk) => {
        this.stderrBuf += chunk;
      });
      proc.stdin?.on("error", () => {});
      const fail = (err) => reject(err);
      proc.once("error", fail);
      proc.once("spawn", () => {
        proc.off("error", fail);
        proc.on("error", (err) => this.rejectAll(err));
        proc.on("exit", (code) => {
          const tail = this.stderrBuf.trim();
          this.rejectAll(
            new Error(`kernel exited ${code}${tail ? `: ${tail.slice(0, 500)}` : ""}`)
          );
        });
        proc.unref();
        proc.stdin?.unref?.();
        proc.stdout?.unref?.();
        proc.stderr?.unref?.();
        resolve();
      });
    });
  }
  rejectAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  async detach() {
    const proc = this.proc;
    this.proc = null;
    this.pending.clear();
    this.buf = "";
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
    }
    proc.kill("SIGTERM");
  }
  writeStdin(payload) {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    try {
      return stdin.write(payload);
    } catch {
      return false;
    }
  }
  rpc(method, params = {}, signal) {
    const id = `${this.sessionId}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("kernel not started"));
        return;
      }
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        }
      });
      this.writeStdin(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  onData(chunk) {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        this.chain = this.chain.then(() => this.onLine(line)).catch(() => void 0);
      }
      nl = this.buf.indexOf("\n");
    }
  }
  async onLine(line) {
    const msg = JSON.parse(line);
    if (msg.type === "host") {
      try {
        const result = this.host ? await this.host(String(msg.method), msg.params ?? {}) : null;
        this.writeStdin(JSON.stringify({ type: "host_result", id: msg.id, result: sanitizeJson(result) }) + "\n");
      } catch (err) {
        this.writeStdin(
          JSON.stringify({ type: "host_result", id: msg.id, error: sanitizeText(String(err)) }) + "\n"
        );
      }
      return;
    }
    const pending = this.pending.get(String(msg.id));
    if (!pending) return;
    this.pending.delete(String(msg.id));
    pending.resolve(msg);
  }
};
function sanitizeText(s) {
  if (typeof s !== "string") return s;
  return Buffer.from(s, "utf8").toString("utf8");
}
function sanitizeJson(v) {
  if (typeof v === "string") return sanitizeText(v);
  if (Array.isArray(v)) return v.map(sanitizeJson);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeJson(val);
    return out;
  }
  return v;
}
function pythonRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../python");
}
function pythonCandidates() {
  const env = process.env.DSH_RLM_PYTHON;
  if (env) return [{ bin: env, prefix: [] }];
  if (process.platform === "win32") {
    return [
      { bin: "py", prefix: ["-3"] },
      { bin: "python", prefix: [] },
      { bin: "python3", prefix: [] }
    ];
  }
  return [
    { bin: "python3", prefix: [] },
    { bin: "python", prefix: [] }
  ];
}
function isMissingBin(err) {
  const e = err;
  if (e.code === "ENOENT") return true;
  const m = String(e.message ?? "");
  return m.includes("ENOENT") || m.includes("exited 9009");
}
export {
  KernelManager
};
