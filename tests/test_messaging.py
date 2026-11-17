"""messaging.py: the platforms' state and the send targets, from a fake profile home (no gateway)."""

import contextlib
import json
import os
import sys
import types

import pytest

from hermes_tern_plugin.backend.gateway import messaging

STATE = {
    "pid": 41972, "gateway_state": "running", "updated_at": "2026-11-17T08:25:32+00:00", "code_version": "0.23.2",
    "platforms": {
        "telegram": {"state": "connected", "error_code": None, "error_message": None, "needs_attention": False,
                     "updated_at": "2026-11-17T07:37:16+00:00", "retrying_since": None},
        "whatsapp": {"state": "disconnected", "error_code": None, "error_message": None, "needs_attention": True,
                     "updated_at": "2026-11-17T08:21:02+00:00", "retrying_since": "2026-11-16T09:25:50+00:00"},
        "fieldai": {"state": "connected", "needs_attention": False, "updated_at": "2026-11-17T07:37:16+00:00"},
        "mimar:discord": {"state": "fatal", "error_code": "discord_auth_error", "error_message": "401",
                          "needs_attention": False},
    },
}

DIRECTORY = {"platforms": {
    "telegram": [{"id": "5795068189:1409", "name": "📟 MHI VRF gateway · fa-7ae9b284", "type": "dm", "thread_id": "1409"},
                 {"id": "5795068189", "name": "Dayum", "type": "dm", "thread_id": None}],
    "fieldai": [{"id": "fa-61d44cb4", "name": "Field AI fa-61d44cb4", "type": "dm"}],
    "whatsapp": [],
}}

CONFIG = """
platforms:
  telegram:
    extra:
      dm_topics:
      - chat_id: 5795068189
        topics:
        - name: "📟 LG klima kutusu · fa-61d44cb4"
          skill: field-device-chat
          thread_id: 1232
        - name: "📟 MHI VRF gateway · fa-7ae9b284"
          skill: field-device-chat
          thread_id: 1409
"""


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "hermes"
    monkeypatch.setattr(messaging, "hermes_home", lambda: path)
    # No gateway in this process: the snapshot comes from the file.
    monkeypatch.delitem(sys.modules, "gateway.status", raising=False)
    return path


def write(home, name, value):
    (home / name).write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")


def test_status_reads_the_file_and_puts_the_broken_platforms_first(home):
    write(home, "gateway_state.json", STATE)
    out = messaging.status({})
    assert out["source"] == "file"
    assert out["gateway"] == {"state": "running", "pid": 41972, "updated_at": STATE["updated_at"], "version": "0.23.2"}
    assert [(r["profile"], r["name"], r["needs_attention"]) for r in out["platforms"]] == [
        (None, "whatsapp", True), ("mimar", "discord", True), (None, "fieldai", False), (None, "telegram", False)]
    whatsapp = out["platforms"][0]
    # A retrying platform has been down since it started retrying.
    assert whatsapp["since"] == "2026-11-16T09:25:50+00:00" and whatsapp["state"] == "disconnected"
    # A fatal platform needs attention even when the gateway did not flag it.
    assert out["platforms"][1]["error_code"] == "discord_auth_error"


def test_status_prefers_the_gateways_own_memory_when_this_process_is_that_gateway(home, monkeypatch):
    write(home, "gateway_state.json", STATE)
    live = {**STATE, "pid": os.getpid(), "platforms": {"whatsapp": {"state": "connected"}}}
    monkeypatch.setitem(sys.modules, "gateway.status", types.SimpleNamespace(
        _runtime_status_state=live, _runtime_status_state_path=home / "gateway_state.json"))
    out = messaging.status({})
    assert out["source"] == "live"
    assert [(r["name"], r["state"], r["needs_attention"]) for r in out["platforms"]] == [("whatsapp", "connected", False)]


def test_another_homes_memory_is_not_this_profiles(home, monkeypatch, tmp_path):
    write(home, "gateway_state.json", STATE)
    monkeypatch.setitem(sys.modules, "gateway.status", types.SimpleNamespace(
        _runtime_status_state={"pid": os.getpid(), "platforms": {}}, _runtime_status_state_path=tmp_path / "x.json"))
    assert messaging.status({})["source"] == "file"


def test_no_state_file_is_no_platforms(home):
    assert messaging.status({}) == {"source": "none", "gateway": None, "platforms": []}


def test_targets_join_home_channels_config_topics_and_the_directory_without_duplicates(home):
    write(home, "gateway_state.json", STATE)
    write(home, "channel_directory.json", DIRECTORY)
    write(home, "config.yaml", CONFIG)
    out = messaging.targets({})["targets"]
    assert [t["target"] for t in out] == [
        "whatsapp", "fieldai", "telegram",
        "telegram:5795068189:1232", "telegram:5795068189:1409",
        "telegram:5795068189", "fieldai:fa-61d44cb4"]
    lg = out[3]
    assert lg == {"target": "telegram:5795068189:1232", "platform": "telegram", "name": "📟 LG klima kutusu · fa-61d44cb4",
                  "kind": "topic", "origin": "dm_topics", "skill": "field-device-chat"}
    assert out[0]["kind"] == "home"


def test_targets_survive_unreadable_files(home):
    write(home, "channel_directory.json", "not json")
    write(home, "config.yaml", ": : bad yaml [")
    assert messaging.targets({}) == {"targets": []}


@pytest.fixture
def token(home, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delitem(sys.modules, "gateway.platforms._shared", raising=False)
    write(home, ".env", 'OTHER=1\nTELEGRAM_BOT_TOKEN="123:secret"\n')
    return "123:secret"


def test_check_asks_get_me_with_the_profiles_token_and_never_returns_it(token):
    seen = []
    out = messaging.check({"platform": "telegram"}, get_me=lambda t: seen.append(t) or {
        "ok": True, "result": {"username": "emir_hermes_bot", "has_topics_enabled": True}})
    assert seen == [token]
    assert out == {"ok": True, "detail": "the token is @emir_hermes_bot's", "username": "emir_hermes_bot", "topics": True}


def test_check_reports_a_refused_token_and_an_unreachable_telegram_without_the_token(token):
    refused = messaging.check({"platform": "telegram"}, get_me=lambda t: {"ok": False, "description": "Unauthorized"})
    assert refused == {"ok": False, "detail": "Telegram refused the token: Unauthorized"}

    def down(t):
        raise OSError(f"cannot reach https://api.telegram.org/bot{t}/getMe")
    out = messaging.check({"platform": "telegram"}, get_me=down)
    assert out["ok"] is False and token not in out["detail"] and "<token>" in out["detail"]


def test_check_without_a_token_says_so(home, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delitem(sys.modules, "gateway.platforms._shared", raising=False)
    assert messaging.check({"platform": "telegram"}, get_me=pytest.fail) == {
        "ok": False, "detail": "no TELEGRAM_BOT_TOKEN is set for this profile"}


def test_check_refuses_other_platforms(home):
    with pytest.raises(ValueError):
        messaging.check({"platform": "whatsapp"})


class Db:
    def __init__(self, rows):
        self.rows = rows

    def get_session(self, sid):
        return self.rows.get(sid)


def test_chats_name_each_messaging_session_by_its_topic_or_chat(home, monkeypatch):
    write(home, "gateway_state.json", STATE)
    write(home, "channel_directory.json", DIRECTORY)
    write(home, "config.yaml", CONFIG)
    rows = {
        "topic": {"source": "telegram", "chat_id": "5795068189", "thread_id": 1232, "chat_type": "dm", "display_name": "Emir"},
        "dm": {"source": "telegram", "chat_id": 5795068189, "thread_id": None, "chat_type": "dm"},
        "group": {"source": "whatsapp", "chat_id": "1203@g.us", "thread_id": "", "display_name": "Saha ekibi"},
        "local": {"source": "tui", "chat_id": None},
    }
    monkeypatch.setattr(messaging.sessions, "database", lambda: contextlib.nullcontext(Db(rows)))
    out = messaging.chats({"ids": ["topic", "dm", "group", "local", "gone", 7]})["chats"]
    assert out == {
        "topic": {"platform": "telegram", "chat_id": "5795068189", "thread_id": "1232", "chat_type": "dm",
                  "target": "telegram:5795068189:1232", "name": "📟 LG klima kutusu · fa-61d44cb4"},
        "dm": {"platform": "telegram", "chat_id": "5795068189", "thread_id": None, "chat_type": "dm",
               "target": "telegram:5795068189", "name": "Dayum"},
        "group": {"platform": "whatsapp", "chat_id": "1203@g.us", "thread_id": None, "chat_type": None,
                  "target": "whatsapp:1203@g.us", "name": "Saha ekibi"},
    }


def test_chats_without_a_database_answer_nothing(home, monkeypatch):
    def broken():
        raise RuntimeError("no hermes_state")
    monkeypatch.setattr(messaging.sessions, "database", broken)
    assert messaging.chats({"ids": ["a"]}) == {"chats": {}}


def test_a_scoped_secret_miss_never_borrows_the_launch_profiles_token(home, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "default-profile-secret")
    monkeypatch.setitem(sys.modules, "gateway.platforms._shared", types.SimpleNamespace(get_scoped_secret=lambda *a: None))
    assert messaging._secret(home, "TELEGRAM_BOT_TOKEN") is None
