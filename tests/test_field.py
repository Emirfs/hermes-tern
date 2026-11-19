"""field.py against a fake field-ai-box host folder: fake transport modules, no broker, no box."""

import json
import sqlite3
import sys
import threading
import textwrap
import time
import types

import pytest

from hermes_tern_plugin.backend.gateway import field, messaging
from hermes_tern_plugin.backend.shared import field_boxes

DEVICES = {"fa-61d44cb4": {"key": "00" * 32, "label": "field-ai-box", "name": "LG klima kutusu"},
           "fa-7ae9b284": {"key": "11" * 32, "label": "mhi-vrf-gateway", "name": "MHI VRF gateway"}}

# A FieldCloud that answers STATUS reads and records every command it is asked to send.
CLOUD = textwrap.dedent('''
    import os
    DEFAULT_DEVICES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "private", "devices.json")
    SENT = []
    OFFLINE = set()

    class FieldCloud:
        def __init__(self, devices_path=DEFAULT_DEVICES, on_event=None, client_tag="pc"):
            self.client_tag = client_tag
            self.closed = False

        async def connect(self):
            return ("broker", 8883)

        async def close(self):
            self.closed = True

        async def cmd(self, dev, cmd, timeout=8.0):
            SENT.append((dev, cmd, timeout))
            if dev in OFFLINE:
                raise TimeoutError(f"{dev} did not answer within {timeout}s (offline?)")
            return {"kind": "status", "cmd": cmd}
''')

TOPICS = {"fa-61d44cb4": {"thread_id": 1232, "name": "📟 LG klima kutusu · fa-61d44cb4"}}
TOPICS_MODULE = textwrap.dedent('''
    import json, os
    TOPICS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "private", "telegram_topics.json")
    def load_topics():
        return json.load(open(TOPICS, encoding="utf-8")) if os.path.exists(TOPICS) else {}
''')


@pytest.fixture
def box(tmp_path, monkeypatch):
    """A field-ai-box checkout and a Hermes home whose config names its MCP server."""
    repo = tmp_path / "field-ai-box"
    (repo / "host").mkdir(parents=True)
    (repo / "private").mkdir()
    (repo / "private" / "devices.json").write_text(json.dumps(DEVICES), encoding="utf-8")
    (repo / "private" / "telegram_topics.json").write_text(json.dumps(TOPICS), encoding="utf-8")
    (repo / "host" / "fieldai_cloud.py").write_text(CLOUD, encoding="utf-8")
    (repo / "host" / "fieldai_topics.py").write_text(TOPICS_MODULE, encoding="utf-8")
    home = tmp_path / "hermes"
    config = {"mcp_servers": {"field_ai": {"command": "python", "args": [str(repo / "host" / "field_ai_mcp.py")]}},
              "platforms": {"telegram": {"extra": {"dm_topics": [{"chat_id": 5795068189, "topics": [
                  {"name": "📟 MHI VRF gateway · fa-7ae9b284", "skill": "field-device-chat", "thread_id": 1409}]}]}}}}
    (home / "gateway_state.json").write_text(json.dumps(
        {"platforms": {"fieldai": {"state": "connected", "updated_at": "2026-11-17T07:37:16+00:00"}}}), encoding="utf-8")
    monkeypatch.setattr(messaging, "hermes_home", lambda: home)
    monkeypatch.setattr(messaging, "read_config", lambda _home: config)
    for name in ("fieldai_cloud", "fieldai_topics", "gateway.status", "gateway.run_api"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(field, "_inflight", {})
    yield types.SimpleNamespace(repo=repo, config=config)
    for name in ("fieldai_cloud", "fieldai_topics"):
        sys.modules.pop(name, None)


def adapter(online, last_seen, info):
    return types.SimpleNamespace(platform=types.SimpleNamespace(value="fieldai"), online=online, info=info,
                                 cloud=types.SimpleNamespace(last_seen=last_seen))


def test_host_dir_is_the_field_ai_servers_script_folder(box):
    assert field.host_dir(box.config) == box.repo / "host"
    assert field.host_dir({"mcp_servers": {"field_radio": {"args": ["x.py"]}}}) is None
    assert field.transport(box.config) == "cloud"
    assert field.transport({"mcp_servers": {"field_ai": {"env": {"FIELD_AI_TRANSPORT": "USB"}}}}) == "usb"


def test_devices_list_boxes_topics_and_what_the_platform_heard_without_keys(box, monkeypatch):
    runner = types.SimpleNamespace(adapters={"tg": types.SimpleNamespace(platform=types.SimpleNamespace(value="telegram")),
                                             "fa": adapter({"fa-61d44cb4": True}, {"fa-61d44cb4": 1794900000.5},
                                                           {"fa-61d44cb4": {"fw": "0.1.4", "ssid": "saha", "rssi": -61, "ip": None}})})
    monkeypatch.setitem(sys.modules, "gateway.run_api", types.SimpleNamespace(_ACTIVE_RUNNER=runner))
    out = field.devices({})
    assert "key" not in json.dumps(out["devices"])
    assert out["adapter"] is True and out["transport"] == "cloud"
    assert out["platform"]["state"] == "connected"
    lg, mhi = out["devices"]
    assert lg == {"id": "fa-61d44cb4", "name": "LG klima kutusu", "kind": "field-ai-box",
                  "topic": {"thread_id": 1232, "name": TOPICS["fa-61d44cb4"]["name"]},
                  "online": True, "last_seen": 1794900000.5, "fw": "0.1.4", "ssid": "saha", "rssi": -61}
    # A topic only config.yaml names is matched by the device id its name ends with.
    assert mhi["topic"] == {"thread_id": "1409", "name": "📟 MHI VRF gateway · fa-7ae9b284",
                            "chat_id": "5795068189", "target": "telegram:5795068189:1409"}
    assert mhi["online"] is None and mhi["last_seen"] is None


def test_devices_without_a_running_platform_say_nothing_was_heard(box):
    out = field.devices({})
    assert out["adapter"] is False
    assert [(d["online"], d["last_seen"]) for d in out["devices"]] == [(None, None), (None, None)]


def test_status_sends_only_the_read_commands(box):
    out = field.status({"device": "fa-61d44cb4"})
    cloud = sys.modules["fieldai_cloud"]
    assert [c for _, c, _ in cloud.SENT] == ["STATUS", "STM STATUS", "STM RF STATUS"]
    assert {c for _, c, _ in cloud.SENT} <= {c for _, c in field.READS}
    assert all(t == field.COMMAND_TIMEOUT_S for _, _, t in cloud.SENT)
    assert out["device"] == "fa-61d44cb4" and out["transport"] == "cloud" and out["errors"] == {}
    assert out["reads"] == {"esp": {"kind": "status", "cmd": "STATUS"}, "stm32": {"kind": "status", "cmd": "STM STATUS"},
                            "rf": {"kind": "status", "cmd": "STM RF STATUS"}}


def test_an_offline_box_stops_at_the_first_unanswered_read(box):
    field.registry(box.repo / "host")  # imports the fake transport
    sys.modules["fieldai_cloud"].OFFLINE.add("fa-7ae9b284")
    out = field.status({"device": "fa-7ae9b284"})
    assert [c for _, c, _ in sys.modules["fieldai_cloud"].SENT] == ["STATUS"]
    assert out["reads"] == {} and "offline" in out["errors"]["esp"]


@pytest.mark.parametrize("device", [None, "", "fa-unknown", "../../etc", 42])
def test_status_refuses_anything_but_a_provisioned_box(box, device):
    with pytest.raises(ValueError):
        field.status({"device": device})


def test_a_hung_query_answers_with_a_timeout_instead_of_holding_the_call(box, monkeypatch):
    monkeypatch.setattr(field, "QUERY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(field, "GRACE_S", 0)
    release = threading.Event()
    try:
        out = field.status({"device": "fa-61d44cb4"}, run=lambda *a: release.wait(5))
    finally:
        release.set()
    assert out["reads"] == {} and "no answer" in out["errors"]["query"]


class Authorities:
    """``runner.session_authorities``: which served profile owns which home."""

    def __init__(self, homes):
        self.homes = homes  # home path -> profile name (None: the launch profile)

    def for_home(self, home):
        return home if str(home) in self.homes else None

    def profile_name(self, home):
        return self.homes[str(home)]


def test_another_served_profiles_adapter_is_never_read(box, monkeypatch):
    home = messaging.hermes_home()
    launch = adapter({"fa-61d44cb4": True}, {"fa-61d44cb4": 1.0}, {})
    mimar = adapter({"fa-61d44cb4": False}, {"fa-61d44cb4": 2.0}, {})
    runner = types.SimpleNamespace(adapters={"fa": launch}, _profile_adapters={"mimar": {"fa": mimar}},
                                   session_authorities=Authorities({str(home): "mimar"}))
    monkeypatch.setitem(sys.modules, "gateway.run_api", types.SimpleNamespace(_ACTIVE_RUNNER=runner))
    assert field.devices({})["devices"][0]["last_seen"] == 2.0
    runner.session_authorities = Authorities({str(home): None})
    assert field.devices({})["devices"][0]["last_seen"] == 1.0
    # A home this gateway does not serve gets no adapter at all, not the launch profile's.
    runner.session_authorities = Authorities({})
    out = field.devices({})
    assert out["adapter"] is False and out["devices"][0]["online"] is None


LINK = textwrap.dedent('''
    SENT = []
    OFFLINE = False

    def _exchange(command, kind, timeout=2.0):
        SENT.append((command, kind, timeout))
        if OFFLINE:
            raise TimeoutError(f"no {kind!r} reply for {command!r} on COM11")
        return {"kind": kind, "cmd": command}
''')


def test_usb_transport_reads_over_the_cable_with_the_same_read_only_commands(box, monkeypatch):
    box.config["mcp_servers"]["field_ai"]["env"] = {"FIELD_AI_TRANSPORT": "usb"}
    (box.repo / "host" / "field_ai_link.py").write_text(LINK, encoding="utf-8")
    monkeypatch.delitem(sys.modules, "field_ai_link", raising=False)
    out = field.status({"device": "fa-61d44cb4"})
    link = sys.modules["field_ai_link"]
    assert link.SENT == [("STATUS", "status", field.COMMAND_TIMEOUT_S), ("STM STATUS", "status", field.COMMAND_TIMEOUT_S),
                         ("STM RF STATUS", "rf", field.COMMAND_TIMEOUT_S)]
    assert out["transport"] == "usb" and out["errors"] == {} and set(out["reads"]) == {"esp", "stm32", "rf"}
    assert "fieldai_cloud" not in sys.modules or sys.modules["fieldai_cloud"].SENT == []

    link.SENT.clear()
    link.OFFLINE = True
    out = field.status({"device": "fa-61d44cb4"})
    assert [c for c, _, _ in link.SENT] == ["STATUS"] and "COM11" in out["errors"]["esp"]

    # The cable reaches whichever box is plugged in: another box's answer is not filed under this id.
    link.OFFLINE = False
    monkeypatch.setattr(link, "_exchange", lambda command, kind, timeout=2.0: {"kind": kind, "device_id": "fa-7ae9b284"})
    out = field.status({"device": "fa-61d44cb4"})
    assert out["reads"] == {} and out["errors"] == {"device": "the box on the USB cable is fa-7ae9b284, not fa-61d44cb4"}
    sys.modules.pop("field_ai_link", None)


# ── Device tabs: the topic's open session (shared/field_boxes.py, field.session) ─────────────────

LG_KEY = "agent:main:telegram:dm:5795068189:1232"
MHI_KEY = "agent:main:telegram:dm:5795068189:1409"


def seed(home, rows):
    """A state.db whose sessions table has the columns the device tab reads, holding ``rows``."""
    conn = sqlite3.connect(home / "state.db")
    conn.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, session_key TEXT, chat_id TEXT, "
                 "chat_type TEXT, thread_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, parent_session_id TEXT)")
    for r in rows:
        conn.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (r["id"], r.get("source", "telegram"), r["key"], r["key"].split(":")[-2], "dm", r["key"].split(":")[-1],
                      r["at"], r.get("ended"), r.get("reason"), r.get("parent")))
    conn.commit()
    conn.close()


def test_a_device_is_named_by_id_alias_or_part_of_its_name(box):
    devices = json.loads((box.repo / "private" / "devices.json").read_text(encoding="utf-8"))
    devices["fa-7ae9b284"]["aliases"] = ["vrf", 3]
    (box.repo / "private" / "devices.json").write_text(json.dumps(devices), encoding="utf-8")
    rows = field_boxes.boxes(box.config)
    assert "key" not in json.dumps(rows)
    pick = lambda q: field_boxes.resolve_device(q, rows)["id"]  # noqa: E731
    assert pick("fa-61d44cb4") == pick("FA-61D44CB4") == "fa-61d44cb4"
    assert pick("VRF") == pick("mhi-vrf-gateway") == "fa-7ae9b284"
    assert pick("lg klima kutusu") == "fa-61d44cb4"
    assert pick("fa-7a") == "fa-7ae9b284"
    assert pick("klima") == "fa-61d44cb4" and pick("mhi") == "fa-7ae9b284"
    with pytest.raises(LookupError, match="several devices"):
        pick("fa-")
    with pytest.raises(LookupError, match="no device 'daikin'; known: fa-61d44cb4"):
        pick("daikin")
    with pytest.raises(LookupError):
        pick("  ")


def test_a_topic_without_an_open_session_has_its_key_and_no_session(box):
    home = messaging.hermes_home()
    rows = {b["id"]: b for b in field_boxes.boxes(box.config)}
    # No state.db yet, then one where the topic's last session ended.
    mhi = field_boxes.topic_session(home, rows["fa-7ae9b284"])
    assert (mhi["session_id"], mhi["session_key"], mhi["thread_id"]) == (None, MHI_KEY, 1409)
    seed(home, [{"id": "s1", "key": MHI_KEY, "at": 1.0, "ended": 2.0, "reason": "session_reset"}])
    assert field_boxes.topic_session(home, rows["fa-7ae9b284"])["session_id"] is None


def test_the_open_session_is_the_newest_unended_row_of_the_topic(box):
    home = messaging.hermes_home()
    seed(home, [{"id": "old", "key": LG_KEY, "at": 1.0, "ended": 2.0, "reason": "session_reset"},
                {"id": "now", "key": LG_KEY, "at": 3.0, "parent": "old"},
                {"id": "other", "key": MHI_KEY, "at": 9.0},
                {"id": "cli", "key": LG_KEY, "at": 10.0, "source": "cli"}])
    lg = {b["id"]: b for b in field_boxes.boxes(box.config)}["fa-61d44cb4"]
    # The topics file names no chat: its thread alone finds the rows, and their key names the topic.
    assert lg["chat_id"] is None
    out = field_boxes.topic_session(home, lg)
    assert (out["session_id"], out["session_key"], out["rotated"], out["ended_reason"]) == ("now", LG_KEY, False, None)


def test_a_session_reset_rotates_but_a_compression_does_not(box):
    home = messaging.hermes_home()
    mhi = {b["id"]: b for b in field_boxes.boxes(box.config)}["fa-7ae9b284"]
    seed(home, [{"id": "a", "key": MHI_KEY, "at": 1.0, "ended": 2.0, "reason": "compression"},
                {"id": "b", "key": MHI_KEY, "at": 2.0, "parent": "a"}])
    out = field_boxes.topic_session(home, mhi, current="a")
    assert (out["session_id"], out["rotated"], out["ended_reason"]) == ("b", False, "compression")
    seed(home, [{"id": "b", "key": MHI_KEY, "at": 2.0, "parent": "a", "ended": 5.0, "reason": "session_reset"},
                {"id": "c", "key": MHI_KEY, "at": 5.0, "parent": "b"}])
    out = field_boxes.topic_session(home, mhi, current="a")
    assert (out["session_id"], out["rotated"]) == ("c", True)
    out = field_boxes.topic_session(home, mhi, current="b")
    assert (out["session_id"], out["rotated"], out["ended_reason"]) == ("c", True, "session_reset")
    assert field_boxes.topic_session(home, mhi, current="c")["rotated"] is False


def test_list_devices_is_the_c1_json_array(box):
    home = messaging.hermes_home()
    seed(home, [{"id": "now", "key": LG_KEY, "at": 3.0}])
    assert field_boxes.listing(home, box.config) == [
        {"id": "fa-61d44cb4", "name": "LG klima kutusu", "thread_id": 1232, "session_key": LG_KEY, "session_id": "now",
         "platform": "telegram"},
        {"id": "fa-7ae9b284", "name": "MHI VRF gateway", "thread_id": 1409, "session_key": MHI_KEY, "session_id": None,
         "platform": "telegram"}]


def test_the_session_rpc_follows_the_topic_and_adds_the_heartbeat(box, monkeypatch):
    home = messaging.hermes_home()
    seed(home, [{"id": "s1", "key": MHI_KEY, "at": 1.0, "ended": 2.0, "reason": "session_reset"},
                {"id": "s2", "key": MHI_KEY, "at": 2.0, "parent": "s1"}])
    runner = types.SimpleNamespace(adapters={"fa": adapter({"fa-7ae9b284": False}, {"fa-7ae9b284": 7.0}, {})})
    monkeypatch.setitem(sys.modules, "gateway.run_api", types.SimpleNamespace(_ACTIVE_RUNNER=runner))
    out = field.session({"device": "fa-7ae9b284", "current": "s1"})
    assert out["session_id"] == "s2" and out["rotated"] is True and out["ended_reason"] == "session_reset"
    assert out["online"] is False and out["last_seen"] == 7.0 and out["name"] == "MHI VRF gateway"
    assert field.session({"device": "fa-7ae9b284"})["rotated"] is False
    for bad in ({"device": "fa-unknown"}, {"device": "../x"}, {"device": "fa-7ae9b284", "current": 3}):
        with pytest.raises(ValueError):
            field.session(bad)


# ── The device agent's side panel (field.agent): mission, journal, vault note ──────────────────────

MHI = "fa-7ae9b284"

# The vault library's read_device as the hafiza slice publishes it.
NOTES_MODULE = textwrap.dedent('''
    def read_device(vault, device):
        return {"summary": "", "decisions": [], "open": [], "facts": [
            {"field": "b2.bit0", "meaning": "power", "status": "verified", "evidence": "capture:a", "updated": "2026-11-19"},
            {"field": "family 0707 b4", "meaning": "mode?", "status": "candidate", "evidence": "", "updated": "2026-11-18"},
            "not a fact"]}
''')


def journal(repo, rows, *, device=MHI):
    """``rows`` as the journal's lines: dicts as JSON, strings verbatim."""
    path = repo / "private" / "agents" / device / "journal.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(r if isinstance(r, str) else json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return path


def entry(id, kind, ts, **extra):
    return {"id": id, "ts": ts, "device": MHI, "kind": kind, "title": f"{kind} {id}", "body": "", "evidence": "", **extra}


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "hafiza"
    (root / ".tools").mkdir(parents=True)
    (root / "devices").mkdir()
    monkeypatch.setenv("HAFIZA_DIR", str(root))
    monkeypatch.setattr(field, "_notes_module", {})
    return root


def test_agent_lists_open_help_requests_decisions_and_work_newest_first(box, vault):
    (box.repo / "missions").mkdir()
    (box.repo / "missions" / f"{MHI}.md").write_text("# Görev\nMHI VRF protokolünü çöz.", encoding="utf-8")
    (vault / ".tools" / "device_notes.py").write_text(NOTES_MODULE, encoding="utf-8")
    (vault / "devices" / f"{MHI}.md").write_text("---\ntype: device\n---\n", encoding="utf-8")
    journal(box.repo, [
        entry("h1", "help_request", 1.0, status="open"),
        entry("d1", "decision", 2.0),
        "not json",
        "[1, 2]",
        entry("h2", "help_request", 3.0, status="open"),
        entry("r1", "report", 4.0),
        {"id": "x1", "ts": 5.0, "device": MHI, "kind": "help_done", "ref": "h1"},
        entry("w1", "wake", 6.0, reason="kutu yeniden çevrimiçi", trigger="event"),
        entry("p1", "protocol_finding", 7.0, field="b2.bit0", meaning="power", status="verified"),
        entry("f1", "followup", 8.0, due_ts=99.0, reason="tekrar bak"),
        entry("u1", "some_future_kind", 9.0),
        {**entry("o1", "decision", 10.0), "device": "fa-61d44cb4"},
        entry("d2", "decision", 11.0, extra_field={"ignored": True}),
        entry("h3", "help_request", 12.0, status="open"),
    ])
    out = field.agent({"device": MHI})
    assert out["device"] == MHI and out["mission"].startswith("# Görev") and out["errors"] == {}
    assert [h["id"] for h in out["help_requests"]] == ["h3", "h2"]
    assert [d["id"] for d in out["decisions"]] == ["d2", "d1"]
    assert [r["id"] for r in out["reports"]] == ["w1", "r1"]
    assert out["reports"][0]["reason"] == "kutu yeniden çevrimiçi" and out["reports"][0]["trigger"] == "event"
    assert set(out["decisions"][0]) == {"id", "ts", "kind", "title", "body", "evidence"}
    assert [f["field"] for f in out["facts"]] == ["b2.bit0", "family 0707 b4"]
    assert out["facts"][1] == {"field": "family 0707 b4", "meaning": "mode?", "status": "candidate", "evidence": "",
                               "updated": "2026-11-18"}


def test_agent_keeps_the_newest_and_breaks_ties_by_line_order(box, vault):
    rows = [entry(f"d{i}", "decision", float(i)) for i in range(25)]
    rows += [entry("t1", "report", 50.0), entry("t2", "report", 50.0), entry("nots", "report", None)]
    journal(box.repo, rows)
    out = field.agent({"device": MHI})
    assert [d["id"] for d in out["decisions"]] == [f"d{i}" for i in range(24, 4, -1)]
    assert [r["id"] for r in out["reports"]] == ["t2", "t1", "nots"]
    journal(box.repo, [entry(f"r{i}", "report", 100.0 + i) for i in range(35)])
    reports = field.agent({"device": MHI})["reports"]
    assert len(reports) == field.REPORTS_KEPT and (reports[0]["id"], reports[-1]["id"]) == ("r34", "r5")


def test_agent_reads_missing_files_as_empty_without_writing(box, vault):
    out = field.agent({"device": MHI})
    assert out == {"device": MHI, "mission": "", "help_requests": [], "decisions": [], "reports": [], "facts": [],
                   "errors": {}}
    assert not (box.repo / "private" / "agents").exists() and not (box.repo / "missions").exists()
    assert list((vault / "devices").iterdir()) == []


def test_the_vault_library_is_not_asked_for_a_note_that_does_not_exist(box, vault):
    (vault / ".tools" / "device_notes.py").write_text(NOTES_MODULE, encoding="utf-8")
    assert field.agent({"device": MHI})["facts"] == []
    assert field._notes_module == {}


def test_a_broken_vault_library_leaves_the_map_empty_and_says_why(box, vault):
    (vault / ".tools" / "device_notes.py").write_text("raise RuntimeError('half written')\n", encoding="utf-8")
    (vault / "devices" / f"{MHI}.md").write_text("", encoding="utf-8")
    journal(box.repo, [entry("d1", "decision", 1.0)])
    out = field.agent({"device": MHI})
    assert out["facts"] == [] and "half written" in out["errors"]["facts"]
    assert [d["id"] for d in out["decisions"]] == ["d1"]


def test_the_vault_is_the_folder_above_the_hafiza_server_config_runs(box, monkeypatch):
    monkeypatch.delenv("HAFIZA_DIR", raising=False)
    assert field.vault_dir(box.config) is None
    config = {"mcp_servers": {**box.config["mcp_servers"], "hafiza": {"command": "python", "args": [
        "-B", "C:/x/hafiza/.tools/hafiza_mcp.py"]}}}
    assert field.vault_dir(config).as_posix() == "C:/x/hafiza"
    monkeypatch.setenv("HAFIZA_DIR", "/elsewhere")
    assert field.vault_dir(config).as_posix() == "/elsewhere"


@pytest.mark.parametrize("device", [None, "", "..", "../x", "fa-unknown", 42])
def test_agent_refuses_anything_but_a_provisioned_box(box, device):
    with pytest.raises(ValueError):
        field.agent({"device": device})
