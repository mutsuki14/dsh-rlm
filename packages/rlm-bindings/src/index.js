// packages/rlm-bindings/src/index.ts
var name = "@seamlabs/dsh-rlm/bindings";
var inject = ["subagents", "tools", "codeRuntime"];
function apply(ctx) {
  ctx.on("code-runtime/bindings", async (bindings, next) => {
    bindings.push({
      global: "rlm",
      functions: {
        run: async (args) => {
          const child = await ctx.subagents.getProvider("spawn-in-process").start({
            prompt: args.prompt,
            name: args.name,
            maxDepth: ctx.config.rlm?.maxDepth ?? 2
          });
          return {
            rlm_child_id: child.id,
            name: args.name ?? child.id,
            session_dir: child.sessionDir,
            model: child.model
          };
        },
        list_subagents: async () => ctx.subagents.list(ctx.get("agentSessionId")),
        delete_subagent: async (args) => {
          await ctx.subagents.drain(args.rlm_child_id);
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
