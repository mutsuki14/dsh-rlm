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

from rlm_shim import bind as shim_bind
from rlm_shim import host as shim_host
from rlm_shim import inject as shim_inject
from rlm_shim import inspect as shim_inspect
from rlm_shim import install as shim_install
from rlm_shim import snapshot as shim_snapshot

NS: dict[str, Any] = {"__name__": "__main__"}
_REAL_STDOUT = sys.stdout
_HOST_LOCK = threading.Lock()
_SURROGATES = {i: "\ufffd" for i in range(0xD800, 0xE000)}


def _clean_str(s: str) -> str:
    return s.translate(_SURROGATES)


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return _clean_str(value)
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, tuple):
        return [_clean(v) for v in value]
    if isinstance(value, dict):
        return {
            _clean_str(k) if isinstance(k, str) else k: _clean(v) for k, v in value.items()
        }
    return value


def _json(value: Any) -> str:
    return json.dumps(_clean(value), ensure_ascii=False)


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


def _run_cell(src: str) -> tuple[Any, list[str]]:
    stripped = src.lstrip()
    if stripped.startswith("%%bash"):
        script = stripped[6:].lstrip("\n")
        value = _host_request(
            "tools.dispatch",
            {"global": "tools", "name": "bash", "args": {"command": script}},
        )
        text = "" if value is None else str(value)
        return value, [text] if text else []
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
            # last already included in body
            pass
    logs = buf.getvalue().splitlines()
    return value, logs


def handle(msg: dict[str, Any]) -> dict[str, Any]:
    method = msg.get("method")
    params = msg.get("params") or {}
    mid = msg.get("id")
    try:
        if method == "ping":
            return {"type": "result", "id": mid, "logs": [], "value": "pong"}
        if method == "execute":
            value, logs = _run_cell(params.get("program") or "")
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
