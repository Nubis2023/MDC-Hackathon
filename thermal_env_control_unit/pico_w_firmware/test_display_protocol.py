#!/usr/bin/env python3
"""
Self-check for the Pico -> ESP32 display protocol.  Plain asserts, no framework:

    python3 pico_w_firmware/test_display_protocol.py

Guards the three things that were silently broken before:
  1. GET /config keys actually land on AlertManager attributes
     (server says `alert_cooldown_sec` / `post_interval_sec`; this class
     calls them `cooldown_sec` / `interval_sec`).
  2. Firing an alert reaches the display over UART, not just HTTP.
  3. A framed {"type":"ack"} from the display clears the alert state,
     including when it arrives split across two reads.

ponytail: hand-rolled module stubs instead of a MicroPython emulator — the
firmware only touches a handful of hardware calls. Swap for `mpremote`-driven
on-device tests if this grows past protocol checks.
"""
import json
import os
import sys
import time as _time
import types

# ── MicroPython / hardware shims ────────────────────────────────────


class _FakePin:
    OUT = 0
    IN = 1
    PULL_UP = 2

    def __init__(self, *a, **k):
        self._v = 1          # idle HIGH, matching the pulled-up ack button

    def value(self, v=None):
        if v is None:
            return self._v
        self._v = v

    def toggle(self):
        self._v = 0 if self._v else 1


class _FakeUART:
    """Captures what the firmware writes; replays what a test queues."""

    def __init__(self, *a, **k):
        self.written = []
        self._rx = b""

    def write(self, s):
        self.written.append(s)

    def queue(self, data: bytes):
        self._rx += data

    def any(self):
        return len(self._rx)

    def read(self):
        d, self._rx = self._rx, b""
        return d

    def messages(self):
        """Every complete JSON line written so far, decoded."""
        out = []
        for chunk in self.written:
            for line in chunk.strip().split("\n"):
                if line:
                    out.append(json.loads(line))
        return out


class _FakeADC:
    def __init__(self, *a, **k):
        pass

    def read_u16(self):
        return 0


class _FakeI2C:
    def __init__(self, *a, **k):
        pass

    def scan(self):
        return []

    def readfrom_mem(self, *a, **k):
        return b"\x00\x00"

    def writeto_mem(self, *a, **k):
        return None


_machine = types.ModuleType("machine")
_machine.Pin, _machine.ADC = _FakePin, _FakeADC
_machine.I2C, _machine.UART = _FakeI2C, _FakeUART
sys.modules["machine"] = _machine

_network = types.ModuleType("network")
_network.STA_IF = 0
_network.WLAN = lambda *a, **k: types.SimpleNamespace(
    active=lambda *a: True,
    connect=lambda *a: None,
    isconnected=lambda: False,
    ifconfig=lambda: ("0.0.0.0",) * 4,
)
sys.modules["network"] = _network

_urequests = types.ModuleType("urequests")
_urequests.get = _urequests.post = lambda *a, **k: None   # http_post catches this
sys.modules["urequests"] = _urequests

sys.modules["ujson"] = json

_dht = types.ModuleType("dht")


class _FakeDHT11:
    def __init__(self, *a, **k):
        pass

    def measure(self):
        pass

    def temperature(self):
        return 20

    def humidity(self):
        return 50


_dht.DHT11 = _FakeDHT11
sys.modules["dht"] = _dht

# MicroPython-only time helpers
_time.sleep_ms = lambda ms: None
_time.ticks_ms = lambda: int(_time.time() * 1000)
_time.ticks_add = lambda t, d: t + d
_time.ticks_diff = lambda a, b: a - b

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402  (must follow the stubs above)


# ── Tests ────────────────────────────────────────────────────────────


def test_config_keys_land():
    """The server's key spelling must reach the attributes the code reads."""
    alerts = main.AlertManager()
    assert alerts.interval_sec == 60      # defaults before config
    assert alerts.cooldown_sec == 300

    # Exactly the payload reference_server.py serves from GET /config.
    alerts.update_thresholds({
        "temp_min": 1.0, "temp_max": 2.0,
        "humidity_min": 3.0, "humidity_max": 4.0,
        "tds_warning": 5.0, "tds_critical": 6.0,
        "voc_warning": 7.0, "voc_critical": 8.0,
        "post_interval_sec": 99,
        "alert_cooldown_sec": 77,
    })

    assert alerts.temp_min == 1.0 and alerts.voc_critical == 8.0
    # These two are the regression: previously they stayed at 60 / 300.
    assert alerts.interval_sec == 99, f"post_interval_sec ignored: {alerts.interval_sec}"
    assert alerts.cooldown_sec == 77, f"alert_cooldown_sec ignored: {alerts.cooldown_sec}"


def test_config_pushed_to_display():
    """The display renders thresholds, so it must be told when they change."""
    alerts = main.AlertManager()
    main.uart.written.clear()
    alerts.update_thresholds({"temp_max": 42.0})

    cfg = [m for m in main.uart.messages() if m["type"] == "config"]
    assert len(cfg) == 1, f"expected one config frame, got {len(cfg)}"
    assert cfg[0]["temp_max"] == 42.0


def test_alert_reaches_display():
    """_fire must emit UART, not only POST /alerts."""
    alerts = main.AlertManager()
    main.uart.written.clear()
    alerts._fire("temperature_high", "critical", 41.0, 30.0, "Ambient too hot")

    alarms = [m for m in main.uart.messages() if m["type"] == "alert"]
    assert len(alarms) == 1, "alert never reached the display"
    assert alarms[0]["severity"] == "critical"
    assert alarms[0]["message"] == "Ambient too hot"
    assert alarms[0]["alert_type"] == "temperature_high"


def test_ack_from_display_clears_state():
    alerts = main.AlertManager()
    alerts._buzzer_on = True
    alerts._active["temperature_high"] = True

    main.uart.queue(b'{"type":"ack"}\n')
    main.poll_display(alerts)

    assert alerts._active == {}, "ACK did not clear active alerts"
    assert alerts._buzzer_on is False, "ACK did not silence the buzzer"


def test_ack_split_across_reads():
    """UART delivers bytes, not messages — a half line must not be consumed."""
    alerts = main.AlertManager()
    alerts._active["voc_critical"] = True

    main.uart.queue(b'{"type":"a')
    main.poll_display(alerts)
    assert alerts._active, "acted on an incomplete line"

    main.uart.queue(b'ck"}\n')
    main.poll_display(alerts)
    assert alerts._active == {}, "did not reassemble the split line"


def test_garbage_does_not_crash():
    alerts = main.AlertManager()
    main.uart.queue(b'not json at all\n{"type":"ack"}\n')
    main.poll_display(alerts)   # must survive the bad line and still see the ack
    assert alerts._active == {}


def test_rx_buffer_is_bounded():
    """A newline-less stream must not grow without bound."""
    alerts = main.AlertManager()
    main.uart.queue(b"x" * (main._RX_BUF_MAX + 10))
    main.poll_display(alerts)
    assert len(main._rx_buf) == 0, "RX buffer was not discarded on overflow"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        main._rx_buf = b""
        main.uart.written.clear()
        main.uart._rx = b""
        t()
        print(f"  ok  {t.__name__}")
    print(f"\n{len(tests)} passed")
