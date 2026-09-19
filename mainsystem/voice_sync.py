"""Update this project's existing ElevenLabs client tools and private agent.

API shapes verified against the official update-tool documentation and installed
ElevenLabs 2.68 SDK: PATCH /v1/convai/tools/{id} takes tool_config, and PATCH
/v1/convai/agents/{id} accepts a partial conversation_config. Audio settings are
never sent. This module does not start a voice session.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .providers import check_base, ProviderError
from .voice import PROMPT, cloud_tool_config, tool_configs, voice_tool_configs


class VoiceSyncHTTPError(ProviderError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"ElevenLabs sync returned HTTP {status}")


def _request(base, key, method, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(base + path, body, method=method,
        headers={"Content-Type": "application/json", "xi-api-key": key})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise VoiceSyncHTTPError(error.code) from None
    except (OSError, ValueError) as error:
        raise ProviderError(f"ElevenLabs sync failed: {type(error).__name__}") from None


def _write(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def sync_voice(dry_run=False):
    """Checkpoint successful creates, reuse known IDs, and patch only owned fields."""
    key, agent_id = os.getenv("ELEVENLABS_API_KEY"), os.getenv("ELEVENLABS_AGENT_ID")
    if not key or not agent_id:
        raise RuntimeError("Configure the existing ElevenLabs key and agent ID locally first")
    base = check_base(os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io"))
    out = Path("runtime")
    checkpoint = out / "eleven-created.json"
    if not checkpoint.exists():
        raise RuntimeError("Missing local resource checkpoint; cannot verify which tools this project created")
    state = json.loads(checkpoint.read_text(encoding="utf-8"))
    configs = {config["name"]: cloud_tool_config(config) for config in voice_tool_configs()}
    owned_names = {config["name"] for config in tool_configs()} | set(configs)
    if state.get("agent_id") != agent_id:
        raise RuntimeError("Configured agent does not match this project's creation checkpoint")
    known = state.get("tools")
    if (not isinstance(known, dict) or not known or set(known) - owned_names
            or any(not isinstance(value, str) or not value for value in known.values())
            or len(set(known.values())) != len(known)):
        raise RuntimeError("Invalid or unexpected tool resource checkpoint")
    if state.get("pending_create"):
        raise RuntimeError("A previous tool creation has an uncertain outcome. Reconcile pending_create with ElevenLabs before retrying")

    call = lambda method, path, payload=None: _request(base, key, method, path, payload)
    agent_path = "/v1/convai/agents/" + urllib.parse.quote(agent_id, safe="")
    agent = call("GET", agent_path)
    if (agent.get("agent_id") != agent_id or agent.get("name") != "ShopSwarm customer agent"
            or agent.get("access_info", {}).get("is_creator") is False
            or agent.get("platform_settings", {}).get("auth", {}).get("enable_auth") is not True):
        raise RuntimeError("The checkpoint must refer to the existing private ShopSwarm customer agent")
    prompt_before = agent.get("conversation_config", {}).get("agent", {}).get("prompt", {})
    if set(prompt_before.get("tool_ids", [])) - set(known.values()):
        raise RuntimeError("Agent includes tools outside this project's checkpoint; review before changing its tools")
    tools_before = {}
    for name, tool_id in known.items():
        existing = call("GET", "/v1/convai/tools/" + urllib.parse.quote(tool_id, safe=""))
        config = existing.get("tool_config", {})
        if (existing.get("id") != tool_id or config.get("type") != "client" or config.get("name") != name
                or existing.get("access_info", {}).get("is_creator") is False):
            raise RuntimeError("A recorded tool no longer matches this project's client tool")
        tools_before[name] = {"id": tool_id, "tool_config": config}

    plan = {"agent_id": agent_id, "update_tools": [name for name in configs if name in known],
            "create_tools": [name for name in configs if name not in known], "tool_count": len(configs),
            "detach_tools": [name for name in known if name not in configs]}
    _write(out / "eleven-sync-plan.json", plan)
    if dry_run:
        print(f"Voice sync plan: update {len(plan['update_tools'])} tools, create {len(plan['create_tools'])}, detach {len(plan['detach_tools'])}; no cloud changes made")
        return plan

    # Back up only the fields we change. Client tool schemas contain no API keys;
    # omit unrelated agent settings, auth secrets, and connector configuration.
    _write(out / f"eleven-sync-before-{time.time_ns()}.json", {
        "agent_id": agent_id,
        "prompt": {"prompt": prompt_before.get("prompt"), "tool_ids": prompt_before.get("tool_ids", [])},
        "tools": tools_before,
    })
    for name, config in configs.items():
        if name in known:
            call("PATCH", "/v1/convai/tools/" + urllib.parse.quote(known[name], safe=""), {"tool_config": config})
        else:
            # A dropped response must not cause a blind duplicate POST on retry.
            state["pending_create"] = name
            _write(checkpoint, state)
            try:
                created = call("POST", "/v1/convai/tools", {"tool_config": config})
            except VoiceSyncHTTPError as error:
                # A schema validation rejection is definitive: no create ran.
                # Timeouts, transport errors and other statuses remain uncertain.
                if error.status == 422:
                    state.pop("pending_create", None)
                    _write(checkpoint, state)
                raise
            tool_id = created.get("id")
            if not isinstance(tool_id, str) or not tool_id or tool_id in known.values():
                raise RuntimeError("Tool create did not return a unique ID; reconcile the pending creation")
            known[name] = tool_id
            state.pop("pending_create")
            _write(checkpoint, state)

    tool_ids = [known[name] for name in configs]
    state["pending_voice_route"] = "mel-supervisor"
    _write(checkpoint, state)
    # A partial PATCH preserves the selected voice, feedback settings, first
    # message, model, and every other unrelated conversation/platform setting.
    call("PATCH", agent_path, {"conversation_config": {"agent": {"prompt": {"prompt": PROMPT, "tool_ids": tool_ids}}}})
    verified = call("GET", agent_path)
    prompt_after = verified.get("conversation_config", {}).get("agent", {}).get("prompt", {})
    if (prompt_after.get("prompt") != PROMPT or prompt_after.get("tool_ids") != tool_ids
            or verified.get("platform_settings", {}).get("auth", {}).get("enable_auth") is not True):
        raise RuntimeError("Voice sync verification failed; review the saved before configuration")
    before_conversation = agent.get("conversation_config", {})
    after_conversation = verified.get("conversation_config", {})
    for section in ("tts", "asr", "turn", "conversation"):
        if before_conversation.get(section) != after_conversation.get(section):
            raise RuntimeError("An unrelated voice setting changed during sync; review the agent configuration")
    before_agent = before_conversation.get("agent", {})
    after_agent = after_conversation.get("agent", {})
    if (before_agent.get("first_message") != after_agent.get("first_message")
            or prompt_before.get("llm") != prompt_after.get("llm")):
        raise RuntimeError("The greeting or model changed during sync; review the agent configuration")
    state["synced_tool_count"] = len(configs)
    state["voice_route"] = "mel-supervisor"
    state.pop("pending_voice_route", None)
    _write(checkpoint, state)
    print(f"Updated the existing private ShopSwarm agent with {len(configs)} client tools; voice settings preserved")
    return plan
