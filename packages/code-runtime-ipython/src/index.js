import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
  children = new Map();
  aborts = new Map();
  depthBySession = new Map();
  haystackBySession = new Map();
  contextInjected = new Set();
  lastParent = null;
  lastBindings = [];
  lastSignal = undefined;
  maxDepth = 2;
  waitTimeoutMs = 180000;
  sessionState = new Map();
  activeKernel = null;

  constructor(ctx, host, options = {}) {
    this.ctx = ctx;
    this.host = host;
    if (Number.isFinite(options.maxDepth)) this.maxDepth = Math.max(0, options.maxDepth);
    if (Number.isFinite(options.waitTimeoutMs)) this.waitTimeoutMs = Math.max(1000, options.waitTimeoutMs);
    else if (Number.isFinite(Number(process.env.DSH_RLM_WAIT_MS))) {
      this.waitTimeoutMs = Math.max(1000, Number(process.env.DSH_RLM_WAIT_MS));
    } else {
      this.waitTimeoutMs = 900000;
    }
  }

  sessionId() {
    if (this.activeKernel) return this.activeKernel;
    const parent = this.lastParent || this.resolveParent();
    return parent?.session?.id ?? parent?.id ?? this.ctx.get("agentSessionId") ?? "default";
  }

  currentState() {
    const id =
      this.activeKernel || this.lastParent?.session?.id || this.lastParent?.id || this.ctx.get("agentSessionId");
    if (id && this.sessionState.has(id)) return this.sessionState.get(id);
    return null;
  }

  currentParent() {
    return this.currentState()?.parent || this.lastParent || this.resolveParent();
  }

  currentBindings() {
    return this.currentState()?.bindings || this.lastBindings || [];
  }

  currentSignal() {
    const s = this.currentState()?.signal || this.lastSignal;
    if (s && !s.aborted) return s;
    return new AbortController().signal;
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

  emit(kind, detail) {
    const payload = typeof detail === "string" ? { detail } : (detail ?? {});
    try {
      this.ctx.sessions?.append?.({ type: kind, sessionId: this.sessionId(), ...payload });
    } catch {
      /* log-only */
    }
    try {
      this.ctx.emit?.(kind, payload);
    } catch {
      /* optional */
    }
  }

  setHaystack(sessionId, text, { rebind = false } = {}) {
    const id = String(sessionId || "default");
    this.haystackBySession.set(id, String(text ?? ""));
    if (rebind) this.contextInjected.delete(id);
  }

  resolveHaystack(sessionId) {
    const id = String(sessionId || this.sessionId());
    if (this.haystackBySession.has(id)) return this.haystackBySession.get(id);
    const global = this.ctx.get("rlm.haystack");
    if (global != null && global !== "") return String(global);
    return "";
  }

  dshHome() {
    return process.env.DSH_HOME || join(homedir(), ".dsh");
  }

  skillDir() {
    return join(this.dshHome(), "rlm-skills");
  }

  dshSkillRoot() {
    return join(this.dshHome(), "skills");
  }

  kebabName(name) {
    const safe = String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!safe) throw new Error("invalid skill name (need kebab-case)");
    return safe;
  }

  pyModule(kebab) {
    return kebab.replace(/-/g, "_");
  }

  hostHandler() {
    if (this.host) return this.host;
    return (method, params) => this.hostMethods(method, params);
  }

  async dispatchHost(sessionId, method, params) {
    const prev = this.activeKernel;
    this.activeKernel = sessionId;
    try {
      return await this.hostMethods(method, params);
    } finally {
      this.activeKernel = prev;
    }
  }

  async hostMethods(method, params) {
      if (method === "rlm.run") return this.spawnChild(params);
      if (method === "rlm.wait") {
        return this.waitChild(String(params.rlm_child_id), params.timeout_ms);
      }
      if (method === "rlm.peek") {
        const id = String(params.rlm_child_id);
        const snap = this.readChildSnapshot(id);
        const meta = this.children.get(id);
        const agent = this.childAgent(id);
        return {
          result: snap.text ?? meta?.lastText ?? null,
          count: snap.count || (meta?.lastText ? 1 : 0),
          status: agent?.status ?? meta?.status ?? "unknown",
        };
      }
      if (method === "rlm.followup") {
        return this.followupChild(String(params.rlm_child_id), String(params.message ?? params.text ?? ""));
      }
      if (method === "rlm.interrupt") return this.interruptChild(String(params.rlm_child_id));
      if (method === "rlm.list_subagents") return this.listChildrenProjected();
      if (method === "rlm.delete_subagent") return this.deleteChild(String(params.rlm_child_id));
      if (method === "rlm.load_haystack") return this.resolveHaystack(this.sessionId());
      if (method === "rlm.set_haystack") {
        // Do NOT injectNamespace here: the kernel is blocked in host_request_sync
        // waiting for this reply. Injecting into the same worker deadlocks.
        // The shim assigns NS["context"] after the host returns.
        this.setHaystack(this.sessionId(), params.text ?? params.haystack ?? "", { rebind: true });
        return true;
      }
      if (method === "rlm.save_skill") return this.saveSkillPackage(params);
      if (method === "rlm.load_skill") return this.loadSkillPackage(params.name);
      if (method === "rlm.list_skills") return this.listSkillNames();
      if (method === "tools.dispatch") {
        const bindings = this.currentBindings();
        const ns = bindings.find((b) => b.global === (params.global ?? "tools"));
        let name = params.name;
        let fn = ns?.functions?.[name];
        if (typeof fn !== "function" && name === "bash") {
          name = ns?.functions?.pwsh ? "pwsh" : ns?.functions?.shell ? "shell" : name;
          fn = ns?.functions?.[name];
        }
        const args = params.args && typeof params.args === "object" ? { ...params.args } : params.args ?? {};
        if (name === "pwsh" && args && args.description == null) {
          args.description = String(args.command ?? "shell").slice(0, 80);
        }
        if (typeof fn === "function") return fn(args);
        return this.ctx.tools.execute({
          global: params.global,
          name,
          args,
        });
      }
      throw new Error(`unknown host method ${method}`);
  }

  /**
   * Prefer continuable admission so handle.message() can follow up later.
   * One-shot background children cannot be continued.
   */
  async spawnChild(params) {
    const parent = this.currentParent();
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
    const userPrompt = String(params.prompt ?? "").trim();
    if (!userPrompt) throw new Error("rlm(): empty prompt");
    const childPrompt = composeChildPrompt(userPrompt, parent);
    const label = params.name ?? "rlm";
    this.emit("rlm/spawn", { name: label, depth: remaining });

    if (typeof this.ctx.subagents?.startContinuable === "function") {
      const ac = new AbortController();
      const providers = [...new Set([params.provider, "spawn", "spawn-in-process"].filter(Boolean))];
      let lastErr;
      for (const provider of providers) {
        try {
          const out = await this.ctx.subagents.startContinuable({
            provider,
            label,
            request: {
              prompt: asBlocks(childPrompt),
              parent,
              maxDepth: remaining,
            },
            signal: ac.signal,
          });
          const id = String(out.childId ?? out.id ?? out.rlm_child_id);
          this.aborts.set(id, ac);
          this.trackChild(id, {
            name: params.name ?? id,
            mode: "continuable",
            depth: remaining - 1,
            sessionDir: out.sessionDir ?? out.session_dir ?? "",
            model: out.model ?? "",
          });
          this.bindChildWatch(id, parent);
          return {
            rlm_child_id: id,
            name: params.name ?? id,
            session_dir: out.sessionDir ?? out.session_dir ?? "",
            model: out.model ?? "",
            status: "running",
            mode: "continuable",
          };
        } catch (err) {
          lastErr = err;
          if (!isRetryableContinuable(err)) throw err;
        }
      }
      if (!this.currentBindings().find((b) => b.global === "tools")?.functions?.subagent && typeof this.ctx.subagents?.start !== "function") {
        throw lastErr;
      }
    }

    const tools = this.currentBindings().find((b) => b.global === "tools")?.functions;
    const spawnFn = tools?.subagent || tools?.subagent_fork;
    if (typeof spawnFn === "function") {
      const out = await spawnFn({
        description: label,
        prompt: childPrompt,
        run_in_background: true,
        backgroundMode: "continuable",
      });
      const id = childIdFrom(out) ?? `rlm-${Date.now()}`;
      this.trackChild(id, {
        name: params.name ?? id,
        mode: "continuable",
        depth: remaining - 1,
      });
      this.bindChildWatch(id, parent);
      return {
        rlm_child_id: id,
        name: params.name ?? id,
        session_dir: "",
        model: "",
        status: "running",
        mode: "continuable",
      };
    }

    const ac = new AbortController();
    const run = await this.ctx.subagents.start("spawn", {
      label,
      prompt: [{ type: "text", text: childPrompt }],
      parent,
      signal: ac.signal,
      maxDepth: remaining,
    });
    this.aborts.set(String(run.id), ac);
    this.trackChild(String(run.id), {
      name: params.name ?? run.id,
      mode: "one-shot",
      depth: remaining - 1,
      run,
      resultPromise: run.result,
      sessionDir: run.localAgent?.session?.dir ?? "",
      model: run.localAgent?.model ?? "",
    });
    return {
      rlm_child_id: run.id,
      name: params.name ?? run.id,
      session_dir: run.localAgent?.session?.dir ?? "",
      model: run.localAgent?.model ?? "",
      status: "running",
      mode: "one-shot",
    };
  }

  trackChild(id, extra) {
    const key = String(id);
    this.depthBySession.set(key, extra.depth);
    const existing = this.children.get(key);
    let settleResolve = existing?.settleResolve;
    const settlePromise =
      existing?.settlePromise ||
      new Promise((resolve) => {
        settleResolve = resolve;
      });
    this.children.set(key, {
      id: key,
      name: extra.name ?? existing?.name ?? key,
      mode: extra.mode ?? "continuable",
      status: extra.status ?? existing?.status ?? "running",
      lastText: extra.lastText ?? existing?.lastText ?? null,
      assistantCount: existing?.assistantCount ?? 0,
      run: extra.run,
      resultPromise: extra.resultPromise,
      consumed: false,
      awaitingFollowup: false,
      settled: existing?.settled ?? false,
      settlePromise,
      settleResolve,
      sessionDir: extra.sessionDir ?? existing?.sessionDir ?? "",
      model: extra.model ?? existing?.model ?? "",
    });
  }

  markSettled(id, text, reason) {
    const key = String(id);
    const meta = this.children.get(key);
    if (!meta) return;
    const folded = text ? sanitizeText(String(text)) : meta.lastText;
    if (folded) meta.lastText = folded;
    if (meta.awaitingFollowup && !folded) return;
    meta.status = reason === "error" ? "error" : "done";
    meta.settled = true;
    meta.awaitingFollowup = false;
    try {
      meta.settleResolve?.(meta.lastText ?? "");
    } catch {
      /* */
    }
  }

  onChildEnded(info) {
    const id = String(info?.id ?? info?.childId ?? "");
    if (!id) return;
    const text = foldBlocks(info?.lastAssistantMessage ?? info?.output);
    if (!this.children.has(id)) {
      this.trackChild(id, { name: info?.label ?? id, mode: "continuable" });
    }
    this.markSettled(id, text, info?.stopReason);
  }

  bindChildWatch(id, parent) {
    const meta = this.children.get(String(id));
    if (!meta) return;
    if (!meta.settlePromise) {
      meta.settlePromise = new Promise((resolve) => {
        meta.settleResolve = resolve;
      });
    }
    const scoped = parent?.ctx || this.ctx;
    if (!meta.watchedEnd) {
      meta.watchedEnd = true;
      const handle = (info) => this.onChildEnded(info);
      try {
        scoped?.on?.("subagent/end", handle);
      } catch {
        /* */
      }
      try {
        if (scoped !== this.ctx) this.ctx.on?.("subagent/end", handle);
      } catch {
        /* */
      }
    }
    const attachIdle = () => {
      const agent = this.childAgent(id);
      if (!agent || typeof agent.whenIdle !== "function" || meta.watchedIdle) return;
      meta.watchedIdle = true;
      Promise.resolve(agent.whenIdle())
        .then(() => {
          const snap = this.readChildSnapshot(id);
          this.markSettled(id, snap.text || meta.lastText, "completed");
        })
        .catch(() => {});
    };
    attachIdle();
    setTimeout(attachIdle, 25);
  }

  bumpFollowup(id) {
    const meta = this.children.get(String(id));
    if (meta) {
      meta.status = "running";
      meta.consumed = true;
      meta.awaitingFollowup = true;
      meta.settled = false;
      meta.watchedIdle = false;
      meta.settlePromise = new Promise((resolve) => {
        meta.settleResolve = resolve;
      });
    }
  }

  async followupChild(id, message) {
    if (!message) throw new Error("rlm.message(): empty message");
    const meta = this.children.get(String(id));
    if (meta?.mode === "one-shot") {
      throw new Error("rlm.message(): child is one-shot (need startContinuable)");
    }
    const parent = this.currentParent();
    const tools = this.currentBindings().find((b) => b.global === "tools")?.functions;
    const send = tools?.send_message;
    let messageId = null;
    if (typeof send === "function") {
      const out = await send({ subagent_id: id, message });
      messageId = out?.messageId ?? out?.id ?? null;
    } else if (typeof this.ctx.subagents?.followup === "function") {
      if (!parent) throw new Error("rlm.message(): no live parent agent");
      const senderSessionId = parent.session?.id ?? parent.id;
      messageId = await this.ctx.subagents.followup(parent, id, asBlocks(message), {
        source: { kind: "coordinator", form: "relay", senderSessionId },
        signal: this.currentSignal(),
      });
    } else {
      throw new Error(
        "rlm.message(): no continuable followup (need ctx.subagents.followup or tools.send_message)",
      );
    }
    this.bumpFollowup(id);
    this.bindChildWatch(id, parent);
    this.emit("rlm/followup", { id, messageId });
    return { messageId, status: "running" };
  }

  async interruptChild(id) {
    const tools = this.currentBindings().find((b) => b.global === "tools")?.functions;
    if (typeof tools?.interrupt_agent === "function") {
      await tools.interrupt_agent({ agent_id: id });
      return true;
    }
    if (typeof this.ctx.subagents?.interrupt === "function") {
      const parent = this.currentParent();
      await this.ctx.subagents.interrupt(id, { kind: "ancestor", agent: parent });
      return true;
    }
    const ac = this.aborts.get(String(id));
    try {
      ac?.abort?.("rlm.interrupt");
    } catch {
      /* ignore */
    }
    return true;
  }

  async waitChild(id, timeoutMs) {
    const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : this.waitTimeoutMs;
    const meta = this.children.get(id);
    if (meta && meta.status === "done" && meta.lastText != null && !meta.awaitingFollowup) {
      return { result: meta.lastText, status: "done" };
    }
    this.bindChildWatch(id, this.currentParent());
    if (meta?.resultPromise && !meta.consumed) {
      const settled = await meta.resultPromise;
      meta.consumed = true;
      let folded = foldSubagentOutput(settled);
      if (
        (folded == null || folded === "") &&
        !(settled?.stopReason && settled.stopReason !== "running")
      ) {
        folded = await this.waitContinuable(id, budget);
      } else if (folded) {
        meta.lastText = folded;
        meta.awaitingFollowup = false;
        const snap = this.readChildSnapshot(id);
        if (snap.count) meta.assistantCount = snap.count;
      }
      meta.status = settled?.stopReason === "error" ? "error" : "done";
      this.emit("rlm/wait", { id, status: meta.status });
      if (meta.mode === "one-shot") {
        await disposeRun(meta.run);
        const ac = this.aborts.get(id);
        this.aborts.delete(id);
        try {
          ac?.abort?.("rlm.wait settled");
        } catch {
          /* ignore */
        }
      }
      return {
        result: folded ?? null,
        status: meta.status === "error" ? "error" : "done",
        diagnostic: settled?.diagnostic ?? null,
      };
    }
    const result = await this.waitContinuable(id, budget);
    this.emit("rlm/wait", { id, status: "done" });
    return { result, status: "done" };
  }

  async waitContinuable(id, timeoutMs) {
    const meta = this.children.get(id) || { lastText: null, assistantCount: 0, status: "running" };
    const seen = meta.assistantCount || 0;
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : this.waitTimeoutMs);
    this.bindChildWatch(id, this.currentParent());

    const commit = (snap) => {
      const delta = Array.isArray(snap.parts) ? snap.parts.slice(seen).filter(Boolean) : [];
      const text = delta.length ? sanitizeText(delta.join("\n\n")) : snap.text ?? meta.lastText ?? "";
      meta.lastText = text;
      meta.assistantCount = snap.count || meta.assistantCount || (text ? 1 : 0);
      meta.status = "done";
      meta.awaitingFollowup = false;
      meta.settled = true;
      if (!this.children.has(id)) {
        this.children.set(id, { ...meta, id, name: meta.name ?? id, mode: meta.mode ?? "continuable" });
      }
      return text;
    };

    if (meta.settled && (meta.lastText || meta.lastText === "")) {
      const last0 = this.readChildSnapshot(id);
      return commit(last0.text ? last0 : { text: meta.lastText, count: 1, parts: [meta.lastText] });
    }

    let last = this.readChildSnapshot(id);
    let stable = null;
    let stableHits = 0;
    let sawRunning = false;

    while (Date.now() < deadline) {
      last = this.readChildSnapshot(id);
      const childAgent = this.childAgent(id);
      const running = childAgent?.status === "running";
      if (running) sawRunning = true;

      if (running && typeof childAgent.whenIdle === "function") {
        const remain = Math.max(1000, deadline - Date.now());
        try {
          await Promise.race([
            childAgent.whenIdle(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("idle-timeout")), remain)),
          ]);
        } catch {
          /* fall through to snapshot / overall timeout */
        }
        last = this.readChildSnapshot(id);
        if (last.text && (seen === 0 ? last.count > 0 : last.count > seen)) return commit(last);
        if (last.text) return commit(last);
        continue;
      }

      const newer = Boolean(last.text) && (seen === 0 ? last.count > 0 : last.count > seen);
      if (newer && !running) {
        if (last.text === stable) stableHits += 1;
        else {
          stable = last.text;
          stableHits = 1;
        }
        const idle = !childAgent || childAgent.status === "idle" || sawRunning || stableHits >= 2;
        if (idle) return commit(last);
      }
      if (meta.settled && (meta.lastText || last.text)) {
        return commit(last.text ? last : { text: meta.lastText, count: 1, parts: [meta.lastText] });
      }
      await Promise.race([
        meta.settlePromise || new Promise((r) => setTimeout(r, 250)),
        new Promise((r) => setTimeout(r, 250)),
      ]);
    }

    last = this.readChildSnapshot(id);
    if (last?.text) return commit(last);
    if (meta.lastText) return commit({ text: meta.lastText, count: 1, parts: [meta.lastText] });
    const agent = this.childAgent(id);
    throw new Error(
      `rlm.wait: timed out waiting for ${id} (agent=${agent ? agent.status : "missing"} messages=${last?.count ?? 0})`,
    );
  }

  childAgent(id) {
    const parent = this.currentParent();
    const roots = [parent?.ctx, this.ctx];
    for (const root of roots) {
      try {
        const agent = root?.agents?.get?.(id);
        const aid = agent?.id ?? agent?.session?.id;
        if (agent && String(aid) === String(id)) return agent;
      } catch {
        /* optional */
      }
    }
    return null;
  }

  async childActivity(id) {
    try {
      const rows = await this.ctx.subagents?.listChildren?.(this.sessionId());
      const row = Array.isArray(rows)
        ? rows.find((r) => String(r.id ?? r.childId ?? r.subagentId) === String(id))
        : undefined;
      return String(row?.activity ?? row?.status ?? "").toLowerCase();
    } catch {
      return "";
    }
  }

  readChildSnapshot(id) {
    const parent = this.currentParent();
    const bags = [
      this.ctx.sessions,
      this.ctx.get?.("sessions"),
      parent?.ctx?.sessions,
      parent?.ctx?.get?.("sessions"),
    ];
    let session;
    for (const bag of bags) {
      try {
        session = bag?.get?.(id) || bag?.get?.(String(id));
        if (session) break;
      } catch {
        session = undefined;
      }
    }
    if (!session) return { text: null, count: 0, parts: [] };
    let messages = [];
    try {
      messages = session.deriveMessages?.() ?? session.messages ?? [];
    } catch {
      messages = [];
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      try {
        const events = session.events;
        if (Array.isArray(events)) {
          messages = events
            .filter((ev) => ev?.type === "assistant/message")
            .map((ev) => ev.data?.message ?? ev.data)
            .filter(Boolean);
        }
      } catch {
        messages = [];
      }
    }
    if (!Array.isArray(messages)) return { text: null, count: 0, parts: [] };
    const assistants = messages.filter(
      (m) => m?.role === "assistant" || m?.kind === "assistant" || m?.type === "assistant",
    );
    const parts = [];
    for (const msg of assistants) {
      const t = assistantText(msg);
      if (t && !/^started subagent/i.test(t.trim())) parts.push(t);
    }
    const text = parts.length ? sanitizeText(parts.join("\n\n")) : null;
    return { text, count: assistants.length, parts };
  }

  async listChildrenProjected() {
    const live = [];
    try {
      const rows = await this.ctx.subagents?.listChildren?.(this.sessionId());
      if (Array.isArray(rows)) live.push(...rows);
    } catch {
      /* optional */
    }
    const byId = new Map();
    for (const row of live) {
      const id = String(row.id ?? row.childId ?? row.subagentId ?? "");
      if (!id) continue;
      const mode = row.mode ?? "continuable";
      if (mode !== "continuable") continue;
      byId.set(id, {
        rlm_child_id: id,
        name: row.label ?? row.name ?? id,
        status: row.activity ?? row.status ?? "idle",
        mode: "continuable",
        session_dir: row.sessionDir ?? "",
        model: row.model ?? "",
        result: this.children.get(id)?.lastText ?? null,
      });
    }
    for (const [id, meta] of this.children) {
      if (meta.mode === "one-shot") continue;
      if (!byId.has(id)) {
        byId.set(id, {
          rlm_child_id: id,
          name: meta.name,
          status: meta.status,
          mode: meta.mode,
          session_dir: meta.sessionDir ?? "",
          model: meta.model ?? "",
          result: meta.lastText,
        });
      }
    }
    return [...byId.values()];
  }

  async deleteChild(id) {
    try {
      await this.interruptChild(id);
    } catch {
      /* best-effort */
    }
    const meta = this.children.get(id);
    if (meta?.run?.dispose) await meta.run.dispose().catch(() => undefined);
    this.children.delete(id);
    const ac = this.aborts.get(id);
    this.aborts.delete(id);
    try {
      ac?.abort?.("rlm.delete");
    } catch {
      /* ignore */
    }
    return null;
  }

  saveSkillPackage(params) {
    const kebab = this.kebabName(params.name);
    const mod = this.pyModule(kebab);
    const code = String(params.code ?? "");
    const description = String(params.description ?? `RLM skill ${kebab}`).replace(/\s+/g, " ").slice(0, 240);
    const pkgDir = join(this.skillDir(), kebab);
    mkdirSync(pkgDir, { recursive: true });
    const initPath = join(pkgDir, "__init__.py");
    writeFileSync(initPath, code.endsWith("\n") ? code : `${code}\n`, "utf8");
    const skillMd = `---
name: ${kebab}
description: ${JSON.stringify(description)}
---
# ${kebab}

Load from the RLM kernel with \`load_skill("${kebab}")\`. Implementation is \`__init__.py\`.
`;
    writeFileSync(join(pkgDir, "SKILL.md"), skillMd, "utf8");
    const dshDir = join(this.dshSkillRoot(), kebab);
    mkdirSync(dshDir, { recursive: true });
    writeFileSync(join(dshDir, "SKILL.md"), skillMd, "utf8");
    this.skills.set(kebab, code);
    this.emit("rlm/skill-save", { name: kebab });
    return { name: kebab, module: mod, root: this.skillDir(), init: initPath };
  }

  loadSkillPackage(name) {
    const kebab = this.kebabName(name);
    const mod = this.pyModule(kebab);
    const pkgInit = join(this.skillDir(), kebab, "__init__.py");
    const flat = join(this.skillDir(), `${kebab}.py`);
    const snakeFlat = join(this.skillDir(), `${mod}.py`);
    for (const path of [pkgInit, flat, snakeFlat]) {
      try {
        const code = readFileSync(path, "utf8");
        this.skills.set(kebab, code);
        return { code, root: this.skillDir(), module: mod, name: kebab, init: path.endsWith("__init__.py") ? path : "" };
      } catch {
        /* try next */
      }
    }
    if (this.skills.has(kebab)) {
      return {
        code: this.skills.get(kebab),
        root: this.skillDir(),
        module: mod,
        name: kebab,
        init: pkgInit,
      };
    }
    throw new Error(`harness missing skill ${kebab}`);
  }

  listSkillNames() {
    let disk = [];
    try {
      disk = readdirSync(this.skillDir(), { withFileTypes: true }).flatMap((ent) => {
        if (ent.isDirectory() && (existsSync(join(this.skillDir(), ent.name, "__init__.py")) || existsSync(join(this.skillDir(), ent.name, "SKILL.md")))) {
          return [ent.name];
        }
        if (ent.isFile() && ent.name.endsWith(".py")) return [ent.name.slice(0, -3)];
        return [];
      });
    } catch {
      disk = [];
    }
    return [...new Set([...this.skills.keys(), ...disk])];
  }

  async maybeInjectContext(km, sessionId) {
    const hay = this.resolveHaystack(sessionId);
    let current;
    try {
      const ns = await km.inspectNamespace();
      current = ns?.context;
    } catch {
      current = undefined;
    }
    if (current === hay) {
      this.contextInjected.add(sessionId);
      return;
    }
    try {
      await km.injectNamespace({ context: hay ?? "" });
      this.contextInjected.add(sessionId);
    } catch {
      try {
        await km.execute(`context = ${JSON.stringify(hay ?? "")}\n`);
        this.contextInjected.add(sessionId);
      } catch {
        /* best-effort */
      }
    }
  }

  async onCompacted() {
    const id = this.sessionId();
    const km = this.kernels.get(id);
    if (!km) {
      this.emit("rlm/kernel-snapshot", { after: "compaction", vars: 0, kernel: false });
      return;
    }
    const snap = await km.inspectNamespace().catch(() => ({}));
    this.emit("rlm/kernel-snapshot", {
      after: "compaction",
      vars: Object.keys(snap || {}).length,
      kernel: true,
    });
  }

  async run(request) {
    const prevParent = this.lastParent;
    const prevBindings = this.lastBindings;
    const prevSignal = this.lastSignal;
    const prevKernel = this.activeKernel;
    try {
      this.lastParent = this.resolveParent();
      this.lastBindings = request.bindings ?? [];
      this.lastSignal = request.signal;
      const id = this.lastParent?.session?.id ?? this.lastParent?.id ?? this.ctx.get("agentSessionId") ?? "default";
      this.sessionState.set(id, {
        parent: this.lastParent,
        bindings: this.lastBindings,
        signal: this.lastSignal,
      });
      this.activeKernel = id;
      if (request.haystack != null || request.context != null) {
        this.setHaystack(id, request.haystack ?? request.context, { rebind: true });
      }
      let km = this.kernels.get(id);
      if (!km) {
        km = new KernelManager(id, (method, params) => this.dispatchHost(id, method, params));
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
      const reserved = new Set(["rlm", "Path", "RLMSpawnHandle", "load_haystack", "set_haystack", "save_skill", "load_skill", "list_skills", "chunk"]);
      await km.installBindings((request.bindings ?? []).filter((b) => !reserved.has(b.global)));
      await this.maybeInjectContext(km, id);
      return await km.execute(request.program, request.signal);
    } finally {
      this.lastParent = prevParent;
      this.lastBindings = prevBindings;
      this.lastSignal = prevSignal;
      this.activeKernel = prevKernel;
    }
  }

  async snapshot(sessionId) {
    const km = this.kernels.get(sessionId);
    if (!km) return new Uint8Array();
    return km.snapshotNamespace();
  }

  async dispose() {
    for (const ac of this.aborts.values()) {
      try {
        ac.abort("runtime dispose");
      } catch {
        /* ignore */
      }
    }
    this.aborts.clear();
    this.sessionState.clear();
    this.children.clear();
    await Promise.all([...this.kernels.values()].map((k) => k.shutdown()));
    this.kernels.clear();
  }
}

function isRetryableContinuable(err) {
  const m = String(err?.message ?? err ?? "").toLowerCase();
  return /preparecontinuable|unknown provider|not continuable|no continuation|provider .* not|continuable unavailable/.test(
    m,
  );
}

function sanitizeText(s) {
  if (typeof s !== "string") return s;
  return Buffer.from(s, "utf8").toString("utf8");
}

function composeChildPrompt(user, parent) {
  const header = parent?.session?.header ?? {};
  const cwd = header.cwd || parent?.session?.cwd || parent?.cwd || process.cwd();
  return [
    `You are a delegated subagent. Stay inside ${cwd} unless the task names another path.`,
    "Use native file tools (read, grep, glob, bash). Finish with a written summary and stop.",
    "Do not scan the whole disk, home directory, or prior DSH session logs.",
    "",
    user,
  ].join("\n");
}

function asBlocks(text) {
  if (Array.isArray(text)) return text;
  return [{ type: "text", text: String(text ?? "") }];
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

function foldBlocks(blocks) {
  if (blocks == null) return null;
  if (typeof blocks === "string") {
    const s = sanitizeText(blocks).trim();
    return s || null;
  }
  const text = assistantText({ content: blocks }) || outputValueText(blocks);
  return text ? sanitizeText(text) : null;
}

function foldSubagentOutput(settled) {
  if (settled == null) return null;
  if (typeof settled === "string") {
    const s = settled.trim();
    if (!s || /^started subagent/i.test(s)) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      return null;
    }
    return sanitizeText(settled);
  }
  if (typeof settled !== "object") return sanitizeText(String(settled));
  if (settled.structured != null) {
    return typeof settled.structured === "string" ? sanitizeText(settled.structured) : settled.structured;
  }
  const output = settled.output ?? settled.content ?? settled;
  if (typeof output === "string") return sanitizeText(output);
  if (Array.isArray(output)) return outputValueText(output);
  if (output && typeof output === "object" && typeof output.text === "string") {
    return sanitizeText(output.text);
  }
  return null;
}

function assistantText(msg) {
  if (!msg) return null;
  if (typeof msg === "string") return msg;
  const content = msg.content ?? msg.text ?? msg.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return outputValueText(content);
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
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
  return texts.length ? sanitizeText(texts.join("")) : null;
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
  const names = ["turn/start", "agent/turn-start", "session/user-message", "user/message"];
  for (const name of names) {
    try {
      ctx.on(name, async (ev, next) => {
        try {
          const text = extractUserText(ev);
          const sid =
            ev?.sessionId ?? ev?.session?.id ?? ctx.get("agentSessionId") ?? runtime.sessionId();
          if (text && sid) runtime.setHaystack(String(sid), text);
        } catch {
          /* never block the turn */
        }
        return typeof next === "function" ? next() : undefined;
      });
    } catch {
      /* event may not exist */
    }
  }
}

function hookCompaction(ctx, runtime) {
  for (const name of ["compaction/end", "compaction/start"]) {
    try {
      ctx.on(name, async (ev, next) => {
        try {
          if (name === "compaction/end") await runtime.onCompacted(ev);
        } catch {
          /* never fail compaction */
        }
        return typeof next === "function" ? next() : undefined;
      });
    } catch {
      /* optional seam */
    }
  }
}

export function apply(ctx, config = {}) {
  const runtime = new IPythonCodeRuntime(ctx, undefined, {
    maxDepth: config.maxDepth ?? 2,
  });
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
  try {
    ctx.on("subagent/end", (info) => runtime.onChildEnded(info));
  } catch {
    /* optional */
  }
  hookHaystackEvents(ctx, runtime);
  hookCompaction(ctx, runtime);
}
