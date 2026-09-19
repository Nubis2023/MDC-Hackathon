"""Persisted environmental observations; these are context, never safety verdicts."""
import copy
import hashlib
import json
import math
import re
import time


ZONES = ("produce", "pantry", "water")
MAX_HISTORY = 600
STALE_SECONDS = 120
LIMITATIONS = [
    "Ambient readings cannot establish food safety or extend use-by dates.",
    "CCS811 measures broad VOC trends and calculated eCO2, not ethylene, pathogens or carbon savings.",
    "TDS does not establish potability or measure water consumption; DHT11 cannot compensate liquid temperature.",
    "APDS-9960 observes a fixed position, not stock quantity or freshness.",
]
FIELDS = {
    "dht11": {"temperature_c": ("C", -40, 85), "relative_humidity_pct": ("%RH", 0, 100)},
    "ccs811": {"tvoc_ppb": ("ppb", 0, 32768), "eco2_ppm": ("ppm", 400, 32768)},
    "tds": {"tds_ppm": ("ppm", 0, 100000), "liquid_temperature_c": ("C", -10, 100)},
    "apds9960": {"present": ("boolean", None, None), "proximity": ("raw", 0, 255)},
}
REQUIRED = {"dht11": {"temperature_c", "relative_humidity_pct"},
            "ccs811": {"tvoc_ppb", "eco2_ppm"}, "tds": {"tds_ppm"}, "apds9960": {"present"}}


def _number(value, name, low, high):
    if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
        raise ValueError(f"{name} must be finite and between {low} and {high}")
    return value


def _identifier(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
        raise ValueError(f"{name} must be a 1-80 character identifier")
    return value


def _metadata(value, name, allowed, default):
    if value is None:
        return {"status": default}
    if not isinstance(value, dict) or set(value) - {"status", "reference"}:
        raise ValueError(f"Invalid {name} metadata")
    if not isinstance(value.get("status"), str) or value["status"] not in allowed:
        raise ValueError(f"Invalid {name} status")
    reference = value.get("reference")
    if reference is not None and (not isinstance(reference, str) or not 1 <= len(reference) <= 200):
        raise ValueError(f"Invalid {name} reference")
    return copy.deepcopy(value)


class EnvironmentStore:
    """Uses the coordinator's SQLite connection and synchronous event-loop ownership."""

    def __init__(self, db):
        self.db = db
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS environment_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_streams (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_devices (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_boots (
                device TEXT NOT NULL, boot TEXT NOT NULL, PRIMARY KEY(device, boot));
            CREATE TABLE IF NOT EXISTS environment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        self.db.commit()

    def _validate(self, body, source):
        if not isinstance(source, str) or source not in {"hardware", "demo"}:
            raise ValueError("Environment source must be hardware or demo")
        allowed = {"type", "zone", "sensor", "device_id", "boot_id", "sequence", "values", "units",
                   "readiness", "calibration", "compensation", "baseline"}
        if not isinstance(body, dict) or set(body) - allowed:
            raise ValueError("Invalid environmental observation fields")
        if body.get("type", "environment") != "environment":
            raise ValueError("Expected environment observation")
        zone, sensor = body.get("zone"), body.get("sensor")
        if not isinstance(zone, str) or not isinstance(sensor, str) or zone not in ZONES or sensor not in FIELDS:
            raise ValueError("Unknown environmental zone or sensor")
        device = _identifier(body.get("device_id"), "device_id")
        boot = _identifier(body.get("boot_id"), "boot_id")
        sequence = body.get("sequence")
        if type(sequence) is not int or not 0 <= sequence <= 9007199254740991:
            raise ValueError("sequence must be a nonnegative safe integer")
        values, units = body.get("values"), body.get("units")
        if not isinstance(values, dict) or not REQUIRED[sensor] <= set(values) <= set(FIELDS[sensor]):
            raise ValueError("Missing or unsupported sensor values")
        if not isinstance(units, dict) or set(units) != set(values):
            raise ValueError("Each sensor value requires an explicit canonical unit")
        for field, value in values.items():
            unit, low, high = FIELDS[sensor][field]
            if units[field] != unit:
                raise ValueError(f"{field} requires unit {unit}")
            if field == "present":
                if type(value) is not bool:
                    raise ValueError("present must be boolean")
            else:
                _number(value, field, low, high)
                if field == "proximity" and type(value) is not int:
                    raise ValueError("proximity must be an integer")
        ready = body.get("readiness", {"state": "unknown"})
        if not isinstance(ready, dict) or set(ready) - {"state", "warmup_seconds", "conditioning_hours"}:
            raise ValueError("Invalid readiness metadata")
        if not isinstance(ready.get("state"), str) or ready["state"] not in {"ready", "unknown", "warming_up", "conditioning", "fault"}:
            raise ValueError("Invalid readiness state")
        for field in ("warmup_seconds", "conditioning_hours"):
            if field in ready:
                _number(ready[field], field, 0, 100000000)
        calibration = _metadata(body.get("calibration"), "calibration",
                                {"calibrated", "uncalibrated", "unknown", "not_required"}, "unknown")
        compensation = _metadata(body.get("compensation"), "compensation",
                                 {"ambient_measured", "liquid_measured", "uncompensated", "unknown", "not_required"}, "unknown")
        if sensor == "tds" and compensation["status"] == "ambient_measured":
            raise ValueError("TDS liquid-temperature compensation cannot use ambient DHT11 readings")
        if compensation["status"] == "liquid_measured" and (sensor != "tds" or "liquid_temperature_c" not in values):
            raise ValueError("Liquid compensation requires an immersed sensor temperature in the TDS observation")
        if calibration["status"] == "not_required" and sensor in {"ccs811", "tds"}:
            raise ValueError("CCS811 and TDS require calibration status")
        baseline = body.get("baseline")
        if baseline is not None:
            if not isinstance(baseline, dict) or set(baseline) != {"kind", "reference", "duration_seconds", "thresholds"}:
                raise ValueError("Baseline needs kind, reference, duration_seconds and thresholds")
            if not isinstance(baseline["kind"], str) or baseline["kind"] not in {"operator", "commissioned"}:
                raise ValueError("Baseline must be operator-entered or commissioned")
            if not isinstance(baseline["reference"], str) or not 1 <= len(baseline["reference"]) <= 200:
                raise ValueError("Baseline requires a reference")
            _number(baseline["duration_seconds"], "duration_seconds", 1, 86400)
            thresholds = baseline["thresholds"]
            if not isinstance(thresholds, dict) or not thresholds or not set(thresholds) <= set(values) - {"present"}:
                raise ValueError("Baseline thresholds must match numeric observed fields")
            for field, bounds in thresholds.items():
                if not isinstance(bounds, dict) or set(bounds) - {"min", "max", "hysteresis"} or not {"min", "max"} & set(bounds):
                    raise ValueError("Each threshold needs min and/or max")
                _, low, high = FIELDS[sensor][field]
                for edge in ("min", "max"):
                    if edge in bounds:
                        _number(bounds[edge], field + "." + edge, low, high)
                if "min" in bounds and "max" in bounds and bounds["min"] >= bounds["max"]:
                    raise ValueError("Threshold min must be below max")
                _number(bounds.get("hysteresis", 0), "hysteresis", 0, high - low)
                if "min" in bounds and "max" in bounds and bounds.get("hysteresis", 0) * 2 >= bounds["max"] - bounds["min"]:
                    raise ValueError("Hysteresis must leave a recovery interval")
        return {"zone": zone, "sensor": sensor, "source": source, "device_id": device, "boot_id": boot,
                "sequence": sequence, "values": copy.deepcopy(values), "units": copy.deepcopy(units),
                "readiness": copy.deepcopy(ready), "calibration": calibration, "compensation": compensation,
                "baseline": copy.deepcopy(baseline), "simulated": source == "demo"}

    @staticmethod
    def _status(record):
        ready = record["readiness"]
        if ready["state"] != "ready":
            return ready["state"]
        if record["sensor"] == "ccs811":
            if ready.get("conditioning_hours", 0) < 48:
                return "conditioning"
            if ready.get("warmup_seconds", 0) < 1200:
                return "warming_up"
        if record["calibration"]["status"] not in {"calibrated", "not_required"}:
            return "unknown"
        return "ready"

    def ingest(self, body, source="hardware"):
        record = self._validate(body, source)
        now = time.time()
        stream_id = "/".join(record[k] for k in ("zone", "sensor", "source", "device_id"))
        device_id = source + "/" + record["device_id"]
        fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        row = self.db.execute("SELECT payload FROM environment_devices WHERE id=?", (device_id,)).fetchone()
        device = json.loads(row[0]) if row else None
        gap = 0
        reboot = bool(device and device["boot_id"] != record["boot_id"])
        if device and not reboot:
            if record["sequence"] == device["sequence"] and fingerprint == device["fingerprint"]:
                return {"accepted": False, "duplicate": True, "stream_id": stream_id,
                        "sequence_gap": 0, "reboot": False}
            if record["sequence"] <= device["sequence"]:
                raise ValueError("Out-of-order or conflicting environmental sequence")
            gap = record["sequence"] - device["sequence"] - 1
        elif self.db.execute("SELECT 1 FROM environment_boots WHERE device=? AND boot=?",
                             (device_id, record["boot_id"])).fetchone():
            raise ValueError("Retired device boot cannot be replayed")
        if not device and self.db.execute("SELECT count(*) FROM environment_devices").fetchone()[0] >= 128:
            raise ValueError("Environmental device limit reached")
        row = self.db.execute("SELECT payload FROM environment_streams WHERE id=?", (stream_id,)).fetchone()
        previous = json.loads(row[0]) if row else None
        if not previous and self.db.execute("SELECT count(*) FROM environment_streams").fetchone()[0] >= 256:
            raise ValueError("Environmental stream limit reached")
        continuity_revision = (device or {}).get("continuity_revision", 0) + int(bool(reboot or gap))
        record.update(id=stream_id, received_at=now, status=self._status(record), sequence_gap=gap,
                      anomaly_state={}, continuity_revision=continuity_revision)
        # Threshold changes, missing samples, reboot, stale/unready samples all break continuity.
        continuous = (previous and previous["boot_id"] == record["boot_id"] and not gap
                      and previous.get("continuity_revision", 0) == continuity_revision
                      and previous["baseline"] == record["baseline"] and previous["status"] == "ready"
                      and previous["calibration"] == record["calibration"]
                      and previous["compensation"] == record["compensation"]
                      and 0 <= now - previous["received_at"] <= STALE_SECONDS)
        if record["status"] == "ready" and record["baseline"]:
            for field, bounds in record["baseline"]["thresholds"].items():
                value = record["values"][field]
                old = previous.get("anomaly_state", {}).get(field) if continuous else None
                breach = (("min" in bounds and value < bounds["min"])
                          or ("max" in bounds and value > bounds["max"]))
                if old and old["active"]:
                    h = bounds.get("hysteresis", 0)
                    breach = (("min" in bounds and value < bounds["min"] + h)
                              or ("max" in bounds and value > bounds["max"] - h))
                if breach:
                    state = copy.deepcopy(old) if old else {"since": now, "count": 0, "active": False}
                    state["count"] += 1
                    state["active"] = (state["count"] >= 2 and now - state["since"] >= record["baseline"]["duration_seconds"])
                    record["anomaly_state"][field] = state
        device = {"boot_id": record["boot_id"], "sequence": record["sequence"], "fingerprint": fingerprint,
                  "continuity_revision": continuity_revision}
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO environment_boots(device,boot) VALUES (?,?)", (device_id, record["boot_id"]))
            self.db.execute("INSERT OR REPLACE INTO environment_devices(id,payload) VALUES (?,?)", (device_id, json.dumps(device)))
            self.db.execute("INSERT OR REPLACE INTO environment_streams(id,payload) VALUES (?,?)", (stream_id, json.dumps(record)))
            row = self.db.execute("INSERT INTO environment_samples(payload) VALUES (?)", (json.dumps(record),))
            self.db.execute("DELETE FROM environment_samples WHERE id NOT IN (SELECT id FROM environment_samples ORDER BY id DESC LIMIT ?)", (MAX_HISTORY,))
        return {"accepted": True, "duplicate": False, "stream_id": stream_id, "sample_id": row.lastrowid,
                "sequence_gap": gap, "reboot": reboot, "status": record["status"]}

    def snapshot(self, now=None):
        now = time.time() if now is None else _number(now, "now", 0, 1e15)
        streams = [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM environment_streams ORDER BY id")]
        samples = [(row[0], json.loads(row[1])) for row in self.db.execute("SELECT id,payload FROM environment_samples ORDER BY id")]
        devices = {row[0]: json.loads(row[1]) for row in self.db.execute("SELECT id,payload FROM environment_devices")}
        history, alerts = [], []
        for sample_id, sample in samples:
            history.append({"id": sample_id, "stream_id": sample["id"], **{k: sample[k] for k in
                ("zone", "sensor", "source", "received_at", "values", "units", "status", "simulated", "device_id", "boot_id", "sequence", "readiness", "calibration", "compensation", "baseline", "sequence_gap")}})
        for stream in streams:
            stream["age_seconds"] = max(0, now - stream["received_at"])
            device = devices[stream["source"] + "/" + stream["device_id"]]
            if stream["boot_id"] != device["boot_id"]:
                stream["status"] = "unknown"
            elif now < stream["received_at"] or stream["age_seconds"] > STALE_SECONDS:
                stream["status"] = "stale"
            relevant = [sample for _, sample in samples if sample["id"] == stream["id"]
                        and sample["boot_id"] == stream["boot_id"] and sample["status"] == "ready"
                        and sample["calibration"] == stream["calibration"]
                        and sample["compensation"] == stream["compensation"]]
            stream["trend"] = {}
            for field, value in stream["values"].items():
                points = [sample["values"][field] for sample in relevant if field in sample["values"]]
                if field != "present" and points:
                    stream["trend"][field] = {"first": points[0], "last": points[-1], "delta": points[-1] - points[0], "sample_count": len(points)}
            states = stream.pop("anomaly_state")
            # A gap received on another sensor in this device also breaks continuity.
            current_continuity = stream.pop("continuity_revision", 0) == device.get("continuity_revision", 0)
            active = [field for field, state in states.items() if state["active"]]
            if active and stream["status"] == "ready" and current_continuity:
                since = min(states[field]["since"] for field in active)
                water = stream["zone"] == "water"
                alerts.append({"id": stream["id"] + "/anomaly", "zone": stream["zone"],
                               "stream_id": stream["id"], "source": stream["source"],
                               "kind": "water_trend_anomaly" if water else "storage_anomaly",
                               "message": "Water trend changed: operator inspection needed; no potability conclusion." if water else "Storage anomaly: inspect the affected batch; no food-safety conclusion.",
                               "metrics": active, "since": since, "duration_seconds": stream["received_at"] - since,
                               "simulated": stream["simulated"]})
        zones = {}
        for zone in ZONES:
            grouped = [stream for stream in streams if stream["zone"] == zone]
            zone_alerts = [alert for alert in alerts if alert["zone"] == zone]
            def status(source=None):
                if any(source is None or alert["source"] == source for alert in zone_alerts):
                    return "inspection_needed"
                if any(stream["status"] == "ready" and (source is None or stream["source"] == source) for stream in grouped):
                    return "observing"
                return "unknown"
            zones[zone] = {"zone": zone, "status": status(), "hardware_status": status("hardware"),
                           "stream_ids": [stream["id"] for stream in grouped], "alerts": zone_alerts}
        return {"zones": zones, "streams": streams, "alerts": alerts, "history": history,
                "demo_loaded": bool(self.db.execute("SELECT 1 FROM environment_meta WHERE key IN ('demo_v1','presentation_demo')").fetchone()),
                "stale_after_seconds": STALE_SECONDS, "retained_history_limit": MAX_HISTORY, "limitations": LIMITATIONS[:],
                "demo_note": "Simulated observations use actual receive time. Trend changes are examples; sustained alerts require elapsed time."}

    def demo(self):
        if self.db.execute("SELECT 1 FROM environment_meta WHERE key='demo_v1'").fetchone():
            return self.snapshot()
        fixtures = [
            ("produce", "dht11", {"temperature_c": 21, "relative_humidity_pct": 57}),
            ("pantry", "dht11", {"temperature_c": 22, "relative_humidity_pct": 44}),
            ("produce", "ccs811", {"tvoc_ppb": 140, "eco2_ppm": 620}),
            ("produce", "ccs811", {"tvoc_ppb": 270, "eco2_ppm": 780}),
            ("produce", "ccs811", {"tvoc_ppb": 410, "eco2_ppm": 990}),
            ("water", "tds", {"tds_ppm": 190}), ("water", "tds", {"tds_ppm": 205}),
            ("water", "tds", {"tds_ppm": 245}), ("water", "apds9960", {"present": True, "proximity": 180}),
        ]
        for sequence, (zone, sensor, values) in enumerate(fixtures):
            body = {"zone": zone, "sensor": sensor, "device_id": "demo-environment-v1", "boot_id": "fixture-v1",
                    "sequence": sequence, "values": values, "units": {field: FIELDS[sensor][field][0] for field in values},
                    "readiness": {"state": "ready", "warmup_seconds": 1200, "conditioning_hours": 48},
                    "calibration": {"status": "calibrated", "reference": "Simulated fixture; no physical calibration"},
                    "compensation": {"status": "uncompensated"}}
            if sensor in {"ccs811", "tds"}:
                field, limit = ("tvoc_ppb", 250) if sensor == "ccs811" else ("tds_ppm", 220)
                body["baseline"] = {"kind": "operator", "reference": "Demo-only example thresholds, not safety limits",
                                    "duration_seconds": 30, "thresholds": {field: {"max": limit, "hysteresis": 10}}}
            # An interrupted seed resumes after its durable sequence without replaying earlier samples.
            row = self.db.execute("SELECT payload FROM environment_devices WHERE id='demo/demo-environment-v1'").fetchone()
            if row and json.loads(row[0])["sequence"] >= sequence:
                continue
            self.ingest(body, source="demo")
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO environment_meta(key,value) VALUES ('demo_v1','loaded')")
        return self.snapshot()
