# 挂到 DeepSeek Harness

[English](INSTALL.md) | 中文

`package.json` 声明了 `dsh.bundle.patch`。`dsh plugin add` 会把该文件叠成 **顶层 YAML 数组形态的 loader 补丁**，不是 `cordis.yml` 对象。插件入口必须是 **JavaScript**（Node 不会对 `node_modules` 里的 `.ts` 剥类型）。

```sh
dsh plugin --profile web add github:mutsuki14/seam-rlm
```

已经装过旧版：

```sh
dsh plugin --profile web update github:mutsuki14/seam-rlm
```

然后重启 profile。这一层会：

1. 禁用原装 `code-runtime`（worker-thread）。对已有 `id` 打补丁时，`name` 只是匹配守卫，不能拿来改名。
2. 插入 `rlm-runtime` / `rlm-bindings` / `rlm-persona` / `rlm-snapshot`
3. 重写 `tools.mode: code`（补丁会替换该行的整个 `config`）

之后若家目录的 `cordis.patch.yml` 再写一次 `tools`，会覆盖这里的 `mode`。把本 bundle 放最后，或在家目录层再写一遍 `mode: code`。

```sh
node test-repl.mjs
```

Windows：kernel 依次尝试 `py -3`、`python`、`python3`。若仍是退出码 9009：

```bat
set DSH_RLM_PYTHON=C:\Path\To\python.exe
```

重启 profile。技能文件在 `%USERPROFILE%\.dsh\rlm-skills\`。
