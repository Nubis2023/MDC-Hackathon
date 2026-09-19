# Changes — display rebrand, hardware correction, protocol fixes

Dated 2026-09-19. Three things happened, in this order: a rebrand to **ShopSwarm**,
the discovery that the shipped display hardware is not what the firmware targeted,
and a set of fixes to the Pico↔display protocol that were found while checking
whether the display was aligned with the rest of the system.

---

## 1. The hardware does not match the original firmware

The board actually connected is a **VIEWE UEDX48480021-MD80ESP32** ("2.1 inch Touch
Knob Display"). `esp32_display/esp32_display.ino` was written for a completely
different display:

| | `esp32_display.ino` assumes | Actual board |
|---|---|---|
| Panel | ILI9488, 480×320, 3.5" | **ST7701S, 480×480, 2.1"** |
| Interface | SPI / parallel 8-bit MCU bus | **3-wire SPI + RGB16** |
| Graphics lib | TFT_eSPI | **ESP32_Display_Panel + LVGL 8.4** |
| Touch | XPT2046 (resistive, SPI) | **CST820 (capacitive, I2C)** |
| Input | 3 buttons A/B/C on GPIO 12/13/14 | knob + touch; no A/B/C |
| MCU | unspecified ESP32-S3 | ESP32-S3 N16R8 (16MB flash, 8MB OPI PSRAM) |

TFT_eSPI drives MCU-bus controllers only; it has no ST7701S RGB driver. An RGB
panel needs the ESP32-S3 LCD_CAM peripheral, which is what `ESP32_Display_Panel`
wraps. **No build flag rescues the old sketch** — it cannot run on this board.

`esp32_display/esp32_display.ino`, `TFT_eSPI_setup.h` and `platformio.ini` are
therefore **dead for this hardware**. They are kept, not deleted, in case an
ILI9488 panel is used later. `esp32_display.ino:274` did get the `EnvCtrl` →
`ShopSwarm` rename before the mismatch was found; that change is correct but
inert.

### New firmware: `esp32_display/shopswarm_display/`

| File | Origin |
|---|---|
| `shopswarm_display.ino` | written for this project |
| `lvgl_v8_port.cpp/.h`, `lv_conf.h`, `esp_panel_*_conf.h`, `esp_utils_conf.h` | copied verbatim from `ESP32_Display_Panel/examples/arduino/gui/lvgl_v8/simple_port/` |

Two lines changed in the copied `esp_panel_board_supported_conf.h`:

```c
#define ESP_PANEL_BOARD_DEFAULT_USE_SUPPORTED       (1)
#define BOARD_VIEWE_UEDX48480021_MD80ET
```

> If the panel stays dark, this macro is the first suspect — the library defines
> three near-identical variants (`MD80E`, `MD80E_V2`, `MD80ET`). The bundled
> instruction sheet named `MD80ET`.

### GPIO budget

The RGB panel claims `1,2,3,8,9,10,11,12,13,14,15,16,17,18,21,38–42,45–48`,
backlight takes `7`, `19/20` are native USB and `26–37` are flash + OPI PSRAM.
**Free: 4, 5, 6, 43, 44.** Because `Serial` is native USB CDC on this board,
43/44 are available, so the Pico link documented in SETUP.md still holds:

```
Pico GP8 (TX) ──► ESP32 GPIO44 (RX)
Pico GP9 (RX) ◄── ESP32 GPIO43 (TX)
```

The sketch uses UART1 on those pins rather than UART0, so ROM boot chatter on
UART0 cannot be mistaken for a Pico frame.

### Build and flash

```bash
cd esp32_display/shopswarm_display
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc" .
arduino-cli upload  --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc" -p /dev/cu.usbmodem1101 .
```

Dependencies: esp32 core ≥ 3.0.7 (built against 3.3.12), `ESP32_Display_Panel`
≥ 1.0.3 (1.0.4), `lvgl` 8.4.0, `ArduinoJson` 7.

---

## 2. Pico-side protocol fixes — `pico_w_firmware/main.py`

Four defects, all of which made the display less functional than it looked.

### 2.1 Alerts never reached the display

`AlertManager._fire()` only called `http_post("/alerts", …)`. There were exactly
two `send_to_display` call sites — `readings` and `drop` — so `{"type":"alert"}`
was never sent. Everything on the display keyed to it (the alert overlay, both
alert LEDs, the speaker, and button B's entire purpose) was unreachable code.

`_fire()` now also emits over UART:

```python
send_to_display({
    "type": "alert", "alert_type": alert_type,
    "severity": severity, "message": message,
})
```

The UART send is placed **after** `http_post`, which catches all its own
exceptions — so a network outage cannot stop the display being told.

### 2.2 The display's ACK went nowhere

The ESP32 sent `{"type":"ack"}`, but the Pico had no `uart.read()` anywhere —
it only ever wrote. Acknowledgement worked solely via the physical button on
GP28, so tapping the display could never silence the buzzer.

Added `poll_display(alerts)`: drains UART1, reassembles newline-framed JSON
across reads, tolerates malformed lines, caps the RX buffer at 512 B, and calls
`alerts.acknowledge()` on an `ack` frame.

### 2.3 Config keys silently did nothing

`update_thresholds()` used `setattr(self, key, …)` over a key list, but two of
the names differ between the server payload and the class:

| Server sends | Class reads | Before |
|---|---|---|
| `alert_cooldown_sec` | `cooldown_sec` | never applied |
| `post_interval_sec` | `interval_sec` | set a new unused attribute |

Replaced with an explicit `_CONFIG_KEYS` map. Both spellings of the cooldown key
are accepted.

A third layer of the same disconnect: `main()` held a **local** `post_interval = 60`
and used it for the POST cadence, so even a corrected `interval_sec` would have
been ignored. The loop now reads `alerts.interval_sec`.

### 2.4 The loop serviced input once per 10 seconds

`time.sleep(10)` meant both the ACK and the physical button were only handled on
the cycle boundary. Replaced with `_idle(10, alerts)`, which polls UART and the
button every 100 ms. The button block moved out of the main body into `_idle`.

### 2.5 New: thresholds are pushed to the display

The display used to hardcode its threshold text while the Pico refetched
thresholds from `GET /config` every 5 minutes — so the shown numbers could
silently diverge from the ones actually alerting.

Added `AlertManager.send_config_to_display()`, emitting `{"type":"config", …}`.
It is called once at boot (seeding defaults before the first `/config` lands,
which can be 5 minutes away) and again on every successful `update_thresholds`.

### Test

`pico_w_firmware/test_display_protocol.py` — plain asserts, no framework, stubs
`machine`/`network`/`urequests`/`dht` and the MicroPython `time` helpers:

```bash
python3 pico_w_firmware/test_display_protocol.py     # 7 passed
```

It covers: config keys landing on the right attributes, config reaching the
display, an alert reaching the display, ACK clearing state, an ACK split across
two reads, malformed input, and RX buffer bounding.

---

## 3. Display-side fixes, folded into the new firmware

These were defects in `esp32_display.ino`. Rather than patch a sketch that cannot
run on this board, the corrected behaviour was built into
`shopswarm_display.ino`.

### 3.1 Non-readings frames blanked every gauge

`parse_pico_message()` assigned all four sensor floats *before* checking the
message type. A `drop` or `alert` frame carries none of those keys, so the naive
`parse_float` returned `0.0` for each — and it also set `stale = false`. The
`value == 0.0 && !stale` branch in `draw_gauge_card` then printed `--`, so every
reading went blank until the next `readings` frame.

Now only a `readings` frame touches the readings. A genuine `0.0` renders as
`0.0`; `--` means "no data yet", tracked by a separate `sensors.valid` flag the
old code did not have.

### 3.2 The timestamp never displayed

```c
int ts_start = json.indexOf("\"timestamp\":\"") + 12;   // pattern is 13 chars
```

`ts_start` landed on the value's opening quote, so `indexOf("\"", ts_start)`
returned that same index, `ts_end > ts_start` was false, and the field was never
assigned. "Last reading:" was permanently blank.

### 3.3 Hand-rolled JSON replaced with ArduinoJson

3.1 and 3.2 were both parser bugs, and the nested `drop` payload
(`{"type":"drop","data":{…}}`) only worked because a top-level substring search
happened to hit the nested keys. The new firmware uses ArduinoJson 7 and reads
`doc["data"]["location"]` properly, which removes that whole class of defect.

### 3.4 Thresholds come from the Pico

The threshold page now renders the values from the `config` frame, and the gauge
colour logic uses them too. It shows `defaults - link down` until the first frame
arrives, so stale numbers are visibly labelled rather than silently wrong.

### 3.5 The drop toast no longer blocks

`show_drop_notification()` held a `delay(4000)` during which UART was not drained.
Replaced with a self-deleting `lv_timer`.

### 3.6 Acknowledge moved to touch

This board has no A/B/C buttons. The alert overlay is tappable and sends
`{"type":"ack"}` — which, with fix 2.2, the Pico now actually acts on.

### UI

480×480 in a round bezel, so all content sits inside the inscribed square
(480/√2 ≈ 339; the layout uses 330). Splash → 2×2 readings grid with a LIVE /
OFFLINE badge, status line and timestamp; tap anywhere to toggle to the
thresholds page; alerts take over as a full-screen overlay.

---

## Still open

- **Not visually confirmed.** Both builds flashed with every block hash-verified,
  but nobody has reported what the panel actually shows. If it is dark, try the
  other two `BOARD_VIEWE_UEDX48480021_*` macros.
- **End-to-end untested.** The Pico↔display protocol changes are covered by unit
  tests and both sides compile, but the two have not been run against each other
  on real hardware.
- **Round-bezel margins are estimated** from the 480×480 spec, not measured.
- **Anti-tearing is off.** `LVGL_PORT_AVOID_TEARING_MODE` is disabled; fine for
  mostly-static content, worth enabling if anything starts animating.
- **Docs still describe the old panel.** `README.md` (lines 4–5, 14, 39–41,
  81–83), `SETUP.md` (Steps 4–5) and `docs/HARDWARE_DESIGN.md` document the
  ILI9488/TFT_eSPI build and the A/B/C buttons. Pointers were added, but they
  have not been rewritten.
- **Old sketch retained.** `esp32_display/esp32_display.ino` and its TFT_eSPI
  config are dead for this board; delete them once an ILI9488 variant is ruled out.
