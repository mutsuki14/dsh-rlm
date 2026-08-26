import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KernelManager } from "./kernel-manager.js";

export const name = "@seamlabs/dsh-rlm/runtime";
export const inject = ["sessions", "subagents", "tools", "agents"];

class IPythonCodeRuntime {
  language = "python";
  isolation = "process";
  kernels = new Map();
  skills = new Map();
  runs = new Map();
  aborts = new Map();
  depthBySession = new Map();
  lastParent = null;
  lastBindings = [];
  lastSignal = undefined;
  maxDepth = 2;

  constructor(ctx, host, options = {}) {
    this.ctx = ctx;
    this.host = host;
    if (Number.isFinite(options.maxDepth)) this.maxDepth = Math.max(0, options.maxDepth);
  }

  sessionId() {
    const parent = this.lastParent;
    return parent?.id ?? parent?.session?.id ?? this.ctx.get("agentSessionId") ?? "default";
  }

  remainingDepth() {
    const id = this.sessionId();
    if (this.depthBySession.has(id)) return this.depthBySession.get(id);
    return this.maxDepth;
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

  skillDir() {
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    return join(home, "rlm-skills");
  }

  skillPath(name) {
    const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
    if (!safe) throw new Error("invalid skill name");
    return { safe, path: join(this.skillDir(), `${safe}.py`) };
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
        const remaining = this.remainingDepth();
        if (remaining <= 0) throw new Error(`rlm(): max recursion depth (${this.maxDepth})`);
        const childPrompt = String(params.prompt ?? "");
        const tools = this.lastBindings.find((b) => b.global === "tools")?.functions;
        const spawnFn = tools?.subagent || tools?.subagent_fork;
        if (typeof spawnFn === "function") {
          const out = await spawnFn({
            description: params.name ?? "rlm",
            prompt: childPrompt,
            run_in_background: false,
          });
          const id = childIdFrom(out) ?? `rlm-${Date.now()}`;
          const folded = foldSubagentOutput(out);
          this.runs.set(String(id), {
            result: Promise.resolve({ output: folded ?? out, stopReason: "completed" }),
          });
          this.depthBySession.set(String(id), remaining - 1);
          return {
            rlm_child_id: id,
            name: params.name ?? id,
            session_dir: "",
            model: "",
            status: "done",
            result: folded,
          };
        }
        const ac = new AbortController();
        const run = await this.ctx.subagents.start("spawn", {
          label: params.name ?? "rlm",
          prompt: [{ type: "text", text: childPrompt }],
          parent,
          signal: ac.signal,
          maxDepth: remaining,
        });
        this.runs.set(String(run.id), run);
        this.aborts.set(String(run.id), ac);
        this.depthBySession.set(String(run.id), remaining - 1);
        return {
          rlm_child_id: run.id,
          name: params.name ?? run.id,
          session_dir: run.localAgent?.session?.dir ?? "",
          model: run.localAgent?.model ?? "",
          status: "running",
        };
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
          const ac = this.aborts.get(id);
          this.aborts.delete(id);
          try { ac?.abort?.("rlm.wait settled"); } catch { /* ignore */ }
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
        const { safe, path } = this.skillPath(params.name);
        mkdirSync(this.skillDir(), { recursive: true });
        const code = String(params.code ?? "");
        writeFileSync(path, code, "utf8");
        this.skills.set(safe, code);
        return safe;
      }
      if (method === "rlm.load_skill") {
        const { safe, path } = this.skillPath(params.name);
        if (this.skills.has(safe)) return this.skills.get(safe);
        try {
          const code = readFileSync(path, "utf8");
          this.skills.set(safe, code);
          return code;
        } catch {
          throw new Error(`harness missing skill ${safe}`);
        }
      }
      if (method === "rlm.list_skills") {
        let disk = [];
        try {
          disk = readdirSync(this.skillDir())
            .filter((f) => f.endsWith(".py"))
            .map((f) => f.slice(0, -3));
        } catch {
          disk = [];
        }
        return [...new Set([...this.skills.keys(), ...disk])];
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
    for (const ac of this.aborts.values()) {
      try { ac.abort("runtime dispose"); } catch { /* ignore */ }
    }
    this.aborts.clear();
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

export function apply(ctx, config = {}) {
  const runtime = new IPythonCodeRuntime(ctx, undefined, {
    maxDepth: config.maxDepth ?? 2,
  });
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
}
