"""The field AI boxes (ESP32-S3 + STM32) for the pane's ``/field`` sheet and its device tabs, read only.

- ``plugin.hermes-tern.field.devices`` ``{}`` answers ``{"host", "transport", "platform", "devices": [...]}``: each
  provisioned box (id, name, kind), its Telegram DM topic, and what the gateway's ``fieldai`` platform last
  heard from it (online, last seen, Wi-Fi, firmware). No device I/O: the platform adapter's own heartbeat
  bookkeeping, when that adapter runs in this gateway.
- ``plugin.hermes-tern.field.status`` ``{"device"}`` answers ``{"device", "transport", "reads", "errors",
  "elapsed_ms"}``: one READ-ONLY status query of one box over the transport the ``field_ai`` MCP server uses
  (the public MQTT broker with AES-GCM envelopes, or the USB cable when that server runs with
  ``FIELD_AI_TRANSPORT=usb``), under a hard timeout, on a worker thread.
- ``plugin.hermes-tern.field.session`` ``{"device", "current"?}`` answers ``{"id", "name", "thread_id",
  "session_key", "session_id", "rotated", "ended_reason", "online", "last_seen", ...}``: the open session of the
  box's Telegram DM topic (the newest row of that chat and thread in state.db without ``ended_at``), which a
  device tab (``hermes tern --device``) shows and follows. ``rotated``: the topic moved on from ``current`` (a
  ``session_reset``), not merely compressed it. state.db is opened read-only.

The box code is the user's field-ai-box checkout, read through ``shared/field_boxes.py``: its ``host/`` folder is
the one config.yaml's ``mcp_servers.field_ai.args`` names, and its modules are imported from there. Only the commands in ``READS``
(and the arm box's status read) ever reach a box: never RF transmit/config/mode, the OLED, the arm's motion,
torque, limits or poses, tasks, firmware pushes or provisioning.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Callable, Optional

from ..shared.field_boxes import boxes, host_dir, host_module, registry, topic_session, topics
from . import messaging

logger = logging.getLogger(__name__)

DEVICES_METHOD = "field.devices"
STATUS_METHOD = "field.status"
SESSION_METHOD = "field.session"
PLATFORM = "fieldai"
# The only box commands this module sends: (what the answer is filed under, the command). All read state.
READS = (("esp", "STATUS"), ("stm32", "STM STATUS"), ("rf", "STM RF STATUS"))
ARM_LABEL = "field-arm"
# Seconds: one command's answer, and the whole query (the RPC answers by then whatever the box does).
COMMAND_TIMEOUT_S = 6.0
QUERY_TIMEOUT_S = 25.0
# Seconds the RPC waits past the query's own timeout for the worker to give its answer.
GRACE_S = 2.0
_DEVICE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

# Guards the pool and the in-flight map; reentrant, as status() makes the pool while it holds it.
_pool_lock = threading.RLock()
_pool: Optional[ThreadPoolExecutor] = None
# (Host folder, transport, device) -> query in flight, never shared across profiles' registries.
_inflight: dict[tuple[str, str, str], Future] = {}


def _executor() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="hermes-tern-field")
        return _pool


def transport(config: dict[str, Any]) -> str:
    """``usb`` or ``cloud``, as the ``field_ai`` MCP server reads its environment (cloud by default)."""
    server = (config.get("mcp_servers") or {}).get("field_ai") if isinstance(config.get("mcp_servers"), dict) else None
    env = server.get("env") if isinstance(server, dict) else None
    value = env.get("FIELD_AI_TRANSPORT") if isinstance(env, dict) else None
    return "usb" if isinstance(value, str) and value.lower() == "usb" else "cloud"


def _adapter(home: Path) -> Any:
    """This profile's running ``fieldai`` adapter, if any (never another served profile's)."""
    runner = getattr(sys.modules.get("gateway.run_api"), "_ACTIVE_RUNNER", None)
    adapters = getattr(runner, "adapters", None)
    authorities = getattr(runner, "session_authorities", None)
    if authorities is not None:
        authority = authorities.for_home(home)
        if authority is None:
            return None
        profile = authorities.profile_name(authority)
        if profile:
            adapters = getattr(runner, "_profile_adapters", {}).get(profile)
    for adapter in list(adapters.values()) if isinstance(adapters, dict) else ():
        if getattr(getattr(adapter, "platform", None), "value", None) == PLATFORM:
            return adapter
    return None


def heard(adapter: Any, dev: str) -> dict[str, Any]:
    """What the platform last heard from ``dev``: online, last_seen (epoch s), and the heartbeat's Wi-Fi and firmware."""
    if adapter is None:
        return {"online": None, "last_seen": None}
    online = getattr(adapter, "online", {})
    seen = getattr(getattr(adapter, "cloud", None), "last_seen", {})
    info = getattr(adapter, "info", {}).get(dev) or {}
    out = {"online": online.get(dev) if isinstance(online, dict) else None,
           "last_seen": seen.get(dev) if isinstance(seen, dict) else None}
    out.update({k: info.get(k) for k in ("fw", "ssid", "rssi", "ip") if info.get(k) is not None})
    return out


def _platform_row(home: Path) -> Optional[dict[str, Any]]:
    _, snapshot = messaging.runtime_state(home)
    return next((r for r in messaging.platform_rows(snapshot) if r["name"] == PLATFORM and not r["profile"]), None)


def devices(_params: dict, **_: Any) -> dict[str, Any]:
    home = messaging.hermes_home()
    config = messaging.read_config(home)
    host = host_dir(config)
    if host is None:
        raise ValueError("config.yaml has no mcp_servers.field_ai server script; the field-ai-box host folder is unknown")
    adapter, by_topic = _adapter(home), topics(host, config)
    rows = [{"id": dev, "name": meta["name"], "kind": meta["label"], "topic": by_topic.get(dev), **heard(adapter, dev)}
            for dev, meta in registry(host).items()]
    return {"host": str(host), "transport": transport(config), "platform": _platform_row(home),
            "adapter": adapter is not None, "devices": rows}


async def _cloud_reads(fc: Any, dev: str, label: str, host: Path) -> tuple[dict[str, Any], dict[str, str]]:
    """The READS of ``dev`` over the broker, in one connection; the first unanswered one ends it (offline)."""
    reads: dict[str, Any] = {}
    errors: dict[str, str] = {}
    if label == ARM_LABEL:
        fa = host_module(host, "field_arm")
        async with fa.arm_link(dev) as (link, arm):
            reads["arm"] = await fa.status(link, arm, timeout=COMMAND_TIMEOUT_S, retries=1)
        return reads, errors
    cloud = fc.FieldCloud(client_tag="tern")
    await cloud.connect()
    try:
        for key, command in READS:
            try:
                reads[key] = await cloud.cmd(dev, command, timeout=COMMAND_TIMEOUT_S)
            except TimeoutError as exc:
                errors[key] = str(exc)
                break
            except Exception as exc:
                errors[key] = f"{type(exc).__name__}: {exc}"
    finally:
        await cloud.close()
    return reads, errors


def _usb_reads(host: Path, dev: str) -> tuple[dict[str, Any], dict[str, str]]:
    """The READS over the USB cable (``FIELD_AI_PORT``, as the MCP server's ``field_ai_link``). The cable reaches
    whichever box is plugged in, so an ESP answer naming another device id is reported, not filed as ``dev``'s."""
    link = host_module(host, "field_ai_link")
    reads: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for key, command in READS:
        try:
            reads[key] = link._exchange(command, "rf" if key == "rf" else "status", timeout=COMMAND_TIMEOUT_S)
        except Exception as exc:
            errors[key] = f"{type(exc).__name__}: {exc}"
            if isinstance(exc, TimeoutError):
                break
    plugged = reads.get("esp", {}).get("device_id") if isinstance(reads.get("esp"), dict) else None
    if plugged and plugged != dev:
        return {}, {"device": f"the box on the USB cable is {plugged}, not {dev}"}
    return reads, errors


def query(host: Path, dev: str, label: str, mode: str) -> dict[str, Any]:
    """One status query of ``dev`` (on the calling thread; ``status`` runs it on a worker under a timeout)."""
    started = time.monotonic()
    if mode == "usb":
        reads, errors = _usb_reads(host, dev)
    else:
        fc = host_module(host, "fieldai_cloud")
        reads, errors = asyncio.run(asyncio.wait_for(_cloud_reads(fc, dev, label, host), QUERY_TIMEOUT_S))
    return {"device": dev, "transport": mode, "reads": reads, "errors": errors,
            "elapsed_ms": round((time.monotonic() - started) * 1000)}


def status(params: dict, *, run: Callable[..., dict[str, Any]] = query, **_: Any) -> dict[str, Any]:
    dev = params.get("device")
    if not isinstance(dev, str) or not _DEVICE_ID.match(dev):
        raise ValueError("field.status needs the device id of a provisioned box")
    config = messaging.read_config(messaging.hermes_home())
    host = host_dir(config)
    if host is None:
        raise ValueError("config.yaml has no mcp_servers.field_ai server script; the field-ai-box host folder is unknown")
    boxes = registry(host)
    if dev not in boxes:
        raise ValueError(f"unknown device {dev}; provisioned: {', '.join(boxes) or 'none'}")
    mode = transport(config)
    key = (str(host.resolve()), mode, dev)
    with _pool_lock:
        future = _inflight.get(key)
        if future is None or future.done():
            future = _inflight[key] = _executor().submit(run, host, dev, boxes[dev]["label"], mode)
    try:
        return future.result(timeout=QUERY_TIMEOUT_S + GRACE_S)
    except FutureTimeout as exc:
        detail = str(exc) if future.done() and str(exc) else f"no answer within {QUERY_TIMEOUT_S:.0f}s"
        return {"device": dev, "transport": mode, "reads": {},
                "errors": {"query": detail}, "elapsed_ms": None}
    finally:
        with _pool_lock:
            if _inflight.get(key) is future and future.done():
                _inflight.pop(key, None)


def session(params: dict, **_: Any) -> dict[str, Any]:
    dev, current = params.get("device"), params.get("current")
    if not isinstance(dev, str) or not _DEVICE_ID.match(dev):
        raise ValueError("field.session needs the device id of a provisioned box")
    if current is not None and not isinstance(current, str):
        raise ValueError("field.session's current is a session id")
    home = messaging.hermes_home()
    rows = boxes(messaging.read_config(home))
    box = next((b for b in rows if b["id"] == dev), None)
    if box is None:
        raise ValueError(f"unknown device {dev}; provisioned: {', '.join(b['id'] for b in rows) or 'none'}")
    return {**topic_session(home, box, current or None), **heard(_adapter(home), dev)}


def register(ctx) -> None:
    ctx.register_rpc(DEVICES_METHOD, devices)
    ctx.register_rpc(STATUS_METHOD, status)
    ctx.register_rpc(SESSION_METHOD, session)
