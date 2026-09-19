"""Explicit hackathon fixtures; no physical devices or model-provider changes."""
import datetime as dt
import time

from .devices import SimulatedDevice
from .environment import FIELDS


SCENARIO = "shopswarm-hackathon-v2"
SENSOR_INTERVAL = 15
FILTER_REFERENCE = "Elkay WaterSentry Plus 51300C: https://www.elkay.com/products/shop-now/51300c — 3,000 US gallons or one year; installation and usage below are simulated."


class DemoWorkflows:
    def _init_demo(self, enabled=False):
        self.demo_state = {"enabled": False, "label": "Hackathon simulation", "source": "demo",
                           "scenario": SCENARIO, "devices": "simulated", "sensor_refresh_seconds": SENSOR_INTERVAL,
                           "seeded": False, "history_scope": "Earlier simulated sessions remain historical records."}
        self._demo_date = dt.date.today()
        self._demo_sample_sequence = 0
        self._demo_last_sample = None
        self._demo_frame = 0
        if enabled:
            if not isinstance(self.device, SimulatedDevice):
                raise ValueError("Hackathon demo mode requires the simulated device adapter")
            self.device.inspect_delay = 3.0
            self.load_presentation_demo()

    def load_presentation_demo(self):
        """Seed once per current session; retries reuse each durable mutation ID."""
        if self.stopped: raise ValueError("Emergency stop is active")
        if not isinstance(self.device, SimulatedDevice):
            raise ValueError("Demo fixtures require the simulated device adapter")
        if self.demo_state["seeded"]:
            self.refresh_demo_sensors()
            return dict(self.demo_state)
        prefix = SCENARIO + ":" + self.session_id
        today = self._demo_date
        definitions = [("Tomatoes — demo tray", "produce", 20, 2, 120, 3),
                       ("Leafy greens — demo inspection", "produce", 6, 1, 80, 1),
                       ("Packaged oats — demo pantry", "pantry", 16, 30, 200, 1.5)]
        batches = []
        for index, (product, zone, quantity, days, mass, demand) in enumerate(definitions):
            batch = self.sustainability.add_batch({"request_id": prefix + f":batch:{index}", "product": product,
                "zone": zone, "quantity": quantity, "date_type": "planning" if zone == "produce" else "best_before",
                "received_date": today.isoformat(), "date": (today + dt.timedelta(days=days)).isoformat(),
                "unit_mass_g": mass, "source": "demo"})
            self.sustainability.set_forecast({"request_id": prefix + f":forecast:{index}", "batch_id": batch["batch_id"],
                "daily_demand": demand, "lead_days": 2, "review_days": 3, "uncertainty_units": 2,
                "open_order_units": 0, "source": "demo"})
            batches.append(batch["batch_id"])
        self.sustainability.hold_batch({"request_id": prefix + ":hold", "batch_id": batches[1], "held": True,
            "reason": "Simulated quality hold: inspect this demo batch before any sale, use or donation."})
        for index, batch, kind, quantity in [(0, batches[0], "used", 6), (1, batches[0], "donated", 2),
                                              (2, batches[1], "discarded", 1), (3, batches[2], "used", 4)]:
            self.sustainability.record_outcome({"request_id": prefix + f":outcome:{index}", "batch_id": batch,
                "kind": kind, "quantity": quantity, "handoff_confirmed": kind == "donated",
                "reason": "Simulated hackathon outcome; no real consumption, disposal or donation handoff occurred."})
        for index, volume in enumerate((500, 750, 1000, 500)):
            self.sustainability.record_refill({"request_id": prefix + f":refill:{index}", "volume_ml": volume,
                "note": "Simulated measured-volume fixture; no physical dispensing occurred.", "source": "demo"})
        installation = self.water_filters.register({"request_id": prefix + ":filter", "manufacturer": "Elkay",
            "model": "WaterSentry Plus 51300C", "instructions_reference": FILTER_REFERENCE,
            "installed_date": (today - dt.timedelta(days=335)).isoformat(), "rated_days": 365,
            "rated_litres": 11356.235352, "source": "demo"})
        self.water_filters.record_throughput({"request_id": prefix + ":throughput", "filter_id": installation["filter_id"],
            "total_litres": 10220, "measured_on": today.isoformat(), "covers_all_throughput_since_installation": True,
            "measurement_reference": "Simulated complete cumulative meter fixture for the hackathon; no physical meter is connected."})
        # Do not overwrite commerce edits if the manual loader is used mid-session.
        stock_changed = (self.stock_versions["coffee"] == 0 and "coffee" not in self.stock_checks
                         and "coffee" not in self.cart["items"] and not any(job["status"] == "running" for job in self.jobs.values()))
        if stock_changed:
            self.device.stock["coffee"] = self.recorded_stock["coffee"] = 12
            self.device.present["coffee"] = True
        self.demo_state.update(enabled=True, seeded=True, batch_ids=batches, filter_id=installation["filter_id"],
                               seed_date=today.isoformat(), stock_changed=stock_changed,
                               outcomes_recorded=4, refill_records=4, session_refill_volume_ml=2750)
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO environment_meta(key,value) VALUES ('presentation_demo',?)", (SCENARIO,))
        # Three current samples make the initial charts useful. They retain actual
        # receive times; later chart points arrive while the presentation runs.
        for _ in range(3): self.refresh_demo_sensors(force=True)
        self.emit("coordinator", "hackathon_demo_loaded", None, dict(self.demo_state))
        return dict(self.demo_state)

    def refresh_demo_sensors(self, force=False):
        if not self.demo_state["enabled"] or self.stopped: return
        if not isinstance(self.device, SimulatedDevice):
            raise ValueError("Demo sensor generator cannot run against hardware")
        now = time.time()
        if not force and self._demo_last_sample is not None and 0 <= now - self._demo_last_sample < SENSOR_INTERVAL:
            return
        frame = self._demo_frame % 6
        values = [
            ("produce", "dht11", {"temperature_c": (7.8, 8.2, 8.7, 9.1, 8.9, 8.5)[frame], "relative_humidity_pct": (83, 84, 85, 86, 85, 84)[frame]}),
            ("pantry", "dht11", {"temperature_c": (21, 21.2, 21.5, 21.7, 21.4, 21.2)[frame], "relative_humidity_pct": (44, 45, 46, 45, 44, 43)[frame]}),
            ("produce", "ccs811", {"tvoc_ppb": (160, 225, 285, 320, 300, 270)[frame], "eco2_ppm": (610, 680, 760, 820, 790, 740)[frame]}),
            ("water", "tds", {"tds_ppm": (170, 175, 182, 188, 185, 179)[frame], "liquid_temperature_c": 20}),
            ("water", "apds9960", {"present": True, "proximity": (178, 180, 182, 181, 179, 180)[frame]}),
        ]
        for zone, sensor, reading in values:
            body = {"zone": zone, "sensor": sensor, "device_id": "demo-environment-v1", "boot_id": self.session_id,
                "sequence": self._demo_sample_sequence, "values": reading,
                "units": {field: FIELDS[sensor][field][0] for field in reading},
                "readiness": {"state": "ready", "warmup_seconds": 1200, "conditioning_hours": 48},
                "calibration": {"status": "calibrated", "reference": "Simulated scenario; no physical sensor calibration"},
                "compensation": {"status": "uncompensated", "reference": "Simulated presentation values"}}
            if sensor == "ccs811":
                body["baseline"] = {"kind": "operator", "reference": "Demo-only inspection threshold, not a food-safety limit",
                    "duration_seconds": 30, "thresholds": {"tvoc_ppb": {"max": 250, "hysteresis": 10}}}
            self.environment.ingest(body, source="demo")
            self._demo_sample_sequence += 1
        self._demo_frame += 1
        self._demo_last_sample = now
        self.demo_state["last_sensor_sample_at"] = now
