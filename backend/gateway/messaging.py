"""The messaging gateway's platforms for the pane: their state, and where ``hermes send`` can deliver.

- ``plugin.hermes-tern.messaging.status`` ``{}`` answers ``{"source", "gateway", "platforms": [...]}``: each
  platform the gateway runs (Telegram, WhatsApp, a plugin platform such as ``fieldai``) with its state,
  error, ``needs_attention`` and since when. The plugin runs inside the gateway, so it reads the gateway's own
  in-memory snapshot (``gateway.status``) when that is this process's, and ``<HERMES_HOME>/gateway_state.json``
  otherwise (``source`` says which).
- ``plugin.hermes-tern.messaging.targets`` ``{}`` answers ``{"targets": [...]}``: the ``--to`` values ``hermes send``
  takes, from ``channel_directory.json`` (the chats the gateway has seen), the per-chat Telegram DM topics in
  config.yaml (``platforms.telegram.extra.dm_topics``), and each platform's bare name (its home channel).
- ``plugin.hermes-tern.messaging.check`` ``{"platform": "telegram"}`` answers ``{"ok", "detail", ...}``: whether
  Telegram accepts the bot token the gateway holds (Bot API ``getMe``, which sends nothing). The token never
  leaves this process.
- ``plugin.hermes-tern.messaging.chats`` ``{"ids": [...]}`` answers ``{"chats": {id: {...}}}``: for the inbox, where
  each messaging session talks (platform, chat, topic thread, the chat's or topic's name), from its stored row.

All four only read; nothing here sends a message or changes a platform.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from ..shared import sessions
from ..shared.field_boxes import topic_targets

logger = logging.getLogger(__name__)

STATUS_METHOD = "messaging.status"
TARGETS_METHOD = "messaging.targets"
CHECK_METHOD = "messaging.check"
CHATS_METHOD = "messaging.chats"
# The most sessions one messaging.chats call looks up.
MAX_CHAT_IDS = 200
CHECK_TIMEOUT_S = 10.0
TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN"
STATE_FILE = "gateway_state.json"
DIRECTORY_FILE = "channel_directory.json"
# The fields of a platform's row the pane shows, as gateway/status.py writes them.
_FIELDS = ("state", "error_code", "error_message", "updated_at", "retrying_since")
# A platform in one of these states is not delivering, whether or not the gateway flagged it.
_BROKEN = {"fatal", "disconnected", "retrying", "error"}


def hermes_home() -> Path:
    """The profile's home: Hermes' own resolver (it follows the RPC's profile scope), else HERMES_HOME."""
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:  # outside Hermes (tests, a bare interpreter)
        env = os.environ.get("HERMES_HOME", "").strip()
        if env:
            return Path(env)
        local = os.environ.get("LOCALAPPDATA")
        return Path(local) / "hermes" if local else Path.home() / ".hermes"


def read_json(path: Path) -> Optional[dict[str, Any]]:
    """The JSON object at ``path``; None when it is missing, unreadable or not an object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _yaml_load(text: str) -> Any:
    """Hermes' own YAML policy (``hermes_yaml``, ruamel); PyYAML outside Hermes."""
    try:
        from hermes_yaml import safe_load
    except ImportError:
        from yaml import safe_load
    return safe_load(text)


def read_config(home: Path) -> dict[str, Any]:
    """The profile's config.yaml as a dict; empty when it cannot be read."""
    try:
        data = _yaml_load((home / "config.yaml").read_text(encoding="utf-8"))
    except Exception as exc:
        logger.debug("hermes-tern: config.yaml unreadable: %s", exc)
        return {}
    return data if isinstance(data, dict) else {}


def _live_snapshot(home: Path) -> Optional[dict[str, Any]]:
    """The gateway's in-memory runtime status, when this process is that gateway and it is this home's."""
    status = sys.modules.get("gateway.status")
    snapshot = getattr(status, "_runtime_status_state", None)
    if not isinstance(snapshot, dict) or snapshot.get("pid") != os.getpid():
        return None
    path = getattr(status, "_runtime_status_state_path", None)
    try:
        if path is not None and Path(path).resolve() != (home / STATE_FILE).resolve():
            return None
    except OSError:
        return None
    return snapshot


def runtime_state(home: Path) -> tuple[str, Optional[dict[str, Any]]]:
    """``(source, snapshot)``: ``live`` (the gateway's memory), ``file`` (gateway_state.json) or ``none``."""
    live = _live_snapshot(home)
    if live is not None:
        return "live", live
    on_disk = read_json(home / STATE_FILE)
    return ("file", on_disk) if on_disk is not None else ("none", None)


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def platform_rows(snapshot: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per platform in a runtime snapshot, the ones needing attention first, then by name.

    A multiplexed gateway keys another profile's platform ``<profile>:<platform>``; the row splits it."""
    raw = snapshot.get("platforms") if isinstance(snapshot, dict) else None
    rows = []
    for key, p in (raw or {}).items() if isinstance(raw, dict) else ():
        if not isinstance(key, str) or not isinstance(p, dict):
            continue
        profile, _, name = key.rpartition(":")
        row = {"key": key, "name": name, "profile": profile or None}
        row.update({f: _text(p.get(f)) for f in _FIELDS})
        row["state"] = row["state"] or "unknown"
        row["needs_attention"] = bool(p.get("needs_attention")) or row["state"] in _BROKEN
        row["since"] = row["retrying_since"] or row["updated_at"]
        rows.append(row)
    return sorted(rows, key=lambda r: (not r["needs_attention"], r["profile"] or "", r["name"]))


def status(_params: dict, **_: Any) -> dict[str, Any]:
    home = hermes_home()
    source, snapshot = runtime_state(home)
    gateway = None
    if snapshot is not None:
        gateway = {"state": _text(snapshot.get("gateway_state")) or "unknown", "pid": snapshot.get("pid"),
                   "updated_at": _text(snapshot.get("updated_at")), "version": _text(snapshot.get("code_version"))}
    return {"source": source, "gateway": gateway, "platforms": platform_rows(snapshot)}


def _target(target: str, platform: str, name: str, kind: str, origin: str) -> dict[str, str]:
    return {"target": target, "platform": platform, "name": name, "kind": kind, "origin": origin}


def directory_targets(directory: Optional[dict[str, Any]]) -> list[dict[str, str]]:
    """``hermes send`` targets from channel_directory.json: ``platform:<id>`` (a topic's id holds its thread)."""
    out = []
    platforms = directory.get("platforms") if isinstance(directory, dict) else None
    for platform, chats in platforms.items() if isinstance(platforms, dict) else ():
        for chat in chats if isinstance(chats, list) else ():
            ident = chat.get("id") if isinstance(chat, dict) else None
            if isinstance(ident, (str, int)) and str(ident):
                name = _text(chat.get("name")) or str(ident)
                out.append(_target(f"{platform}:{ident}", platform, name, _text(chat.get("type")) or "chat", "directory"))
    return out


def all_targets(home: Path) -> list[dict[str, str]]:
    """Every ``hermes send`` target, each once: home channels, then config topics (they carry the topic's skill
    and the configured name), then the directory's chats."""
    _, snapshot = runtime_state(home)
    homes = [_target(r["name"], r["name"], "home channel", "home", "platform")
             for r in platform_rows(snapshot) if not r["profile"]]
    seen: set[str] = set()
    out = []
    for t in [*homes, *topic_targets(read_config(home)), *directory_targets(read_json(home / DIRECTORY_FILE))]:
        if t["target"] not in seen:
            seen.add(t["target"])
            out.append(t)
    return out


def targets(_params: dict, **_: Any) -> dict[str, Any]:
    return {"targets": all_targets(hermes_home())}


def chat_of(stored: Optional[dict[str, Any]], names: dict[str, str]) -> Optional[dict[str, Any]]:
    """Where a messaging session's stored row says it talks: the platform, chat, topic thread, and the chat's
    name (the topic's or chat's target name, else the row's display name)."""
    if not isinstance(stored, dict) or stored.get("chat_id") in (None, ""):
        return None
    platform, chat, thread = str(stored.get("source") or ""), str(stored["chat_id"]), stored.get("thread_id")
    thread = None if thread in (None, "") else str(thread)
    target = f"{platform}:{chat}:{thread}" if thread else f"{platform}:{chat}"
    return {"platform": platform, "chat_id": chat, "thread_id": thread, "chat_type": _text(stored.get("chat_type")),
            "target": target, "name": names.get(target) or _text(stored.get("display_name"))}


def chats(params: dict, **_: Any) -> dict[str, Any]:
    raw = params.get("ids")
    ids = [i for i in raw if isinstance(i, str) and i][:MAX_CHAT_IDS] if isinstance(raw, list) else []
    names = {t["target"]: t["name"] for t in all_targets(hermes_home()) if t["kind"] != "home"}
    out: dict[str, Any] = {}
    try:
        with sessions.database() as db:
            for i in ids:
                if found := chat_of(db.get_session(i), names):
                    out[i] = found
    except Exception as exc:  # no database, another schema: the inbox shows titles alone
        logger.debug("messaging.chats: session database unreadable: %s", exc)
    return {"chats": out}


def _secret(home: Path, name: str) -> Optional[str]:
    """A credential as the gateway's adapters read it (profile-scoped), else the process env, else ``<home>/.env``."""
    try:
        from gateway.platforms._shared import get_scoped_secret
    except ImportError:  # outside the gateway
        get_scoped_secret = None
    if get_scoped_secret is not None:
        value = get_scoped_secret(name, None)
        # A scoped miss is authoritative: never borrow the launch profile's environment token.
        return value.strip() if isinstance(value, str) and value.strip() else None
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    try:
        for line in (home / ".env").read_text(encoding="utf-8").splitlines():
            if m := re.match(rf"\s*{re.escape(name)}\s*=\s*(.*)", line):
                return m.group(1).strip().strip("\"'") or None
    except OSError:
        pass
    return None


def _get_me(token: str) -> dict[str, Any]:
    """Telegram's ``getMe`` answer; an HTTP error's body is Telegram's own (it never echoes the token)."""
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/getMe")
    try:
        with urllib.request.urlopen(request, timeout=CHECK_TIMEOUT_S) as reply:
            return json.load(reply)
    except urllib.error.HTTPError as exc:
        try:
            return json.load(exc)
        except ValueError:
            return {"ok": False, "description": f"HTTP {exc.code}"}


def check(params: dict, *, get_me=_get_me, **_: Any) -> dict[str, Any]:
    platform = params.get("platform")
    if platform != "telegram":
        raise ValueError("messaging.check checks only telegram's bot token")
    token = _secret(hermes_home(), TELEGRAM_TOKEN)
    if not token:
        return {"ok": False, "detail": f"no {TELEGRAM_TOKEN} is set for this profile"}
    try:
        answer = get_me(token)
    except (OSError, ValueError) as exc:  # unreachable, a timeout, a body that is not JSON
        detail = str(exc).replace(token, "<token>")
        return {"ok": False, "detail": f"Telegram did not answer: {detail}"}
    result = answer.get("result") if isinstance(answer, dict) else None
    if not isinstance(answer, dict) or not answer.get("ok") or not isinstance(result, dict):
        description = answer.get("description") if isinstance(answer, dict) else None
        return {"ok": False, "detail": f"Telegram refused the token: {description or 'no reason given'}"}
    return {"ok": True, "detail": f"the token is @{result.get('username')}'s", "username": result.get("username"),
            "topics": bool(result.get("has_topics_enabled"))}


def register(ctx) -> None:
    ctx.register_rpc(STATUS_METHOD, status)
    ctx.register_rpc(TARGETS_METHOD, targets)
    ctx.register_rpc(CHECK_METHOD, check)
    ctx.register_rpc(CHATS_METHOD, chats)
