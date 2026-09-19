import asyncio
import copy
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from .agents import Agent, Tool, object_schema
from .devices import SimulatedDevice, HttpDevice
from .providers import make_provider
from .catalog import CATALOG, SKU
from .commerce import ShopWorkflows
from .sustainability_workflows import SustainabilityWorkflows
from .assistant_workflows import AssistantWorkflows
from .demo_scenario import DemoWorkflows


BUDGET = {"type": "integer", "minimum": 1, "maximum": 1000000}


class Swarm(ShopWorkflows, SustainabilityWorkflows, AssistantWorkflows, DemoWorkflows):
    """Coordinator + independent role conversations; all mutations run on one event loop."""
    def __init__(self, provider=None, device=None, db_path=":memory:"):
        demo_enabled = os.getenv("SHOPSWARM_DEMO_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}
        if demo_enabled and ((device is not None and not isinstance(device, SimulatedDevice))
                             or (device is None and os.getenv("DEVICE_MODE", "simulated") != "simulated")):
            raise ValueError("Hackathon demo mode requires simulated devices")
        self.provider = provider or make_provider()
        if device is None and os.environ.get("DEVICE_MODE", "simulated") not in {"simulated", "hardware"}:
            raise ValueError("DEVICE_MODE must be simulated or hardware")
        self.device = device or (HttpDevice(os.environ.get("QUARKY_BRIDGE_URL", ""),
            os.environ.get("QUARKY_BRIDGE_TOKEN", "")) if os.environ.get("DEVICE_MODE") == "hardware" else SimulatedDevice())
        if db_path != ":memory:": Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path)
        self.db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
        self.session_id = uuid.uuid4().hex
        self.orders = {}; self.jobs = {}; self.sensor_readings = {}; self.robot_lock = asyncio.Lock()
        self.order_locks = {}; self.events = []; self.stopped = False
        self.sensor_checks = {}; self.sensor_check_at = {}
        self.max_age = 30.0
        self._init_shop()
        self._init_sustainability()
        self._init_assistant()
        goals = {
            "inventory": "Verify the requested item using physical evidence; resolve disagreement with recorded stock",
            "robot": "Perform only the assigned inspection or approved delivery and return evidence",
            "finance": "Compute a quote in integer cents and check the customer's budget",
            "marketing": "Find an affordable alternative and verify its availability before proposing it",
        }
        self.agents = {role: Agent(role, goal, self.provider, self.emit) for role, goal in goals.items()}
        self.emit("coordinator", "session_started", None, {"device_mode": self.device.mode, "provider": self.provider.name,
            "money_mode": "test-ledger", "recovery": "old events retained; pending orders are not resumed after restart"})
        self._init_demo(demo_enabled)

    def emit(self, actor, kind, mission_id, data):
        event = {"session_id": self.session_id, "time": time.time(), "actor": actor,
            "kind": kind, "mission_id": mission_id, "data": data}
        row = self.db.execute("INSERT INTO events(payload) VALUES (?)", (json.dumps(event),))
        self.db.commit(); event["seq"] = row.lastrowid
        self.events.append(event)
        return event

    def fresh(self, evidence):
        if evidence.get("invalidated_by_sensor"): return False
        stamp = evidence.get("observed_at")
        if type(stamp) not in (int, float): return False
        age = time.time() - stamp
        return (-2 <= age <= self.max_age and bool(evidence.get("evidence_id"))
                and evidence.get("source") == self.device.mode)

    async def _inspect(self, sku, mission):
        async def inspect_station(sku):
            if sku != expected: raise ValueError("Inspection target changed")
            async with self.robot_lock:
                if self.stopped: raise RuntimeError("Emergency stop is active")
                result = await asyncio.wait_for(self.device.inspect(sku), timeout=7)
                if self.stopped: raise RuntimeError("Stopped during inspection")
                if not self.fresh(result) or result.get("sku") != sku or type(result.get("present")) is not bool:
                    raise RuntimeError("Inspection lacks fresh, matching evidence")
                if "quantity" in result and (type(result["quantity"]) is not int or result["quantity"] < 0
                        or result["present"] != (result["quantity"] > 0)):
                    raise RuntimeError("Inspection quantity contradicts shelf presence")
                return result
        expected = sku
        result = await self.agents["robot"].run(mission, {"sku": sku}, [Tool(
            "inspect_station", "Inspect the assigned product bay and return a timestamped observation", object_schema({"sku": SKU}), inspect_station)])
        return result[-1]["result"]

    async def _inventory(self, sku, mission):
        stock_version = self.stock_versions[sku]
        async def verify_stock(sku):
            if sku != expected: raise ValueError("Inventory target changed")
            self.emit("inventory", "delegated", mission, {"to": "robot", "task": "inspect", "sku": sku})
            evidence = await self._inspect(sku, mission)
            reported = self.recorded_stock[sku] > 0
            mismatch = (self.recorded_stock[sku] != evidence["quantity"] if type(evidence.get("quantity")) is int
                        else reported != evidence["present"])
            if mismatch:
                self.emit("inventory", "inventory_mismatch", mission, {"sku": sku, "recorded_present": reported,
                    "observed_present": evidence["present"], "evidence_id": evidence["evidence_id"]})
            eligibility = self.batch_eligibility(sku, 1, evidence)
            return {"sku": sku, "available": evidence["present"] and eligibility["eligible"],
                    "mismatch": mismatch, "evidence": evidence, "batch_eligibility": eligibility}
        expected = sku
        result = await self.agents["inventory"].run(mission, {"sku": sku}, [Tool(
            "verify_stock", "Read recorded inventory and ask the robot specialist to verify the requested bay",
            object_schema({"sku": SKU}), verify_stock)])
        checked = result[-1]["result"]
        if self.stock_versions[sku] != stock_version:
            checked["evidence"]["invalidated_by_sensor"] = True
        self.stock_checks[sku] = copy.deepcopy(checked)
        return checked

    async def _quote(self, sku, budget_cents, mission):
        async def quote_order(sku, budget_cents):
            if sku != expected or budget_cents != expected_budget: raise ValueError("Quote terms changed")
            price = CATALOG[sku]["price_cents"]
            return {"sku": sku, "price_cents": price, "budget_cents": budget_cents,
                "within_budget": price <= budget_cents, "currency": "USD", "money_mode": "test-ledger"}
        expected, expected_budget = sku, budget_cents
        result = await self.agents["finance"].run(mission, {"sku": sku, "budget_cents": budget_cents}, [Tool(
            "quote_order", "Compute the immutable catalog price and compare it with the approved budget",
            object_schema({"sku": SKU, "budget_cents": BUDGET}), quote_order)])
        return result[-1]["result"]

    async def _alternatives(self, requested_sku, budget_cents, mission):
        async def find_alternatives(requested_sku, budget_cents):
            if requested_sku != expected or budget_cents != expected_budget: raise ValueError("Alternative constraints changed")
            candidates = []
            for sku, item in CATALOG.items():
                if sku == requested_sku or item["price_cents"] > budget_cents: continue
                self.emit("marketing", "delegated", mission, {"to": "inventory", "sku": sku, "task": "verify_alternative"})
                inventory = await self._inventory(sku, mission)
                if inventory["available"]:
                    candidates.append({"sku": sku, "price_cents": item["price_cents"], "evidence": inventory["evidence"]})
            return {"alternatives": candidates, "publication": "draft-only"}
        expected, expected_budget = requested_sku, budget_cents
        result = await self.agents["marketing"].run(mission, {"requested_sku": requested_sku, "budget_cents": budget_cents}, [Tool(
            "find_alternatives", "Find affordable alternatives; ask inventory to verify each before proposing it",
            object_schema({"requested_sku": SKU, "budget_cents": BUDGET}), find_alternatives)])
        return result[-1]["result"]

    async def prepare_order(self, sku, budget_cents):
        if sku not in CATALOG: raise ValueError("Unknown SKU")
        if type(budget_cents) is not int or not 1 <= budget_cents <= 1000000: raise ValueError("Invalid budget")
        if self.stopped: raise RuntimeError("Emergency stop is active")
        mission = uuid.uuid4().hex
        order = {"id": mission, "sku": sku, "budget_cents": budget_cents, "version": 1,
            "status": "investigating", "approved": False, "money_mode": "test-ledger"}
        self.orders[mission] = order; self.order_locks[mission] = asyncio.Lock()
        self.emit("customer", "request_received", mission, {"sku": sku, "budget_cents": budget_cents})
        try:
            # Separate conversations and tasks execute concurrently; robot access is serialized.
            async with asyncio.TaskGroup() as group:
                inventory_task = group.create_task(self._inventory(sku, mission))
                finance_task = group.create_task(self._quote(sku, budget_cents, mission))
            inventory, quote = inventory_task.result(), finance_task.result()
            order.update(inventory=inventory, quote=quote)
            if inventory["available"] and quote["within_budget"]:
                order["status"] = "awaiting_approval"
            else:
                order.update(await self._alternatives(sku, budget_cents, mission))
                order["status"] = "alternative_proposed" if order["alternatives"] else "unfulfillable"
            order["version"] += 1
            self.emit("coordinator", "order_prepared", mission, copy.deepcopy(order))
            return copy.deepcopy(order)
        except Exception as e:
            order["status"] = "failed"; order["error"] = type(e).__name__; order["version"] += 1
            self.emit("coordinator", "order_failed", mission, {"error_type": type(e).__name__})
            raise

    async def approve_and_fulfill(self, order_id, expected_version):
        if order_id not in self.orders: raise ValueError("Unknown order")
        async with self.order_locks[order_id]:
            order = self.orders[order_id]
            if order["status"] == "fulfilled": return copy.deepcopy(order)  # idempotent acknowledgment
            if type(expected_version) is not int or order["version"] != expected_version: raise ValueError("Order changed; review its current version")
            if self.stopped or order["status"] != "awaiting_approval": raise ValueError("Order is not ready for approval")
            if not self.fresh(order["inventory"]["evidence"]): raise ValueError("Inspection expired; prepare a new order")
            if not order["quote"]["within_budget"]: raise ValueError("Budget exceeded")
            self.require_batch_eligibility(order["sku"], 1, order["inventory"]["evidence"])
            order.update(status="fulfilling", approved=True, version=order["version"]+1)
            self.emit("human", "order_approved", order_id, {"sku": order["sku"], "price_cents": order["quote"]["price_cents"]})
            command_id = uuid.uuid4().hex
            executed = None
            async def deliver_item(sku):
                nonlocal executed
                if sku != order["sku"]: raise ValueError("Delivery target differs from the approved item")
                if executed is not None: return executed
                async with self.robot_lock:
                    if self.stopped: raise RuntimeError("Emergency stop is active")
                    current = await asyncio.wait_for(self.device.inspect(sku), timeout=7)
                    if (not self.fresh(current) or current.get("sku") != sku or current.get("present") is not True):
                        raise RuntimeError("Item no longer available")
                    self.require_batch_eligibility(sku, 1, current)
                    executed = await asyncio.wait_for(self.device.deliver(sku, command_id), timeout=7)
                    if (self.stopped or not self.fresh(executed) or executed.get("completed") is not True
                        or executed.get("arrival_verified") is not True or executed.get("sku") != sku
                        or executed.get("command_id") != command_id):
                        raise RuntimeError("Delivery completion is unverified; reconcile manually")
                    self.sustainability.consume(sku, executed)
                    return executed
            try:
                report = await self.agents["robot"].run(order_id, {"sku": order["sku"]}, [Tool(
                    "deliver_item", "Deliver only the human-approved item; recheck stock and verify arrival",
                    object_schema({"sku": SKU}), deliver_item)])
                order.update(status="fulfilled", receipt=report[-1]["result"], version=order["version"]+1)
                self.recorded_stock[order["sku"]] = max(0, self.recorded_stock[order["sku"]] - 1)
                self.stock_checks.pop(order["sku"], None)
                self.invalidate_stock(order["sku"], "Stock was consumed by another order. Check the cart again.")
                # Test bookkeeping only: never call a payment processor.
                order["ledger"] = {"recognized_test_revenue_cents": order["quote"]["price_cents"], "reconciled": True}
                self.emit("finance", "test_order_reconciled", order_id, order["ledger"])
                return copy.deepcopy(order)
            except Exception as e:
                order.update(status="manual_review", version=order["version"]+1, error=type(e).__name__)
                self.emit("coordinator", "manual_review_required", order_id, {"error_type": type(e).__name__, "command_id": command_id})
                raise

    async def stop(self):
        self.stopped = True
        self.emit("human", "stop_requested", None, {})
        acknowledged = False
        try:
            result = await asyncio.wait_for(self.device.stop(), timeout=2)
            acknowledged = result.get("stopped") is True and result.get("source") == self.device.mode
            self.emit("robot", "stop_acknowledged" if acknowledged else "stop_unconfirmed", None, result)
        except Exception:
            self.emit("robot", "stop_unconfirmed", None, {"action": "Use the physical power switch"})
        return {"motion_inhibited": True, "device_acknowledged": acknowledged,
                "device_mode": self.device.mode,
                "next_step": "Restart the harness to clear the stop latch" if acknowledged else "Use the physical power switch"}

    async def add_sensor(self, reading):
        required = {"device_id", "sku", "present", "sequence"}
        if not isinstance(reading, dict) or not required <= set(reading): raise ValueError("Incomplete sensor event")
        if reading["sku"] not in CATALOG or type(reading["present"]) is not bool or type(reading["sequence"]) is not int:
            raise ValueError("Invalid sensor event")
        device_id = reading["device_id"]
        if not isinstance(device_id, str) or not 1 <= len(device_id) <= 80: raise ValueError("Invalid device ID")
        previous = self.sensor_readings.get(device_id)
        if previous and reading["sequence"] <= previous["sequence"]: raise ValueError("Duplicate/out-of-order sensor reading")
        stored = {k: reading[k] for k in required}
        stored.update(received_at=time.time(), source="hardware-telemetry")
        self.sensor_readings[device_id] = stored
        self.emit("sensor", "shelf_observation", None, stored)
        if not previous or previous["present"] != stored["present"] or previous["sku"] != stored["sku"]:
            self.invalidate_stock(reading["sku"], "A shelf sensor changed. Check the cart again.")
        # Telemetry alone never grants stock availability or robot arrival.
        for order in self.orders.values():
            evidence = order.get("inventory", {}).get("evidence", {})
            if (order["sku"] == reading["sku"] and order["status"] == "awaiting_approval"
                    and evidence.get("present") != reading["present"]):
                evidence["invalidated_by_sensor"] = True
        changed = not previous or previous["present"] != stored["present"] or previous["sku"] != stored["sku"]
        sku = stored["sku"]
        current = self.jobs.get(self.sensor_checks.get(sku), {})
        result = dict(stored)
        if changed and not self.stopped and current.get("status") != "running" and time.time()-self.sensor_check_at.get(sku, 0) >= 5:
            try:
                job = await self.start_job("inspect", sku=sku)
                self.sensor_checks[sku] = job["job_id"]; self.sensor_check_at[sku] = time.time()
                result["inspection_job_id"] = job["job_id"]
                self.emit("sensor", "inspection_requested", job["job_id"], {"sku": sku})
            except ValueError:
                result["inspection_deferred"] = True
        elif changed:
            result["inspection_deferred"] = True
        return result

    async def start_job(self, operation, **kwargs):
        if operation not in {"prepare", "fulfill", "inspect", "check_stock", "restock", "check_cart", "checkout"}: raise ValueError("Unknown job operation")
        if sum(v["status"] == "running" for v in self.jobs.values()) >= 4: raise ValueError("Too many active jobs")
        job_id = uuid.uuid4().hex
        self.jobs[job_id] = {"id": job_id, "operation": operation, "status": "running", "created_at": time.time()}
        if operation in {"check_stock", "inspect"} and kwargs.get("sku") in {*CATALOG, "all"}:
            self.jobs[job_id]["request"] = {"sku": kwargs["sku"]}
        async def run():
            try:
                if operation == "prepare": result = await self.prepare_order(**kwargs)
                elif operation == "fulfill": result = await self.approve_and_fulfill(**kwargs)
                elif operation == "inspect": result = await self._inventory(kwargs["sku"], job_id)
                elif operation == "check_stock": result = await self.check_stock(**kwargs)
                elif operation == "restock": result = await self.restock_item(**kwargs)
                elif operation == "check_cart": result = await self.check_cart(**kwargs)
                else: result = await self.approve_cart(**kwargs)
                self.jobs[job_id].update(status="completed", result=result)
            except Exception as e:
                self.jobs[job_id].update(status="failed", error=str(e)[:250])
        asyncio.create_task(run())
        return {"job_id": job_id, "status": "running", "instruction": "Poll job_status; never announce completion yet"}

    async def snapshot(self):
        return copy.deepcopy({"session_id": self.session_id, "provider": self.provider.name,
            "device_mode": self.device.mode, "money_mode": "test-ledger", "stopped": self.stopped,
            "demo": self.demo_state, "robot_motion": getattr(self.device, "motion", None),
            "catalog": {sku: {**item, "recorded_stock": self.recorded_stock[sku]} for sku, item in CATALOG.items()},
            "stock": self.stock_snapshot(), "cart": self.cart_snapshot(), "restock_requests": self.restock_requests[-30:],
            "sustainability": self.sustainability_snapshot(),
            "mel": self.mel_status, "water_filters": self.water_filters.snapshot(),
            "operator_proposals": self.operator_proposals.snapshot(),
            "max_evidence_age_seconds": self.max_age, "orders": self.orders, "jobs": self.jobs,
            "sensor_readings": self.sensor_readings, "events": self.events[-250:]})

    async def demo(self):
        first = await self.prepare_order("coffee", 1500)
        if not first.get("alternatives"): return {"first": first}
        second = await self.prepare_order(first["alternatives"][0]["sku"], 1500)
        # An offline scenario fixture represents human approval. Live agents lack this authority.
        final = await self.approve_and_fulfill(second["id"], second["version"])
        return {"first": first, "final": final, "event_count": len(self.events),
                "disclosure": "Simulation with deterministic agent fixtures; no real payments or robot movement"}
