"""Quick state snapshots (``<HERMES_HOME>/state-snapshots/``) for ``/snapshot`` in Tern.

``/snapshot create`` runs ``hermes backup --quick`` through ``cli.exec``; ``hermes`` has no command for
the rest, which only the classic CLI's ``/snapshot`` did. These plugin RPC methods call the same
Hermes functions it calls (``hermes_cli/backup.py``):

- ``plugin.hermes-tern.snapshots.list`` ``{limit?}``: the newest snapshots first, and how many there are.
- ``plugin.hermes-tern.snapshots.prune`` ``{keep?}``: deletes all but the ``keep`` newest (20 by default).
- ``plugin.hermes-tern.snapshots.restore`` ``{id, check?}``: ``id`` is a snapshot id or its number in
  the list (1 is the newest). A restore replaces the profile's ``state.db``, config and cron files, so
  it runs only while no gateway owns the profile. These methods run inside the gateway, which owns
  it: the answer then refuses and names what does it safely (the classic CLI's ``/snapshot restore``
  pauses the gateway around the restore). ``check`` resolves the id and answers whether it would
  run, without restoring.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

DEFAULT_KEEP = 20  # the classic CLI's /snapshot prune default
MAX_LIST = 500
ALL = 10**6  # list_quick_snapshots' limit for "every one" (the classic CLI's own)


def _backup():
    from hermes_cli import backup
    return backup


def _home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def _gateway_owner(home: Path) -> Optional[int]:
    """The pid of the gateway that owns ``home`` (this process when the gateway runs this plugin), else None."""
    from gateway.runtime_ownership import held_by_this_process, live_runtime_owner
    if held_by_this_process(home):
        return os.getpid()
    return live_runtime_owner(home)


def _row(snap: dict) -> dict[str, Any]:
    return {
        "id": str(snap.get("id") or ""),
        "label": snap.get("label") or "",
        "timestamp": snap.get("timestamp") or "",
        "file_count": int(snap.get("file_count") or 0),
        "total_size": int(snap.get("total_size") or 0),
    }


def _int(params: dict, key: str, default: int, low: int, high: int) -> int:
    raw = params.get(key, default)
    if isinstance(raw, bool) or not isinstance(raw, int) or not low <= raw <= high:
        raise ValueError(f"{key} must be a whole number from {low} to {high}")
    return raw


def list_snapshots(params: dict, **_: Any) -> dict[str, Any]:
    limit = _int(params, "limit", 50, 1, MAX_LIST)
    snaps = _backup().list_quick_snapshots(limit=ALL)
    return {
        "snapshots": [_row(s) for s in snaps[:limit]],
        "total": len(snaps),
        "dir": str(_home() / "state-snapshots"),
    }


def _resolve(ref: Any) -> str:
    """A snapshot id from ``ref``: its id, or its number in the list (1 = newest), as the classic CLI takes it."""
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError("restore needs a snapshot id or its number in /snapshot list")
    ref = ref.strip()
    backup = _backup()
    if ref.isdecimal():
        snaps = backup.list_quick_snapshots(limit=ALL)
        n = int(ref)
        if not 1 <= n <= len(snaps):
            raise ValueError(f"no snapshot #{n}: /snapshot list numbers 1 to {len(snaps)}")
        return str(snaps[n - 1]["id"])
    if backup.quick_snapshot_dir(ref) is None:
        raise ValueError(f"no snapshot {ref!r}: /snapshot list shows the ids")
    return ref


def restore_alternative(snap_id: str) -> str:
    return (f"In a terminal, run `hermes --cli` and type `/snapshot restore {snap_id}`: the classic CLI pauses "
            "the gateway for the restore and starts it again (Telegram/WhatsApp are offline for those "
            f"seconds). Or stop the gateway (`hermes gateway stop`), run `/snapshot restore {snap_id}` in "
            "`hermes --cli`, then `hermes gateway start`.")


def restore(params: dict, **_: Any) -> dict[str, Any]:
    snap_id = _resolve(params.get("id"))
    owner = _gateway_owner(_home())
    if owner is not None:
        return {
            "id": snap_id, "restored": False, "refused": True,
            "reason": (f"The gateway (pid {owner}) owns this profile: restoring would replace its state.db, "
                       "config and cron files under it, and it serves your messaging platforms too."),
            "alternative": restore_alternative(snap_id),
        }
    if params.get("check") is True:
        return {"id": snap_id, "restored": False, "refused": False}
    return {"id": snap_id, "restored": bool(_backup().restore_quick_snapshot(snap_id)), "refused": False}


def prune(params: dict, **_: Any) -> dict[str, Any]:
    keep = _int(params, "keep", DEFAULT_KEEP, 0, ALL)
    return {"deleted": int(_backup().prune_quick_snapshots(keep=keep)), "keep": keep}


def register(ctx) -> None:
    ctx.register_rpc("snapshots.list", list_snapshots)
    ctx.register_rpc("snapshots.restore", restore)
    ctx.register_rpc("snapshots.prune", prune)
