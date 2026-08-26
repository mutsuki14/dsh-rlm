# Mount into DeepSeek Harness

`package.json` declares `dsh.bundle.patch`. `dsh plugin add` stacks that file as a **top-level YAML array of loader patch entries** — not a `cordis.yml` object. Plugin entries are **JavaScript** (Node will not strip types under `node_modules`).

```sh
dsh plugin --profile web add github:mutsuki14/seam-rlm
```

If an older copy is already installed:

```sh
dsh plugin --profile web update github:mutsuki14/seam-rlm
```

Then restart the profile. The layer:

1. disables the stock `code-runtime` worker-thread row (id-targeted `name` cannot rename a row)
2. inserts `rlm-runtime` / `rlm-bindings` / `rlm-persona` / `rlm-snapshot`
3. restates `tools.mode: code` (a patch replaces the whole `config`)

A later home-level `cordis.patch.yml` that writes `tools` again will overwrite this. Put this bundle last, or restate `mode: code` in the home layer.

```sh
node test-repl.mjs
```

Windows: the kernel looks for `py -3`, then `python`, then `python3`. If spawn still fails with exit 9009, set:

```sh
set DSH_RLM_PYTHON=C:\Path\To\python.exe
```

and restart the profile.
