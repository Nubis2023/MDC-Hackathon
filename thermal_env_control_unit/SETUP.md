# SETUP.md — Thermal Environmental Control Unit

> **Display hardware changed.** The connected panel is a VIEWE UEDX48480021 (ST7701S 480x480, LVGL), not the ILI9488 described below. The ILI9488/TFT_eSPI instructions in this file are retained for that panel only and will not work on the current board. Build `esp32_display/shopswarm_display/` instead - see [CHANGES.md](CHANGES.md).

## Parts List

| Part | Model | Purpose |
|---|---|---|
| Microcontroller | Raspberry Pi Pico W | Main controller + WiFi |
| Display | ESP32-S3 VIEWE Smart Display (ILI9488 3.5") | Local UI |
| Temp + Humidity | DHT11 | Ambient monitoring |
| VOC | MTK-MB005 | Produce spoilage detection |
| TDS | Ocean TDS Meter (analog) | Water filter status |
| Breadboard | Full-size (830 tie-point) | Prototyping |
| Jumper wires | M/M and M/F dupont cables | Wiring |
| Resistors | 330Ω, 1kΩ, 4.7kΩ (one each) | LED, buzzer, DHT pull-up |
| NPN Transistor | 2N2222 or S8050 | Buzzer drive |
| Diode | 1N4001 | Flyback protection on buzzer |
| USB power | 5V 2A USB power supply | System power |

---

## Step 1 — Flash MicroPython onto the Pico W

1. Hold the **BOOTSEL** button on the Pico W.
2. Plug the Pico W into your computer via USB.
3. Release BOOTSEL — a drive named `RPI-RP2` will appear.
4. Download the latest `.uf2` from:
   ```
   https://micropython.org/download/RP2040BOARD/
   ```
   Select the **Raspberry Pi Pico W** build.
5. Drag-and-drop the `.uf2` file onto the `RPI-RP2` drive.
6. The Pico W will reboot and enumerate as a USB serial device.

---

## Step 2 — Configure WiFi and Endpoint

Open `pico_w_firmware/main.py` and edit these constants at the top:

```python
WIFI_SSID = "YOUR_WIFI_SSID"
WIFI_PASS = "YOUR_WIFI_PASSWORD"
ENDPOINT  = "http://192.168.1.100:8080"   # Your server address
DEVICE_ID = "pico-ctrl-001"               # Unique device name
```

---

## Step 3 — Upload Firmware to Pico W

**Recommended: Thonny IDE**

1. Install Thonny: https://thonny.org/
2. Set interpreter to **MicroPython (Raspberry Pi Pico)** via Thonny's interpreter selector (bottom-right).
3. Open `pico_w_firmware/main.py` in Thonny.
4. Save it to the Pico W (Thonny → File → Save as → Raspberry Pi Pico).
5. Name it `main.py` — it will run automatically on every boot.

**Alternative: ampy**

```bash
pip install adafruit-ampy
ampy -p /dev/tty.usbmodem* put pico_w_firmware/main.py main.py
```

**Alternative: mpremote**

```bash
pip install mpremote
mpremote cp pico_w_firmware/main.py :main.py
```

---

## Step 4 — ESP32-S3 Display Setup

### Option A: Arduino IDE

1. Install the **ESP32 board package**:
   - File → Preferences → Additional Board Manager URLs:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Tools → Board → Board Manager → install **esp32 by Espressif Systems**
2. Select board: **ESP32S3 Dev Module**
3. Set the following in Tools menu:
   - Upload Speed: `115200`
   - Partition Scheme: `Huge APP (3MB No OTA / 1MB SPIFFS)`
   - Flash Mode: `DIO`
4. Install libraries (Sketch → Include Library → Manage Libraries):
   - **TFT_eSPI** by Bodmer
   - **XPT2046_Touchscreen** by Paul Stoffregen
   - **JC_Button** by digilect
5. Open `esp32_display/esp32_display.ino` in Arduino IDE.
6. Configure `TFT_eSPI` — edit your Arduino `libraries/TFT_eSPI/User_Setups/` folder:
   - Create or edit `Setup45_ESP32_S3_VIEWE_ILI9488.h` (copy from `esp32_display/TFT_eSPI_setup.h`)
7. Upload to the ESP32-S3 via USB-C.

### Option B: PlatformIO

```bash
cd esp32_display
pio pkg install
pio run --target upload
```

Create `platformio.ini` in `esp32_display/`:

```ini
[env:esp32-s3-view]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
monitor_speed = 115200
build_flags =
    -DCORE_DEBUG_LEVEL=0
lib_deps =
    bodmer/TFT_eSPI@^2.5.43
    paulStoffregen/XPT2046_Touchscreen@^1.4
    digilect/JC_Button@^2.1.0
```

---

## Step 5 — TFT_eSPI Configuration for ESP32-S3 VIEWE

The ESP32-S3 VIEWE uses an ILI9488 display and XPT2046 touch controller. Create this file:

**File: `~/Arduino/libraries/TFT_eSPI/User_Setups/Setup45_ESP32_S3_VIEWE_ILI9488.h`**

```cpp
// Setup45 — ESP32-S3 VIEWE Smart Display (ILI9488 3.5" 480x320)

#ifndef USER_SETUP_LOADED
#define USER_SETUP_LOADED

#define ILI9488_DRIVER     1
#define TFT_WIDTH   320
#define TFT_HEIGHT  480

#define ESP32_PARALLEL

#define TFT_CS    5
#define TFT_DC    6
#define TFT_RST   7
#define TFT_WR    8
#define TFT_RD    9

#define TFT_D0   38
#define TFT_D1   39
#define TFT_D2   40
#define TFT_D3   41
#define TFT_D4   42
#define TFT_D5   45
#define TFT_D6   46
#define TFT_D7   47

#define LOAD_GLCD   1
#define LOAD_FONT2  1
#define LOAD_FONT4  1
#define LOAD_FONT7  1

#define SMOOTH_FONT  1

#define SPI_FREQUENCY  40000000
#define SPI_READ_FREQUENCY  6000000

#define TOUCH_CS  40
#define TOUCH_IRQ 38

#endif
```

In your Arduino sketch, add at the top:
```cpp
#define USER_SETUP_S45
#include <TFT_eSPI.h>
```

---

## Step 6 — Breadboard Assembly

Follow the pinout table in `docs/HARDWARE_DESIGN.md`. Key wiring steps:

1. **Power rails**: Run 3.3V from Pico 3V3 OUT to the + bus, and GND to the − bus.
2. **DHT11**: Data pin → GP4 with a 4.7kΩ pull-up resistor between DATA and 3.3V.
3. **VOC MTK-MB005**: SDA → GP0, SCL → GP1, VCC → 3.3V rail.
   - *If your MB005 requires 5V, power from VSYS and add a logic-level shifter on SDA/SCL.*
4. **TDS**: AOUT → GP26 (ADC0). If the sensor outputs 0–5V, add a 10kΩ+10kΩ voltage divider.
5. **Status LED**: Anode through 330Ω resistor to GP25, cathode to GND.
6. **Buzzer**: Positive terminal to 3.3V rail, negative through 2N2222 transistor to GND.
   - Transistor base → GP27 via 1kΩ resistor.
   - Flyback diode (1N4001) across buzzer terminals (anode=GND, cathode=3.3V).
7. **Acknowledge button**: One side → GP28, other side → GND.
8. **UART bridge**: Connect Pico W GP8 → ESP32 GPIO43, Pico W GP9 → ESP32 GPIO44.
   - Connect GND between Pico and ESP32.
   - Power ESP32 from Pico 3V3 OUT (if display is low-power) or a separate 5V source.

---

## Step 7 — HTTP Endpoint (Server Side)

The Pico W expects these endpoints on your server:

| Method | Path | Direction | Purpose |
|---|---|---|---|
| `GET` | `/config` | Server → Pico | Threshold configuration |
| `POST` | `/readings` | Pico → Server | Batch sensor data |
| `POST` | `/alerts` | Pico → Server | Threshold breach notifications |
| `GET` | `/check-drops` | Pico → Server | Temperature drop events |

A minimal reference server (Python Flask) is in `server/reference_server.py`.

---

## Step 8 — Running

1. **Pico W**: On power-up, the LED on GP25 flashes 3×, WiFi connects, main loop starts.
2. **ESP32**: Splash screen → Home page. Readings appear within ~10 seconds.
3. **Flashing LEDs**: Red/amber LEDs pulsing with buzzer = active alert. Press **B** on ESP32 to acknowledge.

---

## Calibration Notes

### TDS Meter
The Ocean TDS sensor is calibrated for NaCl solutions. Adjust the `k` factor in `tds_read_ppm()`:
```python
k = 1.0  # increase if readings read high, decrease if low
tds = voltage * (TDS_REF_PPM / TDS_REF_VOLTAGE) * k
```
Test with a 138 ppm reference solution and tweak until readings match.

### VOC MTK-MB005
The MB005 returns raw concentration units (typically 0–1000 or 0–500 depending on firmware).
- Run the sensor in fresh air for 10 minutes to establish a baseline.
- The warning/critical thresholds in `AlertManager` are tuned for ethanol-equivalent ppm.
- If your sensor uses a different scale, adjust `voc_warning` and `voc_critical` accordingly.

### DHT11 Accuracy
The DHT11 has ±2°C and ±5% RH accuracy. For precise control, consider upgrading to DHT22.
The firmware interface is the same — only change `DHT11` to `DHT22` in the pin definition section.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Pico W not connecting to WiFi | Wrong SSID/password, weak signal |
| VOC sensor returns -1.0 | Wrong I2C address (scan with `i2c.scan()`) |
| TDS reads 0 or very low | Sensor not powered, ADC pin wrong, voltage divider needed |
| ESP32 display shows white screen | TFT_eSPI setup file not configured correctly |
| UART garbled characters | Baud rate mismatch (both must be 115200) |
| DHT11 always reads 0 or None | Missing 4.7kΩ pull-up, or pin used by another peripheral |
