# dsh-rlm

Layer 1 Recursive Language Model runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is the drop-in plugin sketched in Seam. It replaces the default `code-runtime-worker-thread` with a **persistent Python kernel** per agent session and binds `await rlm()` onto `ctx.subagents`.

## Why

DeepSeek Harness Code Mode is programmatic tool calling with a **fresh worker per `run_code`**. Prime Agent's RLM needs:

1. A kernel that outlives the turn
2. Context as a Python variable
3. Recursive subagents as function calls
4. Host-owned policy (approvals, sandbox, session log)

DSH already has the seams (`ctx.codeRuntime`, `ctx.subagents`, `tools.mode = code`, Python SDK renderer). This plugin fills the persistence gap.

## Packages

| Package | Seam |
|---|---|
| `@seamlabs/dsh-rlm/runtime` | `ctx.codeRuntime` |
| `@seamlabs/dsh-rlm/bindings` | `rlm()` → subagents |
| `@seamlabs/dsh-rlm/persona` | `systemPrompt.section` preamble (`tools.mode: code` is the patch) |
| `@seamlabs/dsh-rlm/snapshot` | kernel namespace → SessionEvent |

Declare every `@deepseek-ai/*` host package as a **peerDependency**.

## Kernel

`KernelManager` talks JSONL to `python/repl_worker.py`. Same process, same `NS`, across `execute()` calls. Nested `await rlm()` is a `host` frame on the same pipes so it cannot deadlock the cell.

Entries ship as **JavaScript**. Node will not strip TypeScript under `node_modules`.

```sh
node test-repl.mjs
```

## Install

```sh
dsh plugin --profile web add github:mutsuki14/seam-rlm
```

`package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The patch file is a **top-level YAML array** (disable stock `code-runtime`, insert RLM rows, set `tools.mode: code`). See [INSTALL.md](INSTALL.md).

## Trust

The kernel is not a sandbox. Run it inside the existing DSH sandbox. `%%bash` and `tools.*` must re-enter `tools/execute`; never `subprocess` around the pipeline.
