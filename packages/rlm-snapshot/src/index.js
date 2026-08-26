var name = "@seamlabs/dsh-rlm/snapshot";
var inject = ["sessions", "codeRuntime"];
function apply(ctx) {
  ctx.on("turn/end", async (_event, next) => {
    try {
      const runtime = ctx.codeRuntime;
      const id = ctx.get("agentSessionId");
      if (id && runtime?.snapshot) await runtime.snapshot(id);
    } catch {
      /* best-effort; never block the turn */
    }
    return next();
  });
}
export { apply, inject, name };
