"""Mel relay and portable chat-completions adapters. No SDK required for core."""
import asyncio
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field


class ProviderError(RuntimeError):
    pass


@dataclass
class Reply:
    text: str = ""
    calls: list = field(default_factory=list)
    usage: dict = field(default_factory=dict)


def check_base(url):
    p = urllib.parse.urlsplit(url)
    if p.username or p.password or p.query or p.fragment:
        raise ProviderError("Use an API base URL without credentials, query, or fragment")
    if p.scheme != "https" and not (p.scheme == "http" and p.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise ProviderError("API URLs require HTTPS, except a local development service")
    if not p.netloc:
        raise ProviderError("Missing API host")
    return url.rstrip("/")


def request_json(url, payload=None, headers=None, timeout=25):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, body, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        # Never include upstream bodies/headers: they may contain credentials or prompts.
        raise ProviderError(f"API returned HTTP {e.code}; check account, URL, and quota") from None
    except (OSError, ValueError) as e:
        raise ProviderError(f"API connection/JSON error: {type(e).__name__}") from None


def parse_mel(lines):
    reply = Reply()
    terminal = False
    for raw in lines:
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ProviderError("Malformed Mel NDJSON stream") from None
        if not isinstance(event, dict): raise ProviderError("Mel event must be an object")
        kind = event.get("event")
        if kind == "error":
            raise ProviderError("Mel reported a streaming error; inspect account status in Mel")
        if kind == "token":
            reply.text += event.get("text", "")
        if kind == "tool_calls":
            reply.calls.extend(event.get("calls", []))
            reply.usage.update(event.get("usage") or {})
            terminal = True
        if kind == "done":
            reply.usage.update(event.get("usage") or {})
            terminal = True
        # Intentionally do not log thinking events or private reasoning.
    if not terminal:
        raise ProviderError("Mel stream ended without done or tool_calls")
    return reply


class MelProvider:
    name = "mel"
    def __init__(self, tool_role="worker"):
        if tool_role not in {"worker", "orchestrator"}:
            raise ProviderError("Unsupported Mel tool role")
        self.tool_role = tool_role
        self.base = check_base(os.environ.get("MEL_RELAY_URL", ""))
        self.token = os.environ.get("MEL_TOKEN", "")
        if not self.token:
            raise ProviderError("MEL_TOKEN is missing; obtain an authorized session through documented sign-in")
        self.device_id = os.environ.get("MEL_DEVICE_ID", "shopswarm-laptop")
        self.project_id = hashlib.sha256(os.path.abspath(os.getcwd()).encode()).hexdigest()[:12]

    def _call(self, role, conversation_id, turn_id, messages, tools):
        payload = {
            "device_id": self.device_id, "turn_id": turn_id,
            "model": os.environ.get("MEL_MODEL", "auto"), "bias": "responsive",
            "autonomous": False, "tool_role": self.tool_role, "project_id": self.project_id,
            "cwd": os.getcwd(), "conversation_id": conversation_id,
            "messages": messages, "tools": tools,
        }
        req = urllib.request.Request(self.base + "/v1/agent/stream", json.dumps(payload).encode(), headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
            "Accept": "application/x-ndjson",
        })
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                return parse_mel(response)
        except urllib.error.HTTPError as e:
            raise ProviderError(f"Mel HTTP {e.code}; no silent switch to simulation") from None
        except OSError as e:
            raise ProviderError(f"Mel transport failed: {type(e).__name__}") from None

    async def complete(self, role, conversation_id, turn_id, messages, tools):
        return await asyncio.to_thread(self._call, role, conversation_id, turn_id, messages, tools)


class ChatProvider:
    """Explicit BYOK fallback for providers supporting /chat/completions."""
    name = "chat"
    def __init__(self):
        self.base = check_base(os.environ.get("LLM_BASE_URL", ""))
        self.key = os.environ.get("LLM_API_KEY", "")
        self.model = os.environ.get("LLM_MODEL", "")
        if not self.key or not self.model:
            raise ProviderError("Set LLM_API_KEY and an available LLM_MODEL for this provider")

    async def complete(self, role, conversation_id, turn_id, messages, tools):
        wire_messages = []
        for message in messages:
            msg = dict(message)
            if msg.get("tool_calls"):
                msg["tool_calls"] = [{"id": c["id"], "type": "function", "function": {
                    "name": c["name"], "arguments": c["arguments"]}} for c in msg["tool_calls"]]
            wire_messages.append(msg)
        data = await asyncio.to_thread(request_json, self.base + "/chat/completions", {
            "model": self.model, "messages": wire_messages,
            "tools": [{"type": "function", "function": tool} for tool in tools],
        }, {"Authorization": "Bearer " + self.key})
        message = data["choices"][0]["message"]
        return Reply(message.get("content") or "", [
            {"id": c["id"], "name": c["function"]["name"], "arguments": c["function"]["arguments"]}
            for c in message.get("tool_calls", [])], data.get("usage", {}))


class ScriptedProvider:
    """Deterministic fixtures. This exercises the harness; it is NOT an LLM."""
    name = "scripted-simulation"
    async def complete(self, role, conversation_id, turn_id, messages, tools):
        await asyncio.sleep(0)
        results = [m for m in messages if m["role"] == "tool"]
        if results:
            return Reply("Completed fixture tool execution; see the returned evidence.")
        context = json.loads(messages[1]["content"])["context"]
        name = tools[0]["name"]
        arguments = {k: context[k] for k in tools[0]["parameters"].get("required", [])}
        return Reply(calls=[{"id": "call_" + uuid.uuid4().hex[:10], "name": name, "arguments": json.dumps(arguments)}])


def make_provider():
    selected = os.environ.get("SWARM_PROVIDER", "scripted").lower()
    if selected == "scripted": return ScriptedProvider()
    if selected == "mel": return MelProvider()
    if selected == "chat": return ChatProvider()
    raise ProviderError("SWARM_PROVIDER must be scripted, mel, or chat")
