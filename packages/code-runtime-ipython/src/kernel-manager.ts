import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type CodeBindingNamespace = {
  global: string;
  names?: string[];
  functions?: Record<string, (args: unknown) => Promise<unknown>>;
};

export type CodeRunResult = {
  value?: unknown;
  logs: string[];
  error?: { kind: string; message: string };
};

export type HostHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
};

/**
 * Persistent Python process. JSONL over stdin/stdout.
 * host_request (rlm / tools.*) is multiplexed on the same pipes so a
 * nested rlm() cannot deadlock the cell the way a single ZMQ shell
 * channel would.
 */
export class KernelManager {
  readonly sessionId: string;
  private host?: HostHandler;
  private proc: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, Pending>();
  private chain = Promise.resolve();
  private pythonRootDir?: string;
  private stderrBuf = "";

  constructor(sessionId: string, host?: HostHandler, pythonRootDir?: string) {
    this.sessionId = sessionId;
    this.host = host;
    this.pythonRootDir = pythonRootDir;
  }

  async start() {
    const root = this.pythonRootDir ?? pythonRoot();
    const worker = join(root, "repl_worker.py");
    const tried: string[] = [];
    for (const c of pythonCandidates()) {
      const label = [c.bin, ...c.prefix].join(" ");
      try {
        await this.attach(c.bin, [...c.prefix, "-u", worker], root);
        await Promise.race([
          this.rpc("ping"),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("ping timeout")), 8000),
          ),
        ]);
        return;
      } catch (err) {
        tried.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        await this.detach();
        if (!isMissingBin(err)) {
          throw new Error(
            `kernel start failed with ${label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    throw new Error(
      `kernel start failed: no Python 3 on PATH (${tried.join("; ")}). Install Python 3 or set DSH_RLM_PYTHON to the executable (Windows: py or python). Exit 9009 means the command was not found.`,
    );
  }

  async installBindings(bindings: CodeBindingNamespace[]) {
    const spec = bindings.map((b) => ({
      global: b.global,
      names: b.names ?? Object.keys(b.functions ?? {}),
    }));
    await this.rpc("bind", { spec });
  }

  async execute(program: string, signal?: AbortSignal): Promise<CodeRunResult> {
    const result = await this.rpc("execute", { program }, signal);
    if (result.error && typeof result.error === "object") {
      const err = result.error as { kind?: string; message?: string };
      return {
        logs: Array.isArray(result.logs) ? (result.logs as string[]) : [],
        error: { kind: err.kind ?? "Error", message: err.message ?? "execute failed" },
      };
    }
    return {
      logs: Array.isArray(result.logs) ? (result.logs as string[]) : [],
      value: result.value,
    };
  }

  async snapshotNamespace(): Promise<Uint8Array> {
    const result = await this.rpc("snapshot");
    return Buffer.from(JSON.stringify(result.value ?? {}));
  }

  async inspectNamespace(): Promise<Record<string, unknown>> {
    const result = await this.rpc("inspect");
    return (result.value as Record<string, unknown>) ?? {};
  }

  async injectNamespace(values: Record<string, unknown>) {
    await this.rpc("inject", { values });
  }

  async shutdown() {
    try {
      await Promise.race([
        this.rpc("shutdown"),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {
      /* already dead */
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.stdin?.end();
      proc.kill("SIGTERM");
    }
  }

  private attach(bin: string, args: string[], root: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.buf = "";
      this.stderrBuf = "";
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: root, PYTHONUNBUFFERED: "1" },
        windowsHide: true,
      });
      this.proc = proc;
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
      proc.stderr?.on("data", (chunk: string) => {
        this.stderrBuf += chunk;
      });
      const fail = (err: Error) => reject(err);
      proc.once("error", fail);
      proc.once("spawn", () => {
        proc.off("error", fail);
        proc.on("error", (err) => this.rejectAll(err));
        proc.on("exit", (code) => {
          const tail = this.stderrBuf.trim();
          this.rejectAll(
            new Error(`kernel exited ${code}${tail ? `: ${tail.slice(0, 500)}` : ""}`),
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

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private async detach() {
    const proc = this.proc;
    this.proc = null;
    this.pending.clear();
    this.buf = "";
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    proc.kill("SIGTERM");
  }

  private rpc(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
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
        },
      });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        this.chain = this.chain.then(() => this.onLine(line)).catch(() => undefined);
      }
      nl = this.buf.indexOf("\n");
    }
  }

  private async onLine(line: string) {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.type === "host") {
      try {
        const result = this.host
          ? await this.host(String(msg.method), (msg.params as Record<string, unknown>) ?? {})
          : null;
        this.proc?.stdin?.write(JSON.stringify({ type: "host_result", id: msg.id, result }) + "\n");
      } catch (err) {
        this.proc?.stdin?.write(
          JSON.stringify({ type: "host_result", id: msg.id, error: String(err) }) + "\n",
        );
      }
      return;
    }
    const pending = this.pending.get(String(msg.id));
    if (!pending) return;
    this.pending.delete(String(msg.id));
    pending.resolve(msg);
  }
}

function pythonRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../python");
}

function pythonCandidates(): { bin: string; prefix: string[] }[] {
  const env = process.env.DSH_RLM_PYTHON;
  if (env) return [{ bin: env, prefix: [] }];
  if (process.platform === "win32") {
    return [
      { bin: "py", prefix: ["-3"] },
      { bin: "python", prefix: [] },
      { bin: "python3", prefix: [] },
    ];
  }
  return [
    { bin: "python3", prefix: [] },
    { bin: "python", prefix: [] },
  ];
}

function isMissingBin(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  const m = String(e.message ?? "");
  return m.includes("ENOENT") || m.includes("exited 9009");
}
