import type { Context } from "@deepseek-ai/cordis";
import { KernelManager, type HostHandler } from "./kernel-manager";

export type CodeBindingNamespace = {
  global: string;
  functions: Record<string, (args: unknown) => Promise<unknown>>;
};

export type CodeRunRequest = {
  program: string;
  bindings: CodeBindingNamespace[];
  signal?: AbortSignal;
};

export type CodeRunResult = {
  value?: unknown;
  logs: string[];
  error?: { kind: string; message: string };
};

export class IPythonCodeRuntime {
  readonly language = "python" as const;
  readonly isolation = "process" as const;
  private kernels = new Map<string, KernelManager>();
  private ctx: Context;
  private host?: HostHandler;
  private skills = new Map<string, string>();

  constructor(ctx: Context, host?: HostHandler) {
    this.ctx = ctx;
    this.host = host;
  }

  private sessionId(): string {
    const id = this.ctx.get("agentSessionId") as string | undefined;
    return id ?? "default";
  }

  private hostHandler(): HostHandler {
    if (this.host) return this.host;
    return async (method, params) => {
      if (method === "rlm.run") {
        const child = await this.ctx.subagents
          .getProvider("spawn-in-process")
          .start({
            prompt: params.prompt,
            name: params.name,
            maxDepth: this.ctx.config?.rlm?.maxDepth ?? 2,
          });
        return {
          rlm_child_id: child.id,
          name: params.name ?? child.id,
          session_dir: child.sessionDir,
          model: child.model,
          status: "running",
        };
      }
      if (method === "rlm.wait") {
        const id = this.ctx.get("agentSessionId");
        const rows = await this.ctx.subagents.list(id);
        type Sub = { id?: string; result?: unknown; output?: unknown; status?: string };
        const row = Array.isArray(rows)
          ? (rows as Sub[]).find((x) => x.id === params.rlm_child_id)
          : undefined;
        return {
          result: row?.result ?? row?.output ?? null,
          status: row?.status ?? "done",
        };
      }
      if (method === "rlm.list_subagents") {
        return this.ctx.subagents.list(this.ctx.get("agentSessionId"));
      }
      if (method === "rlm.delete_subagent") {
        await this.ctx.subagents.drain(params.rlm_child_id);
        return null;
      }
      if (method === "rlm.load_haystack") {
        return (this.ctx.get("rlm.haystack") as string | undefined) ?? "";
      }
      if (method === "rlm.save_skill") {
        this.skills.set(String(params.name), String(params.code ?? ""));
        return true;
      }
      if (method === "rlm.load_skill") {
        const code = this.skills.get(String(params.name));
        if (code === undefined) throw new Error(`harness 里没有 ${params.name}`);
        return code;
      }
      if (method === "rlm.list_skills") {
        return [...this.skills.keys()];
      }
      if (method === "tools.dispatch") {
        return this.ctx.tools.execute({
          global: params.global,
          name: params.name,
          args: params.args,
        });
      }
      throw new Error(`unknown host method ${method}`);
    };
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const id = this.sessionId();
    let km = this.kernels.get(id);
    if (!km) {
      km = new KernelManager(id, this.hostHandler());
      await km.start();
      this.kernels.set(id, km);
    }
    await km.installBindings(request.bindings);
    return km.execute(request.program, request.signal);
  }

  async snapshot(sessionId: string): Promise<Uint8Array> {
    const km = this.kernels.get(sessionId);
    if (!km) return new Uint8Array();
    return km.snapshotNamespace();
  }

  async dispose() {
    await Promise.all([...this.kernels.values()].map((k) => k.shutdown()));
    this.kernels.clear();
  }
}
