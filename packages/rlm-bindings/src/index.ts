import type { Context } from "@deepseek-ai/cordis";

export const name = "@seamlabs/dsh-rlm/bindings";
export const inject = ["subagents", "tools", "codeRuntime", "agents"];

export function apply(ctx: Context) {
  ctx.on("code-runtime/bindings", async (bindings, next) => {
    bindings.push({
      global: "rlm",
      functions: {
        run: async (args: { prompt: string; name?: string }) => {
          const parent = ctx.agents.get(ctx.get("agentSessionId"));
          const run = await ctx.subagents.start("spawn", {
            label: args.name ?? "rlm",
            prompt: [{ type: "text", text: args.prompt }],
            parent,
            signal: new AbortController().signal,
            maxDepth: 2,
          });
          return {
            rlm_child_id: run.id,
            name: args.name ?? run.id,
            session_dir: "",
            model: "",
          };
        },
        list_subagents: async () => ctx.subagents.listChildren(ctx.get("agentSessionId")),
        delete_subagent: async (args: { rlm_child_id: string }) => {
          await ctx.subagents.drainContinuableChildren(
            ctx.agents.get(ctx.get("agentSessionId")),
            [args.rlm_child_id],
          );
          return null;
        },
      },
    });
    return next();
  });
}
