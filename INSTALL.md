# Mount into DeepSeek Harness

One bundle. The package.json `dsh.bundle.patch` field is what `dsh plugin add` looks for.

```sh
# new profile
dsh plugin --profile rlm add @deepseek-ai/dsh-base
dsh plugin --profile rlm add github:mutsuki14/seam-rlm

# or overlay an existing profile
dsh --profile web --patch ./cordis.patch.yml
```

The patch replaces the `code-runtime` row (`id: code-runtime`) with the persistent JSONL kernel and turns `tools.mode` to `code`. Later layers win per row — if a home-level patch resets `tools.mode`, put this overlay last.

```sh
node --experimental-strip-types test-repl.mjs
```

Kernel is not a sandbox. Keep DSH's existing sandbox. `%%bash` / `tools.*` must host_request back into `tools/execute`.
