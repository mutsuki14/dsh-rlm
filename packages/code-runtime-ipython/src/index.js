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
        try {
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
        } catch (startErr) {
          const tools = this.lastBindings.find((b) => b.global === "tools")?.functions;
          const spawnFn = tools?.subagent || tools?.subagent_fork;
          if (typeof spawnFn !== "function") throw startErr;
          const out = await spawnFn({
            description: params.name ?? "rlm",
            prompt: String(params.prompt ?? ""),
            run_in_background: false,
          });
          const id = childIdFrom(out) ?? `rlm-${Date.now()}`;
          this.runs.set(String(id), { result: Promise.resolve({ output: out }) });
          return {
            rlm_child_id: id,
            name: params.name ?? id,
            session_dir: "",
            model: "",
            status: "done",
            result: typeof out === "string" ? out : out?.output ?? out,
          };
        }
      }
      if (method === "rlm.wait") {
        const id = String(params.rlm_child_id);
        const run = this.runs.get(id);
        if (run?.result) {
          const settled = await run.result;
          let folded = foldSubagentOutput(settled);
          if ((folded == null || folded === "") && !(settled?.stopReason && settled.stopReason !== "running")) {
            folded = await this.waitContinuable(id);
          }
          await disposeRun(run);
          this.runs.delete(id);
          return {
            result: folded ?? null,
            status: settled?.stopReason ?? "done",
            diagnostic: settled?.diagnostic ?? null,
          };
        }
        const result = await this.waitContinuable(id);
        return { result, status: "done" };
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

  async waitContinuable(id) {
    const deadline = Date.now() + 180000;
    let last = null;
    while (Date.now() < deadline) {
      last = this.readChildOutput(id);
      if (last != null && last !== "") return last;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (last != null && last !== "") return last;
    throw new Error(`rlm.wait: timed out waiting for ${id}`);
  }

  readChildOutput(id) {
    const session = this.ctx.sessions?.get?.(id);
    if (!session) return null;
    let messages = [];
    try {
      messages = session.deriveMessages?.() ?? session.messages ?? [];
    } catch {
      messages = [];
    }
    if (!Array.isArray(messages)) return null;
    const assistants = messages.filter(
      (m) => m?.role === "assistant" || m?.kind === "assistant" || m?.type === "assistant",
    );
    const last = assistants.at(-1);
    if (!last) return null;
    const content = last.content ?? last.text ?? last.message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    }
    return content ?? null;
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

function disposeRun(run) {
  if (run && typeof run.dispose === "function") {
    return Promise.resolve(run.dispose()).catch(() => undefined);
  }
  return Promise.resolve();
}

function childIdFrom(out) {
  if (out == null) return undefined;
  if (typeof out === "string") {
    const m = out.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    return m?.[0] ?? out;
  }
  return out.subagentId ?? out.childId ?? out.id ?? out.rlm_child_id;
}

function foldSubagentOutput(settled) {
  if (settled == null) return null;
  if (typeof settled === "string") return settled;
  if (typeof settled !== "object") return String(settled);
  if (settled.structured != null) return settled.structured;
  const output = settled.output ?? settled.content ?? settled;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return outputValueText(output);
  if (output && typeof output === "object" && typeof output.text === "string") {
    return output.text;
  }
  return null;
}

function outputValueText(values) {
  const texts = [];
  for (const value of values) {
    if (typeof value === "string") {
      texts.push(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (value.type && value.type !== "text") continue;
    if (typeof value.text === "string") {
      texts.push(value.text);
      continue;
    }
    const content = value.content ?? value.message;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === "string") texts.push(b);
        else if (b && (!b.type || b.type === "text") && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
    }
  }
  return texts.join("") || null;
}

export function apply(ctx) {
  const runtime = new IPythonCodeRuntime(ctx);
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
}
