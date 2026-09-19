#!/usr/bin/env python3
# server/reference_server.py
# Minimal Flask reference server for the Thermal Environmental Control Unit.
# Handles GET /config, GET /check-drops, POST /readings, POST /alerts.

from flask import Flask, request, jsonify
from datetime import datetime, timezone
import threading

app = Flask(__name__)

# ── In-memory store ─────────────────────────────
class Store:
    readings   = []
    alerts     = []
    config = {
        "temp_min":        5.0,
        "temp_max":       30.0,
        "humidity_min":   30.0,
        "humidity_max":   80.0,
        "tds_warning":   200.0,
        "tds_critical":   350.0,
        "voc_warning":   150.0,
        "voc_critical":   300.0,
        "post_interval_sec":    60,
        "alert_cooldown_sec":   300,
    }
    # Simulated temperature-drop dataset
    drops = [
        {
            "timestamp": "2026-09-19T08:00:00Z",
            "location": "cooler-zone-a",
            "drop_c": -3.8,
            "current_c": 19.2,
            "alert": True,
        },
        {
            "timestamp": "2026-09-19T10:30:00Z",
            "location": "walk-in-freezer",
            "drop_c": -8.5,
            "current_c": 3.1,
            "alert": True,
        },
        {
            "timestamp": "2026-09-19T12:15:00Z",
            "location": "refrigeration-bay-2",
            "drop_c": -1.2,
            "current_c": 16.0,
            "alert": False,
        },
    ]


store = Store()
store_lock = threading.Lock()


# ── Routes ──────────────────────────────────────
@app.route("/config", methods=["GET"])
def get_config():
    """Return current alert thresholds and intervals to the Pico W."""
    return jsonify(store.config)


@app.route("/readings", methods=["POST"])
def post_readings():
    """Receive batched sensor readings from the Pico W."""
    data = request.get_json()
    with store_lock:
        store.readings.append({
            "received_at": datetime.now(timezone.utc).isoformat(),
            **data,
        })
    print(f"[SERVER] readings from {data.get('device_id','?')}: "
          f"T={data['sensors'].get('temperature_c')}°C "
          f"H={data['sensors'].get('humidity_pct')}% "
          f"TDS={data['sensors'].get('tds_ppm')}ppm "
          f"VOC={data['sensors'].get('voc_index')}")
    return jsonify({"status": "ok"}), 200


@app.route("/alerts", methods=["POST"])
def post_alerts():
    """Receive alert notifications from the Pico W."""
    data = request.get_json()
    with store_lock:
        store.alerts.append({
            "received_at": datetime.now(timezone.utc).isoformat(),
            **data,
        })
    print(f"[SERVER] ALERT [{data.get('severity','?')}] "
          f"{data.get('alert_type','?')}: {data.get('message','')}")
    return jsonify({"status": "alert_received"}), 200


@app.route("/check-drops", methods=["GET"])
def check_drops():
    """Return temperature-drop events from the historical dataset."""
    return jsonify({"drops": store.drops})


# ── Admin endpoints (browser) ────────────────────
@app.route("/")
def index():
    html = """<!DOCTYPE html>
<html><head><title>EnvCtrl Monitor</title>
<style>
  body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
  h1 { color: #58a6ff; }
  h2 { color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; max-width: 700px; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #30363d; padding: 8px 12px; text-align: left; }
  th { background: #161b22; color: #58a6ff; }
  tr:hover { background: #161b22; }
  .ok    { color: #3fb950; }
  .warn  { color: #d29922; }
  .crit  { color: #f85149; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.85em; }
  .badge-ok    { background: #1f6feb22; color: #58a6ff; }
  .badge-warn  { background: #d2992222; color: #d29922; }
  .badge-crit  { background: #f8514922; color: #f85149; }
</style></head><body>
<h1>🌡️  Thermal Environmental Control Unit</h1>
<p>Reference server running. Endpoints:</p>
<ul>
  <li><code>GET  /config</code> — thresholds</li>
  <li><code>GET  /check-drops</code> — temperature drop events</li>
  <li><code>POST /readings</code> — sensor batch</li>
  <li><code>POST /alerts</code> — threshold breach</li>
</ul>
<h2>Recent Alerts</h2>
<table><tr><th>Time</th><th>Type</th><th>Severity</th><th>Message</th></tr>
"""
    with store_lock:
        for a in reversed(store.alerts[-20:]):
            sev = a.get("severity", "")
            badge_cls = "badge-ok" if sev == "ok" else "badge-warn" if sev == "warning" else "badge-crit"
            html += f"<tr><td>{a.get('received_at','')}</td>"
            html += f"<td>{a.get('alert_type','')}</td>"
            html += f"<td><span class='badge {badge_cls}'>{sev}</span></td>"
            html += f"<td>{a.get('message','')}</td></tr>"
    html += "</table><h2>Recent Readings</h2>"
    html += "<table><tr><th>Time</th><th>T (°C)</th><th>H (%)</th><th>TDS (ppm)</th><th>VOC</th></tr>"
    with store_lock:
        for r in reversed(store.readings[-20:]):
            s = r.get("sensors", {})
            html += f"<tr><td>{r.get('received_at','')}</td>"
            html += f"<td>{s.get('temperature_c','—')}</td>"
            html += f"<td>{s.get('humidity_pct','—')}</td>"
            html += f"<td>{s.get('tds_ppm','—')}</td>"
            html += f"<td>{s.get('voc_index','—')}</td></tr>"
    html += "</table></body></html>"
    return html


if __name__ == "__main__":
    print("Starting reference server on http://0.0.0.0:8080")
    app.run(host="0.0.0.0", port=8080, debug=True)
