"""Persistent JSONL Python kernel.

stdin/stdout are newline-delimited JSON. Namespace survives across execute
calls in this process — this is the Layer 1 RLM invariant without ZeroMQ.

Protocol:
  → {"id","method":"execute"|"snapshot"|"bind"|"ping"|"shutdown","params"?}
  ← {"type":"result","id","logs","value","error"?}
  ← {"type":"host","id","method","params"}   # kernel → TypeScript host
  → {"type":"host_result","id","result"|"error"}
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import inspect
import io
import json
import sys
import threading
import traceback
from typing import Any

from rlm_shim import RLM_VERSION
from rlm_shim import bind as shim_bind
from rlm_shim import host as shim_host
from rlm_shim import inject as shim_inject
from rlm_shim import inspect as shim_inspect
from rlm_shim import install as shim_install
from rlm_shim import sanitize as _clean
from rlm_shim import snapshot as shim_snapshot

NS: dict[str, Any] = {"__name__": "__main__"}
_ORIG_DUMPS = json.dumps
_RAW_STDOUT = sys.stdout
_RAW_STDERR = sys.stderr


class _SafeText:
    """stdout/stderr that never utf-8-encodes lone surrogates (Python raises even with errors='replace')."""

    def __init__(self, inner: Any):
        self._inner = inner

    def write(self, data: Any) -> int:
        if isinstance(data, bytes):
            data = data.decode("utf-8", "replace")
        if isinstance(data, str):
            data = _clean(data)
        return self._inner.write(data)

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        return self._inner.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _safe_dumps(obj: Any, *args: Any, **kwargs: Any) -> str:
    return _ORIG_DUMPS(_clean(obj), *args, **kwargs)


json.dumps = _safe_dumps  # type: ignore[assignment]
_REAL_STDOUT = _SafeText(_RAW_STDOUT)
sys.stdout = _REAL_STDOUT
sys.stderr = _SafeText(_RAW_STDERR)
_HOST_LOCK = threading.Lock()


def _clean_str(s: str) -> str:
    return _clean(s) if isinstance(s, str) else s


def _json(value: Any) -> str:
    cleaned = _clean(value)
    try:
        return _ORIG_DUMPS(cleaned, ensure_ascii=False)
    except (UnicodeEncodeError, ValueError, TypeError):
        return _ORIG_DUMPS(cleaned, ensure_ascii=True, default=lambda o: str(type(o).__name__))


def _dump(value: Any) -> Any:
    cleaned = _clean(value)
    try:
        json.dumps(cleaned)
        return cleaned
    except TypeError:
        return _clean_str(repr(value))


def _host_request(method: str, params: dict[str, Any]) -> Any:
    req_id = f"h{id(params)}-{method}"
    with _HOST_LOCK:
        _REAL_STDOUT.write(
            _json({"type": "host", "id": req_id, "method": method, "params": params}) + "\n"
        )
        _REAL_STDOUT.flush()
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("host closed")
        msg = json.loads(line)
        if msg.get("error"):
            raise RuntimeError(_clean_str(str(msg["error"])))
        return _clean(msg.get("result"))


shim_host.set_transport(_host_request)
shim_install(NS)


class _TopReturn(ast.NodeTransformer):
    """Module-level `return x` (legal in the lab) becomes an expression so CPython can eval it."""

    def visit_FunctionDef(self, node: ast.AST) -> ast.AST:
        return node

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_ClassDef = visit_FunctionDef

    def visit_Return(self, node: ast.Return) -> ast.AST:
        val = node.value if node.value is not None else ast.Constant(value=None)
        return ast.Expr(value=val)


_SHELL_MAGICS = {"%%bash": "bash", "%%sh": "bash", "%%pwsh": "pwsh"}


def _run_bash(script: str, tool: str = "bash") -> Any:
    args = {"command": script, "description": f"%{tool}"}
    try:
        return _host_request(
            "tools.dispatch",
            {"global": "tools", "name": tool, "args": args},
        )
    except RuntimeError:
        fallback = "pwsh" if tool != "pwsh" else "bash"
        return _host_request(
            "tools.dispatch",
            {"global": "tools", "name": fallback, "args": args},
        )


def _split_bash_magic(src: str) -> tuple[str, str | None, str]:
    lines = src.splitlines(keepends=True)
    for i, line in enumerate(lines):
        key = line.strip().lower()
        if key in _SHELL_MAGICS:
            return "".join(lines[:i]), "".join(lines[i + 1 :]), _SHELL_MAGICS[key]
    return src, None, "bash"


def _run_python(src: str) -> tuple[Any, list[str]]:
    tree = ast.parse(src)
    tree = _TopReturn().visit(tree)
    ast.fix_missing_locations(tree)
    if not tree.body:
        return None, []
    buf = io.StringIO()
    last = tree.body[-1]
    body = tree.body[:-1] if isinstance(last, ast.Expr) else tree.body
    flags = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0)

    def _run(codeobj: Any) -> Any:
        value = eval(codeobj, NS)
        if inspect.iscoroutine(value):
            return asyncio.run(value)
        return value

    with contextlib.redirect_stdout(buf):
        if body:
            _run(compile(ast.Module(body, type_ignores=[]), "<cell>", "exec", flags=flags))
        value = None
        if isinstance(last, ast.Expr):
            value = _run(compile(ast.Expression(last.value), "<cell>", "eval", flags=flags))
        elif not body:
            _run(compile(ast.Module([last], type_ignores=[]), "<cell>", "exec", flags=flags))
        elif not isinstance(last, ast.Expr):
            pass
    logs = [_clean_str(line) for line in buf.getvalue().splitlines()]
    return _clean(value), logs


def _run_cell(src: str) -> tuple[Any, list[str]]:
    pre, bash, tool = _split_bash_magic(src)
    logs: list[str] = []
    value: Any = None
    if pre.strip():
        value, logs = _run_python(pre)
    if bash is not None:
        raw = _run_bash(bash, tool)
        text = "" if raw is None else str(raw)
        if text:
            logs = [*logs, _clean_str(text)]
        return _clean(raw) if pre.strip() == "" else value, logs
    if pre.strip():
        return value, logs
    return None, []


def handle(msg: dict[str, Any]) -> dict[str, Any]:
    method = msg.get("method")
    params = msg.get("params") or {}
    mid = msg.get("id")
    try:
        if method == "ping":
            return {"type": "result", "id": mid, "logs": [], "value": "pong"}
        if method == "execute":
            value, logs = _run_cell(params.get("program") or "")
            logs = [f"rlm {RLM_VERSION}", *logs]
            return {"type": "result", "id": mid, "logs": logs, "value": _dump(value)}
        if method == "snapshot":
            return {"type": "result", "id": mid, "logs": [], "value": shim_snapshot(NS)}
        if method == "inspect":
            return {"type": "result", "id": mid, "logs": [], "value": shim_inspect(NS)}
        if method == "inject":
            shim_inject(params.get("values") or {}, NS)
            return {"type": "result", "id": mid, "logs": [], "value": True}
        if method == "bind":
            shim_bind(params.get("spec") or [], NS)
            return {"type": "result", "id": mid, "logs": [], "value": True}
        if method == "shutdown":
            return {"type": "result", "id": mid, "logs": [], "value": True}
        return {
            "type": "result",
            "id": mid,
            "logs": [],
            "error": {"kind": "UnknownMethod", "message": str(method)},
        }
    except Exception as exc:
        return {
            "type": "result",
            "id": mid,
            "logs": [],
            "error": {"kind": type(exc).__name__, "message": str(exc), "trace": traceback.format_exc()},
        }


def main() -> None:
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        out = handle(msg)
        _REAL_STDOUT.write(_json(out) + "\n")
        _REAL_STDOUT.flush()
        if msg.get("method") == "shutdown":
            break


if __name__ == "__main__":
    main()
