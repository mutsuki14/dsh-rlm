import { KernelManager } from "./kernel-manager.js";

export const name = "@seamlabs/dsh-rlm/runtime";
export const inject = ["sessions", "subagents", "tools", "agents"];

class IPythonCodeRuntime {
  language = "python";
  isolation = "process";
  kernels = new Map();
  skills = new Map();
  runs = new Map();
  lastParent = null;
  lastBindings = [];
  lastSignal = undefined;

  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }

  sessionId() {
    const parent = this.lastParent;
    return parent?.id ?? parent?.session?.id ?? this.ctx.get("agentSessionId") ?? "default";
  }

  resolveParent() {
    const a = this.ctx.agents;
    return (
      this.ctx.get("agent") ||
      a?.currentInitiator?.() ||
      a?.list?.()?.[0] ||
      a?.roots?.()?.[0] ||
      null
    );
  }

  hostHandler() {
    if (this.host) return this.host;
    return async (method, params) => {
      if (method === "rlm.run") {
        const parent = this.lastParent || this.resolveParent();
        if (!parent) {
          const listed = this.ctx.agents?.list?.()?.length ?? 0;
          throw new Error(
            `rlm(): no live agent (initiator empty, agents.list=${listed}). ` +
              `run_code must snapshot the parent at run() entry.`,
          );
        }
        const tools = this.lastBindings.find((b) => b.global === "tools")?.functions;
        const spawnFn = tools?.subagent || tools?.subagent_fork;
        if (typeof spawnFn === "function") {
          const out = await spawnFn({
            description: params.name ?? "rlm",
            prompt: String(params.prompt ?? ""),
            run_in_background: true,
          });
          const id = out?.subagentId ?? out?.id ?? out?.rlm_child_id;
          return {
            rlm_child_id: id,
            name: params.name ?? id,
            session_dir: "",
            model: "",
            status: "running",
          };
        }
        const run = await this.ctx.subagents.start("spawn", {
          label: params.name ?? "rlm",
          prompt: [{ type: "text", text: String(params.prompt ?? "") }],
          parent,
          signal: this.lastSignal ?? new AbortController().signal,
          maxDepth: 2,
        });
        this.runs.set(String(run.id), run);
        return {
          rlm_child_id: run.id,
          name: params.name ?? run.id,
          session_dir: run.localAgent?.session?.dir ?? "",
          model: run.localAgent?.model ?? "",
          status: "running",
        };
      }
      if (method === "rlm.wait") {
        const run = this.runs.get(String(params.rlm_child_id));
        if (!run?.result) {
          throw new Error(`rlm.wait: unknown handle ${params.rlm_child_id}`);
        }
        const settled = await run.result;
        return { result: foldSubagentOutput(settled), status: "done" };
      }
      if (method === "rlm.list_subagents") {
        const rows = await this.ctx.subagents.listChildren(this.sessionId());
        return Array.isArray(rows) ? rows : [];
      }
      if (method === "rlm.delete_subagent") {
        const run = this.runs.get(String(params.rlm_child_id));
        if (run?.dispose) await run.dispose();
        this.runs.delete(String(params.rlm_child_id));
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
        const fn = this.lastBindings.find((b) => b.global === "tools")?.functions?.[params.name];
        if (typeof fn === "function") return fn(params.args);
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
    this.lastParent = this.resolveParent();
    this.lastBindings = request.bindings ?? [];
    this.lastSignal = request.signal;
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

function foldSubagentOutput(settled) {
  if (!settled || typeof settled !== "object") return settled ?? null;
  if (settled.structured != null) return settled.structured;
  const output = settled.output;
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output ?? null;
  const texts = [];
  for (const msg of output) {
    const content = msg?.content ?? msg;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b.text === "string") texts.push(b.text);
      }
    }
  }
  return texts.join("\n") || null;
}

export function apply(ctx) {
  const runtime = new IPythonCodeRuntime(ctx);
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
}
