# @seamlabs/dsh-rlm

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久化 **递归语言模型（RLM）** 运行时。

当前版本：**v0.3.0**（非阻塞 `rlm()` + haystack/`context`）。

它把默认「每次 `run_code` 新开 worker 线程」换成 **按会话常驻的 Python kernel**，暴露**非阻塞** `await rlm()`（可并行 fan-out 再 `wait()`），注入 `context`/haystack，并把 `save_skill` / `load_skill` 落到磁盘。

## 安装

```sh
dsh plugin --profile web add github:mutsuki14/seam-rlm
# 已经装过：
dsh plugin --profile web update github:mutsuki14/seam-rlm
```

需要 Node 22+、Python 3（Windows 会依次找 `py -3` / `python` / `python3`，也可设 `DSH_RLM_PYTHON`）。装完请 **重启 profile**。

bundle 补丁 [`cordis.patch.yml`](cordis.patch.yml) 必须是 **顶层 YAML 数组**：禁用原装 `code-runtime`、插入 `rlm-*` 行、设置 `tools.mode: code`。细节见 [INSTALL.md](INSTALL.md) / [INSTALL.zh-CN.md](INSTALL.zh-CN.md)。

## 已验证（DSH 0.1.1-rc.2 实测）

| 能力 | 状态 |
|---|---|
| `run_code` 跨格命名空间（`n=41` → `n+1` → 42） | 通过 |
| 非阻塞 `await rlm(...)`（返回时 `status=running`） | 通过（0.3） |
| 并行 fan-out 再 `wait()`（`AAA` / `BBB`） | 通过（0.3） |
| `context` / haystack 注入 | 通过（0.3） |
| 子代理里再 `rlm()`（`maxDepth: 2`） | 通过 |
| 技能落盘（`$DSH_HOME/rlm-skills/*.py`） | 通过，重启进程仍在 |
| `%%bash`、`Path.read_text()`（走 `tools.read` 的 `file_path`） | 通过 |
| `SyntaxError` / `NameError` 后 kernel 仍可用 | 通过 |
| 末行 `return` 改写 | 通过 |

```python
# 并行扇出
a = await rlm("左半", name="L")
b = await rlm("右半", name="R")
print(await a.wait(), await b.wait())

# context 是变量（有 haystack 时自动注入）
print(context.find("needle"))

save_skill("double", "def double(x):\n    return x * 2\n")
load_skill("double")
print(double(21))              # 42
```

Windows 技能目录：`%USERPROFILE%\.dsh\rlm-skills\`。

## 已知限制

- 优先走 Code Mode `tools.subagent(run_in_background=True)`；若只有 `subagents.start`，则用 `SubagentRun.result` 等待。
- 子代理共用 profile 的 `tools.mode: code`，不是再装一份插件。
- `turn/end` 时的 snapshot 是尽力而为，**重启 harness 后不会还原 kernel**（技能文件会保留）。
- Haystack 来源：`ctx["rlm.haystack"]`、`set_haystack` / `request.haystack`，或 turn-start 钩子（宿主若发出对应事件）。
- kernel 本身不是沙箱，权限走 DSH 的 permission / sandbox。

这不是 HELIX 那种「自动从轨迹抽技能、自我进化」；它是可编程的递归 harness：状态会积累，技能可手写保存。

## 结构

| 导出 | 作用 |
|---|---|
| `@seamlabs/dsh-rlm/runtime` | 常驻 kernel + `rlm.run` / `rlm.wait` / 技能 |
| `@seamlabs/dsh-rlm/persona` | 系统提示前导 |
| `@seamlabs/dsh-rlm/snapshot` | 尽力而为的命名空间快照 |
| `@seamlabs/dsh-rlm/bindings` | 空操作（shim 走 JSONL host，不再走第二条 spawn） |

```sh
node test-repl.mjs
node test-dsh-rlm-wait.mjs
```

Windows 若 kernel 退出码 **9009**（找不到 `python3`）：

```bat
set DSH_RLM_PYTHON=C:\Path\To\python.exe
```

然后重启 profile。

## 发布页

- Release 线：v0.3.0（见 main）；首发标签 [v0.2.0](https://github.com/mutsuki14/seam-rlm/releases/tag/v0.2.0)
- 仓库：<https://github.com/mutsuki14/seam-rlm>
