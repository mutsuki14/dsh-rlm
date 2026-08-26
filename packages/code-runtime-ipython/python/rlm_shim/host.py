from __future__ import annotations

import asyncio
from typing import Any, Callable

_pending: dict[str, asyncio.Future] = {}
_transport: Callable[[str, dict[str, Any]], Any] | None = None


def set_transport(fn: Callable[[str, dict[str, Any]], Any] | None) -> None:
    """JSONL worker installs a blocking stdin/stdout transport."""
    global _transport
    _transport = fn


def host_request_sync(method: str, params: dict[str, Any]) -> Any:
    """Blocking host call. Safe from sync pathlib-style APIs and from asyncio.run."""
    if _transport is None:
        raise RuntimeError("rlm host transport is not installed")
    result = _transport(method, params)
    if asyncio.iscoroutine(result):
        raise RuntimeError("sync host transport returned a coroutine")
    return result


async def host_request(method: str, params: dict[str, Any]) -> Any:
    """Ask the TypeScript host. JSONL transport first; IPython comm fallback."""
    if _transport is not None:
        return host_request_sync(method, params)

    from ipykernel.comm import Comm

    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    comm = Comm(target_name="dsh.host")
    req_id = hex(id(fut))
    _pending[req_id] = fut

    def _on_msg(msg):
        data = msg["content"]["data"]
        pending = _pending.pop(data.get("id"), None)
        if pending and not pending.done():
            if "error" in data:
                pending.set_exception(RuntimeError(data["error"]))
            else:
                pending.set_result(data.get("result"))

    comm.on_msg(_on_msg)
    comm.send({"id": req_id, "method": method, "params": params})
    try:
        return await asyncio.wait_for(fut, timeout=120)
    finally:
        comm.close()
