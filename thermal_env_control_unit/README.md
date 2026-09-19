# Thermal Environmental Control Unit

Monitor temperature, humidity, water filter quality, and produce spoilage with
a Raspberry Pi Pico W + ESP32-S3 VIEWE Smart Display. Alerts are sent to a
configurable HTTP endpoint and displayed locally on the 3.5" TFT.

---

## Hardware

| Component | Model | Connection |
|---|---|---|
| Main controller | Raspberry Pi Pico W | WiFi + UART bridge |
| Display | ESP32-S3 VIEWE (ILI9488 3.5") | UART to Pico W |
| Temperature + Humidity | DHT11 | GPIO 4 |
| VOC (rotting produce) | MTK-MB005 | I2C0 (GPIO 0/1) |
| TDS (water filter) | Ocean TDS Meter | ADC0 (GPIO 26) |
| Buzzer | Active piezo | GPIO 27 via 2N2222 |
| Alert LED | 5mm LED | GPIO 25 via 330Ω |
| Acknowledge button | Momentary SPST | GPIO 28 (pull-up) |

Full pinout and breadboard layout: [`docs/HARDWARE_DESIGN.md`](docs/HARDWARE_DESIGN.md)

---

## Quick Start

```bash
# 1. Flash MicroPython onto Pico W
# Download .uf2 from https://micropython.org/download/RP2040BOARD/
# Hold BOOTSEL, drag .uf2 to RPI-RP2

# 2. Edit WiFi + endpoint credentials
#    pico_w_firmware/main.py  →  WIFI_SSID, WIFI_PASS, ENDPOINT

# 3. Upload firmware to Pico W (Thonny IDE recommended)
#    Save pico_w_firmware/main.py as main.py on the Pico

# 4. Upload display firmware to ESP32-S3
#    Arduino IDE: open esp32_display/esp32_display.ino
#    PlatformIO: cd esp32_display && pio run --target upload

# 5. Run the reference server
pip install flask
python server/reference_server.py
# → http://localhost:8080
```

Full setup guide: [`SETUP.md`](SETUP.md)

---

## Architecture

```
┌──────────────┐  WiFi + HTTP  ┌────────────────────┐
│  Pico W      │───────────────│  HTTP Endpoint     │
│  (firmware)  │               │  /config           │
│              │               │  /readings         │
│  DHT11 ──────►│               │  /alerts           │
│  MTK-MB005 ──►│  UART1       │  /check-drops      │
│  TDS ADC ────►│───────────────►└────────────────────┘
└──────┬───────┘
       │ 115200 8N1
       ▼
┌──────────────┐
│  ESP32-S3    │
│  VIEWE       │───► 3.5" TFT + Touch
│  (display)   │───► Buttons A / B / C
└──────────────┘
```

---

## Files

| Path | Description |
|---|---|
| `docs/HARDWARE_DESIGN.md` | Full pinout, breadboard layout, alert thresholds |
| `pico_w_firmware/main.py` | Pico W MicroPython firmware |
| `esp32_display/esp32_display.ino` | ESP32-S3 Arduino display driver |
| `esp32_display/TFT_eSPI_setup.h` | ILI9488 parallel-interface config |
| `esp32_display/platformio.ini` | PlatformIO build config |
| `server/reference_server.py` | Minimal Flask reference server |
| `requirements.txt` | Python dependencies |
| `SETUP.md` | Step-by-step assembly and flashing guide |

---

## Alert Behaviour

| Sensor | Warning | Critical |
|---|---|---|
| Temperature | < 5°C or > 30°C | < 2°C or > 38°C |
| Humidity | < 30% or > 80% | < 20% or > 90% |
| TDS | > 200 ppm | > 350 ppm (replace filter) |
| VOC Index | > 150 | > 300 (rotting produce) |

On alert: buzzer pulses at 2 Hz, LEDs flash, `POST /alerts` fires to the endpoint.
Press **B** on the ESP32 to acknowledge and silence.
