# @seamlabs/dsh-rlm

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久化 **递归语言模型（RLM）** 运行时。

当前版本：**v0.2.0**（第一版正式 release）。

它把默认「每次 `run_code` 新开 worker 线程」换成 **按会话常驻的 Python kernel**，在 kernel 里暴露 `await rlm()`，并把 `save_skill` / `load_skill` 落到磁盘。

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
| `await rlm(...)` + `handle.wait()` / `handle.result` | 通过 |
| 子代理里再 `rlm()`（`maxDepth: 2`） | 通过 |
| 顺序多个子代理（`AAA` 再 `BBB`） | 通过 |
| 技能落盘（`$DSH_HOME/rlm-skills/*.py`） | 通过，重启进程仍在 |
| `%%bash`、`Path.read_text()`（走 `tools.read` 的 `file_path`） | 通过 |
| `SyntaxError` / `NameError` 后 kernel 仍可用 | 通过 |
| 末行 `return` 改写 | 通过 |

```python
n = 41
h = await rlm("Reply with exactly PONG", name="ping")
print(await h.wait())          # PONG

save_skill("double", "def double(x):\n    return x * 2\n")
load_skill("double")
print(double(21))              # 42
```

Windows 技能目录：`%USERPROFILE%\.dsh\rlm-skills\`。

## 已知限制

- `rlm()` **会等子代理结束**（Code Mode 的 `tools.subagent` 前台调用），否则嵌套 `run_code` 会死锁。同一格里扇出多个 `rlm()` 因此是顺序的，不是真正并行。
- 子代理共用 profile 的 `tools.mode: code`，不是再装一份插件。
- `turn/end` 时的 snapshot 是尽力而为，**重启 harness 后不会还原 kernel**（技能文件会保留）。
- 除非宿主写入 `ctx` 键 `rlm.haystack`，否则 `load_haystack()` 为空。
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

- Release：[v0.2.0](https://github.com/mutsuki14/seam-rlm/releases/tag/v0.2.0)
- 仓库：<https://github.com/mutsuki14/seam-rlm>
