# @seamlabs/dsh-rlm

English | [中文](README.zh-CN.md)

Persistent **Recursive Language Model** runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Current release line: **v0.3.0** (non-blocking `rlm()` + haystack/`context`).

It replaces the per-turn worker-thread `codeRuntime` with a **long-lived Python kernel**, exposes non-blocking `await rlm()` (parallel fan-out + `wait()`), injects `context` from haystack, and keeps `save_skill` / `load_skill` on disk.

## Install

```sh
dsh plugin --profile web add github:mutsuki14/seam-rlm
# already installed:
dsh plugin --profile web update github:mutsuki14/seam-rlm
```

Requires Node 22+, Python 3 (`py -3` / `python` / `python3`, or `DSH_RLM_PYTHON`). Restart the profile after install.

The bundle patch (`cordis.patch.yml`) is a **top-level YAML array**: disables stock `code-runtime`, inserts `rlm-*` rows, sets `tools.mode: code`.

## What works (live-tested on DSH 0.1.1-rc.2)

| Capability | Status |
|---|---|
| Namespace persist across `run_code` (`n=41` → `n+1` → 42) | yes |
| Non-blocking `await rlm(...)` (`status=running` before wait) | yes (0.3) |
| Parallel fan-out then `wait()` (`AAA` / `BBB`) | yes (0.3) |
| `context` / haystack injection (`load_haystack`, `set_haystack`) | yes (0.3) |
| Nested `rlm()` inside a child (`maxDepth: 2`) | yes |
| Durable skills (`$DSH_HOME/rlm-skills/*.py`) | yes, survives process restart |
| `%%bash`, `Path.read_text()` via `tools.read` (`file_path`) | yes |
| SyntaxError / NameError, kernel stays up | yes |
| `return` rewrite of last expression | yes |

```python
# parallel fan-out
a = await rlm("left half", name="L")
b = await rlm("right half", name="R")
print(await a.wait(), await b.wait())

# context is a variable (seeded from haystack when set)
print(context.find("needle"))

save_skill("double", "def double(x):\n    return x * 2\n")
load_skill("double")
print(double(21))              # 42
```

## Known limits

- Background spawn prefers Code Mode `tools.subagent(run_in_background=True)`; if only `subagents.start` is available, wait uses `SubagentRun.result`.
- Child agents share the profile’s `tools.mode: code`; they are not a second copy of the plugin.
- Snapshot on `turn/end` is best-effort and does **not** restore a kernel after harness restart (skills do).
- Haystack is filled from `ctx["rlm.haystack"]`, `set_haystack` / `request.haystack`, or turn-start hooks when the host emits them.
- Kernel is not a sandbox; rely on DSH permission / sandbox policy.

## Layout

| Export | Role |
|---|---|
| `@seamlabs/dsh-rlm/runtime` | persistent kernel + `rlm.run` / `rlm.wait` / skills |
| `@seamlabs/dsh-rlm/persona` | system prompt preamble |
| `@seamlabs/dsh-rlm/snapshot` | best-effort namespace snapshot |
| `@seamlabs/dsh-rlm/bindings` | no-op (shim talks JSONL host, not a second spawn path) |

```sh
node test-repl.mjs
node test-dsh-rlm-wait.mjs
```

Windows 9009: set `DSH_RLM_PYTHON` to `python.exe`. See [INSTALL.md](INSTALL.md).
