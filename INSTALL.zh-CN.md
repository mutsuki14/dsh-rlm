# 挂到 DeepSeek Harness

[English](INSTALL.md) | 中文

`package.json` 声明了 `dsh.bundle.patch`。`dsh plugin add` 会把该文件叠成 **顶层 YAML 数组形态的 loader 补丁**，不是 `cordis.yml` 对象。插件入口必须是 **JavaScript**（Node 不会对 `node_modules` 里的 `.ts` 剥类型）。

```sh
dsh plugin --profile web add github:mutsuki14/dsh-rlm
```

已经装过旧版：

```sh
dsh plugin --profile web update github:mutsuki14/dsh-rlm
```

然后重启 profile。这一层会：

1. 禁用原装 `code-runtime`（worker-thread）。对已有 `id` 打补丁时，`name` 只是匹配守卫，不能拿来改名。
2. 插入 `rlm-runtime` / `rlm-bindings` / `rlm-persona` / `rlm-snapshot`
3. **不要**全局写 `tools.mode: code`（子代理会被收成只能 `run_code`，审代码会空转超时）。父协调器在 `agent.ctx` 上调用 `tools.presentAs("code")`。

家目录的 `cordis.patch.yml` 也别再写一遍 `tools.mode: code`。

```sh
node test-repl.mjs
```

Windows：kernel 依次尝试 `py -3`、`python`、`python3`。若仍是退出码 9009：

```bat
set DSH_RLM_PYTHON=C:\Path\To\python.exe
```

重启 profile。技能文件在 `%USERPROFILE%\.dsh\rlm-skills\`。
