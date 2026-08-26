var RLM_PREAMBLE = `You are an RLM. You write Python for a persistent IPython kernel.

Invariants:
- Context is a variable, not a prompt string. Slice it in Python.
- The only model-visible tool is run_code. Other capabilities are Python.
- Spawn work with await rlm(prompt, name=...). The call returns at admission.
  await handle.wait() fills handle.result. Optional timeout_ms (milliseconds).
  Follow up the same child with await handle.message("..."); await handle.wait().
  await rlm.list_subagents() recovers continuable children after compaction.
- %%bash / %%pwsh as a cell (or after Python in the same cell). await tools.bash("ls")
- Path("file").read_text() / .write_text() re-enter tools/execute. stdlib pathlib.Path
  is patched to the same host-backed Path; do not open() files for writes.
- load_haystack() / save_skill(name, code, description=...) / load_skill(name).
  These are sync but awaitable (`await save_skill(...)` is fine).
  load_skill imports into the kernel and returns {name, code, root, module}.
  Skills are kebab-case packages with SKILL.md + __init__.py.
- Call tools as await tools.name(args) only when the host binding exists.
- Variables, imports, and child handles survive compaction. The kernel is not compacted.
- When finished, assign FINAL and return it.

Do not paste large files into rlm() or into the next cell as literals.
`;

var CHILD_PREAMBLE = `You are a delegated subagent, not the RLM coordinator.
Use native file tools (read, grep, glob, bash or pwsh). Do not wander the whole disk.
Stay inside the working directory unless the task names another path.
When the review is done, write a concise final answer and stop.
`;

var name = "@seamlabs/dsh-rlm/persona";
var inject = ["systemPrompt", "tools"];

function isCoordinator(agent) {
  const header = agent?.session?.header ?? {};
  if (header.origin === "subagent") return false;
  if ((header.delegationDepth ?? 0) > 0) return false;
  return true;
}

function applyCodeMode(agent) {
  const scoped = agent?.ctx;
  if (!scoped?.tools?.presentAs) return;
  try {
    scoped.tools.presentAs("code");
  } catch {
    /* already declared for this scope */
  }
  try {
    scoped.systemPrompt?.section?.({
      name: "rlm:preamble",
      order: 20,
      text: RLM_PREAMBLE,
    });
  } catch {
    /* optional */
  }
}

function applyChildPreamble(agent) {
  try {
    agent?.ctx?.systemPrompt?.section?.({
      name: "rlm:child",
      order: 21,
      text: CHILD_PREAMBLE,
    });
  } catch {
    /* optional */
  }
}

function apply(ctx) {
  const seen = new Set();
  const onAgent = (agent) => {
    const id = agent?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (isCoordinator(agent)) applyCodeMode(agent);
    else applyChildPreamble(agent);
  };
  try {
    ctx.on("agent/created", (ev) => onAgent(ev?.agent ?? ev));
  } catch {
    /* */
  }
  try {
    ctx.on("agent/pre-step", async (ev, next) => {
      onAgent(ev?.agent);
      return typeof next === "function" ? next() : undefined;
    });
  } catch {
    /* */
  }
}

export { apply, inject, name, RLM_PREAMBLE, CHILD_PREAMBLE };