var name = "@seamlabs/dsh-rlm/bindings";
var inject = [];
function apply() {
  // rlm() is the Python shim → host rlm.run on the persistent kernel.
  // Do not register a second spawn path here (it used to call
  // ctx.agents.get(agentSessionId) and fail with "no live agent").
}
export { apply, inject, name };
