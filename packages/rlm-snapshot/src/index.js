// packages/rlm-snapshot/src/index.ts
var name = "@seamlabs/dsh-rlm/snapshot";
var inject = ["sessions", "codeRuntime"];
function apply(ctx) {
  ctx.on("turn/end", async (event, next) => {
    const runtime = ctx.codeRuntime;
    const id = ctx.get("agentSessionId");
    if (runtime.snapshot) {
      const blob = await runtime.snapshot(id);
      ctx.sessions.append({
        type: "rlm/kernel-snapshot",
        sessionId: id,
        bytes: blob.length,
        artifact: await ctx.sessions.putArtifact("kernel-ns", blob)
      });
    }
    return next();
  });
}
export {
  apply,
  inject,
  name
};
