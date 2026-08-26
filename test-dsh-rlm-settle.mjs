import { apply } from "./packages/code-runtime-ipython/src/index.js";

const listeners = {};
const parent = {
  id: "parent-1",
  session: { id: "parent-1", dir: "/tmp", header: { cwd: "/tmp" } },
  ctx: {
    on(name, fn) {
      (listeners[name] ||= []).push(fn);
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
  },
};

let provided;
const ctx = {
  provide(name, value) {
    if (name === "codeRuntime") provided = value;
  },
  on(name, fn) {
    (listeners[name] ||= []).push(fn);
  },
  get(key) {
    if (key === "agent") return parent;
    if (key === "agentSessionId") return parent.id;
    if (key === "sessions") return { get: () => undefined };
    return undefined;
  },
  agents: {
    currentInitiator: () => parent,
    list: () => [parent],
    roots: () => [parent],
    get: () => undefined,
  },
  subagents: {
    startContinuable: async () => ({
      childId: "child-settle",
      messageId: "m1",
      sessionDir: "/tmp/child",
      model: "test",
    }),
    listChildren: async () => [],
  },
  sessions: { get: () => undefined },
  tools: { execute: async () => null },
};

apply(ctx);
if (!provided) throw new Error("no runtime");

const run = provided.run({
  program: `
h = await rlm("reply AAA", name="a")
print("id", h.rlm_child_id)
print("got", await h.wait())
print("peek", await h.peek())
`,
  bindings: [],
});

await new Promise((r) => setTimeout(r, 200));
for (const fn of listeners["subagent/end"] || []) {
  fn({
    id: "child-settle",
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "AAA" }],
  });
}

const result = await run;
const logs = (result.logs || []).join("\n");
console.log(logs);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (!logs.includes("got AAA")) {
  console.error("expected got AAA", logs);
  process.exit(1);
}
if (!logs.includes("peek") || !logs.includes("AAA")) {
  console.error("peek missing", logs);
  process.exit(1);
}
console.log("ok subagent/end wait without child session");
await provided.dispose();

const listeners2 = {};
const parent2 = {
  id: "parent-2",
  session: { id: "parent-2", dir: "/tmp", header: { cwd: "/tmp" } },
  ctx: {
    on(name, fn) {
      (listeners2[name] ||= []).push(fn);
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
  },
};
let provided2;
const ctx2 = {
  provide(name, value) {
    if (name === "codeRuntime") provided2 = value;
  },
  on(name, fn) {
    (listeners2[name] ||= []).push(fn);
  },
  get(key) {
    if (key === "agent") return parent2;
    if (key === "agentSessionId") return parent2.id;
    if (key === "sessions") return { get: () => undefined };
    return undefined;
  },
  agents: {
    currentInitiator: () => parent2,
    list: () => [parent2],
    roots: () => [parent2],
    get: () => undefined,
  },
  subagents: {
    startContinuable: async () => ({ childId: "child-err", messageId: "m2" }),
    listChildren: async () => [],
  },
  sessions: { get: () => undefined },
  tools: { execute: async () => null },
};
apply(ctx2);
const run2 = provided2.run({
  program: `
h = await rlm("boom", name="e")
print("got", await h.wait())
print("st", h.status)
`,
  bindings: [],
});
await new Promise((r) => setTimeout(r, 200));
for (const fn of listeners2["subagent/end"] || []) {
  fn({
    id: "child-err",
    stopReason: "error",
    lastAssistantMessage: [{ type: "text", text: "partial-review" }],
  });
}
const result2 = await run2;
const logs2 = (result2.logs || []).join("\n");
console.log(logs2);
if (result2.error) {
  console.error(result2.error);
  process.exit(1);
}
if (!logs2.includes("got partial-review")) {
  console.error("expected partial text", logs2);
  process.exit(1);
}
if (!logs2.includes("st error")) {
  console.error("expected status error, got", logs2);
  process.exit(1);
}
console.log("ok wait preserves error status");
await provided2.dispose();

