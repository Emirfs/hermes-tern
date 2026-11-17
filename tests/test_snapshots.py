"""snapshots.py: /snapshot list, restore and prune over plugin RPC, on a fake hermes_cli.backup."""

import os
import types
from pathlib import Path

import pytest

from hermes_tern_plugin.backend.gateway import snapshots

SNAPS = [
    {"id": "20261117-120000-b", "label": "after", "timestamp": "2026-11-17T12:00:00", "file_count": 4,
     "total_size": 2048, "files": {"state.db": 1}},
    {"id": "20261116-090000-a", "label": None, "timestamp": "2026-11-16T09:00:00", "file_count": 3, "total_size": 10},
]


@pytest.fixture
def backup(monkeypatch, tmp_path):
    fake = types.SimpleNamespace(
        restored=[], pruned=[],
        list_quick_snapshots=lambda limit=20: SNAPS[:limit],
        quick_snapshot_dir=lambda sid: tmp_path / sid if sid in {s["id"] for s in SNAPS} else None,
    )
    fake.restore_quick_snapshot = lambda sid: fake.restored.append(sid) or True
    fake.prune_quick_snapshots = lambda keep=20: fake.pruned.append(keep) or max(0, len(SNAPS) - keep)
    monkeypatch.setattr(snapshots, "_backup", lambda: fake)
    monkeypatch.setattr(snapshots, "_home", lambda: tmp_path / "hermes")
    return fake


def owned_by(monkeypatch, pid):
    monkeypatch.setattr(snapshots, "_gateway_owner", lambda home: pid)


def test_list_reads_the_newest_first_with_the_total(backup, tmp_path):
    r = snapshots.list_snapshots({"limit": 1})
    assert r == {
        "snapshots": [{"id": "20261117-120000-b", "label": "after", "timestamp": "2026-11-17T12:00:00",
                       "file_count": 4, "total_size": 2048}],
        "total": 2,
        "dir": str(tmp_path / "hermes" / "state-snapshots"),
    }
    assert snapshots.list_snapshots({})["snapshots"][1]["label"] == ""


@pytest.mark.parametrize("limit", [0, -1, "3", True, snapshots.MAX_LIST + 1])
def test_list_refuses_a_bad_limit(backup, limit):
    with pytest.raises(ValueError, match="limit"):
        snapshots.list_snapshots({"limit": limit})


def test_restore_refuses_under_a_running_gateway_and_names_the_safe_way(backup, monkeypatch):
    owned_by(monkeypatch, os.getpid())
    r = snapshots.restore({"id": "2"})
    assert r["refused"] is True and r["restored"] is False
    assert r["id"] == "20261116-090000-a"  # #2 in the list is the older one
    assert f"pid {os.getpid()}" in r["reason"]
    assert "`hermes --cli`" in r["alternative"] and "`/snapshot restore 20261116-090000-a`" in r["alternative"]
    assert backup.restored == []


def test_restore_runs_hermes_restore_when_no_gateway_owns_the_profile(backup, monkeypatch):
    owned_by(monkeypatch, None)
    assert snapshots.restore({"id": "20261117-120000-b", "check": True}) == {
        "id": "20261117-120000-b", "restored": False, "refused": False}
    assert backup.restored == []
    assert snapshots.restore({"id": "1"})["restored"] is True
    assert backup.restored == ["20261117-120000-b"]


@pytest.mark.parametrize("ref, message", [
    ("", "needs a snapshot id"), (None, "needs a snapshot id"), ("3", "no snapshot #3"), ("0", "no snapshot #0"),
    ("nope", "no snapshot 'nope'"),
])
def test_restore_refuses_an_unknown_snapshot_before_anything_else(backup, monkeypatch, ref, message):
    owned_by(monkeypatch, None)
    with pytest.raises(ValueError, match=message):
        snapshots.restore({"id": ref})
    assert backup.restored == []


def test_prune_keeps_twenty_by_default_and_takes_a_count(backup):
    assert snapshots.prune({}) == {"deleted": 0, "keep": 20}
    assert snapshots.prune({"keep": 1}) == {"deleted": 1, "keep": 1}
    assert backup.pruned == [20, 1]
    with pytest.raises(ValueError, match="keep"):
        snapshots.prune({"keep": -1})
    assert backup.pruned == [20, 1]


def test_gateway_owner_is_this_process_when_it_holds_the_profile(monkeypatch):
    import sys
    ownership = types.ModuleType("gateway.runtime_ownership")
    ownership.held_by_this_process = lambda home: home == Path("mine")
    ownership.live_runtime_owner = lambda home: 4242 if home == Path("other") else None
    monkeypatch.setitem(sys.modules, "gateway", types.ModuleType("gateway"))
    monkeypatch.setitem(sys.modules, "gateway.runtime_ownership", ownership)
    assert snapshots._gateway_owner(Path("mine")) == os.getpid()
    assert snapshots._gateway_owner(Path("other")) == 4242
    assert snapshots._gateway_owner(Path("free")) is None
