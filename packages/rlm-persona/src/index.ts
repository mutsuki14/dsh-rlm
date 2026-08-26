import type { Context } from "@deepseek-ai/cordis";
import { RLM_PREAMBLE } from "./prompt";

export const name = "@seamlabs/dsh-rlm/persona";
export const inject = ["systemPrompt"];

export function apply(ctx: Context) {
  // Global Code Mode is the tools row (`mode: code` in cordis.patch.yml).
  // presentAs() is agent/preset-scoped and throws from a plugin context.
  ctx.systemPrompt.section({
    name: "rlm:preamble",
    order: 20,
    text: RLM_PREAMBLE,
  });
}
