"""Explicit local Mel sign-in and sanitized account checks.

Wire contract: https://www.openmel.dev/docs/api, verified September 19, 2026.
Run sign-in in the user's terminal. Never accept passwords as CLI arguments.
"""
import getpass
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from .providers import ProviderError, check_base


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None  # Never forward a password or bearer token to another URL.


def _request_json(url, payload=None, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, body, headers)
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=25) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError("Response too large")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("Expected account object")
            return result
    except urllib.error.HTTPError as error:
        raise ProviderError(f"Mel account request returned HTTP {error.code}; check the relay and sign-in") from None
    except (OSError, ValueError):
        raise ProviderError("Mel account connection or response failed") from None


def _token(value):
    if not isinstance(value, str) or len(value) > 8192 or not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", value):
        raise ProviderError("Mel sign-in did not return a valid session token")
    return value


def _base(value):
    if not isinstance(value, str) or any(char.isspace() or ord(char) < 32 for char in value):
        raise ProviderError("Mel relay URL cannot contain whitespace or control characters")
    return check_base(value)


def _account_status(account):
    if account.get("auth") is not True:
        raise ProviderError("Mel did not verify an authenticated account")
    remaining = account.get("remaining")
    available = None
    if type(remaining) in (int, float):
        available = remaining == -1 or remaining > 0
    return {"status": "ready" if available is not False else "authenticated_no_quota",
            "configured": True, "authenticated": True, "quota_available": available,
            "runtime_verified": False}


def _save_session(path, base, token, enable_specialists=False):
    path = Path(path)
    before = path.read_bytes() if path.exists() else None
    lines = before.decode("utf-8-sig").splitlines() if before is not None else []
    kept = [line for line in lines if not re.match(r"^\s*MEL_(?:TOKEN|RELAY_URL)\s*=", line)]
    kept.extend(["MEL_RELAY_URL=" + base, "MEL_TOKEN=" + token])
    if enable_specialists:
        kept = [line for line in kept if not re.match(r"^\s*SWARM_PROVIDER\s*=", line)]
        kept.append("SWARM_PROVIDER=mel")
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write("\n".join(kept) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass  # On Windows the directory's existing ACL is authoritative.
        current = path.read_bytes() if path.exists() else None
        if current != before:
            raise ProviderError("The environment file changed during sign-in; no credentials were saved")
        os.replace(temporary, path)
        temporary = None
    except ProviderError:
        raise
    except (OSError, UnicodeError):
        raise ProviderError("Could not safely save the Mel session to the environment file") from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    # load_env uses setdefault, so update this process explicitly after persistence.
    os.environ["MEL_RELAY_URL"] = base
    os.environ["MEL_TOKEN"] = token
    if enable_specialists:
        os.environ["SWARM_PROVIDER"] = "mel"


def mel_login(relay_url=None, *, env_path=".env", input_fn=None, password_fn=None, enable_specialists=False):
    base = _base(relay_url or os.getenv("MEL_RELAY_URL", ""))
    read_input = input_fn or input
    read_password = password_fn or getpass.getpass
    print("Sign in to the Mel relay you selected. Your password is entered locally and is not saved.")
    email = read_input("Mel email: ").strip()
    if not email or len(email) > 320 or any(ord(char) < 32 for char in email):
        raise ProviderError("Enter a valid Mel account email")
    password = read_password("Mel password (hidden): ")
    if not isinstance(password, str) or not password:
        raise ProviderError("Mel password is required")
    response = _request_json(base + "/v1/auth/signin", {"email": email, "password": password})
    token = _token(response.get("token"))
    account = _request_json(base + "/v1/me", token=token)
    status = _account_status(account)
    _save_session(env_path, base, token, enable_specialists=enable_specialists)
    print("Mel account verified; relay and session token saved locally. Runtime orchestration still needs its first successful request.")
    if enable_specialists:
        print("Mel specialist mode saved. The next backend start will use Mel for the supervisor and specialists.")
    print(json.dumps(status, indent=2))
    return status


def mel_check(relay_url=None):
    configured_base = os.getenv("MEL_RELAY_URL", "")
    configured_token = os.getenv("MEL_TOKEN", "")
    if not configured_base or not configured_token:
        status = {"status": "not_configured", "configured": False, "authenticated": False,
                  "runtime_verified": False, "message": "Run mel-login with the supported relay URL first."}
    else:
        try:
            base = _base(configured_base)
            if relay_url is not None and _base(relay_url) != base:
                raise ProviderError("Use mel-login before checking a different relay")
            account = _request_json(base + "/v1/me", token=_token(configured_token))
            status = _account_status(account)
        except ProviderError:
            status = {"status": "connection_error", "configured": True, "authenticated": False,
                      "runtime_verified": False, "message": "Check the configured relay and complete mel-login again if needed."}
    print(json.dumps(status, indent=2))
    return status


def _device_flow(base, response, started_at):
    """Validate the app's browser-auth response; this object contains a secret."""
    device_token = _token(response.get("device_token"))
    code, url = response.get("user_code"), response.get("activate_url")
    lifetime, interval = response.get("expires_in"), response.get("interval")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9]{6,16}", code):
        raise ProviderError("Mel returned an invalid browser sign-in code")
    if not isinstance(url, str) or any(char.isspace() or ord(char) < 32 for char in url):
        raise ProviderError("Mel returned no browser activation URL")
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
    if (parsed.scheme != "https" or parsed.hostname not in {"openmel.dev", "www.openmel.dev"}
            or parsed.path != "/activate" or parsed.username or parsed.password or parsed.fragment
            or parsed.port not in (None, 443) or query != {"code": [code]}):
        raise ProviderError("Mel returned an unexpected browser activation destination")
    if type(lifetime) is not int or not 1 <= lifetime <= 600:
        raise ProviderError("Mel returned an invalid browser sign-in expiry")
    if type(interval) is not int or not 1 <= interval <= 30:
        raise ProviderError("Mel returned an invalid browser sign-in polling interval")
    return {"relay_url": _base(base), "device_token": device_token, "user_code": code,
            "activate_url": url, "expires_at": started_at + lifetime, "interval": interval,
            "next_poll_at": started_at + interval, "completed": False}


def begin_browser_login(relay_url=None):
    """Start one fresh flow. Never print or expose its device_token to the UI."""
    base = _base(relay_url or os.getenv("MEL_RELAY_URL", ""))
    started_at = time.time()
    response = _request_json(base + "/v1/device/start", {})
    try:
        return _device_flow(base, response, started_at)
    except (ValueError, TypeError):
        raise ProviderError("Mel returned an invalid browser sign-in response") from None


def poll_browser_login(flow, *, env_path=".env", enable_specialists=False):
    """Poll only this client's pending flow, then verify and persist approval."""
    if flow.get("completed"):
        return {"status": "already_completed", "configured": True, "authenticated": True,
                "runtime_verified": False}
    now = time.time()
    if now >= flow["expires_at"]:
        raise ProviderError("Mel browser sign-in expired; start a new sign-in")
    if now < flow["next_poll_at"]:
        return {"status": "pending", "authenticated": False}
    base = _base(flow["relay_url"])
    token = _token(flow["device_token"])
    flow["next_poll_at"] = now + flow["interval"]
    response = _request_json(base + "/v1/device/poll", {"device_token": token})
    status = response.get("status")
    if status == "pending":
        return {"status": "pending", "authenticated": False}
    if status in {"expired", "denied", "gone"}:
        flow["expires_at"] = now
        raise ProviderError("Mel browser sign-in was denied or expired; start a new sign-in")
    if status != "approved":
        raise ProviderError("Mel returned an unexpected browser sign-in status")
    session_token = _token(response.get("token"))
    # A device approval alone does not establish the account or relay token scope.
    verified = _account_status(_request_json(base + "/v1/me", token=session_token))
    _save_session(env_path, base, session_token, enable_specialists=enable_specialists)
    flow["completed"] = True
    flow.pop("device_token", None)
    return verified


def mel_browser_login(relay_url=None, *, env_path=".env", enable_specialists=False):
    """Google/GitHub/browser session login; no password or stored token scraping."""
    flow = begin_browser_login(relay_url)
    print("Confirm this fresh ShopSwarm sign-in in your browser using your Mel account.")
    print("Code: " + flow["user_code"])
    print("Open: " + flow["activate_url"])
    print("The code expires in ten minutes. Only approve this matching code.")
    try:
        webbrowser.open(flow["activate_url"], new=2)
    except Exception:
        pass  # The exact official URL remains visible for manual navigation.
    while True:
        time.sleep(min(flow["interval"], max(0, flow["expires_at"] - time.time())))
        status = poll_browser_login(flow, env_path=env_path, enable_specialists=enable_specialists)
        if status["status"] != "pending":
            print("Mel browser account verified and saved locally. Runtime orchestration still needs its first successful request.")
            if enable_specialists:
                print("Mel specialist mode saved for the next backend start.")
            print(json.dumps(status, indent=2))
            return status
