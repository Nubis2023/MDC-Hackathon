"""Manufacturer-referenced filter schedules and explicitly measured throughput.

No model, lifespan, flow coverage, replacement threshold, or drinking-water
conclusion is inferred from a sensor reading or from the refill ledger.
"""
import datetime as dt
import json
import math
import time
import uuid


LIMITATIONS = [
    "Use the referenced manufacturer's instructions; recorded limits are operator-entered facts, not independently verified specifications.",
    "TDS does not determine filter replacement or potability and is never used in this assessment.",
    "Refill records are not automatically the filter's entire throughput. Full coverage must be explicitly attested with a measurement reference.",
    "A calendar date or volume limit does not establish water safety or override earlier replacement, maintenance, or inspection requirements.",
    "Demo and simulated records are separate from hardware/operator installation records.",
]


def _text(value, name, maximum=160):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be nonempty text of at most {maximum} characters")
    return value.strip()


def _number(value, name, minimum, maximum, integer=False, strict_minimum=False):
    if (type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value)
            or value > maximum or value < minimum or (strict_minimum and value == minimum)):
        raise ValueError(f"{name} must be a finite {'integer' if integer else 'number'} "
                         f"{'greater than' if strict_minimum else 'at least'} {minimum} and at most {maximum}")
    return value


def _date(value, name):
    value = _text(value, name, 10)
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{name} must use YYYY-MM-DD")
    return parsed


def _today(now=None):
    stamp = time.time() if now is None else _number(now, "now", 0, 253402214400)
    return dt.date.fromtimestamp(stamp)


def _object(body, allowed):
    if not isinstance(body, dict):
        raise ValueError("A JSON object is required")
    extra = set(body) - set(allowed)
    if extra:
        raise ValueError("Unsupported filter fields: " + ", ".join(sorted(map(str, extra))))


class FilterLifecycleStore:
    """Synchronous, SQLite-backed facts owned by the coordinator event loop.

    Hardware/operator installations survive application restarts. Simulated
    installations remain historical after a restart until explicitly replaced
    or a new installation is registered. No hardware command is issued here.
    """

    def __init__(self, db, session_id, device_mode):
        if device_mode not in {"simulated", "hardware"}:
            raise ValueError("Unknown device mode")
        self.db = db
        self.session_id = _text(session_id, "session_id", 128)
        self.device_mode = device_mode
        for table in ("installations", "throughput"):
            self.db.execute(f"CREATE TABLE IF NOT EXISTS filter_{table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS filter_mutations "
                        "(id TEXT PRIMARY KEY, kind TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL)")
        self.db.commit()

    def _rows(self, table):
        return [json.loads(row[0]) for row in self.db.execute(f"SELECT payload FROM filter_{table} ORDER BY rowid")]

    def _save(self, table, identity, data):
        self.db.execute(f"INSERT INTO filter_{table}(id,payload) VALUES (?,?) "
                        "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                        (identity, json.dumps(data, allow_nan=False)))

    def _mutate(self, kind, body, payload, work):
        identity = _text(body.get("request_id"), "request_id")
        request = json.dumps({**payload, "device_mode": self.device_mode}, sort_keys=True, allow_nan=False)
        old = self.db.execute("SELECT kind,request,response FROM filter_mutations WHERE id=?", (identity,)).fetchone()
        if old:
            if old[0] != kind or old[1] != request:
                raise ValueError("Request ID already used for different filter facts")
            return json.loads(old[2])
        self.db.execute("SAVEPOINT filter_lifecycle_write")
        try:
            result = work(identity)
            self.db.execute("INSERT INTO filter_mutations VALUES (?,?,?,?)",
                            (identity, kind, request, json.dumps(result, allow_nan=False)))
            self.db.execute("RELEASE SAVEPOINT filter_lifecycle_write")
            return result
        except Exception:
            self.db.execute("ROLLBACK TO SAVEPOINT filter_lifecycle_write")
            self.db.execute("RELEASE SAVEPOINT filter_lifecycle_write")
            raise

    def _active(self, installation):
        if installation.get("replaced_by") or installation["device_mode"] != self.device_mode:
            return False
        return ((installation["source"] == "operator" and self.device_mode == "hardware")
                or installation["session_id"] == self.session_id)

    @staticmethod
    def _simulated(installation):
        return installation["source"] == "demo" or installation["device_mode"] == "simulated"

    def get_filter(self, filter_id):
        identity = _text(filter_id, "filter_id")
        row = self.db.execute("SELECT payload FROM filter_installations WHERE id=?", (identity,)).fetchone()
        if not row:
            raise ValueError("Unknown filter installation")
        return json.loads(row[0])

    def register(self, body):
        _object(body, {"request_id", "manufacturer", "model", "instructions_reference", "installed_date",
                       "rated_days", "rated_litres", "source", "replaces_filter_id"})
        installed = _date(body.get("installed_date"), "installed_date")
        if installed > _today():
            raise ValueError("installed_date must not be in the future")
        source = body.get("source", "operator")
        if source not in {"operator", "demo"}:
            raise ValueError("source must be operator or demo")
        rated_days = body.get("rated_days")
        if rated_days is not None:
            rated_days = _number(rated_days, "rated_days", 1, 36500, integer=True)
            try:
                installed + dt.timedelta(days=rated_days)
            except OverflowError as exc:
                raise ValueError("Calendar replacement date is outside the supported range") from exc
        rated_litres = body.get("rated_litres")
        if rated_litres is not None:
            rated_litres = _number(rated_litres, "rated_litres", 0, 1e9, strict_minimum=True)
        replaces = body.get("replaces_filter_id")
        if replaces is not None:
            replaces = _text(replaces, "replaces_filter_id")
        payload = {"manufacturer": _text(body.get("manufacturer"), "manufacturer", 120),
                   "model": _text(body.get("model"), "model", 160),
                   "instructions_reference": _text(body.get("instructions_reference"), "instructions_reference", 1000),
                   "installed_date": installed.isoformat(), "rated_days": rated_days,
                   "rated_litres": rated_litres, "source": source, "replaces_filter_id": replaces}

        def write(request_id):
            prior = self.get_filter(replaces) if replaces else None
            if prior:
                if (prior.get("replaced_by") or prior["source"] != source
                        or prior["device_mode"] != self.device_mode):
                    raise ValueError("Replacement must identify an unreplaced filter of the same source and device mode")
                if installed < _date(prior["installed_date"], "prior installed_date"):
                    raise ValueError("Replacement installation date must not precede the prior installation")
            current = [item for item in self._rows("installations")
                       if self._active(item) and item["source"] == source]
            if any(item["filter_id"] != replaces for item in current):
                raise ValueError("An active filter installation already exists; provide its replaces_filter_id")
            result = {**payload, "filter_id": uuid.uuid4().hex, "created_at": time.time(),
                      "session_id": self.session_id, "device_mode": self.device_mode,
                      "evidence_type": "Operator-entered manufacturer reference" if source == "operator" else "Simulated demonstration"}
            self._save("installations", result["filter_id"], result)
            if prior:
                prior["replaced_by"] = result["filter_id"]
                self._save("installations", prior["filter_id"], prior)
            return result

        return self._mutate("register", body, payload, write)

    def record_throughput(self, body):
        _object(body, {"request_id", "filter_id", "total_litres", "measured_on",
                       "covers_all_throughput_since_installation", "measurement_reference"})
        measured = _date(body.get("measured_on"), "measured_on")
        if measured > _today():
            raise ValueError("measured_on must not be in the future")
        complete = body.get("covers_all_throughput_since_installation")
        if type(complete) is not bool:
            raise ValueError("covers_all_throughput_since_installation must be an explicit boolean")
        payload = {"filter_id": _text(body.get("filter_id"), "filter_id"),
                   "total_litres": _number(body.get("total_litres"), "total_litres", 0, 1e9),
                   "measured_on": measured.isoformat(),
                   "covers_all_throughput_since_installation": complete,
                   "measurement_reference": _text(body.get("measurement_reference"), "measurement_reference", 1000)}

        def write(request_id):
            installation = self.get_filter(payload["filter_id"])
            if not self._active(installation):
                raise ValueError("Historical or replaced filter cannot receive current throughput records")
            if measured < _date(installation["installed_date"], "installed_date"):
                raise ValueError("measured_on must not precede installation")
            records = [row for row in self._rows("throughput") if row["filter_id"] == payload["filter_id"]]
            if records:
                latest = records[-1]
                if measured.isoformat() < latest["measured_on"]:
                    raise ValueError("Cumulative throughput readings cannot move backwards in date")
                if payload["total_litres"] < latest["total_litres"]:
                    raise ValueError("Cumulative throughput cannot decrease; register a replacement installation to reset it")
            result = {**payload, "id": request_id, "recorded_at": time.time(),
                      "source": installation["source"], "device_mode": installation["device_mode"],
                      "session_id": self.session_id, "evidence_type": "Simulated cumulative throughput fixture" if installation["source"] == "demo" else "Operator-attested cumulative measurement"}
            self._save("throughput", request_id, result)
            return result

        return self._mutate("throughput", body, payload, write)

    def _assess(self, installation, records, today):
        active = self._active(installation)
        days, capacity = installation["rated_days"], installation["rated_litres"]
        missing = []
        calendar = {"status": "unknown", "installed_date": installation["installed_date"],
                    "rated_days": days, "due_date": None, "days_remaining": None,
                    "reason": "No manufacturer calendar rating is recorded"}
        if days is None:
            missing.append("Manufacturer calendar replacement interval, if specified in the instructions")
        else:
            due = _date(installation["installed_date"], "installed_date") + dt.timedelta(days=days)
            remaining = (due - today).days
            calendar.update(status="due" if remaining <= 0 else "not_due", due_date=due.isoformat(),
                            days_remaining=remaining,
                            reason="Installation date plus the operator-entered manufacturer rated days")
        throughput = {"status": "unknown", "rated_litres": capacity, "total_litres": None,
                      "remaining_litres": None, "last_known_remaining_litres": None,
                      "measured_on": None, "measurement_reference": None,
                      "covers_all_throughput_since_installation": False, "current": False,
                      "reason": "No cumulative throughput measurement is recorded"}
        if capacity is None:
            missing.append("Manufacturer volume rating, if specified in the instructions")
        latest = records[-1] if records else None
        complete_records = [row for row in records if row["covers_all_throughput_since_installation"]]
        last_complete = complete_records[-1] if complete_records else None
        if latest:
            complete = latest["covers_all_throughput_since_installation"]
            current = latest["measured_on"] == today.isoformat()
            throughput.update(total_litres=latest["total_litres"], measured_on=latest["measured_on"],
                              measurement_reference=latest["measurement_reference"], evidence_id=latest["id"],
                              covers_all_throughput_since_installation=complete, current=current)
            if capacity is None:
                throughput["reason"] = "Measured volume is recorded, but no manufacturer volume rating is known"
            elif not complete:
                throughput["reason"] = "Measurement does not attest complete filter throughput since installation"
            else:
                remaining = max(0, capacity - latest["total_litres"])
                throughput["last_known_remaining_litres"] = remaining
                if latest["total_litres"] >= capacity:
                    throughput.update(status="due", remaining_litres=0,
                                      reason="Complete cumulative measurement reached the recorded manufacturer volume limit")
                elif current:
                    throughput.update(status="not_due", remaining_litres=remaining,
                                      reason="Recorded manufacturer rated litres minus today's fully covered cumulative measurement")
                else:
                    throughput["reason"] = "Last complete measurement is historical; current remaining capacity is unknown"
        # A later partial reading cannot erase a previously documented exhausted
        # capacity. Keep the last fully covered measurement as separate evidence.
        if capacity is not None and last_complete:
            throughput.update(last_known_remaining_litres=max(0, capacity - last_complete["total_litres"]),
                              last_complete_measured_on=last_complete["measured_on"],
                              last_complete_measurement_reference=last_complete["measurement_reference"])
            if last_complete["total_litres"] >= capacity:
                throughput.update(status="due", remaining_litres=0,
                                  reason="A fully covered cumulative measurement already reached the recorded manufacturer volume limit")
        if latest is None or not latest["covers_all_throughput_since_installation"]:
            missing.append("Cumulative measured throughput with explicit coverage of all water through this filter since installation")
        elif latest["measured_on"] != today.isoformat() and throughput["status"] != "due":
            missing.append("Current cumulative throughput measurement; last complete measurement is historical")
        due = calendar["status"] == "due" or throughput["status"] == "due"
        known = calendar["status"] != "unknown" or throughput["status"] != "unknown"
        status = "historical" if not active else "replacement_due" if due else "no_known_limit_reached" if known else "unknown"
        action = ("Historical installation; use the current installation's assessment" if not active else
                  "Replacement is due under at least one recorded manufacturer limit; follow the referenced instructions" if due else
                  "No known recorded limit has been reached; confirm missing information and follow all manufacturer instructions" if known else
                  "Replacement timing is unknown; record the applicable manufacturer limits and measurement coverage")
        return {"filter_id": installation["filter_id"], "active": active, "simulated": self._simulated(installation),
                "status": status, "assessed_on": today.isoformat(), "calendar": calendar, "throughput": throughput,
                "missing_information": missing, "action": action,
                "instructions_reference": installation["instructions_reference"], "limitations": LIMITATIONS[:]}

    def assess(self, filter_id, now=None):
        installation = self.get_filter(filter_id)
        records = [row for row in self._rows("throughput") if row["filter_id"] == installation["filter_id"]]
        return self._assess(installation, records, _today(now))

    def snapshot(self, now=None):
        today = _today(now)
        records = self._rows("throughput")
        filters = []
        for installation in self._rows("installations"):
            assessment = self._assess(installation, [row for row in records if row["filter_id"] == installation["filter_id"]], today)
            filters.append({**installation, "active": assessment["active"], "simulated": assessment["simulated"], "assessment": assessment})
        active = [item for item in filters if item["active"]]
        return {"status": "records_available" if active else "unknown", "filters": filters,
                "active_filters": active, "throughput_records": records,
                "missing_information": [] if active else ["Manufacturer", "Filter model", "Manufacturer instructions reference",
                    "Installation date", "Applicable manufacturer calendar and/or volume ratings",
                    "Cumulative throughput with explicit full coverage, if using a volume rating"],
                "device_mode": self.device_mode, "session_id": self.session_id, "limitations": LIMITATIONS[:]}
