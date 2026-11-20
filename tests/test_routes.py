"""routes.py: the model route a messaging chat's next turn resolves, read from the gateway's own resolution."""

import sys
import types
from enum import Enum

import pytest

from hermes_tern_plugin.backend.gateway import routes


class Platform(Enum):
    LOCAL = "local"
    TELEGRAM = "telegram"


def _session(platform):
    return types.SimpleNamespace(source=types.SimpleNamespace(platform=platform), route="agent:main:telegram:dm:1:7")


@pytest.fixture
def gateway(monkeypatch):
    """A gateway holding sessions by id; the chat's provider is what core's settings resolution answers."""
    held = {}
    runner = types.SimpleNamespace()
    modules = {
        "gateway.run_api": types.SimpleNamespace(_ACTIVE_RUNNER=runner),
        "gateway.run": types.SimpleNamespace(_load_gateway_config=lambda: {"model": {"provider": "anthropic"}}),
        "gateway.session_authorities": types.SimpleNamespace(active_authority=lambda r: "authority"),
        "gateway.session_plugin_rpc": types.SimpleNamespace(
            _live=lambda authority, sid: (sid, held[sid]) if sid in held else None),
        "gateway.config": types.SimpleNamespace(Platform=Platform),
        "gateway.platforms.session_model": types.SimpleNamespace(
            _resolve_session_model_settings=lambda r, source, cfg: {"session_key": "k", "model": "gpt-6.1-sol",
                                                                    "provider": "openai-codex", "base_url": ""}),
        "gateway.session_messaging_picks": types.SimpleNamespace(
            messaging_route_info=lambda r, live: {"model": "gpt-6.1-sol", "reasoning_effort": "high",
                                                  "reasoning_effort_wire": "high", "service_tier": "", "fast": False}),
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    return held, runner


def test_a_messaging_chat_answers_the_model_and_provider_its_next_turn_runs(gateway):
    held, runner = gateway
    held["tg"] = _session(Platform.TELEGRAM)
    assert routes.route({}, session_id="tg") == {
        "messaging": True, "model": "gpt-6.1-sol", "provider": "openai-codex", "reasoning_effort": "high",
        "reasoning_effort_wire": "high", "service_tier": "", "fast": False}


def test_a_local_session_or_one_the_gateway_does_not_hold_is_not_messaging(gateway):
    held, _ = gateway
    held["local"] = _session(Platform.LOCAL)
    assert routes.route({}, session_id="local") == {"messaging": False}
    assert routes.route({}, session_id="gone") == {"messaging": False}


def test_outside_the_gateway_process_nothing_is_messaging(monkeypatch):
    monkeypatch.setitem(sys.modules, "gateway.run_api", types.SimpleNamespace(_ACTIVE_RUNNER=None))
    assert routes.route({}, session_id="tg") == {"messaging": False}


def test_a_call_without_a_session_fails():
    with pytest.raises(ValueError):
        routes.route({}, session_id=None)
