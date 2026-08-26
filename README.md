# @seamlabs/dsh-rlm

English | [中文](README.zh-CN.md)

Persistent **Recursive Language Model** runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Current release line: **v0.4.8** (`wait()` listens for `subagent/end`; no longer needs child session visibility).

It replaces the per-turn worker-thread `codeRuntime` with a **long-lived Python kernel**, exposes non-blocking `await rlm()` (parallel fan-out + `wait()`), follows up the **same child** with `handle.message()`, injects `context` from haystack, and stores skills as kebab-case packages (`SKILL.md` + `__init__.py`).

## Install

```sh
dsh plugin --profile web add github:mutsuki14/dsh-rlm
# already installed:
dsh plugin --profile web update github:mutsuki14/dsh-rlm
```

Requires Node 22+, Python 3 (`py -3` / `python` / `python3`, or `DSH_RLM_PYTHON`). Restart the profile after install.

The bundle patch (`cordis.patch.yml`) is a **top-level YAML array**: disables stock `code-runtime`, inserts `rlm-*` rows. Code Mode is **parent-only** (`tools.presentAs("code")` on the coordinator). Subagents keep native file tools.

## What works (live-tested on DSH 0.1.1-rc.2)

| Capability | Status |
|---|---|
| Namespace persist across `run_code` (`n=41` → `n+1` → 42) | yes |
| Non-blocking `await rlm(...)` (`status=running` before wait) | yes |
| Parallel fan-out then `wait()` | yes |
| **Same child follow-up** `handle.message()` / `wait()` | yes (0.4) |
| `list_subagents()` keeps continuable children | yes (0.4) |
| `context` / haystack injection | yes |
| Nested `rlm()` inside a child (`maxDepth: 2`) | yes |
| Skill packages (`SKILL.md` + `__init__.py`, kebab-case) | yes (0.4) |
| Compact: conversation shadowed, **kernel kept** | yes (0.4) |
| Same-child `wait()` is idempotent | yes (0.4.1) |
| Concurrent sessions do not leak parent agent | yes (0.4.1) |
| `%%bash`, `Path.read_text()` via `tools.read` (`file_path`) | yes |

```python
h = await rlm("Review auth/", name="auth")
print(await h.wait())
await h.message("Only error handling this time")
print(await h.wait())

save_skill("double", "def double(x):\n    return x * 2\n", "multiply by two")
load_skill("double")
print(double(21))              # 42
```

## Known limits

- Spawn prefers `ctx.subagents.startContinuable`, then Code Mode `tools.subagent(backgroundMode=continuable)`. A one-shot `start()` child **cannot** be followed up.
- `followup` confirms delivery only; the body still comes from `wait()`. Depth-1 children only.
- Child agents keep native tools (read/grep/bash). Only the parent coordinator is Code Mode.
- Snapshot on `turn/end` is best-effort and does **not** restore a kernel after harness restart (skills do).
- Haystack is filled from `ctx["rlm.haystack"]`, `set_haystack` / `request.haystack`, or turn-start hooks.
- Kernel is not a sandbox; rely on DSH permission / sandbox policy.

This is not HELIX-style automatic skill extraction. State accumulates; skills are saved by the model.

## Layout

| Export | Role |
|---|---|
| `@seamlabs/dsh-rlm/runtime` | persistent kernel + `rlm.run` / `wait` / `followup` / skills |
| `@seamlabs/dsh-rlm/persona` | system prompt preamble |
| `@seamlabs/dsh-rlm/snapshot` | best-effort namespace snapshot |
| `@seamlabs/dsh-rlm/bindings` | no-op (shim talks JSONL host) |

```sh
node test-repl.mjs
node test-dsh-rlm-wait.mjs
node test-dsh-rlm-followup.mjs
```

Windows 9009: set `DSH_RLM_PYTHON` to `python.exe`. See [INSTALL.md](INSTALL.md).
