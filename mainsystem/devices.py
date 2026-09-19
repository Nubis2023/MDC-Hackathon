import asyncio
import time
import uuid
from .catalog import CATALOG
from .providers import check_base, request_json


class DeviceError(RuntimeError):
    pass


def _validate_sku(sku):
    if not isinstance(sku, str) or sku not in CATALOG:
        raise DeviceError("Unknown SKU")


class SimulatedDevice:
    mode = "simulated"
    def __init__(self):
        self.stock = {sku: item["recorded_stock"] for sku, item in CATALOG.items()}
        self.stock["coffee"] = 0
        self.present = {sku: quantity > 0 for sku, quantity in self.stock.items()}
        self._deliveries = {}
        self.obstacle = False
        self.stopped = False
        self.position = "home"
        self.inspect_delay = .08
        self.motion = {"phase": "idle", "sku": None, "operation": None, "source": "simulated"}

    def quantity(self, sku):
        """Apply legacy presence overrides before observing or changing stock."""
        _validate_sku(sku)
        self.stock[sku] = max(1, self.stock[sku]) if self.present[sku] else 0
        return self.stock[sku]

    def _evidence(self, sku):
        quantity = self.quantity(sku)
        return {"sku": sku, "present": quantity > 0, "quantity": quantity,
                "observed_at": time.time(), "source": self.mode,
                "evidence_id": uuid.uuid4().hex, "station": self.position}

    async def inspect(self, sku):
        _validate_sku(sku)
        if self.obstacle or self.stopped:
            self.motion.update(phase="stopped" if self.stopped else "blocked", updated_at=time.time())
            raise DeviceError("Movement blocked or emergency stop is active")
        started = time.time()
        self.motion = {"phase": "moving", "sku": sku, "operation": "inspect", "source": "simulated",
                       "started_at": started, "updated_at": started}
        await asyncio.sleep(self.inspect_delay / 2)
        if self.obstacle or self.stopped:
            self.motion.update(phase="stopped" if self.stopped else "blocked", updated_at=time.time())
            raise DeviceError("Movement blocked or emergency stop is active")
        self.motion.update(phase="inspecting", updated_at=time.time())
        await asyncio.sleep(self.inspect_delay / 2)
        if self.obstacle or self.stopped:
            self.motion.update(phase="stopped" if self.stopped else "blocked", updated_at=time.time())
            raise DeviceError("Movement blocked or emergency stop is active")
        self.position = sku + "-bay"
        self.motion.update(phase="complete", updated_at=time.time())
        return self._evidence(sku)

    async def restock(self, sku, quantity):
        _validate_sku(sku)
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise DeviceError("Restock quantity must be an integer from 1 to 100")
        await asyncio.sleep(0.08)
        if self.obstacle or self.stopped:
            raise DeviceError("Restock blocked: obstruction or emergency stop is active")
        self.stock[sku] = self.quantity(sku) + quantity
        self.present[sku] = True
        self.position = sku + "-bay"
        return {**self._evidence(sku), "restocked_quantity": quantity}

    async def deliver(self, sku, command_id):
        _validate_sku(sku)
        if not isinstance(command_id, str) or not command_id:
            raise DeviceError("Delivery command ID is required")
        await asyncio.sleep(0.08)
        if command_id in self._deliveries:
            receipt = self._deliveries[command_id]
            if receipt["sku"] != sku:
                raise DeviceError("Delivery command ID already belongs to another SKU")
            return dict(receipt)
        if self.obstacle or self.stopped or self.quantity(sku) == 0:
            raise DeviceError("Cannot deliver: obstruction, stop, or missing item")
        self.stock[sku] -= 1
        self.present[sku] = self.stock[sku] > 0
        self.position = "delivery-bay"
        receipt = {"command_id": command_id, "sku": sku, "completed": True,
                "arrival_verified": True, "observed_at": time.time(),
                "source": self.mode, "evidence_id": uuid.uuid4().hex,
                "quantity": self.stock[sku], "delivered_quantity": 1}
        self._deliveries[command_id] = receipt
        return dict(receipt)

    async def stop(self):
        self.stopped = True
        self.motion.update(phase="stopped", updated_at=time.time())
        return {"stopped": True, "source": self.mode}


class HttpDevice:
    """Contract for a local Quarky bridge. Firmware/transport must be integrated on-site."""
    mode = "hardware"
    def __init__(self, base, token):
        self.base = check_base(base)
        self.token = token
        if not token:
            raise DeviceError("QUARKY_BRIDGE_TOKEN is required")

    async def _post(self, operation, body):
        return await asyncio.to_thread(request_json, self.base + "/" + operation, body,
            {"Authorization": "Bearer " + self.token}, 5)

    async def inspect(self, sku):
        _validate_sku(sku)
        result = await self._post("inspect", {"sku": sku, "command_id": uuid.uuid4().hex})
        if result.get("source") != "hardware" or result.get("sku") != sku or type(result.get("present")) is not bool:
            raise DeviceError("Bridge returned invalid inspection evidence")
        return result

    async def deliver(self, sku, command_id):
        _validate_sku(sku)
        result = await self._post("deliver", {"sku": sku, "command_id": command_id})
        if result.get("source") != "hardware" or result.get("command_id") != command_id or result.get("sku") != sku:
            raise DeviceError("Bridge acknowledgment does not match the command")
        return result

    async def restock(self, sku, quantity):
        _validate_sku(sku)
        raise DeviceError("Hardware restocking is not supported by the bridge; restock the shelf physically and inspect it again")

    async def stop(self):
        return await self._post("stop", {"command_id": uuid.uuid4().hex})
