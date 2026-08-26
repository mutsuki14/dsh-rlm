import type { Context } from "@deepseek-ai/cordis";
import { IPythonCodeRuntime } from "./ipython-runtime";

export const name = "@seamlabs/dsh-rlm/runtime";
export const inject = ["sessions", "subagents", "tools", "agents"];

export function apply(ctx: Context) {
  const runtime = new IPythonCodeRuntime(ctx);
  ctx.provide("codeRuntime", runtime);
  ctx.on("dispose", () => runtime.dispose());
}
