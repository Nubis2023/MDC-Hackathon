# pico_w_firmware/main.py
# Thermal Environmental Control Unit — Raspberry Pi Pico W Firmware
# MicroPython v1.24+ | Target: Pico W with WiFi connectivity
#
# Sensors: DHT11 (temp+humidity), MTK-MB005 VOC (I2C), Ocean TDS Meter (analog ADC)
# Output:  UART1 → ESP32-S3 VIEWE Smart Display
# Network: WiFi → HTTP endpoint

import machine
import network
import time
import ujson
import urequests
from machine import Pin, ADC, I2C, UART
from dht import DHT11

# ─────────────────────────────────────────────
# HARDWARE PIN DEFINITIONS
# ─────────────────────────────────────────────
PIN_LED_STATUS  = 25   # Active-HIGH on-board-ish LED (or external on GP25)
PIN_LED_BUILTIN = 15   # Pico W built-in LED
PIN_BUZZER      = 27   # Active-HIGH buzzer drive
PIN_ACK_BTN     = 28   # Active-LOW acknowledge button (internal pull-up)
PIN_DHT11_DATA  = 4    # DHT11 data line
PIN_TDS_ANALOG  = 26   # ADC0 — TDS sensor analog output

# UART bridge to ESP32-S3 display
UART_ID   = 1
UART_TX   = 8    # GP8
UART_RX   = 9    # GP9
UART_BAUD = 115200

# I2C for VOC sensor (MTK-MB005)
I2C_ID    = 0
I2C_SCL   = 1
I2C_SDA   = 0
I2C_FREQ  = 100_000

# ─────────────────────────────────────────────
# WIFI & ENDPOINT CONFIGURATION
# ─────────────────────────────────────────────
WIFI_SSID = "YOUR_WIFI_SSID"
WIFI_PASS = "YOUR_WIFI_PASSWORD"
ENDPOINT  = "http://192.168.1.100:8080"   # Replace with your HTTP server

# ─────────────────────────────────────────────
# DEVICE IDENTITY
# ─────────────────────────────────────────────
DEVICE_ID = "pico-ctrl-001"

# ─────────────────────────────────────────────
# HARDWARE PERIPHERAL INIT
# ─────────────────────────────────────────────
# Status LED on GP25 (active HIGH)
led_status = Pin(PIN_LED_STATUS, Pin.OUT, value=0)

# Built-in Pico W LED
led_builtin = Pin(PIN_LED_BUILTIN, Pin.OUT, value=0)

# Buzzer on GP27 via transistor (active HIGH)
buzzer = Pin(PIN_BUZZER, Pin.OUT, value=0)

# Acknowledge button on GP28 (active LOW, pull-up enabled)
ack_btn = Pin(PIN_ACK_BTN, Pin.IN, Pin.PULL_UP)

# DHT11 on GP4
dht = DHT11(Pin(PIN_DHT11_DATA))

# TDS ADC on GP26 (12-bit ADC, range 0–4095)
# Sensor expects 0–3.3 V signal. ADC reference = 3.3 V.
tds_adc = ADC(Pin(PIN_TDS_ANALOG))

# I2C0 for VOC sensor
i2c = I2C(I2C_ID, scl=Pin(I2C_SCL), sda=Pin(I2C_SDA), freq=I2C_FREQ)

# UART1 bridge to ESP32-S3 display
uart = UART(UART_ID, baudrate=UART_BAUD, tx=Pin(UART_TX), rx=Pin(UART_RX))

# ─────────────────────────────────────────────
# VOC SENSOR (MTK-MB005) HELPERS
# The MB005 uses the Winsen ZH03B-compatible protocol over I2C.
# Register map (partial):
#   0x00  – Firmware version (read, 1 byte)
#   0x02  – VOC concentration high byte
#   0x03  – VOC concentration low byte
#   0x04  – Set working mode (0=inactive, 1=active, 2=sleep)
#   0x10  – Auto-send interval (seconds, in sleep mode)
# ─────────────────────────────────────────────
VOC_I2C_ADDR = 0x32      # Default I2C address for MB005 / ZH03B-compatible
VOC_REGISTER_VOC = 0x02   # VOC concentration register (high, low)

def voc_read_ppm() -> float:
    """
    Read VOC concentration (ppm as ethanol equivalent) from MTK-MB005.
    Returns -1.0 on I2C failure so the main loop can handle gracefully.
    """
    try:
        # Read 2 bytes starting at VOC_REGISTER_VOC
        data = i2c.readfrom_mem(VOC_I2C_ADDR, VOC_REGISTER_VOC, 2)
        if len(data) < 2:
            return -1.0
        raw = (data[0] << 8) | data[1]
        # Zero is valid; distinguish from error by checking length above
        return float(raw)
    except OSError:
        return -1.0

def voc_init() -> bool:
    """Wake / configure the MB005 into active measurement mode."""
    try:
        # Mode 1 = active mode (continuous measurement)
        i2c.writeto_mem(VOC_I2C_ADDR, 0x04, bytes([0x01]))
        time.sleep_ms(50)
        return True
    except OSError:
        return False

# ─────────────────────────────────────────────
# TDS SENSOR CALCULATION
# Reference: Ocean TDS Meter analog output, 0–3.3 V → ADC 0–4095
# Calibration: measure your clean water baseline and adjust TDS_REF_VOLT.
# ─────────────────────────────────────────────
TDS_REF_VOLTAGE = 3.3   # ADC reference voltage (matches Pico 3.3 V rail)
TDS_ADC_MAX     = 4095  # 12-bit ADC
TDS_REF_PPM     = 138.0 # Measured TDS (ppm) of your calibration solution

def tds_read_ppm() -> float:
    """
    Read raw ADC voltage and convert to TDS in ppm.
    The Ocean TDS sensor outputs an analog voltage proportional to
    conductivity, calibrated to NaCl solutions. The conversion uses
    a linear approximation across the typical range (50–2000 ppm).
    """
    raw = tds_adc.read_u16()          # 0–65535 (16-bit oversampled)
    voltage = (raw / 65535) * TDS_REF_VOLTAGE

    # Linear conversion (manufacturer formula for most analog TDS sensors):
    #   TDS (ppm) = (voltage / TDS_REF_VOLTAGE) * TDS_REF_PPM * k
    # k compensates for the sensor's voltage-to-concentration slope.
    # Adjust k empirically against a known TDS solution.
    k = 1.0
    tds = voltage * (TDS_REF_PPM / TDS_REF_VOLTAGE) * k
    return round(tds, 1)

# ─────────────────────────────────────────────
# DHT11 READING WITH RETRY
# ─────────────────────────────────────────────
def dht_read() -> tuple:
    """
    Measure temperature (°C) and humidity (%).
    Returns (temp, humidity) or (None, None) on failure.
    """
    try:
        dht.measure()
        return (dht.temperature(), dht.humidity())
    except OSError:
        return (None, None)

# ─────────────────────────────────────────────
# WIFI CONNECTION
# ─────────────────────────────────────────────
wlan = network.WLAN(network.STA_IF)

def wifi_connect(timeout_s: int = 30) -> bool:
    """Connect to WiFi. Returns True on success."""
    wlan.active(True)
    if wlan.isconnected():
        return True
    led_status.value(1)
    print(f"[WIFI] Connecting to {WIFI_SSID} …")
    wlan.connect(WIFI_SSID, WIFI_PASS)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if wlan.isconnected():
            led_status.value(0)
            print(f"[WIFI] Connected — {wlan.ifconfig()[0]}")
            return True
        time.sleep(0.5)
    led_status.value(0)
    print("[WIFI] Connection failed.")
    return False

def wifi_disconnect():
    wlan.disconnect()
    wlan.active(False)

# ─────────────────────────────────────────────
# HTTP CLIENT HELPERS
# ─────────────────────────────────────────────
def http_get(path: str, timeout_ms: int = 5000):
    """GET request to ENDPOINT + path. Returns parsed JSON or None."""
    try:
        resp = urequests.get(f"{ENDPOINT}{path}", timeout=timeout_ms // 1000)
        data = resp.json()
        resp.close()
        return data
    except Exception as e:
        print(f"[HTTP GET {path}] Error: {e}")
        return None

def http_post(path: str, payload: dict, timeout_ms: int = 5000):
    """POST JSON payload to ENDPOINT + path. Returns True on 2xx."""
    try:
        resp = urequests.post(
            f"{ENDPOINT}{path}",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout_ms // 1000,
        )
        ok = 200 <= resp.status_code < 300
        resp.close()
        return ok
    except Exception as e:
        print(f"[HTTP POST {path}] Error: {e}")
        return False

# ─────────────────────────────────────────────
# ALERT STATE MACHINE
# ─────────────────────────────────────────────
class AlertManager:
    """
    Tracks active alerts, fires buzzer/LED, sends HTTP alerts,
    and respects cooldown / acknowledge.
    """
    def __init__(self):
        # Runtime thresholds (fetched from /config or defaults)
        self.temp_min       = 5.0
        self.temp_max       = 30.0
        self.humidity_min   = 30.0
        self.humidity_max   = 80.0
        self.tds_warning    = 200.0
        self.tds_critical   = 350.0
        self.voc_warning    = 150.0
        self.voc_critical   = 300.0
        self.cooldown_sec   = 300    # seconds before re-alerting same type
        self.interval_sec   = 60     # POST /readings interval

        self._last_alert    = {}     # alert_type → timestamp of last fire
        self._active        = {}     # alert_type → True (not yet acked)
        self._buzzer_on     = False
        self._last_buzzer_toggle = 0

    # Server config key → local attribute name. The two *_sec keys are spelled
    # differently on the server than here, so they are mapped explicitly instead
    # of setattr'd by name — that mismatch previously made them silently no-op.
    _CONFIG_KEYS = {
        "temp_min":           "temp_min",
        "temp_max":           "temp_max",
        "humidity_min":       "humidity_min",
        "humidity_max":       "humidity_max",
        "tds_warning":        "tds_warning",
        "tds_critical":       "tds_critical",
        "voc_warning":        "voc_warning",
        "voc_critical":       "voc_critical",
        "alert_cooldown_sec": "cooldown_sec",   # server's spelling
        "cooldown_sec":       "cooldown_sec",   # accept either
        "post_interval_sec":  "interval_sec",
    }

    def update_thresholds(self, config: dict):
        applied = 0
        for key, attr in self._CONFIG_KEYS.items():
            if key in config:
                setattr(self, attr, config[key])
                applied += 1
        print(f"[ALERT] Thresholds updated from /config ({applied} keys)")
        # The display renders these numbers, so it has to be told when they move.
        self.send_config_to_display()

    def send_config_to_display(self):
        """Push current thresholds to the ESP32 so its UI need not hardcode them."""
        send_to_display({
            "type":         "config",
            "temp_min":     self.temp_min,
            "temp_max":     self.temp_max,
            "humidity_min": self.humidity_min,
            "humidity_max": self.humidity_max,
            "tds_warning":  self.tds_warning,
            "tds_critical": self.tds_critical,
            "voc_warning":  self.voc_warning,
            "voc_critical": self.voc_critical,
        })

    def _cooldown_ok(self, alert_type: str) -> bool:
        last = self._last_alert.get(alert_type, 0)
        return (time.time() - last) > self.cooldown_sec

    def _fire(self, alert_type: str, severity: str, value: float,
              threshold: float, message: str):
        self._active[alert_type] = True
        self._last_alert[alert_type] = time.time()
        self._buzzer_on = True
        self._last_buzzer_toggle = time.time()
        led_status.value(1)

        payload = {
            "device_id": DEVICE_ID,
            "timestamp": _iso_now(),
            "alert_type": alert_type,
            "severity": severity,
            "value": round(value, 2),
            "threshold": round(threshold, 2),
            "message": message,
        }
        http_post("/alerts", payload)

        # The display has no network stack — UART is the only way it hears about
        # an alert. Without this the ESP32's whole alert overlay is unreachable.
        send_to_display({
            "type":       "alert",
            "alert_type": alert_type,
            "severity":   severity,
            "message":    message,
        })

    def evaluate(self, temp: float, humidity: float,
                 tds: float, voc: float):
        now = time.time()

        # ── Temperature ──────────────────────────
        if temp is not None:
            if temp < self.temp_min:
                at = "temperature_low"
                if self._cooldown_ok(at):
                    self._fire(at, "critical" if temp < 2 else "warning",
                               temp, self.temp_min,
                               f"Ambient temperature critically low: {temp}°C")
            elif temp > self.temp_max:
                at = "temperature_high"
                if self._cooldown_ok(at):
                    self._fire(at, "critical" if temp > 38 else "warning",
                               temp, self.temp_max,
                               f"Ambient temperature critically high: {temp}°C")

        # ── Humidity ──────────────────────────────
        if humidity is not None:
            if humidity < self.humidity_min:
                at = "humidity_low"
                if self._cooldown_ok(at):
                    self._fire(at, "critical" if humidity < 20 else "warning",
                               humidity, self.humidity_min,
                               f"Humidity critically low: {humidity}%")
            elif humidity > self.humidity_max:
                at = "humidity_high"
                if self._cooldown_ok(at):
                    self._fire(at, "critical" if humidity > 90 else "warning",
                               humidity, self.humidity_max,
                               f"Humidity critically high: {humidity}%")

        # ── TDS (filter replacement) ──────────────
        if tds > 0:
            if tds > self.tds_critical:
                at = "tds_critical"
                if self._cooldown_ok(at):
                    self._fire(at, "critical", tds, self.tds_critical,
                               f"Filter replacement required — TDS: {tds} ppm")
            elif tds > self.tds_warning:
                at = "tds_warning"
                if self._cooldown_ok(at):
                    self._fire(at, "warning", tds, self.tds_warning,
                               f"Filter degrading — TDS: {tds} ppm")

        # ── VOC (rotting produce) ─────────────────
        if voc >= 0:
            if voc > self.voc_critical:
                at = "voc_critical"
                if self._cooldown_ok(at):
                    self._fire(at, "critical", voc, self.voc_critical,
                               f"Rotting produce detected — VOC index: {voc}")
            elif voc > self.voc_warning:
                at = "voc_warning"
                if self._cooldown_ok(at):
                    self._fire(at, "warning", voc, self.voc_warning,
                               f"Produce spoilage detected — VOC index: {voc}")

        # ── Buzzer pulse (2 Hz toggle) ────────────
        if self._buzzer_on:
            if now - self._last_buzzer_toggle >= 0.25:
                buzzer.value(not buzzer.value())
                self._last_buzzer_toggle = now

    def acknowledge(self):
        """Called when user presses the acknowledge button."""
        self._buzzer_on = False
        buzzer.value(0)
        self._active.clear()
        print("[ALERT] Acknowledged by user")

# ─────────────────────────────────────────────
# UART DISPLAY MESSAGING
# ─────────────────────────────────────────────
def send_to_display(data: dict):
    """Serialize sensor data and send to ESP32-S3 over UART."""
    try:
        msg = ujson.dumps(data)
        uart.write(msg + "\n")
    except Exception as e:
        print(f"[UART] Send error: {e}")


_rx_buf = b""
_RX_BUF_MAX = 512   # a display message is ~40 bytes; anything larger is line noise


def poll_display(alerts):
    """Drain UART1 and handle messages coming back from the ESP32 display."""
    global _rx_buf
    try:
        if not uart.any():
            return
        _rx_buf += uart.read() or b""
    except Exception as e:
        print(f"[UART] Read error: {e}")
        return

    # Never let a newline-less stream grow without bound.
    if len(_rx_buf) > _RX_BUF_MAX:
        print("[UART] RX buffer overflow — discarding")
        _rx_buf = b""
        return

    while b"\n" in _rx_buf:
        line, _rx_buf = _rx_buf.split(b"\n", 1)
        line = line.strip()
        if not line:
            continue
        try:
            msg = ujson.loads(line)
        except Exception:
            print(f"[UART] Bad JSON from display: {line}")
            continue
        if msg.get("type") == "ack":
            print("[UART] Acknowledge received from display")
            alerts.acknowledge()


def _idle(seconds: float, alerts):
    """
    Wait, but stay responsive. The old code slept a flat 10 s, so both the
    display ACK and the physical button were only serviced once per cycle.
    """
    deadline = time.ticks_add(time.ticks_ms(), int(seconds * 1000))
    while time.ticks_diff(deadline, time.ticks_ms()) > 0:
        poll_display(alerts)
        if not ack_btn.value():            # active LOW
            alerts.acknowledge()
            while not ack_btn.value():     # debounce: wait for release
                time.sleep_ms(50)
        time.sleep_ms(100)

# ─────────────────────────────────────────────
# READING HELPERS
# ─────────────────────────────────────────────
def _iso_now() -> str:
    """Return ISO 8601 timestamp (UTC)."""
    secs = time.time()
    return _format_iso_timestamp(secs)

def _format_iso_timestamp(epoch: int) -> str:
    """Convert epoch seconds to 'YYYY-MM-DDTHH:MM:SSZ' (UTC)."""
    tm = time.localtime(epoch)
    return f"{tm[0]:04d}-{tm[1]:02d}-{tm[2]:02d}T{tm[3]:02d}:{tm[4]:02d}:{tm[5]:02d}Z"

# ─────────────────────────────────────────────
# MAIN SENSOR READ FUNCTION
# ─────────────────────────────────────────────
def read_all_sensors() -> dict:
    """Collect readings from all sensors, return dict."""
    temp, hum = dht_read()
    tds = tds_read_ppm()
    voc = voc_read_ppm()

    return {
        "temperature_c": temp,
        "humidity_pct":  hum,
        "tds_ppm":       tds,
        "voc_index":     voc,
    }

# ─────────────────────────────────────────────
# TEMPERATURE DROP HANDLER
# ─────────────────────────────────────────────
def check_temperature_drops() -> list:
    """
    GET /check-drops — retrieve temperature drop events from the HTTP endpoint.
    Returns list of drop dicts. Caller can log or alert on them.
    """
    data = http_get("/check-drops")
    if data and "drops" in data:
        return data["drops"]
    return []

# ─────────────────────────────────────────────
# SETUP & MAIN LOOP
# ─────────────────────────────────────────────
def setup():
    print("=" * 50)
    print("Thermal Environmental Control Unit — Pico W")
    print("=" * 50)

    # Flash status LED to indicate boot
    for _ in range(3):
        led_status.toggle()
        time.sleep_ms(150)
    led_status.value(0)

    # Initialize VOC sensor
    if voc_init():
        print("[VOC] MTK-MB005 initialized in active mode")
    else:
        print("[VOC] MTK-MB005 init failed — check wiring and address")

    # Scan I2C bus for debug
    devices = i2c.scan()
    print(f"[I2C] Devices found: {[hex(d) for d in devices]}")

    # Connect WiFi
    if wifi_connect():
        print("[NET] WiFi ready")
    else:
        print("[NET] WiFi failed — running in offline mode")

def main():
    setup()

    alerts = AlertManager()
    # POST cadence lives on the AlertManager so GET /config can actually move it.
    drop_check_interval = 300  # seconds between /check-drops GETs
    last_post   = 0
    last_drop_check = 0
    last_config = 0

    # Seed the display with the default thresholds so its UI is correct before
    # the first GET /config lands (which can be up to 5 minutes away).
    alerts.send_config_to_display()

    while True:
        now = time.time()

        # ── Fetch config from server every 5 min ──
        if now - last_config > 300:
            config = http_get("/config")
            if config:
                alerts.update_thresholds(config)
            last_config = now

        # ── Check for temperature drop events ──────
        if now - last_drop_check > drop_check_interval:
            drops = check_temperature_drops()
            if drops:
                print(f"[DROPS] Received {len(drops)} drop events:")
                for d in drops:
                    print(f"  {d}")
                    # Forward to display
                    send_to_display({"type": "drop", "data": d})
                    # Fire alert if flagged
                    if d.get("alert"):
                        alerts._fire(
                            "temperature_drop", "warning",
                            d.get("drop_c", 0), 0,
                            f"Temp drop at {d.get('location','unknown')}: "
                            f"{d.get('drop_c')}°C → {d.get('current_c')}°C"
                        )
            last_drop_check = now

        # ── Read all sensors ──────────────────────
        readings = read_all_sensors()
        temp   = readings["temperature_c"]
        hum    = readings["humidity_pct"]
        tds    = readings["tds_ppm"]
        voc    = readings["voc_index"]

        print(f"[READINGS] T={temp}°C  H={hum}%  TDS={tds}ppm  VOC={voc}")

        # ── Evaluate alerts ───────────────────────
        alerts.evaluate(temp, hum, tds, voc)

        # ── Send to display ───────────────────────
        send_to_display({
            "type": "readings",
            "timestamp": _iso_now(),
            **readings,
        })

        # ── POST readings to endpoint ──────────────
        if now - last_post >= alerts.interval_sec:
            payload = {
                "device_id": DEVICE_ID,
                "timestamp": _iso_now(),
                "sensors": readings,
            }
            ok = http_post("/readings", payload)
            print(f"[HTTP] POST /readings → {'OK' if ok else 'FAILED'}")
            last_post = now

        # Main loop ticks every 10 s; POST interval governs upload. _idle keeps
        # the display ACK and the button responsive during the wait.
        _idle(10, alerts)


if __name__ == "__main__":
    main()
