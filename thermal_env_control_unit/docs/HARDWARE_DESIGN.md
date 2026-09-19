# Thermal Environmental Control Unit — Hardware Design Reference

## Overview

| Parameter | Value |
|---|---|
| **Main controller** | Raspberry Pi Pico W (RP2040 + CYW43439 WiFi) |
| **Display / UI controller** | ESP32-S3 VIEWE Smart Display (ILI9488 3.5″ 480×320) |
| **Temp & humidity** | DHT11 |
| **TDS (water filter)** | Ocean TDS Meter (analog voltage output) |
| **VOC (rotting produce)** | MTK-MB005 (I2C) |
| **Network** | Pico W connects to WiFi → HTTP endpoint |
| **Display link** | UART between Pico W and ESP32-S3 |

---

## Pin Assignment — Pico W

```
Pin  | Function               | Connected to
-----|------------------------|-------------------------------------------
 3V3 | Power                  | DHT11 VCC, VOC VCC, TDS VCC (via 3.3V rail)
 GND | Ground                 | DHT11 GND, VOC GND, TDS GND, shared rail
 GP0  | I2C0 SDA (VOC)        | VOC sensor SDA
 GP1  | I2C0 SCL (VOC)        | VOC sensor SCL
 GP4  | Digital input         | DHT11 DATA
 GP26 | ADC0 (TDS analog)     | TDS sensor AOUT
 GP25 | Digital output        | Status LED (active HIGH via 330Ω resistor)
 GP27 | Digital output        | Alert buzzer (active HIGH via transistor)
 GP28 | Digital input         | Alert acknowledge button (active LOW, pull-up)
 GP8  | UART1 TX              | ESP32-S3 RX (UART0 TX, pin 44)
 GP9  | UART1 RX              | ESP32-S3 TX (UART0 RX, pin 43)
 GP15 | Digital output        | Pico indicator LED (built-in, LED_BUILTIN)
 VBUS | USB power sense       | (no wiring — used to detect USB power)
```

### Notes on Pico W pin numbering
- GP0–GP28 are user GPIO pins. GP29–31 are used for built-in functionality (ADC_VREF, etc.).
- UART1 TX=GP8, RX=GP9. UART0 TX=GP0, RX=GP1 (conflicts with I2C0 — use UART1 for ESP32 comms).

---

## Pin Assignment — ESP32-S3 VIEWE Display

```
Pin      | Function              | Connected to
---------|----------------------|------------------------------------------
 3V3     | Power                | Display VCC, touch VCC
 GND     | Ground               | Display GND, touch GND
 GPIO1   | SPI MOSI (VSPI)      | Display DIN (MOSI)
 GPIO3   | SPI MISO             | Display DOUT (MISO, optional)
 GPIO4   | SPI CLK              | Display CLK
 GPIO5   | Chip Select          | Display CS
 GPIO6   | Data/Control         | Display DC
 GPIO7   | Reset                | Display RST (via 10k pull-up to 3V3)
 GPIO40  | I2C SDA (touch)      | Touchpanel SDA (via 3.3V logic level)
 GPIO41  | I2C SCL (touch)      | Touchpanel SCL
 GPIO12  | Digital input        | Button A (active LOW, internal pull)
 GPIO13  | Digital input        | Button B (active LOW, internal pull)
 GPIO14  | Digital input        | Button C (active LOW, internal pull)
 GPIO15  | Digital output       | Alert LED 1 (red, active HIGH)
 GPIO16  | Digital output       | Alert LED 2 (amber, active HIGH)
 GPIO17  | Digital output       | Piezo speaker signal
 GPIO44  | UART0 TX             | Pico W GP9 (UART1 RX)
 GPIO43  | UART0 RX             | Pico W GP8 (UART1 TX)
```

---

## Breadboard Layout

### Power Rails
- **Red bus (+)**: +3.3V from Pico 3V3 OUT — feeds DHT11 VCC, VOC VCC, TDS VCC, ESP32 3V3
- **Blue bus (−)**: GND — shared by DHT11, VOC, TDS, ESP32, status LED, buzzer, buttons

### Signal Wiring (by function)

#### DHT11 (temperature + humidity)
- DHT11 DATA (pin 2) → GP4 via 4.7kΩ pull-up resistor to 3.3V rail
- DHT11 VCC → 3.3V rail
- DHT11 GND → GND rail

#### VOC Sensor MTK-MB005 (I2C)
- VOC SDA → GP0 (I2C0 SDA)
- VOC SCL → GP1 (I2C0 SCL)
- VOC VCC → 3.3V rail
- VOC GND → GND rail
- *Note: Some MTK-MB005 modules require 5V VCC; check datasheet. If 5V required, power from VSYS (5V) and use a bi-directional logic-level shifter between I2C lines and GP0/GP1.*

#### TDS Meter (analog voltage output)
- TDS AOUT → GP26 (ADC0)
- TDS VCC → 3.3V rail
- TDS GND → GND rail
- *Voltage divider recommended if sensor outputs 0–3.3V directly. If sensor outputs 0–5V, use 10kΩ + 10kΩ divider to halve voltage before ADC.*

#### Status LED
- Anode → GP25 via 330Ω current-limiting resistor → 3.3V rail
- Cathode → GND

#### Alert Buzzer
- Buzzer positive → collector of 2N2222 NPN transistor
- Transistor base → GP27 via 1kΩ resistor
- Transistor emitter → GND
- Buzzer negative → 3.3V rail (buzzer powered from 3.3V rail)
- *Add a 1N4001 flyback diode across buzzer terminals (anode to ground, cathode to 3.3V)*

#### Alert Acknowledge Button
- One side → GP28
- Other side → GND
- Internal pull-up on GP28 enabled in firmware

#### UART Bridge (Pico W ↔ ESP32-S3)
- Pico W GP8 (UART1 TX) → ESP32 GPIO43 (UART0 RX)  [voltage: both 3.3V — direct connection]
- Pico W GP9 (UART1 RX) → ESP32 GPIO44 (UART0 TX)
- GND of Pico and ESP32 must be shared

#### ESP32-S3 Power from Pico
- Pico 3V3 OUT → ESP32 3V3 (for low-power display; confirm ESP32-S3 VIEWE draws < 500mA total)
- If display draws more, power ESP32-S3 separately via USB or 5V adapter with 3.3V regulator

---

## Physical Layout on Breadboard

```
   +-------+-------+-------+-------+-------+-------+-------+-------+-------+
   |  3.3V |  GND  | GP25  | GP28  |  USB  |  VSYS |  3V3  |  GND  | GP29  |  <- Pico top row
   +-------+-------+-------+-------+-------+-------+-------+-------+-------+
                        [LED]  [ACK BTN]

   BREADBOARD LEFT ZONE (sensor area)
   =========================================================
   [ DHT11 ]            [ VOC MTK-MB005 ]       [ TDS Meter ]
      |                        |                     |
      +--[4.7k pull-up]--+     +--I2C--> GP0,GP1     +--ADC--> GP26
      |                  |     |                     |
   3.3V               GP4   3.3V                 3.3V
   GND                GND    GND                  GND

   BREADBOARD RIGHT ZONE (alert & comms)
   =========================================================
   [ STATUS LED ]     [ BUZZER + 2N2222 ]      [ ESP32-S3 ]
   GP25----[330R]-->|+                    |   UART TX --> GP9
   GND         LED-|                       |   UART RX <-- GP8
                    +--[1N4001]             |   3V3 <-- Pico 3V3
                                          |   GND --- Pico GND
   GP27----[1k]---Base---2N2222---GND      |
                                          |
   [ ACK BUTTON ]                          |
   GP28 -------[BTN]------- GND           |
   =========================================================
```

---

## Alert Thresholds

| Sensor | Metric | Warning | Critical | Action |
|---|---|---|---|---|
| DHT11 | Temperature | < 5°C or > 30°C | < 2°C or > 38°C | Buzzer + LED + HTTP POST |
| DHT11 | Humidity | < 30% or > 80% | < 20% or > 90% | Buzzer + LED + HTTP POST |
| TDS | PPM | > 200 | > 350 | Filter replacement alert |
| VOC | Index | > 150 | > 300 | Rotting produce alert |

---

## Expected HTTP Endpoint Contract

### POST /readings
Pico W sends batched sensor data:

```json
{
  "device_id": "pico-ctrl-001",
  "timestamp": "2026-09-19T14:30:00Z",
  "sensors": {
    "temperature_c": 22.5,
    "humidity_pct": 55.0,
    "tds_ppm": 142.0,
    "voc_index": 87.0
  }
}
```

### POST /alerts
Pico W notifies of threshold breach:

```json
{
  "device_id": "pico-ctrl-001",
  "timestamp": "2026-09-19T14:30:00Z",
  "alert_type": "temperature_low",
  "severity": "critical",
  "value": 1.8,
  "threshold": 2.0,
  "message": "Ambient temperature critically low: 1.8°C"
}
```

### GET /config
Pico W fetches current thresholds from server:

```json
{
  "temp_min": 5.0,
  "temp_max": 30.0,
  "humidity_min": 30.0,
  "humidity_max": 80.0,
  "tds_warning": 200,
  "tds_critical": 350,
  "voc_warning": 150,
  "voc_critical": 300,
  "post_interval_sec": 60,
  "alert_cooldown_sec": 300
}
```

### GET /check-drops
Returns temperature drop events from historical dataset:

```json
{
  "drops": [
    {
      "timestamp": "2026-09-19T10:00:00Z",
      "location": "cooler-zone-a",
      "drop_c": -4.2,
      "current_c": 18.1,
      "alert": true
    }
  ]
}
```
