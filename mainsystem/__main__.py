import argparse
import asyncio
import json
import os
import sys
from .config import load_env


def main():
    if sys.version_info < (3, 11): raise SystemExit("ShopSwarm requires Python 3.11 or newer")
    load_env()
    parser = argparse.ArgumentParser(description="ShopSwarm starter harness")
    parser.add_argument("command", choices=["demo", "serve", "doctor", "voice", "voice-config", "setup-voice", "sync-voice", "mel-login", "mel-check"])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--relay-url", help="Supported Mel relay URL for mel-login or mel-check; no credentials in this URL")
    parser.add_argument("--enable-specialists", action="store_true", help="With mel-login, save SWARM_PROVIDER=mel only after account verification")
    parser.add_argument("--method", choices=["browser", "password"], default="browser", help="mel-login method; browser supports Google/GitHub and existing browser sessions")
    args = parser.parse_args()
    if args.relay_url is not None and args.command not in {"mel-login", "mel-check"}:
        parser.error("--relay-url applies only to mel-login and mel-check")
    if args.enable_specialists and args.command != "mel-login":
        parser.error("--enable-specialists applies only to mel-login")
    if args.command in {"mel-login", "mel-check"}:
        from .mel_connection import mel_login, mel_browser_login, mel_check
        from .providers import ProviderError
        try:
            login = mel_browser_login if args.method == "browser" else mel_login
            result = (login(args.relay_url, enable_specialists=args.enable_specialists)
                      if args.command == "mel-login" else mel_check(args.relay_url))
        except (ProviderError, OSError, ValueError, EOFError, KeyboardInterrupt):
            print("Mel connection could not be verified. Check the relay URL and sign-in in your local terminal; no runtime fallback was enabled.")
            raise SystemExit(1) from None
        if not result.get("authenticated"):
            raise SystemExit(1)
        return
    if args.command == "doctor":
        import importlib.util
        print(json.dumps({"provider": os.getenv("SWARM_PROVIDER", "scripted"), "devices": os.getenv("DEVICE_MODE", "simulated"),
            "mel_relay_configured": bool(os.getenv("MEL_RELAY_URL")), "mel_token_present": bool(os.getenv("MEL_TOKEN")),
            "eleven_key_present": bool(os.getenv("ELEVENLABS_API_KEY")), "eleven_agent_configured": bool(os.getenv("ELEVENLABS_AGENT_ID")),
            "eleven_sdk_installed": bool(importlib.util.find_spec("elevenlabs")), "pyaudio_installed": bool(importlib.util.find_spec("pyaudio")),
            "hardware_bridge_configured": bool(os.getenv("QUARKY_BRIDGE_URL")),
            "note": "Checks presence only; no live account or device verification performed"}, indent=2)); return
    if args.command == "demo":
        from .core import Swarm
        if os.getenv("DEVICE_MODE", "simulated") != "simulated" or os.getenv("SWARM_PROVIDER", "scripted") != "scripted":
            parser.error("demo is a fixture: set DEVICE_MODE=simulated and SWARM_PROVIDER=scripted; use serve for live mode")
        async def demo():
            swarm = Swarm()
            try: return await swarm.demo()
            finally: swarm.db.close()
        print(json.dumps(asyncio.run(demo()), indent=2)); return
    if args.command == "serve":
        from .server import serve
        serve(args.port); return
    if args.command == "sync-voice":
        from .voice_sync import sync_voice
        sync_voice(); return
    from .voice import run_voice, write_config, setup_voice
    {"voice": run_voice, "voice-config": write_config, "setup-voice": setup_voice}[args.command]()


if __name__ == "__main__": main()
