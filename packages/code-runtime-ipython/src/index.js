import { KernelManager } from "./kernel-manager.js";

export const name = "@seamlabs/dsh-rlm/runtime";
export const inject = ["sessions"];

class IPythonCodeRuntime {
  language = "python";
  isolation = "process";
  kernels = new Map();
  skills = new Map();

  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }

  sessionId() {
    const id = this.ctx.get("agentSessionId");
    return id ?? "default";
  }

  hostHandler() {
    if (this.host) return this.host;
    return async (method, params) => {
      if (method === "rlm.run") {
        const child = await this.ctx.subagents.getProvider("spawn-in-process").start({
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
        const row = Array.isArray(rows) ? rows.find((x) => x.id === params.rlm_child_id) : undefined;
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
        return this.ctx.get("rlm.haystack") ?? "";
      }
      if (method === "rlm.save_skill") {
        this.skills.set(String(params.name), String(params.code ?? ""));
        return true;
      }
      if (method === "rlm.load_skill") {
        const code = this.skills.get(String(params.name));
        if (code === undefined) throw new Error(`harness missing skill ${params.name}`);
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

  async run(request) {
    const id = this.sessionId();
    let km = this.kernels.get(id);
    if (!km) {
      km = new KernelManager(id, this.hostHandler());
      try {
        await km.start();
      } catch (err) {
        await km.shutdown().catch(() => undefined);
        return {
          logs: [],
          error: {
            kind: "KernelStart",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      this.kernels.set(id, km);
    }
    await km.installBindings(request.bindings);
    return km.execute(request.program, request.signal);
  }

  async snapshot(sessionId) {
    const km = this.kernels.get(sessionId);
    if (!km) return new Uint8Array();
    return km.snapshotNamespace();
  }

  async dispose() {
    await Promise.all([...this.kernels.values()].map((k) => k.shutdown()));
    this.kernels.clear();
  }
}

export function apply(ctx) {
  const runtime = new IPythonCodeRuntime(ctx);
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
}
