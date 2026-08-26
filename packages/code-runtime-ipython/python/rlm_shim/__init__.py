"""Model-facing RLM shim. No agent loop, no provider calls."""
from __future__ import annotations

import importlib
import importlib.util
import json
import sys
from dataclasses import dataclass, fields
from typing import Any

from .host import host_request, host_request_sync

RLM_VERSION = "0.4.14"
_SURROGATES = {i: "\ufffd" for i in range(0xD800, 0xE000)}


def sanitize(value: Any) -> Any:
    """Replace unpaired UTF-16 surrogates. utf-8 encode(errors='replace') still throws on them."""
    if isinstance(value, str):
        return value.translate(_SURROGATES)
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, tuple):
        return [sanitize(v) for v in value]
    if isinstance(value, dict):
        return {
            sanitize(k) if isinstance(k, str) else k: sanitize(v) for k, v in value.items()
        }
    return value


def _from_payload(cls: type, payload: Any) -> Any:
    if not isinstance(payload, dict):
        raise TypeError(f"host returned {type(payload).__name__}, expected dict")
    allowed = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in payload.items() if k in allowed})


@dataclass
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: str = ""
    model: str = ""
    status: str = "running"
    result: Any = None
    mode: str = "continuable"

    async def peek(self) -> Any:
        payload = await host_request("rlm.peek", {"rlm_child_id": self.rlm_child_id})
        if isinstance(payload, dict):
            self.status = str(payload.get("status") or self.status)
            if payload.get("result") is not None:
                self.result = sanitize(payload.get("result"))
            return payload
        return sanitize(payload)

    async def wait(self, timeout: float | None = None) -> Any:
        params: dict[str, Any] = {"rlm_child_id": self.rlm_child_id}
        if timeout is not None:
            ms = float(timeout)
            if ms <= 10_000:
                ms *= 1000
            params["timeout_ms"] = int(ms)
        payload = await host_request("rlm.wait", params)
        if isinstance(payload, dict):
            self.status = str(payload.get("status") or "done")
            self.result = sanitize(payload.get("result"))
        else:
            self.status = "done"
            self.result = sanitize(payload)
        return self.result

    async def message(self, text: str) -> "RLMSpawnHandle":
        await host_request(
            "rlm.followup",
            {"rlm_child_id": self.rlm_child_id, "message": str(text)},
        )
        self.status = "running"
        return self

    async def interrupt(self) -> None:
        await host_request("rlm.interrupt", {"rlm_child_id": self.rlm_child_id})


def _ns(ns: dict[str, Any] | None) -> dict[str, Any]:
    if ns is not None:
        return ns
    ip = get_ipython()  # type: ignore[name-defined]
    return ip.user_ns


async def run(prompt: str, name: str | None = None, **kw: Any) -> RLMSpawnHandle:
    payload = await host_request("rlm.run", {"prompt": prompt, "name": name, **kw})
    return _from_payload(RLMSpawnHandle, payload)


async def list_subagents() -> list[RLMSpawnHandle]:
    rows = await host_request("rlm.list_subagents", {})
    return [_from_payload(RLMSpawnHandle, row) for row in (rows or [])]


async def delete_subagent(handle: RLMSpawnHandle | str) -> None:
    cid = handle if isinstance(handle, str) else handle.rlm_child_id
    await host_request("rlm.delete_subagent", {"rlm_child_id": cid})


class _Rlm:
    run = staticmethod(run)
    list_subagents = staticmethod(list_subagents)
    delete_subagent = staticmethod(delete_subagent)
    host_request = staticmethod(host_request)
    RLMSpawnHandle = RLMSpawnHandle

    async def __call__(self, prompt: str, name: str | None = None, **kw: Any):
        return await run(prompt, name=name, **kw)


rlm = _Rlm()


class Path:
    """pathlib-shaped facade. Bytes never leave the host tools pipeline."""

    def __init__(self, path: str):
        self.path = str(path)

    def read_text(self, encoding: str = "utf-8") -> str:
        out = host_request_sync(
            "tools.dispatch",
            {"global": "tools", "name": "read", "args": {"file_path": self.path}},
        )
        if isinstance(out, str):
            return out
        if isinstance(out, dict):
            lines = out.get("lines")
            if isinstance(lines, list):
                parts = []
                for ln in lines:
                    if isinstance(ln, dict) and isinstance(ln.get("text"), str):
                        parts.append(ln["text"])
                    elif isinstance(ln, str):
                        parts.append(ln)
                return "\n".join(parts)
            for k in ("content", "text", "output", "data"):
                if isinstance(out.get(k), str):
                    return out[k]
        return "" if out is None else str(out)

    def write_text(self, data: str, encoding: str = "utf-8") -> int:
        host_request_sync(
            "tools.dispatch",
            {
                "global": "tools",
                "name": "write",
                "args": {"file_path": self.path, "content": str(data)},
            },
        )
        return len(str(data))

    def exists(self) -> bool:
        try:
            self.read_text()
            return True
        except Exception:
            return False

    def __repr__(self) -> str:
        return f"Path({self.path!r})"


def load_haystack() -> str:
    return host_request_sync("rlm.load_haystack", {}) or ""


def set_haystack(text: str) -> None:
    host_request_sync("rlm.set_haystack", {"text": str(text)})


def save_skill(name: str, code: str, description: str | None = None) -> None:
    host_request_sync(
        "rlm.save_skill",
        {"name": name, "code": code, "description": description or ""},
    )


def chunk(s: Any, n: int) -> list[str]:
    text = str(s)
    size = int(n) or 1
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


def install(ns: dict[str, Any] | None = None) -> None:
    target = _ns(ns)

    def load_skill(name: str) -> str:
        payload = host_request_sync("rlm.load_skill", {"name": name}) or ""
        code = ""
        root = ""
        module = ""
        init = ""
        if isinstance(payload, dict):
            code = str(payload.get("code") or "")
            root = str(payload.get("root") or "")
            module = str(payload.get("module") or "")
            init = str(payload.get("init") or "")
        else:
            code = str(payload)
        if not code and not init and not root:
            raise RuntimeError(f"harness 里没有 {name}")
        if root and root not in sys.path:
            sys.path.insert(0, root)
        loaded = False
        if init:
            try:
                spec = importlib.util.spec_from_file_location(module or name.replace("-", "_"), init)
                if spec and spec.loader:
                    sys.modules.pop(spec.name, None)
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    for k, v in vars(mod).items():
                        if k.startswith("_"):
                            continue
                        target[k] = v
                    loaded = True
            except Exception:
                loaded = False
        if not loaded and module:
            try:
                sys.modules.pop(module, None)
                mod = importlib.import_module(module)
                for k, v in vars(mod).items():
                    if k.startswith("_"):
                        continue
                    target[k] = v
                loaded = True
            except Exception:
                loaded = False
        if not loaded and code:
            exec(compile(code, f"<skill:{name}>", "exec"), target)
        kebab = name.replace("_", "-")
        if isinstance(payload, dict) and payload.get("name"):
            kebab = str(payload.get("name"))
        return {
            "name": kebab,
            "code": code,
            "root": root,
            "module": module,
            "init": init,
        }

    def set_haystack(text: str) -> None:
        value = str(text)
        host_request_sync("rlm.set_haystack", {"text": value})
        target["context"] = value

    def list_skills() -> list[str]:
        rows = host_request_sync("rlm.list_skills", {}) or []
        return list(rows)

    target["rlm"] = rlm
    target["RLMSpawnHandle"] = RLMSpawnHandle
    target["Path"] = Path
    target["load_haystack"] = load_haystack
    target["set_haystack"] = set_haystack
    target["save_skill"] = save_skill
    target["load_skill"] = load_skill
    target["list_skills"] = list_skills
    target["chunk"] = chunk
    target["sanitize"] = sanitize
    target["__rlm_version__"] = RLM_VERSION
    _builtin_print = target.get("print", print)

    def _print(*args: Any, **kw: Any) -> None:
        _builtin_print(*tuple(sanitize(a) if isinstance(a, str) else a for a in args), **kw)

    target["print"] = _print
    target.setdefault("tools", _ToolsProxy("tools", ["bash", "pwsh", "read", "write"]))
    # Seed empty context; host injects haystack via injectNamespace / rlm.set_haystack.
    # Do NOT call load_haystack() here — install runs at kernel boot before the host loop.
    target.setdefault("context", "")
    _install_pathlib_guard()


def _install_pathlib_guard() -> None:
    """Route pathlib.Path read/write through the host sandbox (no raw open())."""
    import pathlib as _pl

    concrete = type(_pl.Path())
    if getattr(concrete, "_rlm_guarded", False):
        return
    facade = Path

    class RlmPath(concrete):  # type: ignore[misc,valid-type]
        def read_text(self, encoding: str = "utf-8", errors: str | None = None) -> str:  # type: ignore[override]
            return facade(str(self)).read_text(encoding=encoding or "utf-8")

        def write_text(  # type: ignore[override]
            self,
            data: str,
            encoding: str = "utf-8",
            errors: str | None = None,
            newline: str | None = None,
        ) -> int:
            return facade(str(self)).write_text(str(data), encoding=encoding or "utf-8")

        def open(self, mode: str = "r", *args: Any, **kwargs: Any):  # type: ignore[override]
            writing = any(ch in str(mode) for ch in "wax+")
            if writing:
                raise RuntimeError(
                    "RLM: pathlib.Path.open() writes are blocked; use write_text() so the host sandbox sees them"
                )
            from io import StringIO

            return StringIO(facade(str(self)).read_text())

    RlmPath._rlm_guarded = True  # type: ignore[attr-defined]
    _pl.Path = RlmPath  # type: ignore[misc,assignment]
    setattr(_pl, concrete.__name__, RlmPath)


def bind(spec_json: Any, ns: dict[str, Any] | None = None) -> None:
    spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
    target = _ns(ns)
    reserved = {
        "rlm",
        "Path",
        "RLMSpawnHandle",
        "load_haystack",
        "set_haystack",
        "save_skill",
        "load_skill",
        "list_skills",
        "chunk",
        "sanitize",
        "print",
    }
    for item in spec:
        global_name = item.get("global")
        if global_name in reserved:
            continue
        proxy = _ToolsProxy(global_name, item["names"])
        target[global_name] = proxy


def snapshot(ns: dict[str, Any] | None = None) -> dict[str, str]:
    target = _ns(ns)
    skip = _SKIP
    out: dict[str, str] = {}
    for k, v in target.items():
        if k.startswith("_") or k in skip:
            continue
        out[k] = f"{type(v).__name__}:{_brief(v)}"
    return out


_SKIP = {
    "In",
    "Out",
    "exit",
    "quit",
    "get_ipython",
    "__name__",
    "__builtins__",
    "rlm",
    "RLMSpawnHandle",
    "Path",
    "load_haystack",
    "set_haystack",
    "save_skill",
    "load_skill",
    "list_skills",
    "chunk",
    "sanitize",
    "print",
    "tools",
}


def inspect(ns: dict[str, Any] | None = None) -> dict[str, Any]:
    target = _ns(ns)
    out: dict[str, Any] = {}
    for k, v in target.items():
        if k.startswith("_") or k in _SKIP:
            continue
        if isinstance(v, Path):
            out[k] = {"__type": "path", "path": v.path}
            continue
        if isinstance(v, RLMSpawnHandle):
            out[k] = {
                "__type": "rlm_handle",
                "id": v.rlm_child_id,
                "name": v.name,
                "status": v.status,
                "result": v.result,
                "mode": v.mode,
            }
            continue
        if callable(v) and not isinstance(v, type):
            continue
        try:
            json.dumps(v)
            out[k] = v
        except TypeError:
            out[k] = {"__type": "opaque", "pytype": type(v).__name__, "repr": _brief(v)}
    return out


def inject(values: dict[str, Any], ns: dict[str, Any] | None = None) -> None:
    target = _ns(ns)
    for k, v in (values or {}).items():
        if k in _SKIP or k.startswith("_"):
            continue
        if isinstance(v, dict) and v.get("__type") == "path":
            target[k] = Path(str(v.get("path") or ""))
        elif isinstance(v, dict) and v.get("__type") == "rlm_handle":
            target[k] = RLMSpawnHandle(
                rlm_child_id=str(v.get("id") or v.get("rlm_child_id") or k),
                name=str(v.get("name") or k),
                status=str(v.get("status") or "done"),
                result=v.get("result"),
                mode=str(v.get("mode") or "continuable"),
            )
        elif isinstance(v, dict) and v.get("__type") == "opaque":
            continue
        else:
            target[k] = v


def _brief(v: Any, n: int = 80) -> str:
    s = repr(v)
    return s if len(s) <= n else s[: n - 1] + "…"


class _ToolsProxy:
    def __init__(self, global_name: str, names: list[str]):
        self._global = global_name
        for name in names:
            setattr(self, name, _BoundTool(global_name, name))
        if not hasattr(self, "bash"):
            setattr(self, "bash", _BoundTool(global_name, "bash"))
        if not hasattr(self, "pwsh"):
            setattr(self, "pwsh", _BoundTool(global_name, "pwsh"))


class _BoundTool:
    def __init__(self, global_name: str, name: str):
        self._global = global_name
        self._name = name

    async def __call__(self, args: Any = None, **kw: Any):
        payload = args if args is not None else kw
        if isinstance(payload, str) and self._name in ("bash", "pwsh", "shell"):
            payload = {"command": payload, "description": payload[:80] or self._name}
        try:
            return await host_request(
                "tools.dispatch",
                {"global": self._global, "name": self._name, "args": payload},
            )
        except RuntimeError:
            if self._name == "bash":
                return await host_request(
                    "tools.dispatch",
                    {"global": self._global, "name": "pwsh", "args": payload},
                )
            raise
