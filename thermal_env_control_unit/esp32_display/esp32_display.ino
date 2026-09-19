// esp32_display/esp32_display.ino
// Thermal Environmental Control Unit — ESP32-S3 VIEWE Smart Display
// Framework: Arduino IDE or PlatformIO (esp32 Arduino core v2.0+)
//
// Displays real-time sensor readings received over UART from Pico W.
// Touch input cycles screens; hardware buttons A/B/C trigger quick actions.
//
// Board: ESP32-S3 VIEWE (ILI9488 3.5" 480×320 TFT, XPT2046 touch)
// Install: Arduino Board Manager → "ESP32" by Espressif → 2.0.x

#include <Arduino.h>
#include <TFT_eSPI.h>      // Hardware-specific library for ILI9488 on ESP32
#include <XPT2046_Touchscreen.h>
#include <SPI.h>
#include <JC_Button.h>     // Debounced button library

// ─────────────────────────────────────────────
// PIN ASSIGNMENTS (ESP32-S3 VIEWE default)
// ─────────────────────────────────────────────
#define TFT_CS    5
#define TFT_DC    6
#define TFT_RST   7
#define TFT_MOSI  1
#define TFT_MISO  3
#define TFT_CLK   4

#define TOUCH_CS  40
#define TOUCH_IRQ 38

#define UART_RX   44   // Connected to Pico W GP8 (UART1 TX)
#define UART_TX   43   // Connected to Pico W GP9 (UART1 RX)

#define BTN_A_PIN 12   // Active LOW
#define BTN_B_PIN 13   // Active LOW
#define BTN_C_PIN 14   // Active LOW

#define LED_ALERT1 15  // Red alert LED (active HIGH)
#define LED_ALERT2 16  // Amber alert LED (active HIGH)
#define SPEAKER_PIN 17 // Piezo speaker (PWM via LEDC channel 0)

// LEDC PWM channel for the speaker
#define SPEAKER_CHANNEL 0

// ─────────────────────────────────────────────
// COLOUR PALETTE
// ─────────────────────────────────────────────
#define C_BG        0x0F18   // Dark navy background
#define C_CARD      0x1A2B   // Card background
#define C_PRIMARY   0x07E0   // Green (OK / normal)
#define C_WARNING   0xFD20   // Amber (warning)
#define C_CRITICAL  0xF800   // Red (critical)
#define C_TEXT      0xFFFF   // White text
#define C_SUBTEXT   0xAD55   // Muted grey-cyan
#define C_DIVIDER   0x18E3   // Subtle divider lines

// ─────────────────────────────────────────────
// GLOBAL OBJECTS
// ─────────────────────────────────────────────
TFT_eSPI    tft = TFT_eSPI(320, 480);         // 3.5" display
XPT2046_Touchscreen ts(TOUCH_CS, TOUCH_IRQ);
HardwareSerial espSerial(0);                   // UART0 on GPIO43/44

Button btnA(BTN_A_PIN, 25);   // 25 ms debounce
Button btnB(BTN_B_PIN, 25);
Button btnC(BTN_C_PIN, 25);

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
struct SensorState {
  float temperature_c = 0.0;
  float humidity_pct  = 0.0;
  float tds_ppm       = 0.0;
  float voc_index     = 0.0;
  String timestamp    = "";
  bool  stale         = true;   // true until first valid reading arrives
  unsigned long last_update_ms = 0;
};

SensorState sensors;

// Alert overlay state
bool alert_active = false;
String alert_message = "";
uint16_t alert_colour = C_CRITICAL;

// Current display page: 0=Home, 1=Details, 2=History (future)
uint8_t current_page = 0;
const uint8_t TOTAL_PAGES = 2;

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[ESP32] Display controller booting …");

  // Status LEDs
  pinMode(LED_ALERT1, OUTPUT);
  pinMode(LED_ALERT2, OUTPUT);
  digitalWrite(LED_ALERT1, LOW);
  digitalWrite(LED_ALERT2, LOW);

  // Speaker PWM via LEDC (ESP32 has no analogWrite)
  ledcSetup(SPEAKER_CHANNEL, 2000, 8);  // 2 kHz, 8-bit (0-255)
  ledcAttachPin(SPEAKER_PIN, SPEAKER_CHANNEL);
  ledcWrite(SPEAKER_CHANNEL, 0);

  // Buttons (built-in pull-ups on ESP32)
  pinMode(BTN_A_PIN, INPUT_PULLUP);
  pinMode(BTN_B_PIN, INPUT_PULLUP);
  pinMode(BTN_C_PIN, INPUT_PULLUP);
  btnA.begin();
  btnB.begin();
  btnC.begin();

  // TFT display
  tft.init();
  tft.setRotation(1);        // Landscape
  tft.fillScreen(C_BG);
  tft.setTextColor(C_TEXT, C_BG);
  tft.setFreeFont(&FreeSansBold12pt7b);

  // Touchscreen
  ts.begin();
  ts.setRotation(1);

  // UART bridge from Pico W (115200 baud, matching Pico firmware)
  espSerial.begin(115200, SERIAL_8N1, UART_RX, UART_TX);
  Serial.println("[ESP32] UART bridge ready on GPIO43/44");

  draw_splash();
  delay(1500);
  draw_page_home();
}

// ─────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────
void loop() {
  // ── Read UART messages from Pico W ─────────
  while (espSerial.available()) {
    String line = espSerial.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) {
      parse_pico_message(line);
    }
  }

  // ── Button debouncing ─────────────────────
  btnA.read();
  btnB.read();
  btnC.read();

  if (btnA.wasPressed())  on_btn_page_prev();
  if (btnB.wasPressed())  on_btn_acknowledge();
  if (btnC.wasPressed())  on_btn_page_next();

  // ── Touch input ────────────────────────────
  if (ts.tirqTouched()) {
    if (ts.touched()) {
      TS_Point p = ts.getPoint();
      handle_touch(p.x, p.y);
    }
    ts.touchDone();
  }

  // ── Stale-data indicator ───────────────────
  if (!sensors.stale) {
    unsigned long age = millis() - sensors.last_update_ms;
    if (age > 30000) {
      sensors.stale = true;
      draw_page_home();    // Redraw to show stale state
    }
  }

  // ── Alert pulse ────────────────────────────
  if (alert_active) {
    static unsigned long last_pulse = 0;
    static bool pulse_state = false;
    if (millis() - last_pulse > 500) {
      pulse_state = !pulse_state;
      digitalWrite(LED_ALERT1, pulse_state ? HIGH : LOW);
      digitalWrite(LED_ALERT2, pulse_state ? HIGH : LOW);
      tone_pulse(pulse_state);
      last_pulse = millis();
    }
  }

  delay(10);
}

// ─────────────────────────────────────────────
// UART MESSAGE PARSING
// Expects JSON lines: {"type":"readings","temperature_c":22.5,...}
// ─────────────────────────────────────────────
void parse_pico_message(const String& json) {
  // Minimal JSON parser for embedded use (no ArduinoJson dependency)
  // We look for key:value pairs directly in the raw string.

  sensors.temperature_c = parse_float(json, "temperature_c");
  sensors.humidity_pct  = parse_float(json, "humidity_pct");
  sensors.tds_ppm       = parse_float(json, "tds_ppm");
  sensors.voc_index     = parse_float(json, "voc_index");
  sensors.stale         = false;
  sensors.last_update_ms = millis();

  // Read timestamp if present
  int ts_start = json.indexOf("\"timestamp\":\"") + 12;
  if (ts_start > 11) {
    int ts_end = json.indexOf("\"", ts_start);
    if (ts_end > ts_start) {
      sensors.timestamp = json.substring(ts_start, ts_end);
    }
  }

  // Read message type
  if (json.indexOf("\"type\":\"readings\"") >= 0) {
    draw_page_home();
  } else if (json.indexOf("\"type\":\"alert\"") >= 0) {
    String msg = parse_string(json, "message");
    String sev = parse_string(json, "severity");
    show_alert(msg, sev);
  } else if (json.indexOf("\"type\":\"drop\"") >= 0) {
    String loc = parse_string(json, "location");
    float drop = parse_float(json, "drop_c");
    show_drop_notification(loc, drop);
  }

  Serial.printf("[ESP32] Updated: T=%.1f H=%.1f TDS=%.1f VOC=%.1f\n",
                sensors.temperature_c, sensors.humidity_pct,
                sensors.tds_ppm, sensors.voc_index);
}

// ─────────────────────────────────────────────
// MINIMAL JSON HELPERS
// ─────────────────────────────────────────────
float parse_float(const String& json, const char* key) {
  String k = String("\"") + key + "\":";
  int pos = json.indexOf(k);
  if (pos < 0) return 0.0;
  pos += k.length();
  // Skip whitespace
  while (pos < json.length() && isspace(json.charAt(pos))) pos++;
  // Parse float
  int end = pos;
  while (end < json.length() &&
         (isDigit(json.charAt(end)) || json.charAt(end) == '.' ||
          json.charAt(end) == '-' || json.charAt(end) == '+')) {
    end++;
  }
  String val = json.substring(pos, end);
  return val.toFloat();
}

String parse_string(const String& json, const char* key) {
  String k = String("\"") + key + "\":\"";
  int pos = json.indexOf(k);
  if (pos < 0) return "";
  pos += k.length();
  int end = json.indexOf("\"", pos);
  if (end < 0) return "";
  return json.substring(pos, end);
}

// ─────────────────────────────────────────────
// DRAWING — SPLASH SCREEN
// ─────────────────────────────────────────────
void draw_splash() {
  tft.fillScreen(C_BG);
  tft.setTextDatum(TC_DATUM);
  tft.setTextColor(C_PRIMARY, C_BG);
  tft.setFreeFont(&FreeSansBold24pt7b);
  tft.drawString("ShopSwarm", 160, 100, 1);
  tft.setFreeFont(&FreeSans12pt7b);
  tft.setTextColor(C_SUBTEXT, C_BG);
  tft.drawString("Thermal Monitor v1.0", 160, 150, 1);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString("Pico W + ESP32-S3", 160, 220, 1);
  tft.drawString("Waiting for data …", 160, 260, 1);
  draw_loading_bar(80, 300, 160, 8);
}

// ─────────────────────────────────────────────
// DRAWING — HOME PAGE (overview gauges)
// ─────────────────────────────────────────────
void draw_page_home() {
  tft.fillScreen(C_BG);
  draw_header("Environmental Monitor", sensors.stale ? "[OFFLINE]" : "[LIVE]");
  draw_divider(36);

  // ── Row 1: Temperature + Humidity ─────────
  draw_gauge_card(10,  46, 150, 100, "Temp",      sensors.temperature_c, "°C",
                  sensor_colour(sensors.temperature_c, 5.0, 30.0));
  draw_gauge_card(165, 46, 150, 100, "Humidity",   sensors.humidity_pct,  "%",
                  sensor_colour(sensors.humidity_pct, 30.0, 80.0));

  // ── Row 2: TDS + VOC ───────────────────────
  draw_gauge_card(10,  156, 150, 100, "TDS",       sensors.tds_ppm, "ppm",
                  tds_colour(sensors.tds_ppm));
  draw_gauge_card(165, 156, 150, 100, "VOC Index", sensors.voc_index, "",
                  voc_colour(sensors.voc_index));

  // ── Status bar ─────────────────────────────
  draw_status_bar();

  // ── Page dots ──────────────────────────────
  draw_page_dots();

  // ── Footer ─────────────────────────────────
  draw_footer();
}

// ─────────────────────────────────────────────
// DRAWING — DETAILS PAGE (threshold info)
// ─────────────────────────────────────────────
void draw_page_details() {
  tft.fillScreen(C_BG);
  draw_header("Sensor Thresholds", "");
  draw_divider(36);

  int y = 48;
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_BG);

  // Temperature thresholds
  draw_threshold_row(y, "Temperature", "5 – 30°C", C_PRIMARY);
  y += 26;
  draw_threshold_row(y, "Humidity",   "30 – 80%", C_PRIMARY);
  y += 26;
  draw_threshold_row(y, "TDS Filter", "< 200 ppm OK / > 350 ppm replace", C_WARNING);
  y += 26;
  draw_threshold_row(y, "VOC Index",  "< 150 OK / > 300 rotting produce", C_CRITICAL);
  y += 38;
  draw_divider_y(y);
  y += 14;

  // Last update time
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_BG);
  tft.drawString("Last reading:", 10, y);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(sensors.stale ? "---" : sensors.timestamp.c_str(), 120, y);

  draw_page_dots();
  draw_footer();
}

// ─────────────────────────────────────────────
// WIDGET HELPERS
// ─────────────────────────────────────────────
void draw_header(const char* title, const char* badge) {
  tft.fillRect(0, 0, 320, 32, C_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.setFreeFont(&FreeSansBold12pt7b);
  tft.setTextColor(C_TEXT, C_CARD);
  tft.drawString(title, 10, 8);
  if (badge[0]) {
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setTextColor(badge[0] == '[' ? C_PRIMARY : C_WARNING, C_CARD);
    tft.drawString(badge, 250, 10);
  }
}

void draw_divider(int y) {
  tft.drawFastHLine(0, y, 320, C_DIVIDER);
}

void draw_divider_y(int y) {
  tft.drawFastHLine(0, y, 320, C_DIVIDER);
}

void draw_gauge_card(int x, int y, int w, int h,
                     const char* label, float value, const char* unit,
                     uint16_t colour) {
  // Background card
  tft.fillRoundRect(x, y, w, h, 6, C_CARD);

  // Colour accent bar at top
  tft.fillRect(x, y, w, 4, colour);

  // Label
  tft.setTextDatum(TL_DATUM);
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString(label, x + 10, y + 10);

  // Value
  tft.setFreeFont(&FreeSansBold24pt7b);
  tft.setTextColor(colour, C_CARD);
  char buf[16];
  if (value == 0.0 && !sensors.stale) {
    snprintf(buf, sizeof(buf), "--");
  } else if (sensors.stale) {
    snprintf(buf, sizeof(buf), "--");
  } else {
    snprintf(buf, sizeof(buf), "%.1f", value);
  }
  tft.drawString(buf, x + 10, y + 28);

  // Unit
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString(unit, x + 10, y + 58);
}

void draw_threshold_row(int y, const char* label, const char* value, uint16_t col) {
  tft.setTextDatum(TL_DATUM);
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(label, 10, y);
  tft.setTextColor(col, C_BG);
  tft.drawString(value, 10, y + 13);
}

void draw_status_bar() {
  int y = 270;
  tft.fillRect(0, y, 320, 30, C_CARD);

  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextDatum(TL_DATUM);

  // Temp status
  const char* t_status = sensor_status(sensors.temperature_c, 5.0, 30.0);
  uint16_t t_col = sensor_colour(sensors.temperature_c, 5.0, 30.0);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString("T:", 10, y + 8);
  tft.setTextColor(t_col, C_CARD);
  tft.drawString(t_status, 26, y + 8);

  // TDS status
  const char* td_status = tds_status(sensors.tds_ppm);
  uint16_t td_col = tds_colour(sensors.tds_ppm);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString("Filter:", 110, y + 8);
  tft.setTextColor(td_col, C_CARD);
  tft.drawString(td_status, 170, y + 8);

  // VOC status
  const char* v_status = voc_status(sensors.voc_index);
  uint16_t v_col = voc_colour(sensors.voc_index);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString("Air:", 230, y + 8);
  tft.setTextColor(v_col, C_CARD);
  tft.drawString(v_status, 260, y + 8);
}

void draw_page_dots() {
  int cx = 160;
  int y = 450;
  for (int i = 0; i < TOTAL_PAGES; i++) {
    uint16_t col = (i == current_page) ? C_PRIMARY : C_SUBTEXT;
    tft.fillCircle(cx - 8 + i * 16, y, 4, col);
  }
}

void draw_footer() {
  tft.setTextDatum(TC_DATUM);
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_BG);
  tft.drawString("A: Prev  |  B: Ack  |  C: Next", 160, 462);
}

void draw_loading_bar(int x, int y, int w, int h) {
  uint32_t start = millis();
  while (millis() - start < 2000) {
    int progress = map(millis() - start, 0, 2000, 0, w);
    tft.fillRect(x, y, progress, h, C_PRIMARY);
    delay(50);
  }
}

// ─────────────────────────────────────────────
// COLOUR & STATUS LOGIC
// ─────────────────────────────────────────────
uint16_t sensor_colour(float val, float lo, float hi) {
  if (sensors.stale) return C_SUBTEXT;
  if (val < lo || val > hi) return C_CRITICAL;
  if (val < lo + (hi - lo) * 0.15 || val > hi - (hi - lo) * 0.15) return C_WARNING;
  return C_PRIMARY;
}

uint16_t tds_colour(float tds) {
  if (sensors.stale) return C_SUBTEXT;
  if (tds > 350) return C_CRITICAL;
  if (tds > 200) return C_WARNING;
  return C_PRIMARY;
}

uint16_t voc_colour(float voc) {
  if (sensors.stale) return C_SUBTEXT;
  if (voc > 300) return C_CRITICAL;
  if (voc > 150) return C_WARNING;
  return C_PRIMARY;
}

const char* sensor_status(float val, float lo, float hi) {
  if (sensors.stale) return "??";
  if (val < lo)       return "LOW";
  if (val > hi)       return "HIGH";
  return "OK";
}

const char* tds_status(float tds) {
  if (sensors.stale) return "??";
  if (tds > 350)     return "REPLACE";
  if (tds > 200)     return "CHECK";
  return "OK";
}

const char* voc_status(float voc) {
  if (sensors.stale) return "??";
  if (voc > 300)    return "SPOILAGE";
  if (voc > 150)    return "STALE";
  return "FRESH";
}

// ─────────────────────────────────────────────
// ALERT OVERLAY
// ─────────────────────────────────────────────
void show_alert(const String& message, const String& severity) {
  alert_active  = true;
  alert_message = message;
  alert_colour  = (severity == "critical") ? C_CRITICAL : C_WARNING;

  // Full-screen alert overlay
  tft.fillScreen(C_CARD);
  tft.setTextDatum(TC_DATUM);
  tft.setFreeFont(&FreeSansBold18pt7b);
  tft.setTextColor(alert_colour, C_CARD);
  tft.drawString("ALERT", 160, 60);
  tft.setFreeFont(&FreeSans12pt7b);
  tft.setTextColor(C_TEXT, C_CARD);
  // Word-wrap simple message
  tft.drawString(message.c_str(), 160, 120);

  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_SUBTEXT, C_CARD);
  tft.drawString("Press B to acknowledge", 160, 400);

  Serial.printf("[ESP32] ALERT (%s): %s\n", severity.c_str(), message.c_str());
}

void show_drop_notification(const String& location, float drop_c) {
  // Brief toast notification at top
  tft.fillRect(0, 260, 320, 50, C_WARNING);
  tft.setTextDatum(TC_DATUM);
  tft.setFreeFont(&FreeSans12pt7b);
  tft.setTextColor(C_BG, C_WARNING);
  char buf[64];
  snprintf(buf, sizeof(buf), "TEMP DROP @ %s: %.1f°C", location.c_str(), drop_c);
  tft.drawString(buf, 160, 270);
  delay(4000);
  tft.fillRect(0, 260, 320, 50, C_BG);
  // Redraw current page underneath
  if (current_page == 0) draw_page_home();
  else draw_page_details();
}

// ─────────────────────────────────────────────
// AUDIO
// ─────────────────────────────────────────────
void tone_pulse(bool on) {
  if (on) {
    // Generate a short beep via LEDC PWM on the speaker pin
    ledcWrite(SPEAKER_CHANNEL, 180);  // ~70% duty cycle
    delay(80);
    ledcWrite(SPEAKER_CHANNEL, 0);
  }
}

// ─────────────────────────────────────────────
// BUTTON CALLBACKS
// ─────────────────────────────────────────────
void on_btn_page_prev() {
  current_page = (current_page + TOTAL_PAGES - 1) % TOTAL_PAGES;
  if (current_page == 0) draw_page_home();
  else draw_page_details();
}

void on_btn_page_next() {
  current_page = (current_page + 1) % TOTAL_PAGES;
  if (current_page == 0) draw_page_home();
  else draw_page_details();
}

void on_btn_acknowledge() {
  alert_active = false;
  digitalWrite(LED_ALERT1, LOW);
  digitalWrite(LED_ALERT2, LOW);
  ledcWrite(SPEAKER_CHANNEL, 0);
  // Send ACK back to Pico W via UART
  espSerial.println("{\"type\":\"ack\"}");
  if (current_page == 0) draw_page_home();
  else draw_page_details();
  Serial.println("[ESP32] Alert acknowledged");
}

// ─────────────────────────────────────────────
// TOUCH INPUT
// ─────────────────────────────────────────────
void handle_touch(int x, int y) {
  // Normalize to screen coordinates (landscape, touch is portrait orientation)
  int tx = map(x, 200, 3700, 0, 320);   // x = 200–3700 → 0–320
  int ty = map(y, 300, 3700, 0, 480);   // y = 300–3700 → 0–480

  // Left half of screen → prev page
  if (tx < 160) on_btn_page_prev();
  // Right half → next page
  else on_btn_page_next();

  Serial.printf("[ESP32] Touch at (%d, %d)\n", tx, ty);
}
