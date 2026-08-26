import { apply } from "./packages/code-runtime-ipython/src/index.js";

const fail = (msg) => {
  console.error("FAIL", msg);
  process.exitCode = 1;
};

function ctxFor(agentBox, extra = {}) {
  const parent = () => agentBox.current;
  let provided;
  const ctx = {
    provide(name, value) {
      if (name === "codeRuntime") provided = value;
    },
    on() {},
    emit() {},
    get(key) {
      if (key === "agent") return parent();
      if (key === "agentSessionId") return parent().id;
      return undefined;
    },
    agents: {
      currentInitiator: () => parent(),
      list: () => [parent()],
      roots: () => [parent()],
      get: () => parent(),
    },
    subagents: extra.subagents,
    sessions: extra.sessions ?? { get: () => undefined, append() {} },
    tools: { execute: async () => null },
  };
  apply(ctx);
  return { provided, ctx };
}

// 1. empty prompt
{
  const agentBox = { current: { id: "p1", session: { id: "p1" } } };
  const { provided } = ctxFor(agentBox, {
    subagents: {
      startContinuable: async () => ({ childId: "c1", messageId: "m" }),
      start: async () => {
        throw new Error("start should not run");
      },
      listChildren: async () => [],
    },
  });
  const r = await provided.run({ program: `await rlm("")`, bindings: [] });
  const err = r.error?.message ?? "";
  if (!/empty prompt/i.test(err)) fail(`empty prompt: ${err || JSON.stringify(r)}`);
  else console.log("ok empty prompt");
  await provided.dispose();
}

// 2. rlm binding must not overwrite shim
{
  const agentBox = { current: { id: "p1", session: { id: "p1" } } };
  const { provided } = ctxFor(agentBox, {
    subagents: {
      startContinuable: async (spec) => {
        if (!Array.isArray(spec.request?.prompt)) throw new Error("bad spec");
        return { childId: "c-bind", messageId: "m", sessionDir: "", model: "" };
      },
      followup: async () => "m",
      listChildren: async () => [{ id: "c-bind", mode: "continuable", activity: "idle" }],
      start: async () => {
        throw new Error("start should not run");
      },
    },
    sessions: {
      get: () => ({ deriveMessages: () => [{ role: "assistant", text: "OK" }] }),
      append() {},
    },
  });
  const r = await provided.run({
    program: `h = await rlm("hello", name="x")\nprint("bind", h.status, h.rlm_child_id)`,
    bindings: [{ global: "rlm", names: ["run", "list_subagents"], functions: {} }],
  });
  const logs = (r.logs || []).join("\n");
  if (r.error) fail(`rlm binding overwrite: ${r.error.message}`);
  else if (!logs.includes("c-bind")) fail(`rlm binding overwrite logs ${logs}`);
  else console.log("ok rlm binding reserved");
  await provided.dispose();
}

// 3. one-shot cannot message()
{
  const agentBox = { current: { id: "p1", session: { id: "p1" } } };
  const { provided } = ctxFor(agentBox, {
    subagents: {
      start: async () => ({
        id: "one-shot-1",
        result: Promise.resolve({ output: [{ type: "text", text: "PONG" }], stopReason: "completed" }),
      }),
      listChildren: async () => [],
    },
  });
  const r = await provided.run({
    program: `
h = await rlm("ping", name="x")
print(await h.wait())
await h.message("again")
`,
    bindings: [],
  });
  const err = r.error?.message ?? "";
  if (!/one-shot/i.test(err)) fail(`one-shot message: ${err || (r.logs || []).join("\n")}`);
  else console.log("ok one-shot message rejected");
  await provided.dispose();
}

// 4. concurrent sessions keep their own parent
{
  const parentA = { id: "sess-A", session: { id: "sess-A" } };
  const parentB = { id: "sess-B", session: { id: "sess-B" } };
  const agentBox = { current: parentA };
  const seen = [];
  const { provided } = ctxFor(agentBox, {
    subagents: {
      startContinuable: async (spec) => {
        seen.push(spec.request.parent.id);
        await new Promise((r) => setTimeout(r, 80));
        return { childId: `${spec.request.parent.id}-child`, messageId: "m" };
      },
      listChildren: async () => [],
      start: async () => {
        throw new Error("start should not run");
      },
    },
    sessions: {
      get: (id) => ({ deriveMessages: () => [{ role: "assistant", text: `from ${id}` }] }),
      append() {},
    },
  });
  const pA = provided.run({
    program: `h = await rlm("task A", name="a")\nprint("PA", h.rlm_child_id)`,
    bindings: [],
  });
  await new Promise((r) => setTimeout(r, 40));
  agentBox.current = parentB;
  const pB = provided.run({
    program: `h = await rlm("task B", name="b")\nprint("PB", h.rlm_child_id)`,
    bindings: [],
  });
  const [ra, rb] = await Promise.all([pA, pB]);
  const la = (ra.logs || []).join("\n");
  const lb = (rb.logs || []).join("\n");
  if (ra.error) fail(`concurrent A ${ra.error.message}`);
  if (rb.error) fail(`concurrent B ${rb.error.message}`);
  if (!la.includes("sess-A-child")) fail(`concurrent parent A leaked: ${la} seen=${seen}`);
  if (!lb.includes("sess-B-child")) fail(`concurrent parent B leaked: ${lb} seen=${seen}`);
  if (!(seen.includes("sess-A") && seen.includes("sess-B"))) fail(`parents seen ${seen}`);
  else console.log("ok concurrent session isolation", seen);
  await provided.dispose();
}

// 4b. DSH assistant messages are ContentBlock[]; last may be tool-only
{
  const childId = "c-blocks";
  const agentBox = { current: { id: "p1", session: { id: "p1" } } };
  const { provided } = ctxFor(agentBox, {
    subagents: {
      startContinuable: async () => ({ childId, messageId: "m" }),
      listChildren: async () => [{ id: childId, mode: "continuable", activity: "running" }],
      start: async () => {
        throw new Error("start should not run");
      },
    },
    sessions: {
      get: () => ({
        deriveMessages: () => [
          { role: "assistant", content: [{ type: "text", text: "found 3 issues" }] },
          { role: "assistant", content: [{ type: "tool-use", name: "read" }] },
        ],
      }),
      append() {},
    },
  });
  const r = await provided.run({
    program: `h = await rlm("review", name="auth")
print("WAIT", await h.wait())
`,
    bindings: [],
  });
  const logs = (r.logs || []).join("\n");
  if (r.error) fail(`content-block wait: ${r.error.message}`);
  else if (!logs.includes("found 3 issues")) fail(`block wait logs ${logs}`);
  else console.log("ok content-block wait folds earlier text");
  await provided.dispose();
}

// 5. unpaired UTF-16 surrogates in child output must not crash the kernel
{
  const dirty = "hello\uDCAC world 👍";
  const agentBox = { current: { id: "p1", session: { id: "p1" } } };
  const { provided } = ctxFor(agentBox, {
    subagents: {
      startContinuable: async () => ({ childId: "c-surr", messageId: "m" }),
      listChildren: async () => [{ id: "c-surr", mode: "continuable", activity: "idle" }],
      start: async () => {
        throw new Error("start should not run");
      },
    },
    sessions: {
      get: () => ({ deriveMessages: () => [{ role: "assistant", text: dirty }] }),
      append() {},
    },
  });
  const r = await provided.run({
    program: `print("ver", __rlm_version__)
h = await rlm("review", name="auth")
got = await h.wait()
print("got", got)
print("ok-surrogate")
`,
    bindings: [],
  });
  const logs = (r.logs || []).join("\n");
  if (r.error) fail(`surrogate crash: ${r.error.message}`);
  else if (!logs.includes("ok-surrogate")) fail(`surrogate logs ${logs}`);
  else if (!logs.includes("ver 0.4.8")) fail(`version not injected ${logs}`);
  else if (!logs.includes("rlm 0.4.8")) fail(`execute banner ${logs}`);
  else if (logs.includes("\uDCAC")) fail(`surrogate leaked into logs ${JSON.stringify(logs)}`);
  else console.log("ok surrogate sanitized");
  await provided.dispose();
}

if (process.exitCode) {
  console.error("prod checks failed");
  process.exit(process.exitCode);
}
console.log("ok dsh-rlm 0.4 production checks");
