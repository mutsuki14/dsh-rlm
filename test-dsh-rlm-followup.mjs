import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "./packages/code-runtime-ipython/src/index.js";

const home = mkdtempSync(join(tmpdir(), "dsh-rlm-04-"));
process.env.DSH_HOME = home;

const parent = { id: "parent-1", session: { id: "parent-1", dir: "/tmp" } };
let provided;
const events = [];
let assistants = [{ role: "assistant", text: "ROUND1" }];
let followups = 0;
let spawnedPrompt = "";

const ctx = {
  provide(name, value) {
    if (name === "codeRuntime") provided = value;
  },
  on(name, fn) {
    if (typeof fn === "function") events.push(["on", name]);
  },
  emit(kind, payload) {
    events.push([kind, payload]);
  },
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
    startContinuable: async (spec) => {
      if (!spec?.provider) throw new Error("missing provider");
      if (!spec?.label) throw new Error("missing label");
      if (!Array.isArray(spec.request?.prompt)) throw new Error("prompt must be ContentBlock[]");
      spawnedPrompt = spec.request.prompt.map((b) => (b && b.text) || "").join("");
      if (!spec.signal) throw new Error("missing signal");
      return {
        childId: "c3fb07d4-eafa-4f9b-ac1b-fd6c11c3af86",
        messageId: "m-start",
        sessionDir: "/tmp/child",
        model: "test",
      };
    },
    followup: async (_parent, id, content) => {
      if (!Array.isArray(content)) throw new Error("followup content must be ContentBlock[]");
      const message = content.map((b) => (b && b.text) || "").join("");
      followups += 1;
      setTimeout(() => {
        assistants.push({ role: "assistant", text: `ROUND2:${message}` });
      }, 80);
      return "m-follow";
    },
    listChildren: async () => [
      {
        id: "c3fb07d4-eafa-4f9b-ac1b-fd6c11c3af86",
        label: "reviewer",
        mode: "continuable",
        activity: "idle",
      },
    ],
    start: async () => {
      throw new Error("start() should not run when startContinuable exists");
    },
  },
  sessions: {
    get: () => ({ deriveMessages: () => assistants }),
    append: (row) => events.push(["append", row.type]),
  },
  tools: { execute: async () => null },
};

apply(ctx);
if (!provided) throw new Error("apply did not provide codeRuntime");

const fail = (msg) => {
  console.error("FAIL", msg);
  process.exitCode = 1;
};

const r1 = await provided.run({
  program: `
h = await rlm("first look", name="reviewer")
print("status", h.status)
print("id", h.rlm_child_id)
got = await h.wait()
print("got", got)
got_again = await h.wait()
print("got_again", got_again)
await h.message("only error handling")
got2 = await h.wait()
print("got2", got2)
kids = await rlm.list_subagents()
print("kids", len(kids), kids[0].name)
`,
  bindings: [],
});

const logs = (r1.logs || []).join("\n");
console.log("--- followup logs ---");
console.log(logs);
if (r1.error) fail(r1.error.message);
if (!spawnedPrompt.includes("Stay inside")) fail(`child prompt missing cwd bound: ${spawnedPrompt}`);
if (!spawnedPrompt.includes("first look")) fail(`child prompt dropped user text: ${spawnedPrompt}`);
if (!logs.includes("got ROUND1")) fail(`expected ROUND1, logs=${logs}`);
if (!logs.includes("got_again ROUND1")) fail(`idempotent wait ${logs}`);
if (!logs.includes("got2 ROUND2:only error handling")) fail(`expected ROUND2, logs=${logs}`);
if (followups !== 1) fail(`followups=${followups}`);
if (!logs.includes("kids 1 reviewer")) fail(`list_subagents ${logs}`);

const r2 = await provided.run({
  program: `
save_skill("double", "def double(x):\\n    return x * 2\\n", "multiply by two")
print("skills", list_skills())
load_skill("double")
print("double", double(21))
save_skill("scan-token", "TOKEN = 'SEAM'\\n", "hyphenated package")
load_skill("scan-token")
print("token", TOKEN)
`,
  bindings: [],
});
const logs2 = (r2.logs || []).join("\n");
console.log("--- skill logs ---");
console.log(logs2);
if (r2.error) fail(r2.error.message);
if (!logs2.includes("double 42")) fail(`skill exec ${logs2}`);
if (!logs2.includes("token SEAM")) fail(`hyphen skill ${logs2}`);
const skillMd = readFileSync(join(home, "skills", "double", "SKILL.md"), "utf8");
if (!skillMd.includes("name: double")) fail(`SKILL.md ${skillMd}`);
const initPy = readFileSync(join(home, "rlm-skills", "double", "__init__.py"), "utf8");
if (!initPy.includes("def double")) fail(`__init__.py ${initPy}`);

provided.setHaystack(parent.id, "haystack-needle-haystack");
const r3 = await provided.run({
  program: `print("idx", context.find("needle"))`,
  bindings: [],
});
const logs3 = (r3.logs || []).join("\n");
console.log("--- haystack logs ---");
console.log(logs3);
if (r3.error) fail(r3.error.message);
if (!logs3.includes("idx 9")) fail(`haystack inject ${logs3}`);

await provided.onCompacted();
if (!events.some((e) => e[0] === "rlm/kernel-snapshot" || (e[0] === "append" && e[1] === "rlm/kernel-snapshot"))) {
  fail(`expected compaction snapshot event ${JSON.stringify(events)}`);
}

await provided.dispose();
rmSync(home, { recursive: true, force: true });
if (!process.exitCode) console.log("ok dsh-rlm 0.4 followup + skill package + haystack + compact hook");
