import { apply } from "./packages/code-runtime-ipython/src/index.js";

const parent = { id: "parent-1", session: { id: "parent-1", dir: "/tmp" } };
let provided;
let startCount = 0;
const startedAt = [];

const ctx = {
  provide(name, value) {
    if (name === "codeRuntime") provided = value;
  },
  on() {},
  get(key) {
    if (key === "agent") return parent;
    if (key === "agentSessionId") return parent.id;
    if (key === "rlm.haystack") return "haystack-needle-haystack";
    return undefined;
  },
  agents: {
    currentInitiator: () => parent,
    list: () => [parent],
    roots: () => [parent],
    get: () => parent,
  },
  subagents: {
    start: async (_kind, req) => {
      startCount += 1;
      const n = startCount;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      startedAt.push(Date.now());
      const delay = 80;
      return {
        id,
        result: new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              output: [
                { type: "thinking", text: "thinking..." },
                { type: "text", text: n === 1 ? "AAA" : "BBB" },
              ],
              stopReason: "completed",
            });
          }, delay);
        }),
      };
    },
    listChildren: async () => [],
  },
  sessions: { get: () => undefined },
  tools: { execute: async () => null },
};

apply(ctx);
if (!provided) throw new Error("apply did not provide codeRuntime");

{
  startCount = 0;
  const result = await provided.run({
    program: `
h = await rlm("reply with just PONG", name="ping-1")
print("id", h.rlm_child_id)
print("status", h.status)
got = await h.wait()
print("got", got)
print("handle.result", h.result)
`,
    bindings: [],
  });
  const logs = (result.logs || []).join("\n");
  console.log("--- single ---");
  console.log(logs);
  if (result.error) {
    console.error("FAIL single:", result.error);
    process.exit(1);
  }
  if (!logs.includes("AAA")) {
    console.error("FAIL: expected AAA from first child");
    process.exit(1);
  }
  if (!logs.includes("status running")) {
    console.error("FAIL: expected non-blocking status running, got:", logs);
    process.exit(1);
  }
}

{
  startCount = 0;
  startedAt.length = 0;
  const t0 = Date.now();
  const result = await provided.run({
    program: `
a = await rlm("left", name="L")
b = await rlm("right", name="R")
print("spawned", a.status, b.status)
ra = await a.wait()
rb = await b.wait()
print(ra, rb)
`,
    bindings: [],
  });
  const logs = (result.logs || []).join("\n");
  console.log("--- parallel ---");
  console.log(logs);
  if (result.error) {
    console.error("FAIL parallel:", result.error);
    process.exit(1);
  }
  if (!logs.includes("AAA") || !logs.includes("BBB")) {
    console.error("FAIL: expected AAA BBB");
    process.exit(1);
  }
  if (!logs.includes("spawned running running")) {
    console.error("FAIL: both handles should be running before wait");
    process.exit(1);
  }
  if (startedAt.length >= 2 && startedAt[1] - startedAt[0] > 50) {
    console.error("FAIL: sequential spawn detected", startedAt);
    process.exit(1);
  }
  console.log("elapsed_ms", Date.now() - t0);
}

{
  const result = await provided.run({
    program: `
print("ctx", context)
print("hay", load_haystack())
print("find", context.find("needle"))
`,
    bindings: [],
    haystack: "haystack-needle-haystack",
  });
  const logs = (result.logs || []).join("\n");
  console.log("--- haystack ---");
  console.log(logs);
  if (result.error) {
    console.error("FAIL haystack:", result.error);
    process.exit(1);
  }
  if (!logs.includes("find 9") && !String(result.value).includes("9")) {
    const ok =
      logs.includes("needle") &&
      (logs.includes("9") || result.value === 9);
    if (!ok) {
      console.error("FAIL: context/haystack not injected", logs, result.value);
      process.exit(1);
    }
  }
}

console.log("ok dsh-rlm non-blocking wait + parallel + haystack");
await provided.dispose();
