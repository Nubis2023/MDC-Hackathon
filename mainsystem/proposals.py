"""Persistent agent proposals; only an operator route may apply or reject them.

The store has no commerce approval or arbitrary-dispatch capability. Application
handlers must honor the supplied request_id idempotently, as the sustainability
and filter stores do. A failed/uncertain attempt is never retried automatically.
"""
import copy
import datetime as dt
import inspect
import json
import math
import time
import uuid

from .catalog import CATALOG


OPERATIONS = frozenset({"batch", "hold", "forecast", "outcome", "refill",
                        "filter_register", "filter_throughput"})


def _text(value, name, maximum, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be nonempty text of at most {maximum} characters")
    return value.strip()


def _number(value, name, minimum, maximum, integer=False, nullable=False):
    if value is None and nullable:
        return None
    if (type(value) not in ((int,) if integer else (int, float))
            or not math.isfinite(value) or not minimum <= value <= maximum):
        raise ValueError(f"Invalid {name}")
    return value


def _date(value, name):
    value = _text(value, name, 10)
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{name} must use YYYY-MM-DD")
    return value


def _boolean(value, name):
    if type(value) is not bool:
        raise ValueError(f"{name} must be a boolean")
    return value


def _shape(details, required, optional=()):
    if not isinstance(details, dict):
        raise ValueError("Proposal details must be a JSON object")
    missing = set(required) - set(details)
    extra = set(details) - set(required) - set(optional)
    if missing or extra:
        raise ValueError("Proposal details have missing or unsupported fields")


def validate_details(operation, details):
    """Validate a concrete proposal without applying it or fabricating evidence."""
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ValueError("Unknown proposal operation")
    if operation == "batch":
        _shape(details, {"product", "zone", "quantity", "date_type", "date", "received_date"},
               {"sku", "unit_mass_g", "replaces_batch_id"})
        result = {"product": _text(details["product"], "product", 120),
                  "zone": details["zone"], "quantity": _number(details["quantity"], "quantity", 1, 100000, True),
                  "date_type": details["date_type"], "date": _date(details["date"], "date"),
                  "received_date": _date(details["received_date"], "received_date")}
        if result["zone"] not in ("produce", "pantry") or result["date_type"] not in ("best_before", "use_by", "planning"):
            raise ValueError("Invalid batch zone or date type")
        if result["date"] < result["received_date"]:
            raise ValueError("Batch date must not precede its received date")
        if "sku" in details:
            result["sku"] = _text(details["sku"], "sku", 80, nullable=True)
            if result["sku"] is not None and result["sku"] not in CATALOG:
                raise ValueError("Unknown SKU")
        if "unit_mass_g" in details:
            result["unit_mass_g"] = _number(details["unit_mass_g"], "unit_mass_g", .001, 1000000, nullable=True)
        if "replaces_batch_id" in details:
            result["replaces_batch_id"] = _text(details["replaces_batch_id"], "replaces_batch_id", 160, nullable=True)
    elif operation == "hold":
        _shape(details, {"batch_id", "held", "reason"})
        result = {"batch_id": _text(details["batch_id"], "batch_id", 160),
                  "held": _boolean(details["held"], "held"), "reason": _text(details["reason"], "reason", 500)}
    elif operation == "forecast":
        _shape(details, {"batch_id", "daily_demand", "lead_days", "review_days"},
               {"uncertainty_units", "open_order_units"})
        result = {"batch_id": _text(details["batch_id"], "batch_id", 160),
                  "daily_demand": _number(details["daily_demand"], "daily_demand", 0, 100000),
                  "lead_days": _number(details["lead_days"], "lead_days", 0, 365),
                  "review_days": _number(details["review_days"], "review_days", 0, 365)}
        for name, integer in (("uncertainty_units", False), ("open_order_units", True)):
            if name in details:
                result[name] = _number(details[name], name, 0, 100000, integer)
    elif operation == "outcome":
        _shape(details, {"batch_id", "kind", "quantity", "reason"}, {"handoff_confirmed"})
        result = {"batch_id": _text(details["batch_id"], "batch_id", 160), "kind": details["kind"],
                  "quantity": _number(details["quantity"], "quantity", 1, 100000, True),
                  "reason": _text(details["reason"], "reason", 500)}
        if result["kind"] not in ("used", "discarded", "donated"):
            raise ValueError("Outcome must be used, discarded or donated")
        if "handoff_confirmed" in details:
            result["handoff_confirmed"] = _boolean(details["handoff_confirmed"], "handoff_confirmed")
        if result["kind"] == "donated" and not result.get("handoff_confirmed"):
            raise ValueError("Donation proposal needs an explicit actual-handoff confirmation")
    elif operation == "refill":
        _shape(details, {"volume_ml"}, {"note"})
        result = {"volume_ml": _number(details["volume_ml"], "volume_ml", 1, 1000000)}
        if "note" in details:
            result["note"] = _text(details["note"], "note", 500)
    elif operation == "filter_register":
        _shape(details, {"manufacturer", "model", "instructions_reference", "installed_date"},
               {"rated_days", "rated_litres", "replaces_filter_id"})
        result = {"manufacturer": _text(details["manufacturer"], "manufacturer", 120),
                  "model": _text(details["model"], "model", 160),
                  "instructions_reference": _text(details["instructions_reference"], "instructions_reference", 1000),
                  "installed_date": _date(details["installed_date"], "installed_date")}
        if result["installed_date"] > dt.date.today().isoformat():
            raise ValueError("Filter installation cannot be in the future")
        if "rated_days" in details:
            result["rated_days"] = _number(details["rated_days"], "rated_days", 1, 36500, True, nullable=True)
        if "rated_litres" in details:
            value = _number(details["rated_litres"], "rated_litres", 0, 1e9, nullable=True)
            if value == 0:
                raise ValueError("rated_litres must be positive")
            result["rated_litres"] = value
        if "replaces_filter_id" in details:
            result["replaces_filter_id"] = _text(details["replaces_filter_id"], "replaces_filter_id", 160)
    else:
        _shape(details, {"filter_id", "total_litres", "measured_on",
                         "covers_all_throughput_since_installation", "measurement_reference"})
        result = {"filter_id": _text(details["filter_id"], "filter_id", 160),
                  "total_litres": _number(details["total_litres"], "total_litres", 0, 1e9),
                  "measured_on": _date(details["measured_on"], "measured_on"),
                  "covers_all_throughput_since_installation": _boolean(
                      details["covers_all_throughput_since_installation"], "covers_all_throughput_since_installation"),
                  "measurement_reference": _text(details["measurement_reference"], "measurement_reference", 1000)}
        if result["measured_on"] > dt.date.today().isoformat():
            raise ValueError("Throughput measurement cannot be in the future")
    return result


class ProposalStore:
    """Agent can create drafts; the caller restricts review to human operators.

    ``apply(id, handler, retry=False)`` awaits ``handler(operation, body)``. The
    handler must be idempotent for body['request_id']; an explicit operator retry
    after an uncertain response reuses that identifier. Applied records return
    their saved result without dispatching again. Historical drafts cannot apply.
    """

    def __init__(self, db, session_id, device_mode):
        if device_mode not in {"simulated", "hardware"}:
            raise ValueError("Unknown device mode")
        self.db, self.session_id, self.device_mode = db, _text(session_id, "session_id", 128), device_mode
        self.db.execute("CREATE TABLE IF NOT EXISTS operator_proposals "
                        "(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL)")
        self.db.commit()

    def _active(self, record):
        return record["session_id"] == self.session_id and record["device_mode"] == self.device_mode

    def _public(self, record):
        result = copy.deepcopy(record)
        result["active"] = self._active(record)
        result["review_required"] = record["status"] in {"pending", "failed", "applying"}
        return result

    def _save(self, record):
        self.db.execute("UPDATE operator_proposals SET payload=? WHERE id=?",
                        (json.dumps(record, allow_nan=False), record["proposal_id"]))
        self.db.commit()

    def get(self, proposal_id):
        proposal_id = _text(proposal_id, "proposal_id", 160)
        row = self.db.execute("SELECT payload FROM operator_proposals WHERE id=?", (proposal_id,)).fetchone()
        if not row:
            raise ValueError("Unknown operator proposal")
        return self._public(json.loads(row[0]))

    def create(self, body):
        _shape(body, {"request_id", "operation", "details", "reason"})
        request_id = _text(body["request_id"], "request_id", 160)
        operation = body["operation"]
        details = validate_details(operation, body["details"])
        reason = _text(body["reason"], "reason", 500)
        request = json.dumps({"operation": operation, "details": details, "reason": reason}, sort_keys=True, allow_nan=False)
        old = self.db.execute("SELECT request,payload FROM operator_proposals WHERE request_id=?", (request_id,)).fetchone()
        if old:
            if old[0] != request:
                raise ValueError("Proposal request ID already used for different details")
            return self._public(json.loads(old[1]))
        identity = uuid.uuid4().hex
        record = {"proposal_id": identity, "request_id": request_id, "operation": operation,
                  "details": details, "reason": reason, "status": "pending", "created_at": time.time(),
                  "session_id": self.session_id, "device_mode": self.device_mode,
                  "application_request_id": "operator-proposal:" + identity, "attempts": 0,
                  "approval_granted": False, "outcome_uncertain": False}
        self.db.execute("INSERT INTO operator_proposals VALUES (?,?,?,?)",
                        (identity, request_id, request, json.dumps(record, allow_nan=False)))
        self.db.commit()
        return self._public(record)

    def snapshot(self):
        return [self._public(json.loads(row[0])) for row in
                self.db.execute("SELECT payload FROM operator_proposals ORDER BY rowid")]

    def pending(self):
        return [record for record in self.snapshot() if record["active"] and record["status"] == "pending"]

    def _reviewable(self, proposal_id):
        record = self.get(proposal_id)
        if not record["active"]:
            raise ValueError("Historical proposal cannot be reviewed; create a new current-session proposal")
        record.pop("active", None)
        record.pop("review_required", None)
        return record

    def reject(self, proposal_id, reason):
        reason = _text(reason, "rejection reason", 500)
        record = self._reviewable(proposal_id)
        if record["status"] == "rejected":
            return self._public(record)
        if record["status"] not in {"pending", "failed"}:
            raise ValueError("Only a pending or failed proposal may be rejected")
        record.update(status="rejected", rejection_reason=reason, reviewed_at=time.time())
        self._save(record)
        return self._public(record)

    async def apply(self, proposal_id, handler, retry=False):
        if type(retry) is not bool:
            raise ValueError("retry must be a boolean")
        record = self._reviewable(proposal_id)
        if record["status"] == "applied":
            return self._public(record)
        if record["status"] == "failed" and not retry:
            raise ValueError("The previous attempt may have completed; explicit operator retry is required")
        if record["status"] not in {"pending", "failed"}:
            raise ValueError("Proposal is already applying or was rejected")
        if not callable(handler):
            raise ValueError("An operator application handler is required")
        # Revalidate at review time, but never alter the concrete reviewed facts.
        validate_details(record["operation"], record["details"])
        record.update(status="applying", attempts=record["attempts"] + 1,
                      reviewed_at=time.time(), approval_granted=True, outcome_uncertain=True)
        self._save(record)
        body = {**copy.deepcopy(record["details"]), "request_id": record["application_request_id"]}
        try:
            result = handler(record["operation"], body)
            if inspect.isawaitable(result):
                result = await result
            # Verify durability before reporting success. Serialization failure
            # after a domain write must retain the uncertain-attempt warning.
            json.dumps(result, allow_nan=False)
            record.update(status="applied", result=copy.deepcopy(result), applied_at=time.time(), outcome_uncertain=False)
            record.pop("error_type", None)
            record.pop("error", None)
            self._save(record)
        except BaseException as exc:
            record.pop("result", None)
            record.pop("applied_at", None)
            record.update(status="failed", outcome_uncertain=True, error_type=type(exc).__name__,
                          error="Application did not return a confirmed result. Check the underlying record before explicitly retrying.")
            self._save(record)
            raise
        return self._public(record)
