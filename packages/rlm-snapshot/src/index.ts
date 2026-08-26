import type { Context } from "@deepseek-ai/cordis";

export const name = "@seamlabs/dsh-rlm/snapshot";
export const inject = ["sessions", "codeRuntime"];

export function apply(ctx: Context) {
  ctx.on("turn/end", async (_event, next) => {
    try {
      const runtime = ctx.codeRuntime as { snapshot?: (id: string) => Promise<Uint8Array> };
      const id = ctx.get("agentSessionId") as string | undefined;
      if (id && runtime?.snapshot) await runtime.snapshot(id);
    } catch {
      /* best-effort; never block the turn */
    }
    return next();
  });
}
