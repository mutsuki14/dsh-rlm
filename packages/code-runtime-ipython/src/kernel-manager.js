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
  constructor(sessionId, host, pythonRootDir) {
    this.sessionId = sessionId;
    this.host = host;
    this.pythonRootDir = pythonRootDir;
  }
  async start() {
    const root = this.pythonRootDir ?? pythonRoot();
    const worker = join(root, "repl_worker.py");
    this.proc = spawn(process.env.DSH_RLM_PYTHON ?? "python3", ["-u", worker], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: root, PYTHONUNBUFFERED: "1" }
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk) => this.onData(chunk));
    this.proc.on("exit", (code) => {
      const err = new Error(`kernel exited ${code}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    await this.rpc("ping");
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
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
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
        this.proc?.stdin?.write(JSON.stringify({ type: "host_result", id: msg.id, result }) + "\n");
      } catch (err) {
        this.proc?.stdin?.write(
          JSON.stringify({ type: "host_result", id: msg.id, error: String(err) }) + "\n"
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
function pythonRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../python");
}
export {
  KernelManager
};
