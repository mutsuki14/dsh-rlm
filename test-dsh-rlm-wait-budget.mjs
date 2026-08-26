import { apply } from "./packages/code-runtime-ipython/src/index.js";

const parent = {
  id: "parent-1",
  session: { id: "parent-1", dir: "/tmp", header: { cwd: "/tmp" } },
  ctx: {
    on() {},
    agents: { get: () => ({ status: "running", whenIdle: () => new Promise(() => {}) }) },
    sessions: {
      get: () => ({
        events: [
          {
            type: "assistant/message",
            data: {
              message: { role: "assistant", content: [{ type: "text", text: "still thinking" }] },
            },
          },
        ],
      }),
    },
  },
};

let provided;
const ctx = {
  provide(name, value) {
    if (name === "codeRuntime") provided = value;
  },
  on() {},
  get(key) {
    if (key === "agent") return parent;
    if (key === "agentSessionId") return parent.id;
    if (key === "sessions") return parent.ctx.sessions;
    return undefined;
  },
  agents: {
    currentInitiator: () => parent,
    list: () => [parent],
    roots: () => [parent],
    get: (id) => (String(id) === "child-hang" ? parent.ctx.agents.get() : parent),
  },
  subagents: {
    startContinuable: async () => ({
      childId: "child-hang",
      messageId: "m1",
      sessionDir: "/tmp/child",
      resultPromise: new Promise(() => {}),
    }),
    listChildren: async () => [{ id: "child-hang", activity: "running" }],
  },
  sessions: parent.ctx.sessions,
  tools: { execute: async () => null },
};

apply(ctx);
if (!provided) throw new Error("apply did not provide codeRuntime");

const t0 = Date.now();
const result = await provided.run({
  program: `
h = await rlm("wander forever", name="hang")
print("st0", h.status)
got = await h.wait(timeout_ms=1500)
print("got", got)
print("st1", h.status)
`,
  bindings: [],
});
const dt = Date.now() - t0;
const logs = (result.logs || []).join("\n");
console.log(logs);
if (result.error) {
  console.error("FAIL kernel", result.error);
  process.exit(1);
}
if (dt > 8000) {
  console.error(`FAIL wait ignored budget, took ${dt}ms`);
  process.exit(1);
}
if (!logs.includes("still thinking") && !logs.toLowerCase().includes("timeout")) {
  // snapshot text should come through, or status timeout
  if (!logs.includes("st1 timeout") && !logs.includes("st1 error")) {
    console.error("FAIL expected timeout status or partial text", logs);
    process.exit(1);
  }
}
if (!logs.includes("st1 timeout") && !logs.includes("got still thinking")) {
  console.error("FAIL expected timeout or partial", logs);
  process.exit(1);
}
console.log("ok wait budget races resultPromise", dt);
await provided.dispose();
