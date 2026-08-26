import { apply } from "./packages/code-runtime-ipython/src/index.js";

const parent = { id: "parent-1", session: { id: "parent-1", dir: "/tmp" } };
let provided;

const ctx = {
  provide(name, value) {
    if (name === "codeRuntime") provided = value;
  },
  on() {},
  get(key) {
    if (key === "agent") return parent;
    if (key === "agentSessionId") return parent.id;
    return undefined;
  },
  agents: {
    currentInitiator: () => parent,
    list: () => [parent],
    roots: () => [parent],
    get: () => parent,
  },
  subagents: {
    start: async () => ({
      id: "c3fb07d4-eafa-4f9b-ac1b-fd6c11c3af86",
      result: Promise.resolve({
        output: [
          { type: "thinking", text: "The user asks to reply with exactly PONG." },
          { type: "text", text: "PONG" },
        ],
        stopReason: "completed",
      }),
    }),
    listChildren: async () => [],
  },
  sessions: { get: () => undefined },
  tools: { execute: async () => null },
};

apply(ctx);
if (!provided) throw new Error("apply did not provide codeRuntime");

const result = await provided.run({
  program: `
h = await rlm("reply with just PONG", name="ping-1")
print("id", h.rlm_child_id)
got = await h.wait()
print("got", got)
print("handle.result", h.result)
`,
  bindings: [],
});

const logs = (result.logs || []).join("\n");
console.log("--- logs ---");
console.log(logs);
console.log("--- error ---");
console.log(result.error ?? "(none)");
console.log("--- value ---");
console.log(result.value);

if (result.error) {
  console.error("FAIL: kernel error");
  process.exit(1);
}
if (!logs.includes("PONG")) {
  console.error("FAIL: expected PONG in logs, got:", JSON.stringify(logs));
  process.exit(1);
}
if (!logs.includes("c3fb07d4-eafa-4f9b-ac1b-fd6c11c3af86")) {
  console.error("FAIL: expected child id in logs");
  process.exit(1);
}
console.log("ok dsh-rlm wait fold + host rlm.run/wait");
await provided.dispose();
