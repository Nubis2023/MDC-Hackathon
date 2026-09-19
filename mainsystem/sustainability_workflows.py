"""Operator sustainability records connected to the existing checkout authority."""
from .environment import EnvironmentStore
from .sustainability import SustainabilityStore


class SustainabilityWorkflows:
    def _init_sustainability(self):
        self.environment = EnvironmentStore(self.db)
        self.sustainability = SustainabilityStore(self.db, self.session_id, self.device.mode)

    def sustainability_snapshot(self):
        if hasattr(self, "demo_state"): self.refresh_demo_sensors()
        result = self.sustainability.snapshot(stock=self.stock_snapshot())
        result["environment"] = self.environment.snapshot()
        return result

    async def sustainability_action(self, operation, body):
        actions = {"batch": self.sustainability.add_batch,
                   "hold": self.sustainability.hold_batch,
                   "forecast": self.sustainability.set_forecast,
                   "outcome": self.sustainability.record_outcome,
                   "refill": self.sustainability.record_refill}
        if operation not in actions: raise ValueError("Unknown sustainability action")
        if self.stopped: raise ValueError("Emergency stop is active")
        # Serialize changes to eligibility with the robot's final inspection/delivery.
        async with self.robot_lock:
            if self.stopped: raise ValueError("Emergency stop is active")
            changes_before = self.db.total_changes
            result = actions[operation](body)
            # An ambiguous HTTP response may be retried after a newer stock check.
            # Replaying its saved response must not revoke that newer approval.
            if self.db.total_changes == changes_before:
                return result
            if operation in {"batch", "hold", "outcome"}:
                sku = result.get("sku")
                if not sku and body.get("batch_id"):
                    sku = self.sustainability.get_batch(body["batch_id"]).get("sku")
                if sku in self.recorded_stock:
                    self.invalidate_stock(sku, "Batch records changed. Review eligibility and check stock again.")
            self.emit("operator", "sustainability_" + operation, body.get("batch_id"), result)
            return result

    async def add_environment(self, body):
        result = self.environment.ingest(body, source="hardware")
        self.emit("sensor", "environment_observation", None, result)
        return result

    async def sustainability_demo(self):
        if self.stopped: raise ValueError("Emergency stop is active")
        if self.device.mode != "simulated": raise ValueError("Demo fixtures require simulated device mode")
        demo = self.load_presentation_demo()
        self.emit("operator", "sustainability_demo_loaded", None,
                  {"source": "demo", "stock_changed": demo["stock_changed"], "outcomes_recorded": demo["outcomes_recorded"]})
        return self.sustainability_snapshot()

    def batch_eligibility(self, sku, quantity, evidence):
        result = self.sustainability.eligibility(sku, quantity, evidence=evidence)
        if result["tracked"] and self.device.mode == "hardware":
            result["eligible"] = False
            result["issues"].append("Tracked hardware batches require batch identity verification; the current robot bridge verifies SKU only.")
        return result

    def require_batch_eligibility(self, sku, quantity, evidence):
        result = self.batch_eligibility(sku, quantity, evidence)
        if not result["eligible"]:
            raise ValueError("; ".join(result["issues"]))
        return result
