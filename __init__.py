"""Hermes for Tern.

``hermes tern [flags]`` runs this plugin's frontend (``frontend/dist/entry.js``) in the terminal, which
draws the chat with Tern's own components over the Tern Surface Protocol and attaches to the profile's
gateway itself (``launcher.py``). In a terminal that does not answer the protocol's handshake it
says so and exits.

In a Tern pane whose last ``hermes tern`` died (a crash, a kill, Tern's daemon restarting), a launch
with no session flag resumes the conversation that pane showed (``panes.py``); ``--new`` starts fresh.
"""

from .backend.gateway import (
    charts, field, figure_check, kanban_notify, messaging, peer, pull_requests, render_hints, routes, snapshots,
    tern_env, viewers)
from .backend.launch import launcher


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (runs in a Tern pane only)",
        setup_fn=launcher.setup, handler_fn=launcher.run,
        description="Runs the Tern frontend against this profile's gateway. It needs a Tern pane.")
    # The chart rules of background processes (frontend/src/processes/widgets, charts.py):
    # its own `auxiliary.tern_charts` config block and model picker entry, and the RPC that runs it.
    ctx.register_auxiliary_task(
        charts.TASK, display_name="Tern job charts",
        description="Writes the rules behind a background process's live chart in `hermes tern`, once per process.")
    charts.register(ctx)
    pull_requests.register(ctx)
    viewers.register(ctx)
    tern_env.register(ctx)
    render_hints.register(ctx)
    figure_check.register(ctx)
    # This fork's additions: snapshots, the messaging gateway's platforms and inbox, field devices, and the
    # model route a messaging chat (a device tab) really runs.
    snapshots.register(ctx)
    messaging.register(ctx)
    field.register(ctx)
    routes.register(ctx)
    # Kanban events of every creator to the Telegram "Kanban" topic, and the GitHub peer mesh (its tools
    # everywhere, its poller in the gateway only).
    kanban_notify.register(ctx)
    peer.register(ctx)
