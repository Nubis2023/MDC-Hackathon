"""Auditable batch, planning and measured-outcome facts; no stock or price writes."""
import datetime as dt
import json
import math
import time
import uuid

from .catalog import CATALOG


def _text(value, name, maximum=240, optional=False):
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be nonempty text of at most {maximum} characters")
    return value.strip()


def _number(value, name, minimum=0, maximum=1000000, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be {'an integer' if integer else 'finite'} from {minimum} to {maximum}")
    return value


def _date(value, name):
    value = _text(value, name, 10)
    try:
        result = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must use YYYY-MM-DD") from exc
    if result.isoformat() != value:
        raise ValueError(f"{name} must use YYYY-MM-DD")
    return value


def _today(now=None):
    return dt.date.fromtimestamp(time.time() if now is None else _number(now, "now", 0, 1e12))


class SustainabilityStore:
    """Mutations are synchronous and atomic on the coordinator's SQLite connection.

    Callers serialize linked-batch mutations with robot delivery, and invalidate
    commerce approval evidence after an operator change. Simulated sessions never
    inherit prior inventory silently; old linked rows block until replaced.
    """

    def __init__(self, db, session_id, device_mode):
        if device_mode not in {"simulated", "hardware"}:
            raise ValueError("Unknown device mode")
        self.db, self.session_id, self.device_mode = db, _text(session_id, "session_id", 128), device_mode
        for name in ("batches", "forecasts", "outcomes", "refills"):
            self.db.execute(f"CREATE TABLE IF NOT EXISTS sustain_{name} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS sustain_mutations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL)")
        self.db.commit()

    def _rows(self, table):
        return [json.loads(row[0]) for row in self.db.execute(f"SELECT payload FROM sustain_{table} ORDER BY rowid")]

    def _save(self, table, identity, payload):
        self.db.execute(f"INSERT INTO sustain_{table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                        (identity, json.dumps(payload, allow_nan=False)))

    def _mutate(self, kind, body, payload, work):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        request_id = _text(body.get("request_id", body.get("mutation_id")), "request_id", 160)
        if body.get("request_id") and body.get("mutation_id") and body["request_id"] != body["mutation_id"]:
            raise ValueError("Conflicting request IDs")
        request = json.dumps(payload, sort_keys=True, allow_nan=False)
        old = self.db.execute("SELECT kind,request,response FROM sustain_mutations WHERE id=?", (request_id,)).fetchone()
        if old:
            if old[0] != kind or old[1] != request:
                raise ValueError("Request ID already used for different sustainability facts")
            return json.loads(old[2])
        self.db.execute("SAVEPOINT sustainability_write")
        try:
            result = work(request_id)
            self.db.execute("INSERT INTO sustain_mutations VALUES (?,?,?,?)", (request_id, kind, request, json.dumps(result, allow_nan=False)))
            self.db.execute("RELEASE SAVEPOINT sustainability_write")
            return result
        except Exception:
            self.db.execute("ROLLBACK TO SAVEPOINT sustainability_write")
            self.db.execute("RELEASE SAVEPOINT sustainability_write")
            raise

    def _source(self, value):
        value = value or "operator"
        if value not in {"operator", "demo"}:
            raise ValueError("source must be operator or demo")
        return value

    def _active(self, batch):
        if batch.get("replaced_by") or batch["device_mode"] != self.device_mode:
            return False
        return ((batch["source"] != "demo" and self.device_mode == "hardware")
                or batch["session_id"] == self.session_id)

    def get_batch(self, batch_id):
        batch_id = _text(batch_id, "batch_id", 160)
        row = self.db.execute("SELECT payload FROM sustain_batches WHERE id=?", (batch_id,)).fetchone()
        if not row:
            raise ValueError("Unknown batch")
        return json.loads(row[0])

    def add_batch(self, body):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        sku = _text(body.get("sku") or None, "sku", 80, optional=True)
        if sku is not None and sku not in CATALOG:
            raise ValueError("Unknown SKU")
        zone, date_type = body.get("zone"), body.get("date_type")
        if zone not in {"produce", "pantry"}:
            raise ValueError("Batch zone must be produce or pantry")
        if date_type not in {"best_before", "use_by", "planning"}:
            raise ValueError("Unknown date type")
        source = self._source(body.get("source"))
        if source == "demo" and sku:
            raise ValueError("Demo batches cannot link to commerce stock")
        payload = {"product": _text(body.get("product"), "product", 120), "sku": sku,
                   "zone": zone, "quantity": _number(body.get("quantity"), "quantity", 1, 100000, True),
                   "date_type": date_type, "date": _date(body.get("date"), "date"),
                   "received_date": _date(body.get("received_date"), "received_date"), "source": source,
                   "unit_mass_g": None if body.get("unit_mass_g") is None else _number(body["unit_mass_g"], "unit_mass_g", 0.001, 1000000),
                   "replaces_batch_id": _text(body.get("replaces_batch_id"), "replaces_batch_id", 160, optional=True)}
        if payload["date"] < payload["received_date"]:
            raise ValueError("Batch date must not precede its received date")

        def write(request_id):
            prior = None
            if payload["replaces_batch_id"]:
                prior = self.get_batch(payload["replaces_batch_id"])
                if (prior["device_mode"] != "simulated" or self.device_mode != "simulated" or
                        prior["session_id"] == self.session_id or prior.get("replaced_by") or
                        prior["sku"] != sku or prior["source"] != source or source != "operator"):
                    raise ValueError("Only a prior simulated-session operator batch of the same SKU can be replaced")
            batch = {**payload, "batch_id": uuid.uuid4().hex, "remaining_units": payload["quantity"],
                     "quality_hold": False, "hold_reason": "", "created_at": time.time(),
                     "session_id": self.session_id, "device_mode": self.device_mode}
            self._save("batches", batch["batch_id"], batch)
            if prior:
                prior["replaced_by"] = batch["batch_id"]
                self._save("batches", prior["batch_id"], prior)
            return batch
        return self._mutate("batch", body, payload, write)

    def hold_batch(self, body):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        held = body.get("held")
        if type(held) is not bool:
            raise ValueError("held must be true or false")
        payload = {"batch_id": _text(body.get("batch_id"), "batch_id", 160), "held": held,
                   "reason": _text(body.get("reason"), "reason", 500)}

        def write(request_id):
            batch = self.get_batch(payload["batch_id"])
            if not self._active(batch):
                raise ValueError("Historical batch requires reconciliation before changes")
            batch.update(quality_hold=held, hold_reason=payload["reason"], reviewed_at=time.time())
            if not held:
                batch["best_before_reviewed_on"] = _today().isoformat()
            self._save("batches", batch["batch_id"], batch)
            return batch
        return self._mutate("hold", body, payload, write)

    def set_forecast(self, body):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        payload = {"batch_id": _text(body.get("batch_id"), "batch_id", 160),
                   "source": self._source(body.get("source")),
                   "daily_demand": _number(body.get("daily_demand"), "daily_demand", 0, 100000),
                   "lead_days": _number(body.get("lead_days"), "lead_days", 0, 365),
                   "review_days": _number(body.get("review_days"), "review_days", 0, 365),
                   "uncertainty_units": _number(body.get("uncertainty_units", 0), "uncertainty_units", 0, 100000),
                   "open_order_units": _number(body.get("open_order_units", 0), "open_order_units", 0, 100000, True)}

        def write(request_id):
            batch = self.get_batch(payload["batch_id"])
            if not self._active(batch):
                raise ValueError("Cannot forecast an inactive batch")
            if payload["source"] == "demo" and batch["source"] != "demo":
                raise ValueError("Demo forecasts require a demo batch")
            forecast = {**payload, "updated_at": time.time(), "scope": "this batch only", "sku": batch["sku"]}
            self._save("forecasts", batch["batch_id"], forecast)
            return forecast
        return self._mutate("forecast", body, payload, write)

    def _assess(self, batch, today):
        if not self._active(batch):
            return False, "Historical or replaced batch; reconcile before use"
        if batch["remaining_units"] <= 0:
            return False, "Batch exhausted"
        if batch["quality_hold"]:
            return False, "Quality hold: " + batch["hold_reason"]
        if batch["date"] < today.isoformat():
            if batch["date_type"] == "use_by":
                return False, "Use-by date passed; excluded from sale, use and donation"
            if batch["date_type"] == "best_before" and batch.get("best_before_reviewed_on") != today.isoformat():
                return False, "Best-before date passed; operator quality review required"
        return True, "Eligible by batch records; this is not a food-safety determination"

    def _linked(self, sku):
        return [b for b in self._rows("batches") if b["sku"] == sku and b["source"] == "operator"
                and b["device_mode"] == self.device_mode and not b.get("replaced_by")]

    def eligibility(self, sku, quantity, evidence=None):
        if sku not in CATALOG:
            raise ValueError("Unknown SKU")
        _number(quantity, "quantity", 1, 100000, True)
        batches = self._linked(sku)
        result = {"sku": sku, "tracked": bool(batches), "eligible": True, "issues": [], "allocations": [],
                  "tracked_quantity": sum(b["remaining_units"] for b in batches), "observed_quantity": None}
        if not batches:
            result["status"] = "untracked"
            return result
        historical = [b for b in batches if b["remaining_units"] and not self._active(b)]
        if historical:
            result["issues"].append("Prior simulated-session batch counts require explicit replacement and stock reconciliation")
        evidence = evidence if isinstance(evidence, dict) else {}
        observed = evidence.get("quantity")
        stamp = evidence.get("observed_at")
        fresh = (type(stamp) in (int, float) and math.isfinite(stamp) and -2 <= time.time() - stamp <= 30
                 and evidence.get("source") == self.device_mode and bool(evidence.get("evidence_id"))
                 and not evidence.get("invalidated_by_sensor") and evidence.get("sku") == sku)
        result["observed_quantity"] = observed if type(observed) is int else None
        if not fresh or type(observed) is not int or observed < 0:
            result["issues"].append("Fresh verified stock quantity is required to reconcile tracked batches")
        elif observed != result["tracked_quantity"]:
            result["issues"].append(f"Batch total {result['tracked_quantity']} does not match verified stock {observed}; reconcile counts")
        remaining = quantity
        for batch in sorted(batches, key=lambda b: (b["date"], b["received_date"], b["created_at"], b["batch_id"])):
            if self._assess(batch, _today())[0]:
                units = min(remaining, batch["remaining_units"])
                if units:
                    result["allocations"].append({"batch_id": batch["batch_id"], "quantity": units})
                    remaining -= units
        if remaining:
            result["issues"].append("Insufficient eligible dated batches; inspect holds and date reviews")
        result["eligible"] = not result["issues"]
        result["status"] = "matched" if result["eligible"] else "review_required"
        return result

    def _outcome(self, batch, kind, quantity, identity, reason, **extra):
        occurred_at = time.time()
        result = {"id": identity, "batch_id": batch["batch_id"], "sku": batch["sku"], "product": batch["product"],
                  "kind": kind, "quantity": quantity,
                  "mass_g": None if batch["unit_mass_g"] is None else round(quantity * batch["unit_mass_g"], 3),
                  "source": batch["source"], "device_mode": batch["device_mode"], "session_id": self.session_id,
                  "occurred_at": occurred_at, "reason": reason,
                  "recorded_date": batch["date"], "date_type": batch["date_type"],
                  "on_or_before_recorded_date": dt.date.fromtimestamp(occurred_at).isoformat() <= batch["date"],
                  **extra}
        batch["remaining_units"] -= quantity
        self._save("batches", batch["batch_id"], batch)
        self._save("outcomes", identity, result)
        return result

    def record_outcome(self, body):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        kind = body.get("kind")
        if kind not in {"used", "discarded", "donated"}:
            raise ValueError("Outcome kind must be used, discarded or donated")
        handoff = body.get("handoff_confirmed", False)
        if type(handoff) is not bool:
            raise ValueError("handoff_confirmed must be a boolean")
        if kind == "donated" and not handoff:
            raise ValueError("Donation requires confirmation of an actual handoff")
        payload = {"batch_id": _text(body.get("batch_id"), "batch_id", 160), "kind": kind,
                   "quantity": _number(body.get("quantity"), "quantity", 1, 100000, True),
                   "reason": _text(body.get("reason"), "reason", 500), "handoff_confirmed": handoff}

        def write(request_id):
            batch = self.get_batch(payload["batch_id"])
            if not self._active(batch):
                raise ValueError("Historical batch requires reconciliation before recording outcomes")
            if payload["quantity"] > batch["remaining_units"]:
                raise ValueError("Outcome exceeds remaining batch quantity")
            eligible, reason = self._assess(batch, _today())
            if kind != "discarded" and not eligible:
                raise ValueError(reason)
            return self._outcome(batch, kind, payload["quantity"], request_id, payload["reason"],
                                 handoff_confirmed=handoff, evidence_type="simulated demonstration" if batch["source"] == "demo" else "operator attestation")
        return self._mutate("outcome", body, payload, write)

    def record_refill(self, body):
        if not isinstance(body, dict):
            raise ValueError("A JSON object is required")
        payload = {"volume_ml": _number(body.get("volume_ml"), "volume_ml", 1, 1000000),
                   "note": _text(body.get("note") or "Operator-entered measured volume", "note", 500),
                   "source": self._source(body.get("source"))}

        def write(request_id):
            result = {**payload, "id": request_id, "occurred_at": time.time(), "session_id": self.session_id,
                      "device_mode": self.device_mode, "measurement_method": "simulated volume fixture" if payload["source"] == "demo" else "operator-entered volume",
                      "water_conserved_ml": None}
            self._save("refills", request_id, result)
            return result
        return self._mutate("refill", body, payload, write)

    def consume(self, sku, receipt):
        """Allocate every independently verified delivery receipt, including partial orders."""
        if not isinstance(receipt, dict):
            raise ValueError("A delivery receipt is required")
        command_id = _text(receipt.get("command_id"), "command_id", 160)
        payload = {"sku": sku, "receipt": receipt}

        def write(request_id):
            if (receipt.get("sku") != sku or receipt.get("source") != self.device_mode or
                    receipt.get("completed") is not True or receipt.get("arrival_verified") is not True):
                raise ValueError("Delivery completion and arrival require matching source evidence")
            if sku not in CATALOG:
                raise ValueError("Unknown SKU")
            if not self._linked(sku):
                return {"sku": sku, "tracked": False, "outcomes": [], "command_id": command_id}
            delivered = _number(receipt.get("delivered_quantity", 1), "delivered_quantity", 1, 100000, True)
            post_quantity = _number(receipt.get("quantity"), "receipt quantity", 0, 1000000, True)
            evidence = {**receipt, "quantity": post_quantity + delivered}
            assessment = self.eligibility(sku, delivered, evidence)
            if not assessment["tracked"]:
                return {"sku": sku, "tracked": False, "outcomes": [], "command_id": command_id}
            if not assessment["eligible"]:
                raise ValueError("; ".join(assessment["issues"]))
            if self.device_mode == "hardware":
                batch_id = _text(receipt.get("batch_id"), "Hardware receipt batch_id", 160)
                matched = self.get_batch(batch_id)
                if (matched["sku"] != sku or not self._assess(matched, _today())[0]
                        or matched["remaining_units"] < delivered):
                    raise ValueError("Hardware receipt does not identify an eligible batch with sufficient units")
                assessment["allocations"] = [{"batch_id": batch_id, "quantity": delivered}]
            outcomes = []
            for index, allocation in enumerate(assessment["allocations"]):
                batch = self.get_batch(allocation["batch_id"])
                outcomes.append(self._outcome(batch, "sold", allocation["quantity"], request_id + ":" + str(index),
                    "Verified delivery; FEFO batch ledger allocation", command_id=command_id,
                    evidence_id=receipt.get("evidence_id"), evidence_type="verified delivery",
                    allocation_method=("Receipt identifies physical batch" if self.device_mode == "hardware"
                                       else "Simulated FEFO allocation; no physical batch sensed")))
            return {"sku": sku, "tracked": True, "outcomes": outcomes, "command_id": command_id}
        return self._mutate("consume", {"request_id": "delivery:" + command_id}, payload, write)

    def _plan(self, batch, forecast):
        usable = batch["remaining_units"] if batch["eligible"] else 0
        days = max(0, batch["days_to_date"])
        expected = min(usable, forecast["daily_demand"] * days)
        surplus = max(0, usable - math.ceil(expected))
        horizon = forecast["lead_days"] + forecast["review_days"]
        contribution = min(usable, forecast["daily_demand"] * min(days, horizon))
        demand_window = forecast["daily_demand"] * horizon
        recommended = math.ceil(max(0, demand_window + forecast["uncertainty_units"] - contribution - forecast["open_order_units"]))
        return {**forecast, "product": batch["product"], "source": batch["source"], "forecast_source": forecast["source"],
                "eligible_units": usable, "inventory_demand_contribution_units": contribution, "expected_before_date": expected,
                "projected_surplus_units": surplus, "recommended_order_units": recommended,
                "arithmetic": f"Demand {forecast['daily_demand']}/day × ({forecast['lead_days']} lead + {forecast['review_days']} review days) + {forecast['uncertainty_units']} uncertainty − {contribution} current units expected to sell within both the recorded-date and planning window − {forecast['open_order_units']} open-order units; round up, minimum zero.",
                "surplus_arithmetic": f"{usable} eligible units − {forecast['daily_demand']}/day × {days} days until the recorded date = {surplus} projected surplus units (rounded down, minimum zero).",
                "review_required": True, "forecast_scope": "this batch only; do not sum forecasts for the same product",
                "tradeoff": "Lower orders reduce surplus risk but may increase stockouts; review uncertainty and actual demand.",
                "history_basis": "Explicit forecast; not inferred from sales history", "purchase_placed": False}

    def snapshot(self, stock=None, now=None):
        today = _today(now)
        batches, plans, actions, reconciliation = [], [], [], []
        forecasts = {f["batch_id"]: f for f in self._rows("forecasts")}
        for batch in self._rows("batches"):
            eligible, reason = self._assess(batch, today)
            batch.update(active=self._active(batch), eligible=eligible, eligibility_reason=reason,
                         batch_conditions_eligible=eligible,
                         days_to_date=(dt.date.fromisoformat(batch["date"]) - today).days)
            batches.append(batch)
        skus = set(stock or {}) | {b["sku"] for b in batches if b["sku"] and b["device_mode"] == self.device_mode and not b.get("replaced_by")}
        for sku in sorted(skus):
            linked = self._linked(sku)
            item = (stock or {}).get(sku, {})
            evidence = item.get("evidence", {})
            observed = evidence.get("quantity", item.get("observed_quantity"))
            stamp = evidence.get("observed_at")
            current_time = time.time() if now is None else now
            fresh = (not item.get("observation_stale", False) and not evidence.get("invalidated_by_sensor")
                     and evidence.get("source") == self.device_mode and bool(evidence.get("evidence_id"))
                     and evidence.get("sku") == sku
                     and type(stamp) in (int, float) and math.isfinite(stamp) and -2 <= current_time - stamp <= 30)
            total = sum(b["remaining_units"] for b in linked)
            status = ("untracked" if not linked else "session_reconciliation_required" if any(not self._active(b) and b["remaining_units"] for b in linked)
                      else "unknown" if not fresh or type(observed) is not int else "matched" if total == observed else "mismatch")
            reconciliation.append({"sku": sku, "tracked_quantity": total, "observed_quantity": observed if type(observed) is int else None, "status": status})
        statuses = {row["sku"]: row["status"] for row in reconciliation}
        for batch in batches:
            batch["stock_status"] = statuses.get(batch["sku"], "unlinked")
            if not batch["active"] or not batch["remaining_units"]:
                continue
            reconciled = batch["stock_status"] in {"matched", "unlinked"}
            if not reconciled:
                batch["eligible"] = False
                batch["eligibility_reason"] = (f"Stock reconciliation is {batch['stock_status']}; verify counts before allocation. "
                                               + batch["eligibility_reason"])
            if not batch["eligible"]:
                actions.append({"type": "inspection" if reconciled else "reconciliation", "batch_id": batch["batch_id"], "product": batch["product"],
                                "message": batch["eligibility_reason"], "review_required": True})
            else:
                actions.append({"type": "fefo", "batch_id": batch["batch_id"], "product": batch["product"],
                                "message": f"Use eligible batches in recorded-date order: {batch['date_type']} {batch['date']}.", "review_required": True})
            if batch["batch_id"] in forecasts:
                plan = self._plan(batch, forecasts[batch["batch_id"]])
                plan.update(stock_status=batch["stock_status"], inventory_basis="Batch ledger reconciled to verified stock" if batch["sku"] else "Unlinked batch ledger; operator/demo quantity")
                if not reconciled:
                    plan.update(eligible_units=None, inventory_demand_contribution_units=None, expected_before_date=None,
                                projected_surplus_units=None, recommended_order_units=None,
                                arithmetic="Recommendations unavailable until batch counts reconcile with fresh verified stock.",
                                surplus_arithmetic="Surplus estimate unavailable while stock is unknown or mismatched.",
                                inventory_basis="Unreconciled batch ledger")
                plans.append(plan)
                if plan["projected_surplus_units"]:
                    actions.append({"type": "surplus", "batch_id": batch["batch_id"], "product": batch["product"],
                                    "message": f"Review {plan['projected_surplus_units']} projected surplus units for use, a price-change draft or eligible donation. No action has been performed.", "review_required": True})
        outcomes, refills = self._rows("outcomes"), self._rows("refills")
        totals = lambda: {"used_units": 0, "donated_units": 0, "discarded_units": 0, "sold_units": 0,
                          "used_mass_g": 0, "donated_mass_g": 0, "discarded_mass_g": 0, "sold_mass_g": 0,
                          "known_mass_g": 0, "unknown_mass_units": 0, "refill_volume_ml": 0}
        impact = {"observed": totals(), "simulated": totals(), "estimates": {"avoided_waste_units": None,
                  "water_conserved_ml": None, "avoided_packaging": None, "co2e_kg": None},
                  "totals_scope": "All retained sessions, separated by original evidence provenance",
                  "note": "Recorded outcomes and volume are not automatically waste avoided, water conserved, packaging avoided or CO2e savings. Observed means operator/hardware records; simulated mode and demo facts are separate."}
        for outcome in outcomes:
            bucket = impact["simulated" if outcome["source"] == "demo" or outcome["device_mode"] == "simulated" else "observed"]
            bucket[outcome["kind"] + "_units"] += outcome["quantity"]
            if outcome["mass_g"] is None:
                bucket["unknown_mass_units"] += outcome["quantity"]
            else:
                bucket["known_mass_g"] += outcome["mass_g"]
                bucket[outcome["kind"] + "_mass_g"] += outcome["mass_g"]
        for refill in refills:
            bucket = impact["simulated" if refill["source"] == "demo" or refill["device_mode"] == "simulated" else "observed"]
            bucket["refill_volume_ml"] += refill["volume_ml"]
        return {"batches": sorted(batches, key=lambda b: (b["date"], b["created_at"])), "plans": plans, "actions": actions,
                "outcomes": outcomes, "impact": impact, "refills": refills, "reconciliation": reconciliation,
                "device_mode": self.device_mode, "session_id": self.session_id,
                "limitations": ["Batch registration never changes verified stock.", "Dates and sensor trends do not certify food safety.",
                                "Plans require human review; no prices, supplier purchases or donations are executed."]}

    def demo(self):
        today = _today()
        prefix = "sustainability-demo:" + self.session_id
        previous = self.db.execute("SELECT response FROM sustain_mutations WHERE id=?", (prefix + ":batch:0",)).fetchone()
        if previous:
            today = dt.date.fromisoformat(json.loads(previous[0])["received_date"])
        definitions = [("Tomato tray", "produce", 12, 2, 120), ("Leafy greens — inspection fixture", "produce", 4, 1, 80),
                       ("Packaged pantry fixture", "pantry", 8, 10, 200)]
        result = []
        for index, (product, zone, units, days, mass) in enumerate(definitions):
            batch = self.add_batch({"request_id": prefix + f":batch:{index}", "product": product, "zone": zone,
                "quantity": units, "date_type": "planning" if zone == "produce" else "best_before",
                "date": (today + dt.timedelta(days=days)).isoformat(), "received_date": today.isoformat(),
                "unit_mass_g": mass, "source": "demo"})
            if index == 1:
                self.hold_batch({"request_id": prefix + ":hold", "batch_id": batch["batch_id"], "held": True,
                                 "reason": "Demo quality hold: operator inspection required"})
            else:
                self.set_forecast({"request_id": prefix + f":forecast:{index}", "batch_id": batch["batch_id"],
                    "daily_demand": 3 if index == 0 else 1, "lead_days": 1, "review_days": 2,
                    "uncertainty_units": 1, "open_order_units": 0, "source": "demo"})
            result.append(batch["batch_id"])
        return {"source": "demo", "batch_ids": result, "outcomes_created": 0, "refills_created": 0,
                "message": "Unlinked planning fixtures only; commerce stock is unchanged."}
