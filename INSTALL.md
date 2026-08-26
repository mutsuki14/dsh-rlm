# Mount into DeepSeek Harness

`package.json` declares `dsh.bundle.patch`. `dsh plugin add` stacks that file as a **top-level YAML array of loader patch entries** — not a `cordis.yml` object.

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
node --experimental-strip-types test-repl.mjs
```

Kernel is not a sandbox. Keep DSH's existing sandbox. `%%bash` / `tools.*` must host_request back into `tools/execute`.
