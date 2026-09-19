#!/usr/bin/env python3
"""Desktop dry run of the Pico W firmware.

Stubs machine, network, urequests, dht and micropython, then drives main.run()
through a scripted scenario on a virtual clock. It will not catch timing or
electrical faults, but it does catch the things that otherwise cost you a
flash cycle each: import errors, attribute typos, arithmetic on None, rules
that never fire, rules that never clear.

    python3 tools/simulate.py
"""

import json
import os
import sys
import time as _real_time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "pico-w"))

MANIFEST = json.load(open(os.path.join(ROOT, "server", "manifest.example.json")))

# Scenario state the stubs read from.
SCENE = {"temp": 3.2, "rh": 82.0, "tds_v": 0.42, "voc_v": 1.10,
         "tvoc": 90, "eco2": 480, "online": True}
POSTED = {"alerts": [], "telemetry": 0, "setpoints": []}


# ------------------------------------------------------------ virtual clock --
CLOCK = {"ms": 0}
EPOCH = 1758240000


class StopSim(Exception):
    pass


LIMIT = {"iterations": 0, "max": 430}


def _sleep(seconds):
    CLOCK["ms"] += int(seconds * 1000)
    LIMIT["iterations"] += 1
    if LIMIT["iterations"] >= LIMIT["max"]:
        raise StopSim
    script(LIMIT["iterations"])


tm = types.ModuleType("time")
tm.ticks_ms = lambda: CLOCK["ms"]
tm.ticks_diff = lambda a, b: a - b
tm.ticks_add = lambda a, b: a + b
tm.sleep_ms = lambda ms: CLOCK.__setitem__("ms", CLOCK["ms"] + ms)
tm.sleep_us = lambda us: None
tm.sleep = _sleep
tm.time = lambda: EPOCH + CLOCK["ms"] // 1000
tm.localtime = _real_time.localtime
sys.modules["time"] = tm

mp = types.ModuleType("micropython")
mp.const = lambda v: v
sys.modules["micropython"] = mp


# ------------------------------------------------------------------ machine --
class Pin:
    IN, OUT, PULL_UP, PULL_DOWN = 0, 1, 2, 3

    def __init__(self, ident, mode=None, pull=None, value=None):
        self.id = ident
        self._v = 1 if value else 0

    def value(self, v=None):
        if v is None:
            return self._v
        self._v = int(v)

    def toggle(self):
        self._v ^= 1


class ADC:
    def __init__(self, pin):
        self.id = pin.id if isinstance(pin, Pin) else pin

    def read_u16(self):
        volts = SCENE["tds_v"] if self.id == 26 else SCENE["voc_v"]
        if self.id == 27:
            volts *= 0.6          # the divider sits between module and pin
        return max(0, min(65535, int(volts / 3.3 * 65535)))


class PWM:
    def __init__(self, pin):
        self.duty = 0

    def freq(self, f):
        pass

    def duty_u16(self, d):
        self.duty = d

    def deinit(self):
        pass


class WDT:
    def __init__(self, timeout=0):
        self.fed = 0

    def feed(self):
        self.fed += 1


class UART:
    """Console link. inject() queues a line as if the display sent it."""

    def __init__(self, ident, baudrate=9600, tx=None, rx=None, timeout=0):
        self.rx_buf = b""
        self.tx_lines = []

    def inject(self, obj):
        self.rx_buf += (json.dumps(obj) if isinstance(obj, dict)
                        else str(obj)).encode() + b"\n"

    def any(self):
        return len(self.rx_buf)

    def read(self, n=None):
        data, self.rx_buf = self.rx_buf[:n or len(self.rx_buf)], b""
        return data

    def write(self, s):
        self.tx_lines.append(s.strip())


UARTS = {}


def _uart_factory(ident, **kw):
    u = UART(ident, **kw)
    UARTS[ident] = u
    return u


class I2C:
    """Enough of a CCS811 to exercise the driver end to end."""

    def __init__(self, ident, sda=None, scl=None, freq=100000):
        self.started = False
        self.baseline = 0x1234
        self.env_writes = 0

    def readfrom_mem(self, addr, reg, n):
        if reg == 0x20:
            return bytes([0x81])
        if reg == 0x00:
            return bytes([0x98 if self.started else 0x10])
        if reg == 0xE0:
            return bytes([0x00])
        if reg == 0x11:
            return bytes([self.baseline >> 8, self.baseline & 0xFF])
        if reg == 0x02:
            eco2, tvoc = SCENE["eco2"], SCENE["tvoc"]
            raw = (20 << 10) | 500        # 20 uA, mid-scale ADC
            return bytes([eco2 >> 8, eco2 & 0xFF, tvoc >> 8, tvoc & 0xFF,
                          0x98, 0x00, raw >> 8, raw & 0xFF])
        raise OSError("unexpected register 0x%02X" % reg)

    def writeto_mem(self, addr, reg, data):
        if reg == 0x05:
            self.env_writes += 1
        elif reg == 0x11:
            self.baseline = (data[0] << 8) | data[1]

    def writeto(self, addr, data):
        if data[0] == 0xF4:
            self.started = True


machine = types.ModuleType("machine")
machine.Pin, machine.ADC, machine.PWM = Pin, ADC, PWM
machine.WDT, machine.I2C = WDT, I2C
machine.UART = _uart_factory
sys.modules["machine"] = machine


# ------------------------------------------------------------------ network --
class WLAN:
    def __init__(self, mode=0):
        pass

    def active(self, v=None):
        return True

    def isconnected(self):
        return SCENE["online"]

    def connect(self, ssid, pw):
        pass


net = types.ModuleType("network")
net.WLAN, net.STA_IF = WLAN, 0
sys.modules["network"] = net


class _Resp:
    def __init__(self, code, body):
        self.status_code, self.text = code, body

    def close(self):
        pass


def _request(method, url, headers=None, data=None, timeout=None):
    if not SCENE["online"]:
        raise OSError("network unreachable")
    if "/manifest" in url:
        return _Resp(200, json.dumps(MANIFEST))
    payload = json.loads(data) if data else {}
    if "/alerts" in url:
        POSTED["alerts"].append(payload)
    elif "/telemetry" in url:
        POSTED["telemetry"] += 1
    elif "/setpoints" in url:
        POSTED["setpoints"].append(payload)
    return _Resp(200, '{"ok":true}')


ureq = types.ModuleType("urequests")
ureq.request = _request
sys.modules["urequests"] = ureq


# ------------------------------------------------------------------- sensors --
class _DHT11:
    def __init__(self, pin):
        pass

    def measure(self):
        pass

    def temperature(self):
        return SCENE["temp"]

    def humidity(self):
        return SCENE["rh"]


dht = types.ModuleType("dht")
dht.DHT11 = _DHT11
sys.modules["dht"] = dht

for name, attrs in (("onewire", {"OneWire": object}),
                    ("ds18x20", {"DS18X20": object})):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m


# ------------------------------------------------------------------ scenario --
MARKS = []


def script(i):
    """Drives the scenario by loop iteration. One iteration is 5 s."""
    if i == 20:
        MARKS.append((i, "door opens, temperature starts falling"))
    if 20 <= i < 120:
        SCENE["temp"] = max(-1.5, SCENE["temp"] - 0.05)
    if i == 130:
        MARKS.append((i, "console sets a temporary floor of 0.5 C for 1 h"))
        UARTS[0].inject({"type": "setpoint", "item_id": "pallet-12",
                         "fields": {"min_c": -5.0}, "ttl_s": 3600,
                         "by": "bench"})
    if i == 150:
        MARKS.append((i, "endpoint goes unreachable"))
        SCENE["online"] = False
    if i == 170:
        MARKS.append((i, "endpoint comes back"))
        SCENE["online"] = True
    if i == 190:
        MARKS.append((i, "VOC rises on the CCS811 only"))
        SCENE["tvoc"] = 900
    if i == 250:
        MARKS.append((i, "water filter starts loading up"))
    if i >= 250:
        SCENE["tds_v"] = min(0.86, SCENE["tds_v"] + 0.004)
    if i == 400:
        MARKS.append((i, "temperature recovers"))
        SCENE["temp"] = 3.4


# --------------------------------------------------------------------- run ---
def main():
    import tempfile
    os.chdir(tempfile.mkdtemp())          # keep state files out of the repo

    import config as cfg
    cfg.WIFI_SSID = "sim"
    cfg.CCS811_RUN_IN_S = 60              # do not wait 20 virtual minutes

    import main as firmware
    try:
        firmware.run()
    except StopSim:
        pass

    kinds = {}
    for a in POSTED["alerts"]:
        kinds.setdefault((a["kind"], a["action"]), 0)
        kinds[(a["kind"], a["action"])] += 1

    print("\n--- scenario ---")
    for i, what in MARKS:
        print(f"  iter {i:>3}  {what}")

    print("\n--- alerts posted ---")
    for (kind, action), n in sorted(kinds.items()):
        print(f"  {kind:<24} {action:<10} x{n}")
    if not kinds:
        print("  NONE. Something is wrong: the scenario crosses a threshold.")

    print("\n--- other traffic ---")
    print(f"  telemetry posts   {POSTED['telemetry']}")
    print(f"  setpoint records  {len(POSTED['setpoints'])}")
    lines = UARTS[0].tx_lines if 0 in UARTS else []
    types_seen = {}
    for ln in lines:
        try:
            types_seen[json.loads(ln)["type"]] = types_seen.get(
                json.loads(ln)["type"], 0) + 1
        except Exception:
            pass
    print(f"  console messages  {types_seen}")

    ok = True
    for required in ("temperature_low", "temperature_drop_rate", "filter_warn",
                     "filter_replace", "tvoc_elevated", "voc_disagreement"):
        if not any(k == required for k, _ in kinds):
            print(f"\n  MISSING: expected a {required} alert")
            ok = False
    if not any(a == "clear" for _, a in kinds):
        print("\n  MISSING: nothing ever cleared")
        ok = False
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
