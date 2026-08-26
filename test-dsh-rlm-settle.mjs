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
