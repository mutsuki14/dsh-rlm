import type { Context } from "@deepseek-ai/cordis";
import { RLM_PREAMBLE } from "./prompt";

export const name = "@seamlabs/dsh-rlm/persona";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: Context) {
  ctx.tools.presentAs("code");
  ctx.systemPrompt.register({
    id: "rlm:preamble",
    order: 20,
    async render() {
      return RLM_PREAMBLE;
    },
  });
}
