"""Small MCP stdio adapter for Mel; exposes scoped customer-facing tools.

Run this file by absolute path. No SDK, API key, web server, or child process is
created here. Mel owns this adapter process and closes stdin to stop it.
"""
import copy
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    sys.path.insert(0, str(PROJECT_ROOT))
from shopswarm.voice import local_connection, make_handlers, tool_configs

VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
TOOL_NAMES = frozenset({"catalog", "prepare_order", "job_status", "order_status", "request_approval", "emergency_stop",
                        "check_stock", "restock_item", "view_cart", "set_cart_item", "set_cart_budget", "clear_cart",
                        "check_cart", "request_checkout_approval", "environment_status", "waste_risk", "restock_plan", "impact_summary",
                        "inventory_status", "water_filter_status", "operator_tasks", "propose_action"})
READ_ONLY = frozenset({"catalog", "job_status", "order_status", "request_approval", "view_cart", "request_checkout_approval",
                       "environment_status", "waste_risk", "restock_plan", "impact_summary", "inventory_status", "water_filter_status", "operator_tasks"})
MAX_INPUT = 64 * 1024
MAX_OUTPUT = 1024 * 1024
INSTRUCTIONS = (
    "Use catalog first and disclose the returned agent/device modes and test ledger. "
    "Catalog prices do not prove stock. check_stock inspects one SKU or all; poll job_status. "
    "On request restock_item adds simulated stock or only records a physical restock request; poll the job and report its actual result. "
    "Do not claim physical replenishment from a request. Read view_cart before setting absolute cart quantities (zero removes); "
    "pass expected_version to every cart change and reread after a conflict. Never blindly retry an increment. "
    "A fulfilled cart's lines are a receipt; adding again starts a new cart with quantities counted from zero. "
    "Only change the cart, budget, or stock when requested. Use integer cents for the customer's total budget. "
    "prepare_order and check_cart start jobs; poll job_status for results. Offer only returned alternatives. "
    "request_approval cannot approve or fulfill: ask the operator to use the matching console button. "
    "request_checkout_approval also only reads: ask the human operator to approve the exact checked cart in the console. "
    "Only fulfilled status with its receipt proves delivery. Use emergency_stop when stopping shop activity is requested."
    " For sustainability use environment_status, waste_risk, restock_plan, and impact_summary. "
    "Disclose demo/operator provenance, readiness, stale/unknown values and quality holds. "
    "Sensors never certify food safety or potability; eCO2 is not emissions. "
    "Refill volume is not water conserved; sales/use are not automatically waste avoided. "
    "Recommendations require human review; do not purchase, change prices, or claim donation without an actual handoff. "
    "You are the Mel supervisor: choose and sequence these tools for the complete user request. "
    "Coffee quantities are catalog boxes, not grams. Exclude historical batches from current spoilage-risk answers. "
    "Use water_filter_status for replacement questions: documented service dates/capacities and measured throughput matter; TDS alone cannot decide replacement. "
    "Use operator_tasks for required fields and propose_action for user-requested batch, forecast, hold, outcome, refill and filter records. "
    "A proposal is pending human console review, never a completed action. Do not invent missing facts."
)


def definitions():
    result = []
    for config in tool_configs():
        name = config["name"]
        if name not in TOOL_NAMES: continue
        schema = copy.deepcopy(config["parameters"])
        schema["additionalProperties"] = False
        for value in schema["properties"].values():
            if value.get("type") == "string":
                value.setdefault("minLength", 1)
                value.setdefault("maxLength", 128)
        result.append({"name": name, "description": config["description"], "inputSchema": schema,
                       "annotations": {"readOnlyHint": name in READ_ONLY,
                                       "destructiveHint": name in {"emergency_stop", "clear_cart", "set_cart_item"},
                                       "idempotentHint": name in READ_ONLY,
                                       "openWorldHint": False}})
    return result


def local_handlers():
    connection = local_connection()  # Refresh on each call if the console restarted.
    parsed = urlsplit(connection.get("base", ""))
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or not parsed.port or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in {"", "/"}
            or not isinstance(connection.get("token"), str) or not connection["token"]):
        raise ValueError("Invalid local console connection")
    connection["base"] = connection["base"].rstrip("/")
    return make_handlers(connection)


def rpc_error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def tool_result(data, error=False):
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "isError": error}


class Adapter:
    def __init__(self, handler_factory=local_handlers):
        self.handler_factory = handler_factory
        self.negotiated = False
        self.ready = False
        self.tools = definitions()
        self.schemas = {tool["name"]: tool["inputSchema"] for tool in self.tools}

    def handle(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return rpc_error(None, -32600, "Invalid JSON-RPC request")
        if "id" not in message:
            if message["method"] == "notifications/initialized" and self.negotiated:
                self.ready = True
            return None  # Notifications never invoke tools and never receive responses.
        request_id = message["id"]
        if type(request_id) not in (str, int): return rpc_error(None, -32600, "Invalid request ID")
        params = message.get("params", {})
        if not isinstance(params, dict): return rpc_error(request_id, -32602, "Expected object parameters")
        method = message["method"]
        if method == "initialize":
            if self.negotiated: return rpc_error(request_id, -32600, "Already initialized")
            if (not isinstance(params.get("protocolVersion"), str)
                    or not isinstance(params.get("capabilities"), dict)
                    or not isinstance(params.get("clientInfo"), dict)):
                return rpc_error(request_id, -32602, "Invalid initialization parameters")
            version = params["protocolVersion"]
            self.negotiated = True
            result = {"protocolVersion": version if version in VERSIONS else VERSIONS[-1],
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "shopswarm-local-tools", "version": "0.1.0"},
                      "instructions": INSTRUCTIONS}
        elif method == "ping": result = {}
        elif not self.ready: return rpc_error(request_id, -32002, "Initialize the server first")
        elif method == "tools/list":
            if params.get("cursor") is not None: return rpc_error(request_id, -32602, "Invalid pagination cursor")
            result = {"tools": self.tools}
        elif method == "tools/call":
            name, arguments = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or name not in TOOL_NAMES:
                return rpc_error(request_id, -32602, "Unknown or unavailable tool")
            if not isinstance(arguments, dict): return rpc_error(request_id, -32602, "Expected object tool arguments")
            schema = self.schemas[name]
            if not self.valid_arguments(arguments, schema):
                result = tool_result({"error": "Arguments do not match the listed tool schema", "completed": False}, error=True)
            else:
                try:
                    data = self.handler_factory()[name](arguments)
                    result = tool_result(data, error=isinstance(data, dict) and "error" in data)
                except Exception:
                    result = tool_result({"error": "Local ShopSwarm tool failed. Check the console is running and retry with its current order or job ID.", "completed": False}, error=True)
        else: return rpc_error(request_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def valid_arguments(arguments, schema):
        properties = schema["properties"]
        if not set(schema.get("required", ())) <= set(arguments): return False
        if set(arguments) - set(properties): return False
        for name, value in arguments.items():
            rule = properties[name]
            if rule["type"] == "string":
                if not isinstance(value, str): return False
                if not rule.get("minLength", 0) <= len(value) <= rule.get("maxLength", 128): return False
            elif rule["type"] == "integer":
                if type(value) is not int: return False
                if value < rule.get("minimum", float("-inf")) or value > rule.get("maximum", float("inf")): return False
            else: return False  # Fail closed if a future unsupported schema type is added.
            if "enum" in rule and value not in rule["enum"]: return False
        return True


def run(input_stream, output_stream, adapter=None):
    adapter = adapter or Adapter()
    while True:
        line = input_stream.readline(MAX_INPUT + 1)
        if not line: return
        if len(line) > MAX_INPUT:
            while line and not line.endswith(b"\n"):
                line = input_stream.readline(MAX_INPUT + 1)
            response = rpc_error(None, -32600, "Message exceeds 64 KiB limit")
        else:
            try:
                message = json.loads(line.decode("utf-8"))
                response = adapter.handle(message)
            except (ValueError, UnicodeError, RecursionError):
                response = rpc_error(None, -32700, "Invalid JSON message")
            except Exception:
                response = rpc_error(None, -32603, "Local adapter error")
        if response is None: continue
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_OUTPUT:
            encoded = json.dumps(rpc_error(response.get("id"), -32603, "Tool result exceeds 1 MiB limit")).encode("utf-8")
        try:
            output_stream.write(encoded + b"\n")
            output_stream.flush()
        except (BrokenPipeError, OSError): return


def main():
    os.chdir(PROJECT_ROOT)
    run(sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__": main()
