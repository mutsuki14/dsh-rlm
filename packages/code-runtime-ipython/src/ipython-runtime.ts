import type { Context } from "@deepseek-ai/cordis";
import { KernelManager, type HostHandler } from "./kernel-manager";

export type CodeBindingNamespace = {
  global: string;
  functions: Record<string, (args: unknown) => Promise<unknown>>;
};

export type CodeRunRequest = {
  program: string;
  bindings: CodeBindingNamespace[];
  signal?: AbortSignal;
};

export type CodeRunResult = {
  value?: unknown;
  logs: string[];
  error?: { kind: string; message: string };
};

export class IPythonCodeRuntime {
  readonly language = "python" as const;
  readonly isolation = "process" as const;
  private kernels = new Map<string, KernelManager>();
  private ctx: Context;
  private host?: HostHandler;
  private skills = new Map<string, string>();
  private runs = new Map<string, { result: Promise<unknown>; dispose?: () => void }>();

  constructor(ctx: Context, host?: HostHandler) {
    this.ctx = ctx;
    this.host = host;
  }

  private sessionId(): string {
    const id = this.ctx.get("agentSessionId") as string | undefined;
    return id ?? "default";
  }

  private hostHandler(): HostHandler {
    if (this.host) return this.host;
    return async (method, params) => {
      if (method === "rlm.run") {
        const parent =
          (this.ctx.get("agent") as unknown) || this.ctx.agents.get(this.sessionId());
        if (!parent) {
          throw new Error(`rlm(): no live agent for session ${this.sessionId()}`);
        }
        const run = await this.ctx.subagents.start("spawn", {
          label: params.name ?? "rlm",
          prompt: [{ type: "text", text: String(params.prompt ?? "") }],
          parent,
          signal: new AbortController().signal,
          maxDepth: 2,
        });
        this.runs.set(String(run.id), run);
        return {
          rlm_child_id: run.id,
          name: params.name ?? run.id,
          session_dir: run.localAgent?.session?.dir ?? "",
          model: run.localAgent?.model ?? "",
          status: "running",
        };
      }
      if (method === "rlm.wait") {
        const run = this.runs.get(String(params.rlm_child_id));
        if (!run?.result) {
          throw new Error(`rlm.wait: unknown handle ${params.rlm_child_id}`);
        }
        const settled = await run.result;
        return { result: foldSubagentOutput(settled), status: "done" };
      }
      if (method === "rlm.list_subagents") {
        const rows = await this.ctx.subagents.listChildren(this.sessionId());
        return Array.isArray(rows) ? rows : [];
      }
      if (method === "rlm.delete_subagent") {
        const run = this.runs.get(String(params.rlm_child_id));
        if (run?.dispose) await run.dispose();
        this.runs.delete(String(params.rlm_child_id));
        return null;
      }
      if (method === "rlm.load_haystack") {
        return (this.ctx.get("rlm.haystack") as string | undefined) ?? "";
      }
      if (method === "rlm.save_skill") {
        this.skills.set(String(params.name), String(params.code ?? ""));
        return true;
      }
      if (method === "rlm.load_skill") {
        const code = this.skills.get(String(params.name));
        if (code === undefined) throw new Error(`harness 里没有 ${params.name}`);
        return code;
      }
      if (method === "rlm.list_skills") {
        return [...this.skills.keys()];
      }
      if (method === "tools.dispatch") {
        return this.ctx.tools.execute({
          global: params.global,
          name: params.name,
          args: params.args,
        });
      }
      throw new Error(`unknown host method ${method}`);
    };
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const id = this.sessionId();
    let km = this.kernels.get(id);
    if (!km) {
      km = new KernelManager(id, this.hostHandler());
      try {
        await km.start();
      } catch (err) {
        await km.shutdown().catch(() => undefined);
        return {
          logs: [],
          error: {
            kind: "KernelStart",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      this.kernels.set(id, km);
    }
    await km.installBindings(request.bindings);
    return km.execute(request.program, request.signal);
  }

  async snapshot(sessionId: string): Promise<Uint8Array> {
    const km = this.kernels.get(sessionId);
    if (!km) return new Uint8Array();
    return km.snapshotNamespace();
  }

  async dispose() {
    await Promise.all([...this.kernels.values()].map((k) => k.shutdown()));
    this.kernels.clear();
  }
}

function foldSubagentOutput(settled: unknown): unknown {
  if (!settled || typeof settled !== "object") return settled ?? null;
  const s = settled as { structured?: unknown; output?: unknown };
  if (s.structured != null) return s.structured;
  const output = s.output;
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output ?? null;
  const texts: string[] = [];
  for (const msg of output) {
    const content = (msg as { content?: unknown })?.content ?? msg;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof (b as { text?: string }).text === "string") {
          texts.push((b as { text: string }).text);
        }
      }
    }
  }
  return texts.join("\n") || null;
}
