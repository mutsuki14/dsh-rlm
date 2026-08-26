import type { Context } from "@deepseek-ai/cordis";

export const name = "@seamlabs/dsh-rlm/snapshot";
export const inject = ["sessions", "codeRuntime"];

export function apply(ctx: Context) {
  ctx.on("turn/end", async (event, next) => {
    const runtime = ctx.codeRuntime as {
      snapshot?: (id: string) => Promise<Uint8Array>;
    };
    const id = ctx.get("agentSessionId") as string;
    if (runtime.snapshot) {
      const blob = await runtime.snapshot(id);
      ctx.sessions.append({
        type: "rlm/kernel-snapshot",
        sessionId: id,
        bytes: blob.length,
        artifact: await ctx.sessions.putArtifact("kernel-ns", blob),
      });
    }
    return next();
  });
}
