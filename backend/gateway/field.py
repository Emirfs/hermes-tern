"""The field AI boxes (ESP32-S3 + STM32) for the pane's ``/field`` sheet, read only.

- ``plugin.hermes-tern.field.devices`` ``{}`` answers ``{"host", "transport", "platform", "devices": [...]}``: each
  provisioned box (id, name, kind), its Telegram DM topic, and what the gateway's ``fieldai`` platform last
  heard from it (online, last seen, Wi-Fi, firmware). No device I/O: the platform adapter's own heartbeat
  bookkeeping, when that adapter runs in this gateway.
- ``plugin.hermes-tern.field.status`` ``{"device"}`` answers ``{"device", "transport", "reads", "errors",
  "elapsed_ms"}``: one READ-ONLY status query of one box over the transport the ``field_ai`` MCP server uses
  (the public MQTT broker with AES-GCM envelopes, or the USB cable when that server runs with
  ``FIELD_AI_TRANSPORT=usb``), under a hard timeout, on a worker thread.

The box code is the user's field-ai-box checkout: its ``host/`` folder is the one config.yaml's
``mcp_servers.field_ai.args`` names, and its modules are imported from there. Only the commands in ``READS``
(and the arm box's status read) ever reach a box: never RF transmit/config/mode, the OLED, the arm's motion,
torque, limits or poses, tasks, firmware pushes or provisioning.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import re
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Callable, Optional

from . import messaging

logger = logging.getLogger(__name__)

DEVICES_METHOD = "field.devices"
STATUS_METHOD = "field.status"
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
_TOPIC_DEVICE = re.compile(r"·\s*(\S+)\s*$")

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


def host_dir(config: dict[str, Any]) -> Optional[Path]:
    """The field-ai-box ``host/`` folder: where config.yaml's ``field_ai`` MCP server script lives."""
    servers = config.get("mcp_servers")
    server = servers.get("field_ai") if isinstance(servers, dict) else None
    args = server.get("args") if isinstance(server, dict) else None
    for arg in args if isinstance(args, list) else ():
        if isinstance(arg, str) and arg.endswith(".py"):
            return Path(arg).parent
    return None


def transport(config: dict[str, Any]) -> str:
    """``usb`` or ``cloud``, as the ``field_ai`` MCP server reads its environment (cloud by default)."""
    server = (config.get("mcp_servers") or {}).get("field_ai") if isinstance(config.get("mcp_servers"), dict) else None
    env = server.get("env") if isinstance(server, dict) else None
    value = env.get("FIELD_AI_TRANSPORT") if isinstance(env, dict) else None
    return "usb" if isinstance(value, str) and value.lower() == "usb" else "cloud"


def host_module(host: Path, name: str):
    """Module ``name`` of the box code in ``host``: the one already imported from there (the fieldai platform
    loads ``fieldai_cloud``), else imported by path. ``host`` goes on sys.path, as the MCP server puts it, so
    the module's own plain imports (``import fieldai_proto``) resolve."""
    loaded = sys.modules.get(name)
    origin = getattr(loaded, "__file__", None)
    if loaded is not None and origin and Path(origin).resolve().parent == host.resolve():
        return loaded
    if str(host) not in sys.path:
        sys.path.insert(0, str(host))
    spec = importlib.util.spec_from_file_location(name, host / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"{name}.py not found in {host}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def registry(host: Path) -> dict[str, dict[str, str]]:
    """The provisioned boxes, ``{id: {"name", "label"}}``, from the devices.json fieldai_cloud reads. Keys stay out."""
    path = Path(host_module(host, "fieldai_cloud").DEFAULT_DEVICES)
    raw = messaging.read_json(path) or {}
    return {dev: {"name": str(info.get("name") or info.get("label") or dev), "label": str(info.get("label") or "")}
            for dev, info in raw.items() if isinstance(info, dict)}


def topics(host: Path, config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Each box's Telegram DM topic ``{id: {"thread_id", "name", "chat_id"?}}``: the topics file fieldai_topics
    writes, then config.yaml's dm_topics whose name ends with ``· <device id>``."""
    out: dict[str, dict[str, Any]] = {}
    try:
        for dev, t in host_module(host, "fieldai_topics").load_topics().items():
            if isinstance(t, dict) and t.get("thread_id") is not None:
                out[dev] = {"thread_id": t["thread_id"], "name": t.get("name")}
    except Exception as exc:
        logger.debug("field: no topics file: %s", exc)
    for t in messaging.topic_targets(config):
        _, chat, thread = t["target"].split(":", 2)
        if m := _TOPIC_DEVICE.search(t["name"]):
            entry = out.setdefault(m.group(1), {"thread_id": thread, "name": t["name"]})
            entry.setdefault("chat_id", chat)
            entry["target"] = f"telegram:{chat}:{entry['thread_id']}"
    return out


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


def register(ctx) -> None:
    ctx.register_rpc(DEVICES_METHOD, devices)
    ctx.register_rpc(STATUS_METHOD, status)
