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
  haystackBySession = new Map();
  contextInjected = new Set();
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

  setHaystack(sessionId, text) {
    const id = String(sessionId || "default");
    this.haystackBySession.set(id, String(text ?? ""));
    this.contextInjected.delete(id);
  }

  resolveHaystack(sessionId) {
    const id = String(sessionId || this.sessionId());
    if (this.haystackBySession.has(id)) return this.haystackBySession.get(id);
    const global = this.ctx.get("rlm.haystack");
    if (global != null && global !== "") return String(global);
    return "";
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
        return this.spawnChild(params);
      }
      if (method === "rlm.wait") {
        return this.waitChild(String(params.rlm_child_id));
      }
      if (method === "rlm.list_subagents") {
        const rows = await this.ctx.subagents.listChildren(this.sessionId());
        return Array.isArray(rows) ? rows : [];
      }
      if (method === "rlm.delete_subagent") {
        const id = String(params.rlm_child_id);
        const run = this.runs.get(id);
        if (run?.dispose) await run.dispose();
        this.runs.delete(id);
        const ac = this.aborts.get(id);
        this.aborts.delete(id);
        try { ac?.abort?.("rlm.delete"); } catch { /* ignore */ }
        return null;
      }
      if (method === "rlm.load_haystack") {
        return this.resolveHaystack(this.sessionId());
      }
      if (method === "rlm.set_haystack") {
        this.setHaystack(this.sessionId(), params.text ?? params.haystack ?? "");
        return true;
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

  /**
   * Non-blocking spawn. Prefer tools.subagent(background) so nested run_code
   * does not deadlock under exclusive tool locks; fall back to subagents.start.
   */
  async spawnChild(params) {
    const parent = this.lastParent || this.resolveParent();
    if (!parent) {
      const listed = this.ctx.agents?.list?.()?.length ?? 0;
      throw new Error(
        `rlm(): no live agent (initiator empty, agents.list=${listed}). ` +
          `run_code must snapshot the parent at run() entry.`,
      );
    }
    const remaining = this.remainingDepth();
    if (remaining <= 0) {
      throw new Error(`rlm(): max recursion depth (${this.maxDepth})`);
    }
    const childPrompt = String(params.prompt ?? "");
    const tools = this.lastBindings.find((b) => b.global === "tools")?.functions;
    const spawnFn = tools?.subagent || tools?.subagent_fork;

    // Path A: Code Mode binding, background — returns immediately, enables parallel.
    if (typeof spawnFn === "function") {
      const out = await spawnFn({
        description: params.name ?? "rlm",
        prompt: childPrompt,
        run_in_background: true,
      });
      const id = childIdFrom(out) ?? `rlm-${Date.now()}`;
      this.trackContinuable(id, remaining - 1);
      return {
        rlm_child_id: id,
        name: params.name ?? id,
        session_dir: "",
        model: "",
        status: "running",
      };
    }

    // Path B: host subagents.start — SubagentRun.result is a Promise (non-blocking return).
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

  trackContinuable(id, childDepth) {
    const key = String(id);
    this.depthBySession.set(key, childDepth);
    let settle;
    const result = new Promise((resolve) => {
      settle = resolve;
    });
    this.runs.set(key, { kind: "continuable", id: key, result });
    // Background poller fills result so wait() can share one path.
    (async () => {
      try {
        const text = await this.waitContinuable(key);
        settle({ output: text, stopReason: "completed" });
      } catch (err) {
        settle({
          output: null,
          stopReason: "error",
          diagnostic: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  async waitChild(id) {
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

  async waitContinuable(id) {
    const deadline = Date.now() + 180000;
    let last = null;
    while (Date.now() < deadline) {
      last = this.readChildOutput(id);
      if (last != null && last !== "") return last;

      // Activity probe: if child listed as idle/done and we still have nothing, keep polling briefly.
      try {
        const rows = await this.ctx.subagents.listChildren(this.sessionId());
        const row = Array.isArray(rows)
          ? rows.find((r) => String(r.id ?? r.childId ?? r.subagentId) === id)
          : undefined;
        if (row) {
          const act = String(row.activity ?? row.status ?? "").toLowerCase();
          if ((act === "done" || act === "completed" || act === "idle") && last) {
            return last;
          }
        }
      } catch {
        /* listChildren optional */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (last != null && last !== "") return last;
    throw new Error(`rlm.wait: timed out waiting for ${id}`);
  }

  readChildOutput(id) {
    const session =
      this.ctx.sessions?.get?.(id) ||
      this.ctx.sessions?.get?.(String(id));
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
    if (Array.isArray(content)) return outputValueText(content);
    return content != null ? String(content) : null;
  }

  async maybeInjectContext(km, sessionId) {
    if (this.contextInjected.has(sessionId)) return;
    const hay = this.resolveHaystack(sessionId);
    if (hay === "") {
      // Still mark injected so we don't spam empty assigns; load_haystack can refill later.
      return;
    }
    try {
      await km.injectNamespace({ context: hay });
      this.contextInjected.add(sessionId);
    } catch {
      try {
        await km.execute(`context = ${JSON.stringify(hay)}\n`);
        this.contextInjected.add(sessionId);
      } catch {
        /* best-effort */
      }
    }
  }

  async run(request) {
    const prevParent = this.lastParent;
    const prevBindings = this.lastBindings;
    const prevSignal = this.lastSignal;
    try {
      this.lastParent = this.resolveParent();
      this.lastBindings = request.bindings ?? [];
      this.lastSignal = request.signal;
      const id = this.sessionId();

      // Optional per-request haystack override (host tests / future bindings).
      if (request.haystack != null || request.context != null) {
        this.setHaystack(id, request.haystack ?? request.context);
      }

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
      await this.maybeInjectContext(km, id);
      return await km.execute(request.program, request.signal);
    } finally {
      this.lastParent = prevParent;
      this.lastBindings = prevBindings;
      this.lastSignal = prevSignal;
    }
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
  if (typeof settled === "string") {
    const s = settled.trim();
    if (!s || /^started subagent/i.test(s)) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      return null;
    }
    return settled;
  }
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

function extractUserText(ev) {
  if (ev == null) return "";
  if (typeof ev === "string") return ev.trim();
  const direct = [ev.text, ev.message, ev.prompt, ev.userMessage, ev.input, ev.content];
  for (const c of direct) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      const t = outputValueText(c);
      if (t) return t;
    }
  }
  const msgs = ev.messages ?? ev.history;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "user" || m?.kind === "user" || m?.type === "user") {
        if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
        if (Array.isArray(m.content)) {
          const t = outputValueText(m.content);
          if (t) return t;
        }
        if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
      }
    }
  }
  return "";
}

function hookHaystackEvents(ctx, runtime) {
  const names = [
    "turn/start",
    "agent/turn-start",
    "session/user-message",
    "user/message",
  ];
  for (const name of names) {
    try {
      ctx.on(name, async (ev, next) => {
        try {
          const text = extractUserText(ev);
          const sid =
            ev?.sessionId ??
            ev?.session?.id ??
            ctx.get("agentSessionId") ??
            runtime.sessionId();
          if (text && sid) runtime.setHaystack(String(sid), text);
        } catch {
          /* never block the turn */
        }
        return typeof next === "function" ? next() : undefined;
      });
    } catch {
      /* event may not exist on this DSH build */
    }
  }
}

export function apply(ctx, config = {}) {
  const runtime = new IPythonCodeRuntime(ctx, undefined, {
    maxDepth: config.maxDepth ?? 2,
  });
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
  hookHaystackEvents(ctx, runtime);
}
