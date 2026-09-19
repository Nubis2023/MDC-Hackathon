"""Loopback-only operator console; no public deployment or cloud-to-device tunnel."""
import asyncio
import hmac
import json
import os
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from .core import Swarm
from .voice_session import VoiceSession


class LocalHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR lets a second process bind an occupied listening port.
    # Keep the Unix restart behavior, but reserve the console port on Windows.
    allow_reuse_address = False if os.name == "nt" else ThreadingHTTPServer.allow_reuse_address

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Runtime:
    def __init__(self):
        self.voice = VoiceSession()
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        async def create(): return Swarm(db_path="runtime/events.sqlite3")
        self.swarm = self.call(create())

    def call(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=10)

    def close(self):
        self.voice.close()
        async def shutdown():
            await self.swarm.stop()
            tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.swarm.db.close()
        self.call(shutdown()); self.loop.call_soon_threadsafe(self.loop.stop); self.thread.join(timeout=2)


def make_handler(runtime, token, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def allowed(self, mutate=False):
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            if self.headers.get("Host") not in hosts: return False
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + h for h in hosts}: return False
            return not mutate or hmac.compare_digest(self.headers.get("X-ShopSwarm-Token", ""), token)

        def send(self, status, data, content_type="application/json"):
            body = json.dumps(data).encode() if content_type == "application/json" else data.encode()
            try:
                self.send_response(status); self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff"); self.end_headers(); self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # A refresh/closed tab can abandon a polling response (Windows
                # reports WinError 10053). The operation may already be committed:
                # close this connection without retrying it or sending a second 500.
                self.close_connection = True

        def do_GET(self):
            if not self.allowed(): return self.send(403, {"error": "Local origin required"})
            path = urlsplit(self.path).path
            if path == "/":
                html = (Path(__file__).parent / "console.html").read_text(encoding="utf-8")
                return self.send(200, html.replace("__LOCAL_TOKEN__", token), "text/html; charset=utf-8")
            if path == "/api/state":
                state = runtime.call(runtime.swarm.snapshot())
                state["voice"] = runtime.voice.snapshot()
                return self.send(200, state)
            if path == "/health": return self.send(200, {"ok": True})
            return self.send(404, {"error": "Not found"})

        def do_POST(self):
            if not self.allowed(mutate=True): return self.send(403, {"error": "Local token required"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536: return self.send(413, {"error": "Invalid body size"})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict): raise ValueError("Expected JSON object")
                path = urlsplit(self.path).path
                if path == "/api/voice/start": result = runtime.voice.start()
                elif path == "/api/voice/stop": result = runtime.voice.stop()
                elif path == "/api/assistant":
                    result = runtime.call(runtime.swarm.start_mel_request(body["request"], body["request_id"], body["conversation_id"]))
                elif path == "/api/proposals": result = runtime.call(runtime.swarm.propose_action(body))
                elif path == "/api/proposals/review":
                    result = runtime.call(runtime.swarm.review_proposal(body["proposal_id"], body["decision"], body.get("retry", False)))
                elif path in {"/api/filters/register", "/api/filters/throughput"}:
                    operation = "filter_register" if path.endswith("register") else "filter_throughput"
                    result = runtime.call(runtime.swarm.filter_action(operation, body))
                elif path == "/api/prepare":
                    result = runtime.call(runtime.swarm.start_job("prepare", sku=body["sku"], budget_cents=body["budget_cents"]))
                elif path == "/api/approve":
                    result = runtime.call(runtime.swarm.start_job("fulfill", order_id=body["order_id"], expected_version=body["expected_version"]))
                elif path == "/api/stock/check":
                    result = runtime.call(runtime.swarm.start_job("check_stock", sku=body["sku"]))
                elif path == "/api/stock/restock":
                    result = runtime.call(runtime.swarm.start_job("restock", sku=body["sku"], quantity=body["quantity"]))
                elif path == "/api/cart/item":
                    result = runtime.call(runtime.swarm.set_cart_item(body["sku"], body["quantity"], body["expected_version"]))
                elif path == "/api/cart/budget":
                    result = runtime.call(runtime.swarm.set_cart_budget(body["budget_cents"], body["expected_version"]))
                elif path == "/api/cart/clear":
                    result = runtime.call(runtime.swarm.clear_cart(body["expected_version"]))
                elif path == "/api/cart/check":
                    result = runtime.call(runtime.swarm.start_job("check_cart", expected_version=body["expected_version"]))
                elif path == "/api/cart/approve":
                    result = runtime.call(runtime.swarm.start_job("checkout", expected_version=body["expected_version"], checkout_id=body["checkout_id"]))
                elif path == "/api/stop": result = runtime.call(runtime.swarm.stop())
                elif path == "/api/sensor": result = runtime.call(runtime.swarm.add_sensor(body))
                elif path == "/api/environment": result = runtime.call(runtime.swarm.add_environment(body))
                elif path == "/api/sustainability/demo": result = runtime.call(runtime.swarm.sustainability_demo())
                elif path in {"/api/batches/add", "/api/batches/hold", "/api/forecasts", "/api/outcomes", "/api/refills"}:
                    operation = {"/api/batches/add": "batch", "/api/batches/hold": "hold",
                                 "/api/forecasts": "forecast", "/api/outcomes": "outcome", "/api/refills": "refill"}[path]
                    result = runtime.call(runtime.swarm.sustainability_action(operation, body))
                elif path == "/api/simulate":
                    async def change():
                        device = runtime.swarm.device
                        if device.mode != "simulated": raise ValueError("Simulation controls unavailable in hardware mode")
                        if runtime.swarm.stopped: raise ValueError("Emergency stop is active")
                        if body.get("sku") not in device.present or type(body.get("present")) is not bool:
                            raise ValueError("Invalid simulated shelf state")
                        device.present[body["sku"]] = body["present"]
                        device.quantity(body["sku"])
                        runtime.swarm.invalidate_stock(body["sku"])
                        runtime.swarm.emit("operator", "simulation_changed", None, body)
                        return {"ok": True}
                    result = runtime.call(change())
                else: return self.send(404, {"error": "Not found"})
                return self.send(200, result)
            except (ValueError, KeyError, TypeError) as e:
                return self.send(400, {"error": str(e)[:160]})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__, "message": "Operation failed; inspect local event log"})
    return Handler


def serve(port=8765):
    # Acquire the port before Runtime can seed a session or touch the shared DB.
    server = LocalHTTPServer(("127.0.0.1", port), BaseHTTPRequestHandler)
    try:
        runtime = Runtime()
    except Exception:
        server.server_close(); raise
    token = secrets.token_hex(24)
    server.RequestHandlerClass = make_handler(runtime, token, port)
    connection = Path("runtime/connection.json"); connection.parent.mkdir(exist_ok=True)
    connection.write_text(json.dumps({"base": f"http://127.0.0.1:{port}", "token": token}))
    try: os.chmod(connection, 0o600)
    except OSError: pass
    print(f"ShopSwarm console: http://127.0.0.1:{port}")
    print(f"Agents: {runtime.swarm.provider.name}; devices: {runtime.swarm.device.mode}; test ledger only")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        server.server_close(); runtime.close()
        # Another console may have become current; do not unlink its connection.
        try:
            saved = json.loads(connection.read_text())
            if saved.get("token") == token: connection.unlink(missing_ok=True)
        except (OSError, ValueError): pass
