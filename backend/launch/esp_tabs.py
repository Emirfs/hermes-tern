"""``hermes tern --esp-tabs``: the Tern session named ``ESP``, one tab per field box running
``hermes tern --device <id>``, each tab named after its box.

Idempotent: a box whose tab is there (named after the box, or showing its id, or running its device chat)
keeps it; a missing one gets a new tab; a tab whose program has ended is closed and opened again. The
session is made with the first missing box when there is none. Everything goes through Tern's own CLI
(``tern inspect --json``, ``tern new session|tab``, ``tern rename``, ``tern focus``, ``tern close``), in the
window of the pane it runs in (Tern's rule for ``$TERN_PANE``), so it works from any Tern pane.

Tern starts a tab's command in its own environment. On Windows it runs it through ``powershell.exe -c``,
which drops the double quotes inside arguments, so variables the tab needs (``HERMES_HOME`` of a profile)
ride a small Node launcher with the command line in one base64 word, as the frontend's splits do
(frontend/src/watch/spec.ts ``splitProgram``).
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from typing import Any, Callable, Optional, Sequence

SESSION = "ESP"
# frontend/src/watch/spec.ts WINDOWS_LAUNCHER, byte for byte.
WINDOWS_LAUNCHER = (
    "const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));"
    "const r=require('child_process').spawnSync(p.argv[0],p.argv.slice(1),{stdio:'inherit',env:Object.assign({},process.env,p.env)});"
    "if(r.error)console.error(r.error.message);process.exit(r.status==null?1:r.status)")

Runner = Callable[[Sequence[str]], str]


class TernError(RuntimeError):
    """A ``tern`` command failed; the message is what it said."""


def run_tern(args: Sequence[str]) -> str:
    """``tern ARGS`` answering its stdout; TernError with its stderr when it fails."""
    try:
        done = subprocess.run(["tern", *args], capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
    except FileNotFoundError as exc:
        raise TernError("the `tern` command was not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise TernError(f"`tern {' '.join(args)}` did not answer within 30s") from exc
    if done.returncode != 0:
        raise TernError((done.stderr or done.stdout or f"tern exited {done.returncode}").strip())
    return done.stdout


def tab_program(argv: Sequence[str], env: dict[str, str], *, node: Optional[str], platform: str = sys.platform) -> list[str]:
    """``argv`` as a tab's command line with ``env`` set first (``env VAR=… argv`` off Windows, the Node
    launcher on Windows; ``argv`` itself when there is nothing to set)."""
    if not env:
        return list(argv)
    if platform != "win32":
        return ["env", *(f"{k}={v}" for k, v in env.items()), *argv]
    if not node:
        raise TernError("Node.js was not found; it carries HERMES_HOME into the ESP tabs on Windows")
    payload = json.dumps({"argv": list(argv), "env": env}).encode("utf-8")
    return [node, "-e", WINDOWS_LAUNCHER, base64.b64encode(payload).decode("ascii")]


def _blocks(tab: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in tab.get("blocks") or [] if isinstance(b, dict)]


def find_tab(session: Optional[dict[str, Any]], device: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The tab of ``session`` that is ``device``'s: named after it, or one of its blocks titled with its id or
    running its device chat (``--device <id>``)."""
    name, dev = str(device["name"]).casefold(), str(device["id"]).casefold()
    for tab in (session or {}).get("tabs") or []:
        if str(tab.get("name") or "").casefold() == name or dev in str(tab.get("name") or "").casefold():
            return tab
        for block in _blocks(tab):
            words = " ".join(str(w) for w in (block.get("title"), block.get("command"), *(block.get("args") or [])))
            if dev in str(block.get("title") or "").casefold() or f"--device {dev}" in words.casefold():
                return tab
    return None


def _ended(tab: dict[str, Any]) -> bool:
    blocks = _blocks(tab)
    return bool(blocks) and all(b.get("exited") is not None for b in blocks)


def esp_session(run: Runner) -> Optional[dict[str, Any]]:
    """The window's session named ``ESP``, from ``tern inspect --json``."""
    try:
        state = json.loads(run(["inspect", "--json"]) or "{}")
    except ValueError as exc:
        raise TernError(f"`tern inspect --json` printed no JSON: {exc}") from exc
    return next((s for s in state.get("sessions") or [] if isinstance(s, dict) and s.get("name") == SESSION), None)


def open_tabs(devices: Sequence[dict[str, Any]], command: Callable[[dict[str, Any]], list[str]], *, run: Runner = run_tern,
              cwd: Optional[str] = None, focus: Optional[str] = None) -> list[dict[str, Any]]:
    """Opens what is missing of the ESP session for ``devices`` (``command(device)`` is a tab's command line)
    and shows ``focus``'s tab (a device id), else the first device's. Answers one row per device:
    ``{"id", "name", "block", "state": "kept" | "opened" | "reopened"}``."""
    if not devices:
        raise TernError("no provisioned field devices to open")
    session = esp_session(run)
    launch = ["--cwd", cwd] if cwd else []
    rows: list[dict[str, Any]] = []
    for device in devices:
        tab = find_tab(session, device)
        state = "kept"
        if tab is not None and _ended(tab):
            for block in _blocks(tab):
                run(["close", str(block["id"])])
            tab, state = None, "reopened"
        if tab is None:
            state = "opened" if state == "kept" else state
            where = ["new", "tab", SESSION] if session is not None else ["new", "session", SESSION]
            made = json.loads(run([*where, *launch, "--json", "--", *command(device)]) or "{}")
            block = made.get("block")
            run(["rename", str(block), str(device["name"])])
            # Every later device goes into the session just made.
            session = session or {"name": SESSION, "tabs": []}
        else:
            block = (_blocks(tab) or [{}])[0].get("id")
            if str(tab.get("name") or "") != str(device["name"]):
                run(["rename", str(block), str(device["name"])])
        rows.append({"id": device["id"], "name": device["name"], "block": block, "state": state})
    shown = next((r for r in rows if r["id"] == focus), rows[0])
    if shown["block"] is not None:
        run(["focus", str(shown["block"])])
    return rows
