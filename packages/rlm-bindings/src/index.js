// packages/rlm-bindings/src/index.ts
var name = "@seamlabs/dsh-rlm/bindings";
var inject = ["subagents", "tools", "codeRuntime", "agents"];
function apply(ctx) {
  ctx.on("code-runtime/bindings", async (bindings, next) => {
    bindings.push({
      global: "rlm",
      functions: {
        run: async (args) => {
          const parent = ctx.agents.get(ctx.get("agentSessionId"));
          const run = await ctx.subagents.start("spawn", {
            label: args.name ?? "rlm",
            prompt: [{ type: "text", text: args.prompt }],
            parent,
            signal: new AbortController().signal,
            maxDepth: 2
          });
          return {
            rlm_child_id: run.id,
            name: args.name ?? run.id,
            session_dir: "",
            model: ""
          };
        },
        list_subagents: async () => ctx.subagents.listChildren(ctx.get("agentSessionId")),
        delete_subagent: async (args) => {
          await ctx.subagents.drainContinuableChildren(
            ctx.agents.get(ctx.get("agentSessionId")),
            [args.rlm_child_id]
          );
          return null;
        }
      }
    });
    return next();
  });
}
export {
  apply,
  inject,
  name
};
