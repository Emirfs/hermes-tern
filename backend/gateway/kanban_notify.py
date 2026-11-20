"""Central kanban notifications: every task event on this machine reaches the Telegram "Kanban" topic.

Hermes' own notifier (``kanban notify-subscribe``) only delivers terminal events of tasks someone
subscribed, so it cannot announce a card being created, assigned or claimed. Every creator (the CLI,
the ``kanban_*`` tools, workers, a peer request) writes the same ``task_events`` table of each board's
``kanban.db``, so this module tails that table instead: one thread in the gateway process reads it
(read-only) every few seconds and sends one short Turkish message per interesting event through the
gateway's live Telegram adapter. Nothing is written to ``kanban.db``.

- Destination: ``<HERMES_HOME>/hermes-tern/kanban-notify.json`` ``{"platform": "telegram", "chat_id",
  "thread_id", "topic", "dry_run"}``. Without a chat/thread, or with ``dry_run``, messages are appended
  to ``kanban-notify.log`` beside it instead of being sent.
- Dedupe: the last handled event id per board lives in ``kanban-notify-state.json`` and is written after
  each delivered message, so a plugin reload or gateway restart continues where it stopped. A board seen
  for the first time starts at its newest event (no history replay). Events older than ``MAX_AGE_S``
  are skipped, and one that keeps failing is dropped after ``MAX_FAILURES`` attempts.
- Reading tabs: each delivered message is also handed to ``tern-bridge read`` (key ``kanban-<task>-<kind>``,
  title ``📋 <card title>``, the same text as Markdown on stdin), which opens it as a tab of Tern's
  ``Okuma`` session. That runs on a daemon thread under ``READ_TIMEOUT_S``; a missing or failing
  ``tern-bridge`` costs one log line and never holds or fails the Telegram message.
- Process: the thread starts only where ``gateway.run`` is loaded and works only once the gateway
  runner exists; a reload stops the previous thread (by name) before the new one reads the cursor.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .messaging import hermes_home, read_json

logger = logging.getLogger(__name__)

THREAD_NAME = "hermes-tern:kanban-notify"
DIR = "hermes-tern"
CONFIG_FILE = "kanban-notify.json"
STATE_FILE = "kanban-notify-state.json"
LOG_FILE = "kanban-notify.log"
INTERVAL_S = 5.0
# How long a thread waits for a gateway runner before deciding this process is not the gateway.
RUNNER_WAIT_S = 600.0
SEND_TIMEOUT_S = 30.0
MAX_AGE_S = 6 * 3600
MAX_FAILURES = 12
BATCH = 200
TITLE_MAX = 120
DETAIL_MAX = 400
READ_TIMEOUT_S = 5.0

FAILED_KINDS = {"gave_up": "vazgeçildi", "crashed": "çöktü", "timed_out": "zaman aşımı",
                "spawn_failed": "başlatılamadı"}
NOTIFY_KINDS = ("created", "assigned", "claimed", "completed", "blocked", *FAILED_KINDS)
APPROVAL_HINT = "Onaylamak için: hermes kanban unblock {id}"
_LOCAL_PATH_RE = re.compile(r"(?<![\w:/])(?:/(?:Users|home|private|tmp|var|etc|workspace)/[^\s,;]+|"
                            r"[A-Za-z]:\\[^\s,;]+)")

Deliver = Callable[[str], bool]
# (key, title, markdown) -> None: hands one reading tab to Tern; returns at once.
Reader = Callable[[str, str, str], None]


# --- files -----------------------------------------------------------------------------------------

def data_dir(home: Optional[Path] = None) -> Path:
    """``<HERMES_HOME>/hermes-tern``: this fork's machine-local files (never synced)."""
    return (home or hermes_home()) / DIR


def write_json(path: Path, data: dict[str, Any]) -> None:
    """Atomic replace, so a reader in another process never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_target(home: Path) -> dict[str, Any]:
    return read_json(data_dir(home) / CONFIG_FILE) or {}


# --- formatting ------------------------------------------------------------------------------------

def _clip(text: Any, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _safe(text: Any, limit: int) -> str:
    """One line, secrets and local paths masked (the topic is a chat, not a log)."""
    value = str(text or "")
    try:
        from agent.redact import redact_sensitive_text
        value = redact_sensitive_text(value, force=True)
    except Exception:  # outside Hermes (tests)
        pass
    return _clip(_LOCAL_PATH_RE.sub("[yerel yol]", value), limit)


def _payload(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def format_event(event: dict[str, Any], board: str = "default") -> Optional[str]:
    """The message for one ``task_events`` row joined with its task; None for kinds we stay quiet on.

    ``event`` keys: ``id, task_id, kind, payload, title, assignee, status, created_by``."""
    kind = event.get("kind")
    if kind not in NOTIFY_KINDS:
        return None
    p = _payload(event.get("payload"))
    tid = event.get("task_id") or "?"
    title = _safe(event.get("title") or "(başlıksız)", TITLE_MAX)
    who = event.get("assignee") or p.get("assignee") or "atanmamış"
    prefix = "" if board in ("", "default", None) else f"[{board}] "
    head = f"{prefix}{tid} — {title}"
    if kind == "created":
        status = p.get("status") or event.get("status") or "?"
        lines = [f"🆕 Yeni kart: {head}", f"👤 {who} · durum: {status}"]
        if event.get("created_by"):
            lines[-1] += f" · oluşturan: {_clip(event['created_by'], 40)}"
        if status == "blocked":
            lines.append("⏸ ONAY BEKLİYOR — bu kart sizin onayınız olmadan çalışmaz.")
            lines.append(APPROVAL_HINT.format(id=tid))
        return "\n".join(lines)
    if kind == "assigned":
        before = p.get("from") or "atanmamış"
        return f"👤 Atandı: {head}\n{before} → {p.get('assignee') or who}"
    if kind == "claimed":
        return f"▶️ Başladı: {head}\n👤 {who}"
    if kind == "completed":
        summary = _safe(p.get("summary"), DETAIL_MAX)
        return f"✅ Tamamlandı: {head}" + (f"\n{summary}" if summary else "")
    if kind == "blocked":
        if p.get("reason") == "initial_status":
            return None  # the "created" message already says it waits for approval
        reason = _safe(p.get("reason"), DETAIL_MAX)
        lines = [f"⛔ Engellendi: {head}"]
        if reason:
            lines.append(f"Neden: {reason}")
        if p.get("kind") == "needs_input":
            lines.append(APPROVAL_HINT.format(id=tid))
        return "\n".join(lines)
    detail = _safe(p.get("error") or p.get("reason") or p.get("exit_kind"), DETAIL_MAX)
    return f"❌ Başarısız ({FAILED_KINDS[kind]}): {head}" + (f"\n{detail}" if detail else "")


# --- the tail --------------------------------------------------------------------------------------

_QUERY = (
    "SELECT e.id, e.task_id, e.kind, e.payload, e.created_at, t.title, t.assignee, t.status, t.created_by "
    "FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.id > ? ORDER BY e.id LIMIT ?")


def _open_ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def board_sources() -> list[tuple[str, Path]]:
    """``(slug, kanban.db)`` for every live board, through Hermes' own resolver."""
    from hermes_cli import kanban_db as kb
    try:
        boards = kb.list_boards(include_archived=False)
    except Exception:
        boards = [{"slug": kb.DEFAULT_BOARD}]
    return [(b.get("slug") or kb.DEFAULT_BOARD, kb.kanban_db_path(board=b.get("slug") or kb.DEFAULT_BOARD))
            for b in boards]


class Notifier:
    """One pass per ``tick``; holds the per-event failure counter between passes."""

    def __init__(self, home: Path, deliver: Deliver, sources: Callable[[], Iterable[tuple[str, Path]]] = board_sources,
                 now: Callable[[], float] = time.time, read: Optional[Reader] = None):
        self.home, self.deliver, self.sources, self.now, self.read = home, deliver, sources, now, read
        self.failures: dict[tuple[str, int], int] = {}

    @property
    def state_path(self) -> Path:
        return data_dir(self.home) / STATE_FILE

    def _cursors(self) -> dict[str, int]:
        state = read_json(self.state_path) or {}
        cursors = state.get("cursors")
        return {str(k): int(v) for k, v in cursors.items()} if isinstance(cursors, dict) else {}

    def _save(self, cursors: dict[str, int]) -> None:
        write_json(self.state_path, {"cursors": cursors, "updated_at": int(self.now())})

    def tick(self) -> int:
        """Handle the new events of every board; returns how many messages were delivered."""
        cursors = self._cursors()
        sent = 0
        for slug, path in self.sources():
            if not Path(path).exists():
                continue
            try:
                sent += self._board(slug, Path(path), cursors)
            except sqlite3.Error as exc:
                logger.debug("kanban-notify: board %s unreadable: %s", slug, exc)
        return sent

    def _board(self, slug: str, path: Path, cursors: dict[str, int]) -> int:
        conn = _open_ro(path)
        try:
            if slug not in cursors:
                row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM task_events").fetchone()
                cursors[slug] = int(row[0])
                self._save(cursors)
                return 0
            rows = [dict(r) for r in conn.execute(_QUERY, (cursors[slug], BATCH)).fetchall()]
        finally:
            conn.close()
        sent = 0
        for row in rows:
            text = format_event(row, slug)
            stale = (row.get("created_at") or 0) < self.now() - MAX_AGE_S
            if text and not stale:
                key = (slug, int(row["id"]))
                if not self._try(text, key):
                    break
                sent += 1
                self._reading(row, text)
            elif text:
                logger.info("kanban-notify: skipped stale event %s on %s", row["id"], slug)
            cursors[slug] = int(row["id"])
            self._save(cursors)
        return sent

    def _try(self, text: str, key: tuple[str, int]) -> bool:
        try:
            ok = bool(self.deliver(text))
        except Exception as exc:
            logger.warning("kanban-notify: delivery failed: %s", exc)
            ok = False
        if ok:
            self.failures.pop(key, None)
            return True
        count = self.failures[key] = self.failures.get(key, 0) + 1
        if count >= MAX_FAILURES:
            logger.warning("kanban-notify: dropping event %s on %s after %d failed sends", key[1], key[0], count)
            self.failures.pop(key, None)
            return True
        return False

    def _reading(self, row: dict[str, Any], text: str) -> None:
        if self.read is None:
            return
        title = _safe(row.get("title") or "(başlıksız)", TITLE_MAX)
        try:
            self.read(f"kanban-{row.get('task_id') or '?'}-{row.get('kind')}", f"📋 {title}", reading_markdown(text))
        except Exception as exc:
            logger.warning("kanban-notify: reading tab not queued: %s", exc)


# --- delivery --------------------------------------------------------------------------------------

def _runner() -> Any:
    run = sys.modules.get("gateway.run")
    ref = getattr(run, "_gateway_runner_ref", None)
    try:
        return ref() if callable(ref) else None
    except Exception:
        return None


def _append_log(home: Path, text: str) -> bool:
    path = data_dir(home) / LOG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}] {text}\n\n")
    return True


def send_to_topic(text: str, home: Optional[Path] = None) -> bool:
    """Send ``text`` to the configured Kanban topic through the gateway's live Telegram adapter.

    False when it could not be delivered now (no runner, adapter not connected, Telegram refused), so
    the caller retries; True once sent, or once logged when no topic is configured / ``dry_run``."""
    home = home or hermes_home()
    target = load_target(home)
    chat_id, thread_id = target.get("chat_id"), target.get("thread_id")
    if target.get("dry_run") or not chat_id or not thread_id:
        return _append_log(home, text)
    runner = _runner()
    loop = getattr(runner, "_gateway_loop", None)
    if runner is None or loop is None or not loop.is_running():
        return False
    from gateway.config import Platform
    try:
        platform = Platform(str(target.get("platform") or "telegram"))
    except ValueError:
        logger.warning("kanban-notify: unknown platform %r", target.get("platform"))
        return False
    adapter = (getattr(runner, "adapters", None) or {}).get(platform)
    if adapter is None:
        return False
    coro = adapter.send(str(chat_id), text, metadata={"thread_id": str(thread_id)})
    result = asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=SEND_TIMEOUT_S)
    if getattr(result, "success", True) is False:
        logger.warning("kanban-notify: Telegram refused: %s", getattr(result, "error", None))
        return False
    return True


# --- Tern reading tabs -----------------------------------------------------------------------------

def reading_markdown(text: str) -> str:
    """A Telegram message as Markdown: each line its own paragraph (Markdown would join them)."""
    return "\n\n".join(line for line in text.splitlines() if line.strip()) + "\n"


def tern_bridge() -> Optional[str]:
    """The ``tern-bridge`` CLI: on PATH, else where its installer puts it (``~/.local/bin``)."""
    return shutil.which("tern-bridge") or shutil.which("tern-bridge", path=str(Path.home() / ".local" / "bin"))


def run_read(key: str, title: str, markdown: str, *, run: Callable[..., Any] = subprocess.run,
             find: Callable[[], Optional[str]] = tern_bridge) -> bool:
    """``tern-bridge read --key KEY --title TITLE --from kanban -`` with ``markdown`` on stdin, on the calling
    thread under ``READ_TIMEOUT_S``. Any failure is logged once and reported as False."""
    exe = find()
    if not exe:
        logger.info("kanban-notify: tern-bridge not found; reading tab %s skipped", key)
        return False
    try:
        done = run([exe, "read", "--key", key, "--title", title, "--from", "kanban", "-"], input=markdown.encode("utf-8"),
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=READ_TIMEOUT_S,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as exc:  # a timeout, a missing file, a refused spawn: the tab is optional
        logger.warning("kanban-notify: tern-bridge read %s failed: %s", key, exc)
        return False
    if done.returncode:
        err = (done.stderr or b"").decode("utf-8", "replace").strip()[:200]
        logger.warning("kanban-notify: tern-bridge read %s exited %s: %s", key, done.returncode, err)
        return False
    return True


def queue_reading(key: str, title: str, markdown: str) -> None:
    """``run_read`` on a daemon thread: the notifier never waits for Tern."""
    threading.Thread(target=run_read, args=(key, title, markdown), name="hermes-tern:kanban-read", daemon=True).start()


# --- the gateway thread ----------------------------------------------------------------------------

def in_gateway_process() -> bool:
    """Only the messaging gateway imports ``gateway.run`` before loading plugins."""
    return "gateway.run" in sys.modules


def start_worker(name: str, body: Callable[[threading.Event], None]) -> Callable[[], None]:
    """Run ``body(stop)`` on a daemon thread called ``name`` with the caller's contextvars (profile
    scope). Threads of the same name (a previous plugin load) are told to stop and joined by the new
    thread before ``body`` runs, so two never work at once. Returns a stop function."""
    previous = [t for t in threading.enumerate() if t.name == name and getattr(t, "_ht_stop", None)]
    for old in previous:
        old._ht_stop.set()
    stop = threading.Event()

    def run() -> None:
        for old in previous:
            old.join(timeout=SEND_TIMEOUT_S * 2)
        if not stop.is_set():
            body(stop)

    ctx = contextvars.copy_context()
    thread = threading.Thread(target=ctx.run, args=(run,), name=name, daemon=True)
    thread._ht_stop = stop  # type: ignore[attr-defined]
    thread.start()

    def halt() -> None:
        stop.set()
        if thread is not threading.current_thread():
            thread.join(timeout=2)

    return halt


def run_loop(stop: threading.Event, tick: Callable[[], Any], *, interval: float, label: str) -> None:
    """Call ``tick`` every ``interval`` seconds while a gateway runner exists; give up when none
    appears within ``RUNNER_WAIT_S`` (this process is not the gateway)."""
    waited = 0.0
    while not stop.wait(interval):
        if _runner() is None:
            waited += interval
            if waited >= RUNNER_WAIT_S:
                logger.debug("%s: no gateway runner in this process; stopping", label)
                return
            continue
        waited = 0.0
        try:
            tick()
        except Exception:
            logger.warning("%s: tick failed", label, exc_info=True)


def register(ctx) -> None:
    if not in_gateway_process():
        return
    home = hermes_home()
    notifier = Notifier(home, lambda text: send_to_topic(text, home), read=queue_reading)
    halt = start_worker(THREAD_NAME, lambda stop: run_loop(stop, notifier.tick, interval=INTERVAL_S,
                                                           label="kanban-notify"))
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        on_unload(halt)
