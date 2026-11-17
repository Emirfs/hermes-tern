"""The field AI boxes as both sides read them, read only: the registry (the user's field-ai-box checkout), each
box's Telegram DM topic, and the session state.db keeps for that topic.

The gateway's ``field.*`` RPCs (gateway/field.py) and ``hermes tern --device`` / ``--list-devices`` /
``--esp-tabs`` (launch/launcher.py) both read them here. Callers hand in the profile's home and config.yaml.

The box code's ``host/`` folder is the one config.yaml's ``mcp_servers.field_ai.args`` names; its modules are
imported from there (``fieldai_cloud`` for the devices.json path, ``fieldai_topics`` for the topics file). Nothing
here talks to a box.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_TOPIC_DEVICE = re.compile(r"·\s*(\S+)\s*$")
# A DM topic's session key (gateway/session.py build_session_key), for a topic state.db has no row of yet.
_TOPIC_KEY = "agent:main:telegram:dm:{chat}:{thread}"
# Rows of one topic read at most, newest first (a reset each day for a year stays well under it).
_TOPIC_ROWS = 400


def host_dir(config: dict[str, Any]) -> Optional[Path]:
    """The field-ai-box ``host/`` folder: where config.yaml's ``field_ai`` MCP server script lives."""
    servers = config.get("mcp_servers")
    server = servers.get("field_ai") if isinstance(servers, dict) else None
    args = server.get("args") if isinstance(server, dict) else None
    for arg in args if isinstance(args, list) else ():
        if isinstance(arg, str) and arg.endswith(".py"):
            return Path(arg).parent
    return None


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


def _aliases(info: dict[str, Any]) -> list[str]:
    """devices.json's ``alias`` (a string) and ``aliases`` (a list) of one box."""
    raw = info.get("aliases")
    items = [*(raw if isinstance(raw, list) else ()), info.get("alias")]
    return [str(a).strip() for a in items if isinstance(a, str) and a.strip()]


def registry(host: Path) -> dict[str, dict[str, Any]]:
    """The provisioned boxes, ``{id: {"name", "label", "aliases"}}``, from the devices.json fieldai_cloud reads.
    Keys stay out."""
    path = Path(host_module(host, "fieldai_cloud").DEFAULT_DEVICES)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    return {dev: {"name": str(info.get("name") or info.get("label") or dev), "label": str(info.get("label") or ""),
                  "aliases": _aliases(info)}
            for dev, info in (raw.items() if isinstance(raw, dict) else ()) if isinstance(info, dict)}


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def topic_targets(config: dict[str, Any]) -> list[dict[str, str]]:
    """The Telegram DM topics config.yaml declares (``platforms.telegram.extra.dm_topics``), as ``hermes send``
    targets."""
    out = []
    telegram = (config.get("platforms") or {}).get("telegram") if isinstance(config.get("platforms"), dict) else None
    extra = telegram.get("extra") if isinstance(telegram, dict) else None
    groups = extra.get("dm_topics") if isinstance(extra, dict) else None
    for group in groups if isinstance(groups, list) else ():
        chat = group.get("chat_id") if isinstance(group, dict) else None
        topics = group.get("topics") if isinstance(group, dict) else None
        if chat is None or not isinstance(topics, list):
            continue
        for topic in topics:
            thread = topic.get("thread_id") if isinstance(topic, dict) else None
            if thread is None:
                continue
            target = {"target": f"telegram:{chat}:{thread}", "platform": "telegram",
                      "name": _text(topic.get("name")) or f"topic {thread}", "kind": "topic", "origin": "dm_topics"}
            if _text(topic.get("skill")):
                target["skill"] = topic["skill"]
            out.append(target)
    return out


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
    for t in topic_targets(config):
        _, chat, thread = t["target"].split(":", 2)
        if m := _TOPIC_DEVICE.search(t["name"]):
            entry = out.setdefault(m.group(1), {"thread_id": thread, "name": t["name"]})
            entry.setdefault("chat_id", chat)
            entry["target"] = f"telegram:{chat}:{entry['thread_id']}"
    return out


# ── Device tabs: a box's Telegram DM topic and the session the gateway keeps for it ─────────────


def boxes(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Every provisioned box and its Telegram DM topic: ``{"id", "name", "kind", "aliases", "thread_id",
    "chat_id"}`` (the topic's ids as strings, None without one). ValueError without a field-ai-box host folder."""
    host = host_dir(config)
    if host is None:
        raise ValueError("config.yaml has no mcp_servers.field_ai server script; the field-ai-box host folder is unknown")
    by_topic = topics(host, config)
    out = []
    for dev, meta in registry(host).items():
        topic = by_topic.get(dev) or {}
        out.append({"id": dev, "name": meta["name"], "kind": meta["label"], "aliases": meta["aliases"],
                    "thread_id": None if topic.get("thread_id") is None else str(topic["thread_id"]),
                    "chat_id": None if topic.get("chat_id") is None else str(topic["chat_id"])})
    return out


def resolve_device(query: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The box ``query`` names: its id, then an alias (devices.json ``alias``/``aliases``, its kind, its whole
    name), then an id prefix, then part of its name; case-insensitive. LookupError when none or several do."""
    q = query.strip().casefold()
    if not q:
        raise LookupError("name a device: its id, an alias or part of its name")
    tests = (lambda r: r["id"].casefold() == q,
             lambda r: q in {a.casefold() for a in (*r["aliases"], r["kind"], r["name"]) if a},
             lambda r: r["id"].casefold().startswith(q),
             lambda r: q in r["name"].casefold())
    for test in tests:
        found = [r for r in rows if test(r)]
        if len(found) == 1:
            return found[0]
        if found:
            raise LookupError(f"{query!r} names several devices: "
                              + ", ".join(f"{r['id']} ({r['name']})" for r in found) + "; name one by its id")
    known = ", ".join(f"{r['id']} ({r['name']})" for r in rows) or "none"
    raise LookupError(f"no device {query!r}; known: {known}")


def topic_rows(home: Path, chat_id: Optional[str], thread_id: str) -> list[dict[str, Any]]:
    """The stored sessions of one Telegram DM topic, newest first, from state.db opened read-only; [] when it
    cannot be read (no database yet, a Hermes whose schema differs)."""
    path = home / "state.db"
    if not path.is_file():
        return []
    sql = ("SELECT id, session_key, started_at, ended_at, end_reason, parent_session_id FROM sessions "
           "WHERE source = 'telegram' AND chat_type = 'dm' AND thread_id = ?"
           + (" AND chat_id = ?" if chat_id else "") + " ORDER BY started_at DESC LIMIT ?")
    args = (str(thread_id), *((str(chat_id),) if chat_id else ()), _TOPIC_ROWS)
    try:
        conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error as exc:
        logger.debug("field: state.db unreadable: %s", exc)
        return []
    try:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, args)]
    except sqlite3.Error as exc:
        logger.debug("field: topic sessions unreadable: %s", exc)
        return []
    finally:
        conn.close()


def _compressed_from(rows: dict[str, dict[str, Any]], session_id: str, ancestor: str) -> bool:
    """Whether ``session_id`` continues ``ancestor`` through compression only (each parent ended ``compression``)."""
    seen = set()
    while session_id and session_id not in seen:
        if session_id == ancestor:
            return True
        seen.add(session_id)
        parent = (rows.get(session_id) or {}).get("parent_session_id")
        if not parent or (rows.get(parent) or {}).get("end_reason") != "compression":
            return False
        session_id = parent
    return False


def topic_session(home: Path, box: dict[str, Any], current: Optional[str] = None) -> dict[str, Any]:
    """Box ``box``'s device chat: its topic's key and open session (None while the topic has none), and
    whether that session replaced ``current`` (``rotated``) and how ``current`` ended."""
    thread, chat = box.get("thread_id"), box.get("chat_id")
    rows = topic_rows(home, chat, thread) if thread else []
    by_id = {r["id"]: r for r in rows}
    open_id = next((r["id"] for r in rows if r["ended_at"] is None), None)
    key = next((r["session_key"] for r in rows if r["session_key"]), None)
    if key is None and chat and thread:
        key = _TOPIC_KEY.format(chat=chat, thread=thread)
    rotated = bool(current and open_id and open_id != current and not _compressed_from(by_id, open_id, current))
    ended = (by_id.get(current) or {}).get("end_reason") if current else None
    return {"id": box["id"], "name": box["name"], "kind": box["kind"],
            "thread_id": int(thread) if thread and thread.isdigit() else thread, "chat_id": chat,
            "session_key": key, "session_id": open_id, "platform": "telegram",
            "rotated": rotated, "ended_reason": ended}


def listing(home: Path, config: dict[str, Any]) -> list[dict[str, Any]]:
    """``hermes tern --list-devices``: each box with its topic's key and open session."""
    keys = ("id", "name", "thread_id", "session_key", "session_id", "platform")
    return [{k: s[k] for k in keys} for s in (topic_session(home, b) for b in boxes(config))]
