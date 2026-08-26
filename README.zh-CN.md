# @seamlabs/dsh-rlm

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久化 **递归语言模型（RLM）** 运行时。

当前版本：**v0.4.16**（`wait(timeout_ms=)` 与 `subagent/end` 竞速，闲逛的子代理拖不住父格）。

它把默认「每次 `run_code` 新开 worker 线程」换成 **按会话常驻的 Python kernel**，暴露**非阻塞** `await rlm()`（可并行 fan-out 再 `wait()`），用 `handle.message()` 对**同一个 child** 再推一轮，注入 `context`/haystack，并把技能写成 kebab-case 包（`SKILL.md` + `__init__.py`）。

## 安装

```sh
dsh plugin --profile web add github:mutsuki14/dsh-rlm
# 已经装过：
dsh plugin --profile web update github:mutsuki14/dsh-rlm
```

需要 Node 22+、Python 3（Windows 会依次找 `py -3` / `python` / `python3`，也可设 `DSH_RLM_PYTHON`）。装完请 **重启 profile**。

bundle 补丁 [`cordis.patch.yml`](cordis.patch.yml) 必须是 **顶层 YAML 数组**：禁用原装 `code-runtime`、插入 `rlm-*` 行。**不要**全局设置 `tools.mode: code`（会把子代理也收成只能 `run_code`）。细节见 [INSTALL.md](INSTALL.md) / [INSTALL.zh-CN.md](INSTALL.zh-CN.md)。

## 已验证

| 能力 | 状态 |
|---|---|
| `run_code` 跨格命名空间 | 通过 |
| 非阻塞 `await rlm(...)` | 通过 |
| 并行 fan-out 再 `wait()` | 通过 |
| **同一 child 续聊** `handle.message()` | 通过（0.4） |
| `list_subagents()` 保留 continuable child | 通过（0.4） |
| `context` / haystack 注入 | 通过 |
| 子代理里再 `rlm()`（`maxDepth: 2`） | 通过 |
| 技能包（`SKILL.md` + `__init__.py`） | 通过（0.4） |
| compact 压对话、**不压 kernel** | 通过（0.4） |
| 同一 child 第二次 `wait()` 立刻返回 | 通过（0.4.1） |
| 并发 session 不串 parent | 通过（0.4.1） |

```python
h = await rlm("审 auth/", name="auth")
print(await h.wait())
await h.message("这次只看错误处理")
print(await h.wait())

save_skill("double", "def double(x):\n    return x * 2\n", "乘二")
load_skill("double")
print(double(21))              # 42
```

Windows 技能目录：`%USERPROFILE%\.dsh\rlm-skills\`，同时写一份到 `%USERPROFILE%\.dsh\skills\<name>\SKILL.md` 给 DSH catalog。

## 已知限制

- 优先 `ctx.subagents.startContinuable`，其次 `tools.subagent(backgroundMode=continuable)`。one-shot `start()` 的 child **不能**续聊。
- `followup` 只确认投递，正文仍靠 `wait()`。只允许 depth-1 直系 child。
- 子代理用原生 read/grep/bash；只有父协调器是 Code Mode。
- `turn/end` snapshot 是尽力而为，**重启 harness 后不会还原 kernel**（技能文件会保留）。
- kernel 本身不是沙箱，权限走 DSH。

这不是 HELIX 那种「自动从轨迹抽技能」；它是可编程的递归 harness：状态会积累，技能可手写保存。

```sh
node test-repl.mjs
node test-dsh-rlm-wait.mjs
node test-dsh-rlm-followup.mjs
```
