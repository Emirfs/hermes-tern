"""kanban_notify.py without a gateway: message formatting, the task_events tail and its dedupe."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

import pytest

from hermes_tern_plugin.backend.gateway import kanban_notify as kn


def ev(kind, payload=None, **extra):
    row = {"id": 1, "task_id": "t_abc", "kind": kind, "payload": json.dumps(payload or {}), "title": "Rapor yaz",
           "assignee": "kodcu", "status": "ready", "created_by": "carly"}
    row.update(extra)
    return row


def test_created_says_who_and_status():
    text = kn.format_event(ev("created", {"assignee": "kodcu", "status": "ready"}))
    assert text.startswith("🆕 Yeni kart: t_abc — Rapor yaz")
    assert "kodcu" in text and "durum: ready" in text and "oluşturan: carly" in text
    assert "ONAY" not in text


def test_a_card_created_blocked_says_it_waits_for_approval_and_how_to_give_it():
    text = kn.format_event(ev("created", {"status": "blocked"}))
    assert "ONAY BEKLİYOR" in text and "hermes kanban unblock t_abc" in text
    # The paired initial "blocked" event is folded into the created message.
    assert kn.format_event(ev("blocked", {"reason": "initial_status"})) is None


@pytest.mark.parametrize("kind,payload,expect", [
    ("assigned", {"assignee": "mimar", "from": "kodcu"}, "👤 Atandı: t_abc — Rapor yaz\nkodcu → mimar"),
    ("claimed", {"run_id": 3}, "▶️ Başladı: t_abc — Rapor yaz\n👤 kodcu"),
    ("completed", {"summary": "bitti, 3 dosya"}, "✅ Tamamlandı: t_abc — Rapor yaz\nbitti, 3 dosya"),
    ("blocked", {"reason": "anahtar lazım", "kind": "needs_input"}, "⛔ Engellendi: t_abc — Rapor yaz\nNeden: anahtar lazım"),
    ("gave_up", {"error": "model yok"}, "❌ Başarısız (vazgeçildi): t_abc — Rapor yaz\nmodel yok"),
    ("crashed", {}, "❌ Başarısız (çöktü): t_abc — Rapor yaz"),
    ("timed_out", {}, "❌ Başarısız (zaman aşımı): t_abc — Rapor yaz"),
])
def test_each_notified_kind(kind, payload, expect):
    assert kn.format_event(ev(kind, payload)).startswith(expect)


def test_quiet_kinds_and_board_prefix():
    assert kn.format_event(ev("heartbeat")) is None and kn.format_event(ev("commented")) is None
    assert kn.format_event(ev("claimed"), "saha").startswith("▶️ Başladı: [saha] t_abc")


def test_long_text_and_local_paths_are_trimmed():
    text = kn.format_event(ev("completed", {"summary": "yazıldı C:\\Users\\emir\\gizli.txt " + "x" * 900}))
    assert "C:\\Users" not in text and "[yerel yol]" in text
    assert len(text.splitlines()[1]) <= kn.DETAIL_MAX


# --- the tail ---

SCHEMA = """
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, created_by TEXT);
CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
                          kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
"""


class Board:
    def __init__(self, path: Path):
        self.path = path
        with sqlite3.connect(path) as conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT INTO tasks VALUES ('t1', 'İlk iş', 'kodcu', 'ready', 'user')")

    def add(self, kind, payload=None, at=None):
        with sqlite3.connect(self.path) as conn:
            conn.execute("INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t1', ?, ?, ?)",
                         (kind, json.dumps(payload or {}), int(at or time.time())))


@pytest.fixture()
def board(tmp_path):
    return Board(tmp_path / "kanban.db")


@pytest.fixture()
def home(tmp_path):
    h = tmp_path / "home"
    h.mkdir()
    return h


def notifier(home, board, sink, ok=lambda: True):
    def deliver(text):
        if not ok():
            return False
        sink.append(text)
        return True
    return kn.Notifier(home, deliver, sources=lambda: [("default", board.path)])


def test_first_pass_starts_at_the_newest_event_then_sends_new_ones_in_order(home, board):
    board.add("created", {"status": "ready"})
    sent = []
    n = notifier(home, board, sent)
    assert n.tick() == 0 and sent == []  # no history replay
    board.add("claimed")
    board.add("heartbeat")
    board.add("completed", {"summary": "tamam"})
    assert n.tick() == 2
    assert [s.split(":")[0] for s in sent] == ["▶️ Başladı", "✅ Tamamlandı"]
    state = json.loads((home / "hermes-tern" / kn.STATE_FILE).read_text(encoding="utf-8"))
    assert state["cursors"]["default"] == 4


def test_a_reload_continues_from_the_saved_cursor_without_resending(home, board):
    sent = []
    notifier(home, board, sent).tick()
    board.add("claimed")
    notifier(home, board, sent).tick()
    again = notifier(home, board, sent)  # a plugin reload: fresh object, same files
    assert again.tick() == 0 and len(sent) == 1


def test_a_failed_send_is_retried_then_dropped(home, board, monkeypatch):
    sent, up = [], {"ok": False}
    n = notifier(home, board, sent, ok=lambda: up["ok"])
    n.tick()
    board.add("claimed")
    board.add("completed")
    assert n.tick() == 0 and sent == []
    up["ok"] = True
    assert n.tick() == 2  # retried, in order
    up["ok"] = False
    board.add("crashed")
    monkeypatch.setattr(kn, "MAX_FAILURES", 3)
    for _ in range(3):
        n.tick()
    up["ok"] = True
    board.add("claimed")
    assert n.tick() == 1 and sent[-1].startswith("▶️")  # the crashed event was dropped, not stuck


def test_stale_events_are_skipped(home, board):
    sent = []
    n = notifier(home, board, sent)
    n.tick()
    board.add("claimed", at=time.time() - kn.MAX_AGE_S - 10)
    assert n.tick() == 0 and sent == []
    board.add("completed")
    assert n.tick() == 1


def test_without_a_topic_messages_go_to_the_log(home):
    assert kn.send_to_topic("deneme", home) is True
    assert "deneme" in (home / "hermes-tern" / kn.LOG_FILE).read_text(encoding="utf-8")
    kn.write_json(home / "hermes-tern" / kn.CONFIG_FILE, {"chat_id": "1", "thread_id": 2, "dry_run": True})
    assert kn.send_to_topic("ikinci", home) is True
    assert "ikinci" in (home / "hermes-tern" / kn.LOG_FILE).read_text(encoding="utf-8")


def test_with_a_topic_but_no_gateway_it_waits(home):
    kn.write_json(home / "hermes-tern" / kn.CONFIG_FILE, {"platform": "telegram", "chat_id": "1", "thread_id": 2})
    assert kn.send_to_topic("bekle", home) is False


def test_a_new_worker_replaces_the_previous_one_of_the_same_name():
    started, first_done = threading.Event(), threading.Event()

    def first(stop):
        started.set()
        stop.wait(10)
        first_done.set()

    kn.start_worker("hermes-tern:test-worker", first)
    assert started.wait(2)
    ran = threading.Event()

    def second(stop):
        assert first_done.is_set()  # the old one finished before this started
        ran.set()

    halt = kn.start_worker("hermes-tern:test-worker", second)
    assert ran.wait(5)
    halt()


def test_register_outside_the_gateway_starts_nothing(monkeypatch):
    monkeypatch.delitem(__import__("sys").modules, "gateway.run", raising=False)
    before = {t.name for t in threading.enumerate()}
    kn.register(object())
    assert kn.THREAD_NAME not in {t.name for t in threading.enumerate()} - before


# --- Tern reading tabs (tern-bridge read): fake runners only, no job is ever enqueued ---

def test_each_delivered_message_also_queues_a_reading_tab(home, board):
    sent, tabs, up = [], [], {"ok": True}

    def deliver(text):
        if up["ok"]:
            sent.append(text)
        return up["ok"]

    n = kn.Notifier(home, deliver, sources=lambda: [("default", board.path)], read=lambda *tab: tabs.append(tab))
    n.tick()
    board.add("claimed")
    board.add("heartbeat")
    board.add("completed", {"summary": "rapor hazır"})
    assert n.tick() == 2
    assert [(key, title) for key, title, _ in tabs] == [("kanban-t1-claimed", "📋 İlk iş"), ("kanban-t1-completed", "📋 İlk iş")]
    assert tabs[1][2] == "✅ Tamamlandı: t1 — İlk iş\n\nrapor hazır\n" and sent[1] == "✅ Tamamlandı: t1 — İlk iş\nrapor hazır"
    up["ok"] = False
    board.add("blocked", {"reason": "girdi lazım"})
    assert n.tick() == 0 and len(tabs) == 2  # nothing delivered, no tab


def test_a_failing_reader_never_holds_the_telegram_message(home, board):
    sent = []

    def broken(*_):
        raise RuntimeError("tern-bridge yok")

    n = kn.Notifier(home, lambda t: sent.append(t) or True, sources=lambda: [("default", board.path)], read=broken)
    n.tick()
    board.add("claimed")
    board.add("completed")
    assert n.tick() == 2 and len(sent) == 2
    assert n.tick() == 0  # the cursor moved on: nothing is resent


class FakeRun:
    def __init__(self, returncode=0, raises=None):
        self.calls, self.returncode, self.raises = [], returncode, raises

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if self.raises:
            raise self.raises
        return subprocess.CompletedProcess(argv, self.returncode, b"", b"bozuk")


def test_run_read_hands_the_markdown_to_tern_bridge_read_on_stdin():
    run = FakeRun()
    assert kn.run_read("kanban-t1-claimed", "📋 İlk iş", "▶️ Başladı\n", run=run, find=lambda: "C:/bin/tern-bridge.cmd")
    (argv, kw), = run.calls
    assert argv == ["C:/bin/tern-bridge.cmd", "read", "--key", "kanban-t1-claimed", "--title", "📋 İlk iş",
                    "--from", "kanban", "-"]
    assert kw["input"] == "▶️ Başladı\n".encode("utf-8") and kw["timeout"] == kn.READ_TIMEOUT_S


def test_run_read_swallows_a_missing_cli_a_timeout_and_a_failed_exit(caplog):
    run = FakeRun()
    assert kn.run_read("k", "t", "m", run=run, find=lambda: None) is False and run.calls == []
    timeout = subprocess.TimeoutExpired(["tern-bridge"], kn.READ_TIMEOUT_S)
    assert kn.run_read("k", "t", "m", run=FakeRun(raises=timeout), find=lambda: "tb") is False
    assert kn.run_read("k", "t", "m", run=FakeRun(returncode=2), find=lambda: "tb") is False
    assert any("exited 2: bozuk" in r.getMessage() for r in caplog.records)


def test_queue_reading_returns_before_tern_bridge_answers(monkeypatch):
    release, called = threading.Event(), threading.Event()

    def slow(*tab):
        called.set()
        release.wait(5)

    monkeypatch.setattr(kn, "run_read", slow)
    kn.queue_reading("k", "t", "m")
    assert called.wait(2)  # it runs, on its own thread, while this one goes on
    release.set()
