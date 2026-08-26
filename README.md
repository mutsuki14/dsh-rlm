# @seamlabs/dsh-rlm

English | [中文](README.zh-CN.md)

Persistent **Recursive Language Model** runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

First release: **v0.2.0**.

It replaces the per-turn worker-thread `codeRuntime` with a **long-lived Python kernel**, exposes `await rlm()` from that kernel, and keeps `save_skill` / `load_skill` on disk.

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
| `await rlm(...)` + `handle.wait()` / `handle.result` | yes |
| Nested `rlm()` inside a child (`maxDepth: 2`) | yes |
| Sequential children (`AAA` then `BBB`) | yes |
| Durable skills (`$DSH_HOME/rlm-skills/*.py`) | yes, survives process restart |
| `%%bash`, `Path.read_text()` via `tools.read` (`file_path`) | yes |
| SyntaxError / NameError, kernel stays up | yes |
| `return` rewrite of last expression | yes |

```python
n = 41
h = await rlm("Reply with exactly PONG", name="ping")
print(await h.wait())          # PONG

save_skill("double", "def double(x):\n    return x * 2\n")
load_skill("double")
print(double(21))              # 42
```

## Known limits

- `rlm()` **waits for the child** (Code Mode `tools.subagent` foreground) so nested `run_code` does not deadlock. Parallel fan-out in one cell is therefore sequential.
- Child agents share the profile’s `tools.mode: code`; they are not a second copy of the plugin.
- Snapshot on `turn/end` is best-effort and does **not** restore a kernel after harness restart (skills do).
- `load_haystack()` is empty unless the host sets `ctx` key `rlm.haystack`.
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
