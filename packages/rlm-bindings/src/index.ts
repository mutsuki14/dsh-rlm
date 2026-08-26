import type { Context } from "@deepseek-ai/cordis";

export const name = "@seamlabs/dsh-rlm/bindings";
export const inject = ["subagents", "tools", "codeRuntime"];

export function apply(ctx: Context) {
  ctx.on("code-runtime/bindings", async (bindings, next) => {
    bindings.push({
      global: "rlm",
      functions: {
        run: async (args: { prompt: string; name?: string }) => {
          const child = await ctx.subagents
            .getProvider("spawn-in-process")
            .start({
              prompt: args.prompt,
              name: args.name,
              maxDepth: ctx.config.rlm?.maxDepth ?? 2,
            });
          return {
            rlm_child_id: child.id,
            name: args.name ?? child.id,
            session_dir: child.sessionDir,
            model: child.model,
          };
        },
        list_subagents: async () => ctx.subagents.list(ctx.get("agentSessionId")),
        delete_subagent: async (args: { rlm_child_id: string }) => {
          await ctx.subagents.drain(args.rlm_child_id);
          return null;
        },
      },
    });
    return next();
  });
}
