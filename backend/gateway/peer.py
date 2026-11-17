"""Peer mesh: Hermes instances on different machines talk through a private GitHub repository.

Neither machine needs an inbound port, a VPN or a shared network: both only make outbound HTTPS calls to
the GitHub REST API with the token of the logged-in ``gh`` account (``gh auth token``, fetched at run time
and kept in memory only). The protocol is documented in the mesh repository's README; in short:

- One issue per pair of peers (``mesh: <a> ↔ <b>``, names sorted) holds their conversation; the
  ``mesh: registry`` issue holds presence notes. Every issue carries the ``hermes-mesh`` label.
- A message is an issue comment whose body starts with ``<!-- hermes-mesh {json} -->``: ``v``, ``id``,
  ``from``, ``to`` (a peer name or ``*``), ``kind`` (``ask | reply | notify | ack | presence``),
  ``reply_to`` and, on replies, ``status`` (``done | blocked | failed``). The text follows.
- Only comments authored by the repository owner's account are read; anything else is ignored.

Machine-local files under ``<HERMES_HOME>/hermes-tern/`` (never synced):
``peer.json`` ``{"name", "repo"}`` (created with the lower-cased host name and ``Emirfs/hermes-mesh``;
optional ``ask_assignee``, ``poll_seconds``, ``enabled``), ``peer-state.json`` (the gateway poller's
cursor, ETag, seen comment ids, known peers and inbound requests), ``peer-issues.json`` (issue numbers)
and ``peer-pending/`` (asks whose reply did not arrive before ``peer_ask`` returned).

In the gateway one poller thread reads new comments repo-wide every ``poll_seconds`` with
``If-None-Match`` (an unchanged list costs a 304). An ``ask`` addressed to this peer becomes a local
kanban card (``ask_assignee``, default ``kodcu``); when the card is done its summary is posted back as
the ``reply``, and a block is reported once as a ``notify``. A ``notify`` to this peer, and a late reply
to an ask that timed out, are posted to the Telegram Kanban topic.

The tools ``peer_list``, ``peer_send`` and ``peer_ask`` talk to GitHub directly, so they work in any
process (gateway, Tern, CLI), with or without the poller.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from . import kanban_notify
from .kanban_notify import data_dir, write_json
from .messaging import hermes_home, read_json

logger = logging.getLogger(__name__)

TOOLSET = "hermes-tern"
THREAD_NAME = "hermes-tern:peer-mesh"
DEFAULT_REPO = "Emirfs/hermes-mesh"
DEFAULT_ASSIGNEE = "kodcu"
LABEL = "hermes-mesh"
API = "https://api.github.com"
PROTOCOL = 1
KINDS = ("ask", "reply", "notify", "ack", "presence")
STATUSES = ("done", "blocked", "failed")
REGISTRY_TITLE = "mesh: registry"
CONFIG_FILE = "peer.json"
STATE_FILE = "peer-state.json"
ISSUES_FILE = "peer-issues.json"
PENDING_DIR = "peer-pending"
POLL_SECONDS = 30
ASK_POLL_SECONDS = 5.0
ASK_TIMEOUT_DEFAULT = 120
ASK_TIMEOUT_MAX = 900
PRESENCE_EVERY_S = 12 * 3600
SEEN_KEEP = 1000
# The poll cursor moves forward once this many comments come back, or once it is this old.
ADVANCE_AT = 50
ADVANCE_AFTER_S = 24 * 3600
TEXT_MAX = 60000  # GitHub caps a comment at 65536 characters
REPLY_MAX = 3000
TOKEN_TTL_S = 1800
HTTP_TIMEOUT_S = 20
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
REPO_RE = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
HEADER_RE = re.compile(r"\A\s*<!--\s*hermes-mesh\s+(\{.*?\})\s*-->[ \t]*(?:\r?\n)?", re.S)
BANNER_RE = re.compile(r"\A> \*\*[^\n]*\n(?:\r?\n)?")


class MeshError(RuntimeError):
    pass


# --- config ----------------------------------------------------------------------------------------

def default_name() -> str:
    raw = re.sub(r"[^a-z0-9-]+", "-", socket.gethostname().lower()).strip("-")
    return raw[:48] or "hermes"


@dataclass
class PeerConfig:
    name: str
    repo: str
    ask_assignee: str = DEFAULT_ASSIGNEE
    poll_seconds: int = POLL_SECONDS
    enabled: bool = True

    @property
    def owner(self) -> str:
        return self.repo.split("/", 1)[0].lower()


def load_config(home: Optional[Path] = None, *, create: bool = True) -> PeerConfig:
    """``peer.json``; written with the defaults (host name, ``Emirfs/hermes-mesh``) when missing or
    when its name/repo is invalid. Extra keys are optional and never written by us."""
    path = data_dir(home) / CONFIG_FILE
    raw = read_json(path) or {}
    data = dict(raw)
    if not isinstance(data.get("name"), str) or not NAME_RE.match(data["name"]):
        data["name"] = default_name()
    if not isinstance(data.get("repo"), str) or not REPO_RE.match(data["repo"]):
        data["repo"] = DEFAULT_REPO
    if create and data != raw:
        write_json(path, data)
    assignee = data.get("ask_assignee")
    try:
        poll = max(10, int(data.get("poll_seconds") or POLL_SECONDS))
    except (TypeError, ValueError):
        poll = POLL_SECONDS
    return PeerConfig(name=data["name"], repo=data["repo"],
                      ask_assignee=assignee if isinstance(assignee, str) and assignee.strip() else DEFAULT_ASSIGNEE,
                      poll_seconds=poll, enabled=data.get("enabled", True) is not False)


# --- protocol --------------------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age_s(iso: str) -> float:
    try:
        then = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return float("inf")
    return (datetime.now(timezone.utc) - then).total_seconds()


def new_id(name: str) -> str:
    return f"{name}-{int(time.time())}-{secrets.token_hex(3)}"


def pair_title(a: str, b: str) -> str:
    x, y = sorted((a, b))
    return f"mesh: {x} ↔ {y}"


def encode(header: dict[str, Any], text: str) -> str:
    """A comment body: the machine header (an HTML comment GitHub does not render), a readable banner,
    then the text. ``>`` is escaped inside the JSON so a value can never close the HTML comment."""
    blob = json.dumps(header, ensure_ascii=False, separators=(",", ":")).replace(">", "\\u003e")
    banner = f"> **{header['from']} → {header['to']}** · {header['kind']}"
    if header.get("status"):
        banner += f" · {header['status']}"
    banner += f" · `{header['id']}`"
    return f"<!-- hermes-mesh {blob} -->\n{banner}\n\n{text}"


def parse(body: Any) -> Optional[tuple[dict[str, Any], str]]:
    """``(header, text)`` of a mesh comment, or None when ``body`` is not a valid v1 message."""
    if not isinstance(body, str):
        return None
    match = HEADER_RE.match(body)
    if not match:
        return None
    try:
        header = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(header, dict) or header.get("v") != PROTOCOL or header.get("kind") not in KINDS:
        return None
    if not isinstance(header.get("id"), str) or not header["id"]:
        return None
    if not isinstance(header.get("from"), str) or not NAME_RE.match(header["from"]):
        return None
    to = header.get("to")
    if not isinstance(to, str) or not (to == "*" or NAME_RE.match(to)):
        return None
    if header.get("status") is not None and header["status"] not in STATUSES:
        return None
    text = BANNER_RE.sub("", body[match.end():], count=1)
    return header, text.strip()


# --- GitHub ----------------------------------------------------------------------------------------

def _gh_path() -> Optional[str]:
    found = shutil.which("gh")
    if found:
        return found
    for candidate in (r"C:\Program Files\GitHub CLI\gh.exe", "/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"):
        if Path(candidate).exists():
            return candidate
    return None


_token_lock = threading.Lock()
_token: dict[str, Any] = {"value": None, "at": 0.0}


def gh_token(refresh: bool = False) -> str:
    """The ``gh`` account's token, read at run time and cached in memory for ``TOKEN_TTL_S``."""
    with _token_lock:
        if not refresh and _token["value"] and time.time() - _token["at"] < TOKEN_TTL_S:
            return _token["value"]
        gh = _gh_path()
        if not gh:
            raise MeshError("gh CLI not found; install it and run `gh auth login`")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run([gh, "auth", "token", "--hostname", "github.com"], capture_output=True, text=True,
                              timeout=20, creationflags=flags)
        value = (proc.stdout or "").strip()
        if proc.returncode != 0 or not value:
            raise MeshError("`gh auth token` gave no token; run `gh auth login` on this machine")
        _token.update(value=value, at=time.time())
        return value


@dataclass
class Response:
    status: int
    data: Any
    headers: dict[str, str] = field(default_factory=dict)

    def header(self, name: str) -> Optional[str]:
        lower = name.lower()
        return next((v for k, v in self.headers.items() if k.lower() == lower), None)


Opener = Callable[[urllib.request.Request, float], Any]


def _urlopen(request: urllib.request.Request, timeout: float) -> Any:
    return urllib.request.urlopen(request, timeout=timeout)


class GitHub:
    """Minimal REST client: JSON in/out, conditional GETs, one token refresh on 401."""

    def __init__(self, token: Callable[..., str] = gh_token, opener: Opener = _urlopen):
        self.token, self.opener = token, opener

    def request(self, method: str, path: str, *, params: Optional[dict[str, Any]] = None,
                body: Optional[dict[str, Any]] = None, etag: Optional[str] = None) -> Response:
        url = path if path.startswith("http") else API + path
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        for attempt in (0, 1):
            headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                       "User-Agent": "hermes-tern-mesh", "Authorization": f"Bearer {self.token(refresh=attempt == 1)}"}
            if etag:
                headers["If-None-Match"] = etag
            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener(req, HTTP_TIMEOUT_S) as resp:
                    raw = resp.read()
                    return Response(resp.status, json.loads(raw) if raw else None, dict(resp.headers.items()))
            except urllib.error.HTTPError as exc:
                hdrs = dict(exc.headers.items()) if exc.headers else {}
                if exc.code == 304:
                    return Response(304, None, hdrs)
                if exc.code == 401 and attempt == 0:
                    continue
                detail = ""
                try:
                    detail = json.loads(exc.read() or b"{}").get("message", "")
                except Exception:
                    pass
                raise MeshError(f"GitHub {method} {path}: HTTP {exc.code} {detail}".strip()) from None
        raise MeshError(f"GitHub {method} {path}: unauthorized")


def next_link(resp: Response) -> Optional[str]:
    for part in (resp.header("Link") or "").split(","):
        m = re.search(r'<([^>]+)>\s*;\s*rel="next"', part)
        if m:
            return m.group(1)
    return None


# --- issues and posting ----------------------------------------------------------------------------

_issues_lock = threading.Lock()


def find_or_create_issue(gh: GitHub, home: Path, repo: str, title: str, body: str) -> int:
    """The number of the mesh issue titled ``title`` (the lowest, should two machines race), creating
    it when none exists. Cached in ``peer-issues.json``."""
    path = data_dir(home) / ISSUES_FILE
    key = f"{repo}|{title}"
    with _issues_lock:
        cache = read_json(path) or {}
        if isinstance(cache.get(key), int):
            return cache[key]
        found: list[int] = []
        url: Optional[str] = f"/repos/{repo}/issues"
        params: Optional[dict[str, Any]] = {"labels": LABEL, "state": "all", "per_page": 100}
        while url:
            resp = gh.request("GET", url, params=params)
            found += [i["number"] for i in resp.data or [] if i.get("title") == title and "pull_request" not in i]
            url, params = next_link(resp), None
        if found:
            number = min(found)
        else:
            resp = gh.request("POST", f"/repos/{repo}/issues", body={"title": title, "body": body, "labels": [LABEL]})
            number = int(resp.data["number"])
        cache[key] = number
        write_json(path, cache)
        return number


def post(gh: GitHub, home: Path, cfg: PeerConfig, to: str, kind: str, text: str, *,
         reply_to: Optional[str] = None, extra: Optional[dict[str, Any]] = None) -> tuple[dict[str, Any], int, str]:
    """Post one message; returns ``(header, issue number, comment url)``."""
    if kind == "presence" or to == "*":
        title, intro = REGISTRY_TITLE, "Hermes mesh presence notes (one comment per peer start)."
    else:
        title = pair_title(cfg.name, to)
        intro = f"Hermes mesh conversation between `{min(cfg.name, to)}` and `{max(cfg.name, to)}`."
    number = find_or_create_issue(gh, home, cfg.repo, title, intro + " See the repository README.")
    header = {"v": PROTOCOL, "id": new_id(cfg.name), "from": cfg.name, "to": to, "kind": kind,
              "reply_to": reply_to, "ts": now_iso(), **(extra or {})}
    if len(text) > TEXT_MAX:
        text = text[: TEXT_MAX - 1] + "…"
    resp = gh.request("POST", f"/repos/{cfg.repo}/issues/{number}/comments", body={"body": encode(header, text)})
    return header, number, (resp.data or {}).get("html_url", "")


def _issue_number(comment: dict[str, Any]) -> Optional[int]:
    try:
        return int(str(comment.get("issue_url", "")).rstrip("/").rsplit("/", 1)[1])
    except (IndexError, ValueError):
        return None


def _authored_by_owner(comment: dict[str, Any], owner: str) -> bool:
    login = ((comment.get("user") or {}).get("login") or "").lower()
    return bool(login) and login == owner


# --- kanban glue (in-process Hermes API) ------------------------------------------------------------

def create_card(title: str, body: str, assignee: str, created_by: str, idempotency_key: str) -> str:
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    with kbc.connect_closing() as conn:
        return kb.create_task(conn, title=title, body=body, assignee=assignee, created_by=created_by,
                              idempotency_key=idempotency_key)


def task_outcome(task_id: str) -> Optional[tuple[str, str]]:
    """``(status, summary-or-reason)`` of a local card; None when it no longer exists."""
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    with kbc.connect_closing() as conn:
        task = kb.get_task(conn, task_id)
        if task is None:
            return None
        detail = ""
        if task.status in ("done", "archived"):
            detail = kb.latest_summary(conn, task_id) or task.result or ""
        elif task.status == "blocked":
            row = conn.execute("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'blocked' "
                               "ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
            payload = json.loads(row[0]) if row and row[0] else {}
            detail = str(payload.get("reason") or "")
        return task.status, detail


# --- the gateway poller ----------------------------------------------------------------------------

class Poller:
    """One ``tick`` = fetch new comments, act on the ones addressed to us, settle inbound cards,
    refresh our presence note. State lives in ``peer-state.json``; only this poller writes it."""

    def __init__(self, home: Path, cfg: PeerConfig, gh: GitHub, *, notify: Callable[[str], bool],
                 create: Callable[..., str] = create_card,
                 outcome: Callable[[str], Optional[tuple[str, str]]] = task_outcome,
                 clock: Callable[[], float] = time.time):
        self.home, self.cfg, self.gh = home, cfg, gh
        self.notify, self.create, self.outcome, self.clock = notify, create, outcome, clock
        self.failures: dict[Any, int] = {}

    # state
    @property
    def state_path(self) -> Path:
        return data_dir(self.home) / STATE_FILE

    def load(self) -> dict[str, Any]:
        state = read_json(self.state_path) or {}
        for key, default in (("seen", []), ("peers", {}), ("inbound", {}), ("etag", {}), ("outbox", [])):
            if not isinstance(state.get(key), type(default)):
                state[key] = default
        return state

    def save(self, state: dict[str, Any]) -> None:
        state["seen"] = state["seen"][-SEEN_KEEP:]
        write_json(self.state_path, state)

    def tick(self) -> None:
        state = self.load()
        try:
            self.flush(state)
            self.fetch(state)
            self.settle(state)
            self.presence(state)
        finally:
            self.save(state)

    def say(self, state: dict[str, Any], text: str) -> None:
        """Post to the Kanban topic; kept in ``outbox`` and retried next tick when it cannot go now."""
        try:
            if self.notify(text):
                return
        except Exception:
            logger.warning("peer-mesh: Kanban topic delivery failed", exc_info=True)
        state.setdefault("outbox", []).append(text)

    def flush(self, state: dict[str, Any]) -> None:
        queued, state["outbox"] = list(state.get("outbox") or []), []
        for i, text in enumerate(queued):
            try:
                ok = self.notify(text)
            except Exception:
                ok = False
            if not ok:
                state["outbox"] = queued[i:]
                return

    # inbound comments
    def fetch(self, state: dict[str, Any]) -> int:
        """Read comments updated since the cursor; returns how many were acted on. The first run only
        seeds the cursor (no replay of the repository's history). The cursor stays put while the list is
        short, so the same URL is asked again and an unchanged repository answers 304 (free); handled
        comments are skipped by id. It moves forward once the list grows or the cursor ages."""
        since = state.get("since")
        if not since:
            state["since"] = now_iso()
            return 0
        path = f"/repos/{self.cfg.repo}/issues/comments"
        params = {"since": since, "sort": "updated", "direction": "asc", "per_page": 100}
        etag = state["etag"].get("value") if state["etag"].get("since") == since else None
        resp = self.gh.request("GET", path, params=params, etag=etag)
        if resp.status == 304:
            return 0
        comments = list(resp.data or [])
        state["etag"] = {"since": since, "value": resp.header("ETag")}
        url = next_link(resp)
        while url:
            page = self.gh.request("GET", url)
            comments += list(page.data or [])
            url = next_link(page)
        seen = set(state["seen"])
        handled = 0
        newest, blocked_at = since, None
        for comment in sorted(comments, key=lambda c: (c.get("updated_at") or "", c.get("id") or 0)):
            cid = comment.get("id")
            if cid in seen:
                if blocked_at is None:
                    newest = max(newest, comment.get("updated_at") or newest)
                continue
            parsed = parse(comment.get("body")) if _authored_by_owner(comment, self.cfg.owner) else None
            if parsed:
                header, text = parsed
                self._remember_peer(state, header, comment)
                if header["from"] != self.cfg.name and header["to"] in (self.cfg.name, "*"):
                    try:
                        self.handle(state, header, text, _issue_number(comment))
                        handled += 1
                    except Exception:
                        # Retried next tick (asks are idempotent by request id), a few times.
                        count = self.failures[cid] = self.failures.get(cid, 0) + 1
                        logger.warning("peer-mesh: could not handle %s %s (attempt %d)", header.get("kind"),
                                       header.get("id"), count, exc_info=True)
                        if count < 5:
                            state["etag"] = {}  # ask again even if nothing changed
                            blocked_at = blocked_at or comment.get("updated_at") or since
                            continue
                        if header["kind"] == "ask":
                            try:  # tell the asker instead of leaving it waiting forever
                                self._reply({"peer": header["from"], "request_id": header["id"]}, "failed",
                                            f"{self.cfg.name} isteği karta çeviremedi; tekrar deneyin.")
                            except Exception:
                                logger.warning("peer-mesh: could not post the failure reply", exc_info=True)
            seen.add(cid)
            state["seen"].append(cid)
            if blocked_at is None:
                newest = max(newest, comment.get("updated_at") or newest)
        if len(comments) >= ADVANCE_AT or _age_s(since) > ADVANCE_AFTER_S:
            state["since"] = newest
        return handled

    def _remember_peer(self, state: dict[str, Any], header: dict[str, Any], comment: dict[str, Any]) -> None:
        name = header["from"]
        if name == self.cfg.name:
            return
        entry = state["peers"].setdefault(name, {})
        entry["last_seen"] = max(entry.get("last_seen") or "", comment.get("created_at") or "")
        if header["kind"] == "presence":
            entry["host"] = header.get("host")

    def handle(self, state: dict[str, Any], header: dict[str, Any], text: str, issue: Optional[int]) -> None:
        kind, src = header["kind"], header["from"]
        if kind == "ask":
            first = (text.strip().splitlines() or [""])[0]
            title = f"Peer isteği ({src}): {first[:80] or header['id']}"
            body = (f"{text}\n\n---\nKaynak: hermes-mesh peer `{src}`, istek id `{header['id']}`"
                    f"{f', issue #{issue}' if issue else ''}.\n"
                    "Bu kart tamamlanınca özeti otomatik olarak peer'a yanıt olarak gönderilir.\n"
                    "Güvenlik: cihaza yazan (RF TX, OTA, provisioning, arm) veya dışarı mesaj gönderen işlem yapma; "
                    "gerekiyorsa kartı engelle (kanban_block: onay bekliyor).")
            task_id = self.create(title, body, self.cfg.ask_assignee, f"peer:{src}", f"hermes-mesh:{header['id']}")
            state["inbound"][task_id] = {"peer": src, "request_id": header["id"], "issue": issue,
                                         "received_at": now_iso(), "blocked_sent": False}
            post(self.gh, self.home, self.cfg, src, "ack", f"Kanban kartı açıldı: `{task_id}` ({self.cfg.ask_assignee}).",
                 reply_to=header["id"], extra={"task_id": task_id})
        elif kind == "notify":
            status = f" ({header['status']})" if header.get("status") else ""
            self.say(state, f"📨 Peer {src}{status}: {kanban_notify._safe(text, 1500)}")
        elif kind == "reply":
            pending = pending_path(self.home, str(header.get("reply_to") or ""))
            if pending is not None and pending.exists():
                status = header.get("status") or "done"
                self.say(state, f"📬 Peer {src} yanıtladı ({status}): {kanban_notify._safe(text, 1500)}")
                pending.unlink(missing_ok=True)

    # outbound replies for inbound asks
    def settle(self, state: dict[str, Any]) -> None:
        for task_id, rec in list(state["inbound"].items()):
            try:
                result = self.outcome(task_id)
                if result is None:
                    self._reply(rec, "failed", f"Kart `{task_id}` bulunamadı (silinmiş).")
                    del state["inbound"][task_id]
                    continue
                status, detail = result
                if status in ("done", "archived"):
                    self._reply(rec, "done", detail.strip() or f"Kart `{task_id}` tamamlandı (özet yok).")
                    del state["inbound"][task_id]
                elif status == "blocked" and not rec.get("blocked_sent"):
                    post(self.gh, self.home, self.cfg, rec["peer"], "notify",
                         f"Kart `{task_id}` engellendi: {detail or 'neden belirtilmedi'}",
                         reply_to=rec["request_id"], extra={"status": "blocked", "task_id": task_id})
                    rec["blocked_sent"] = True
                elif status != "blocked":
                    rec["blocked_sent"] = False
            except Exception:
                logger.warning("peer-mesh: could not settle card %s", task_id, exc_info=True)

    def _reply(self, rec: dict[str, Any], status: str, text: str) -> None:
        if len(text) > REPLY_MAX:
            text = text[: REPLY_MAX - 1] + "…"
        post(self.gh, self.home, self.cfg, rec["peer"], "reply", text, reply_to=rec["request_id"],
             extra={"status": status})

    def presence(self, state: dict[str, Any]) -> None:
        last = state.get("presence_at") or 0
        if self.clock() - float(last) < PRESENCE_EVERY_S:
            return
        post(self.gh, self.home, self.cfg, "*", "presence", f"{self.cfg.name} çevrimiçi.",
             extra={"host": socket.gethostname()})
        state["presence_at"] = self.clock()


# --- pending asks (written by peer_ask in any process, read by the poller) --------------------------

def pending_path(home: Path, message_id: str) -> Optional[Path]:
    if not re.fullmatch(r"[a-z0-9-]{1,96}", message_id or ""):
        return None
    return data_dir(home) / PENDING_DIR / f"{message_id}.json"


# --- tools -----------------------------------------------------------------------------------------

def _ok(data: dict[str, Any]) -> str:
    try:
        from tools.registry import tool_result
        return tool_result(data)
    except Exception:
        return json.dumps(data, ensure_ascii=False)


def _err(message: str) -> str:
    try:
        from tools.registry import tool_error
        return tool_error(message)
    except Exception:
        return json.dumps({"error": message}, ensure_ascii=False)


def _peer_arg(args: dict[str, Any], cfg: PeerConfig) -> str:
    peer = str((args or {}).get("peer") or "").strip().lower()
    if not NAME_RE.match(peer):
        raise MeshError("peer must be a peer name (lower-case letters, digits, dashes); see peer_list")
    if peer == cfg.name:
        raise MeshError("that is this machine's own peer name")
    return peer


def _text_arg(args: dict[str, Any]) -> str:
    text = str((args or {}).get("text") or "").strip()
    if not text:
        raise MeshError("text is empty")
    return text


def list_peers(gh: GitHub, home: Path, cfg: PeerConfig) -> dict[str, Any]:
    """Peers from the poller's state plus a live read of the registry and pair issues."""
    peers: dict[str, dict[str, Any]] = {}
    state = read_json(data_dir(home) / STATE_FILE) or {}
    for name, entry in (state.get("peers") or {}).items():
        if isinstance(entry, dict):
            peers[name] = {"name": name, "last_seen": entry.get("last_seen"), "host": entry.get("host")}
    url: Optional[str] = f"/repos/{cfg.repo}/issues"
    params: Optional[dict[str, Any]] = {"labels": LABEL, "state": "all", "per_page": 100}
    registry = None
    while url:
        resp = gh.request("GET", url, params=params)
        for issue in resp.data or []:
            title = issue.get("title") or ""
            if title == REGISTRY_TITLE:
                registry = registry or issue["number"]
            m = re.fullmatch(r"mesh: ([a-z0-9-]+) ↔ ([a-z0-9-]+)", title)
            if m and cfg.name in m.groups():
                other = m.group(2) if m.group(1) == cfg.name else m.group(1)
                peers.setdefault(other, {"name": other, "last_seen": None, "host": None})
        url, params = next_link(resp), None
    if registry:
        resp = gh.request("GET", f"/repos/{cfg.repo}/issues/{registry}/comments", params={"per_page": 100})
        for comment in resp.data or []:
            parsed = parse(comment.get("body")) if _authored_by_owner(comment, cfg.owner) else None
            if not parsed or parsed[0]["kind"] != "presence" or parsed[0]["from"] == cfg.name:
                continue
            h = parsed[0]
            entry = peers.setdefault(h["from"], {"name": h["from"], "last_seen": None, "host": None})
            entry["last_seen"] = max(entry.get("last_seen") or "", comment.get("created_at") or "")
            entry["host"] = h.get("host") or entry.get("host")
    return {"me": cfg.name, "repo": cfg.repo, "peers": sorted(peers.values(), key=lambda p: p["name"])}


def wait_reply(gh: GitHub, cfg: PeerConfig, issue: int, message_id: str, peer: str, timeout_s: float,
               *, sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
               since: Optional[str] = None) -> dict[str, Any]:
    """Poll the pair issue for the ``reply`` to ``message_id`` (conditional GETs) until ``timeout_s``."""
    deadline = clock() + max(0.0, timeout_s)
    path = f"/repos/{cfg.repo}/issues/{issue}/comments"
    params = {"since": since or now_iso(), "per_page": 100}
    etag = None
    ack: Optional[dict[str, Any]] = None
    while True:
        resp = gh.request("GET", path, params=params, etag=etag)
        if resp.status != 304:
            etag = resp.header("ETag")
            comments = list(resp.data or [])
            url = next_link(resp)
            while url:
                page = gh.request("GET", url)
                comments += list(page.data or [])
                url = next_link(page)
            for comment in comments:
                parsed = parse(comment.get("body")) if _authored_by_owner(comment, cfg.owner) else None
                if not parsed:
                    continue
                h, text = parsed
                if h["from"] != peer or h.get("reply_to") != message_id:
                    continue
                if h["kind"] == "reply":
                    return {"answered": True, "status": h.get("status") or "done", "reply": text,
                            "reply_id": h["id"], "ack": ack}
                if h["kind"] == "ack":
                    ack = {"task_id": h.get("task_id"), "text": text}
                if h["kind"] == "notify" and h.get("status") == "blocked":
                    ack = {**(ack or {}), "blocked": text}
        if clock() >= deadline:
            return {"answered": False, "ack": ack}
        sleep(min(ASK_POLL_SECONDS, max(0.0, deadline - clock())))


def peer_list_tool(args: dict[str, Any], **_: Any) -> str:
    try:
        home = hermes_home()
        cfg = load_config(home)
        return _ok(list_peers(GitHub(), home, cfg))
    except MeshError as exc:
        return _err(str(exc))


def peer_send_tool(args: dict[str, Any], **_: Any) -> str:
    try:
        home = hermes_home()
        cfg = load_config(home)
        header, issue, url = post(GitHub(), home, cfg, _peer_arg(args, cfg), "notify", _text_arg(args))
        return _ok({"sent": True, "id": header["id"], "to": header["to"], "issue": issue, "url": url})
    except MeshError as exc:
        return _err(str(exc))


def peer_ask_tool(args: dict[str, Any], **_: Any) -> str:
    try:
        home = hermes_home()
        cfg = load_config(home)
        peer, text = _peer_arg(args, cfg), _text_arg(args)
        try:
            timeout = float((args or {}).get("timeout_s") or ASK_TIMEOUT_DEFAULT)
        except (TypeError, ValueError):
            timeout = ASK_TIMEOUT_DEFAULT
        timeout = min(max(timeout, 0.0), ASK_TIMEOUT_MAX)
        gh = GitHub()
        started = now_iso()
        header, issue, url = post(gh, home, cfg, peer, "ask", text)
        result = wait_reply(gh, cfg, issue, header["id"], peer, timeout, since=started)
        result.update(id=header["id"], peer=peer, issue=issue, url=url)
        if not result["answered"]:
            pending = pending_path(home, header["id"])
            if pending is not None:
                write_json(pending, {"peer": peer, "issue": issue, "asked_at": started, "text": text[:500]})
            result["note"] = ("No reply yet. The peer works on it as a kanban card; when the reply arrives "
                              "the gateway posts it to the Telegram Kanban topic.")
        return _ok(result)
    except MeshError as exc:
        return _err(str(exc))


LIST_SCHEMA = {
    "name": "peer_list",
    "description": "List the other Hermes machines (peers) reachable over the private GitHub mesh, with when each "
                   "was last seen, and this machine's own peer name.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
SEND_SCHEMA = {
    "name": "peer_send",
    "description": "Send a one-way note to another Hermes machine (peer) over the GitHub mesh. The peer shows it in "
                   "its Telegram Kanban topic; no work is started. Use peer_ask to request work or an answer.",
    "parameters": {"type": "object", "properties": {
        "peer": {"type": "string", "description": "Peer name from peer_list"},
        "text": {"type": "string", "description": "The note"},
    }, "required": ["peer", "text"], "additionalProperties": False},
}
ASK_SCHEMA = {
    "name": "peer_ask",
    "description": "Ask another Hermes machine (peer) to do something or answer a question. The peer turns it into a "
                   "kanban card on its own board and replies with the card's result. Waits up to timeout_s for the "
                   "reply; when it is not ready, returns pending and the reply later reaches the Kanban topic. Never "
                   "ask a peer for device-writing actions (RF TX, OTA, provisioning, arm) or to message anyone.",
    "parameters": {"type": "object", "properties": {
        "peer": {"type": "string", "description": "Peer name from peer_list"},
        "text": {"type": "string", "description": "The request, self-contained, with acceptance criteria"},
        "timeout_s": {"type": "number", "description": f"Seconds to wait for the reply (0-{ASK_TIMEOUT_MAX}, "
                                                       f"default {ASK_TIMEOUT_DEFAULT})"},
    }, "required": ["peer", "text"], "additionalProperties": False},
}


# --- registration ----------------------------------------------------------------------------------

def register(ctx) -> None:
    for name, schema, handler, emoji in (("peer_list", LIST_SCHEMA, peer_list_tool, "🛰️"),
                                         ("peer_send", SEND_SCHEMA, peer_send_tool, "📨"),
                                         ("peer_ask", ASK_SCHEMA, peer_ask_tool, "🛰️")):
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler, emoji=emoji,
                          description=schema["description"])
    if not kanban_notify.in_gateway_process():
        return
    home = hermes_home()
    cfg = load_config(home)
    if not cfg.enabled:
        return
    poller = Poller(home, cfg, GitHub(), notify=lambda text: kanban_notify.send_to_topic(text, home))
    halt = kanban_notify.start_worker(THREAD_NAME, lambda stop: kanban_notify.run_loop(
        stop, poller.tick, interval=float(cfg.poll_seconds), label="peer-mesh"))
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        on_unload(halt)
