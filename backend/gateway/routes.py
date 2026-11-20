"""The model route a messaging chat's next turn resolves, for the pane that shows it.

The shared gateway's ``session.info`` and ``model.options`` describe a messaging chat (a Telegram topic, a
device tab's box) by config.yaml's default model: neither applies the chat's ``channel_overrides`` entry or
its own ``/model`` pick, so a device tab showed no model, and its picker checked a model the chat does not
run. ``plugin.hermes-tern.session.route`` ``{session_id}`` answers what the chat's next turn will use,
from the gateway's own resolution (session ``/model`` > ``channel_overrides`` > config.yaml):

- ``{"messaging": true, "model", "provider", "reasoning_effort", "reasoning_effort_wire", "service_tier",
  "fast"}`` for a live messaging chat;
- ``{"messaging": false}`` for a local session (its ``session.info`` already says it) or one this gateway
  does not hold.

It only reads: it builds no agent, resolves no credentials and changes no override.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

ROUTE_METHOD = "session.route"


def _live(session_id: str) -> Optional[tuple[Any, Any]]:
    """The gateway runner and the live session ``session_id`` names on this profile's authority (also
    through a compressed conversation's resident agent), else None."""
    runner = getattr(sys.modules.get("gateway.run_api"), "_ACTIVE_RUNNER", None)
    if runner is None:
        return None
    from gateway.session_authorities import active_authority
    from gateway.session_plugin_rpc import _live as live_of
    authority = active_authority(runner)
    found = live_of(authority, session_id) if authority is not None else None
    return (runner, found[1]) if found else None


def route(params: dict, *, session_id: Optional[str] = None, **_: Any) -> dict[str, Any]:
    sid = session_id or params.get("session_id")
    if not isinstance(sid, str) or not sid:
        raise ValueError("session.route needs the session_id of the chat it reads")
    found = _live(sid)
    if found is None:
        return {"messaging": False}
    runner, live = found
    from gateway.config import Platform
    if live.source.platform == Platform.LOCAL:
        return {"messaging": False}
    from gateway.platforms.session_model import _resolve_session_model_settings
    from gateway.run import _load_gateway_config
    from gateway.session_messaging_picks import messaging_route_info
    info = messaging_route_info(runner, live)
    # The same precedence for the provider, which messaging_route_info resolves but does not return.
    settings = _resolve_session_model_settings(runner, live.source, _load_gateway_config() or {})
    return {"messaging": True, **info, "provider": str(settings.get("provider") or "")}


def register(ctx) -> None:
    ctx.register_rpc(ROUTE_METHOD, route)
