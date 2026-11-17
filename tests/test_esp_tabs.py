"""esp_tabs.py against a fake `tern` CLI: the ESP session, a tab per box, idempotent."""

import base64
import json

import pytest

from hermes_tern_plugin.backend.launch import esp_tabs

LG = {"id": "fa-61d44cb4", "name": "LG klima kutusu"}
MHI = {"id": "fa-7ae9b284", "name": "MHI VRF gateway"}


class Tern:
    """The window's sessions as `tern inspect --json` shows them, changed by the commands the helper runs."""

    def __init__(self):
        self.sessions = []
        self.calls = []
        self.next = 10

    def __call__(self, args):
        self.calls.append(list(args))
        verb = args[0]
        if verb == "inspect":
            return json.dumps({"sessions": self.sessions})
        if verb == "new":
            command = list(args[args.index("--") + 1:])
            block = {"id": self.next, "title": "", "command": " ".join(command), "args": ["-c", " ".join(command)], "exited": None}
            tab = {"id": self.next + 1, "name": None, "blocks": [block]}
            self.next += 2
            if args[1] == "session":
                self.sessions.append({"name": args[2], "tabs": [tab]})
            else:
                next(s for s in self.sessions if s["name"] == args[2])["tabs"].append(tab)
            return json.dumps({"session": 1, "tab": tab["id"], "block": block["id"]})
        if verb == "rename":
            for tab in self.tabs():
                if any(b["id"] == int(args[1]) for b in tab["blocks"]):
                    tab["name"] = args[2]
            return ""
        if verb == "close":
            for s in self.sessions:
                s["tabs"] = [t for t in s["tabs"] if not any(b["id"] == int(args[1]) for b in t["blocks"])]
            return ""
        if verb == "focus":
            return ""
        raise AssertionError(args)

    def tabs(self):
        return [t for s in self.sessions for t in s["tabs"]]


def command(box):
    return ["hermes", "tern", "--device", box["id"]]


def test_the_first_run_makes_the_esp_session_with_a_named_tab_per_box():
    tern = Tern()
    rows = esp_tabs.open_tabs([LG, MHI], command, run=tern)
    assert [s["name"] for s in tern.sessions] == ["ESP"]
    assert [t["name"] for t in tern.tabs()] == ["LG klima kutusu", "MHI VRF gateway"]
    assert [r["state"] for r in rows] == ["opened", "opened"]
    assert tern.calls[1][:3] == ["new", "session", "ESP"] and tern.calls[1][-4:] == command(LG)
    assert tern.calls[3][:3] == ["new", "tab", "ESP"] and tern.calls[3][-4:] == command(MHI)
    assert tern.calls[-1] == ["focus", str(rows[0]["block"])]


def test_a_second_run_keeps_every_tab_and_focuses_the_asked_box():
    tern = Tern()
    esp_tabs.open_tabs([LG, MHI], command, run=tern)
    tern.calls.clear()
    rows = esp_tabs.open_tabs([LG, MHI], command, run=tern, focus=MHI["id"])
    assert [r["state"] for r in rows] == ["kept", "kept"]
    assert [c[0] for c in tern.calls] == ["inspect", "focus"] and tern.calls[-1] == ["focus", str(rows[1]["block"])]
    assert len(tern.tabs()) == 2


def test_a_missing_box_gets_its_tab_and_an_ended_one_is_opened_again():
    tern = Tern()
    esp_tabs.open_tabs([LG], command, run=tern)
    tern.tabs()[0]["blocks"][0]["exited"] = 1
    rows = esp_tabs.open_tabs([LG, MHI], command, run=tern)
    assert [r["state"] for r in rows] == ["reopened", "opened"]
    assert [t["name"] for t in tern.tabs()] == ["LG klima kutusu", "MHI VRF gateway"]


def test_a_tab_another_launcher_opened_is_found_by_its_device_chat():
    tern = Tern()
    tern.sessions = [{"name": "ESP", "tabs": [{"id": 2, "name": "lg", "blocks": [
        {"id": 3, "title": "", "command": "hermes tern --device fa-61d44cb4", "args": [], "exited": None}]}]}]
    rows = esp_tabs.open_tabs([LG], command, run=tern)
    assert rows[0]["state"] == "kept" and ["rename", "3", "LG klima kutusu"] in tern.calls


def test_no_boxes_is_an_error():
    with pytest.raises(esp_tabs.TernError):
        esp_tabs.open_tabs([], command, run=Tern())


def test_a_tab_program_carries_variables_through_tern():
    argv = ["C:\\h\\hermes.exe", "tern", "--device", "fa-1"]
    assert esp_tabs.tab_program(argv, {}, node=None, platform="win32") == argv
    assert esp_tabs.tab_program(argv, {"HERMES_HOME": "/h"}, node=None, platform="linux") == ["env", "HERMES_HOME=/h", *argv]
    node, flag, script, blob = esp_tabs.tab_program(argv, {"HERMES_HOME": "C:\\p"}, node="node.exe", platform="win32")
    assert (node, flag, script) == ("node.exe", "-e", esp_tabs.WINDOWS_LAUNCHER) and '"' not in script
    assert json.loads(base64.b64decode(blob)) == {"argv": argv, "env": {"HERMES_HOME": "C:\\p"}}
    with pytest.raises(esp_tabs.TernError):
        esp_tabs.tab_program(argv, {"HERMES_HOME": "C:\\p"}, node=None, platform="win32")
