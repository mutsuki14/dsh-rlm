import type { Context } from "@deepseek-ai/cordis";
import { RLM_PREAMBLE } from "./prompt";

export const name = "@seamlabs/dsh-rlm/persona";
export const inject = ["systemPrompt", "tools"];

const CHILD_PREAMBLE = `You are a delegated subagent, not the RLM coordinator.
Use native file tools (read, grep, glob, bash or pwsh). Do not wander the whole disk.
Stay inside the working directory unless the task names another path.
When the review is done, write a concise final answer and stop.
`;

function isCoordinator(agent: { session?: { header?: { origin?: string; delegationDepth?: number } } } | undefined) {
  const header = agent?.session?.header ?? {};
  if (header.origin === "subagent") return false;
  if ((header.delegationDepth ?? 0) > 0) return false;
  return true;
}

export function apply(ctx: Context) {
  const seen = new Set<string>();
  const onAgent = (agent: any) => {
    const id = agent?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const scoped = agent?.ctx;
    if (isCoordinator(agent)) {
      try {
        scoped?.tools?.presentAs?.("code");
      } catch {
        /* already declared */
      }
      try {
        scoped?.systemPrompt?.section?.({ name: "rlm:preamble", order: 20, text: RLM_PREAMBLE });
      } catch {
        /* */
      }
    } else {
      try {
        scoped?.systemPrompt?.section?.({ name: "rlm:child", order: 21, text: CHILD_PREAMBLE });
      } catch {
        /* */
      }
    }
  };
  ctx.on("agent/created" as never, ((ev: any) => onAgent(ev?.agent ?? ev)) as never);
  ctx.on("agent/pre-step" as never, (async (ev: any, next: any) => {
    onAgent(ev?.agent);
    return typeof next === "function" ? next() : undefined;
  }) as never);
}