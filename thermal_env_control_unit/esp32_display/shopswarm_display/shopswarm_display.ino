// shopswarm_display/shopswarm_display.ino
// ShopSwarm — VIEWE UEDX48480021-MD80ESP32 (2.1" 480x480 knob display)
//
// Hardware: ESP32-S3 N16R8, ST7701S panel (3-wire SPI + RGB16), CST820 touch.
// This is NOT the ILI9488/TFT_eSPI target that ../esp32_display.ino assumes;
// that sketch cannot run on this board at all. See CHANGES.md.
//
// Requires: ESP32_Display_Panel >= 1.0.3, LVGL 8.4.0, ArduinoJson 7,
//           esp32 Arduino core >= 3.0.7.
// Board selection lives in esp_panel_board_supported_conf.h next to this file.
//
// ── Pico W link ──────────────────────────────────────────────────────
// The RGB panel consumes most of the GPIO bank. Free pins on this board are
// 4, 5, 6, 43, 44 (19/20 are native USB, 26-37 are flash + OPI PSRAM).
// `Serial` is native USB CDC here, which leaves 43/44 available for the Pico —
// so the wiring in SETUP.md still holds:
//     Pico GP8 (TX) -> ESP32 GPIO44 (RX)
//     Pico GP9 (RX) <- ESP32 GPIO43 (TX)
// ponytail: UART1 on those pins rather than UART0, so ROM boot chatter on
// UART0 cannot be mistaken for a Pico frame.

#include <Arduino.h>
#include <esp_display_panel.hpp>
#include <lvgl.h>
#include <ArduinoJson.h>
#include "lvgl_v8_port.h"

using namespace esp_panel::drivers;
using namespace esp_panel::board;

// ─────────────────────────────────────────────
// PICO UART LINK
// ─────────────────────────────────────────────
#define PICO_UART_RX 44
#define PICO_UART_TX 43
#define PICO_BAUD    115200

HardwareSerial picoSerial(1);

// ─────────────────────────────────────────────
// LAYOUT
// The panel is 480x480 in a round bezel, so everything lives inside the
// inscribed square (480 / sqrt(2) = 339). 330 leaves a little margin.
// ─────────────────────────────────────────────
#define SAFE_BOX   330
#define TILE_W     155
#define TILE_H     120

// ─────────────────────────────────────────────
// COLOUR PALETTE (carried over from the TFT_eSPI build)
// ─────────────────────────────────────────────
#define C_BG        0x0F1418
#define C_CARD      0x1A2430
#define C_PRIMARY   0x00E07A
#define C_WARNING   0xFFA726
#define C_CRITICAL  0xFF5252
#define C_TEXT      0xFFFFFF
#define C_SUBTEXT   0x8AA0A8

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
struct SensorState {
  float temperature_c = 0.0f;
  float humidity_pct  = 0.0f;
  float tds_ppm       = 0.0f;
  float voc_index     = 0.0f;
  String timestamp    = "";
  bool  valid         = false;   // true once a readings frame has landed
  unsigned long last_update_ms = 0;
};

// Defaults mirror AlertManager.__init__ in pico_w_firmware/main.py. The Pico
// pushes a {"type":"config"} frame at boot and whenever GET /config moves them,
// so these are only a placeholder until the link is up.
struct Thresholds {
  float temp_min = 5.0f,   temp_max = 30.0f;
  float hum_min  = 30.0f,  hum_max  = 80.0f;
  float tds_warn = 200.0f, tds_crit = 350.0f;
  float voc_warn = 150.0f, voc_crit = 300.0f;
  bool  from_pico = false;       // false while still showing defaults
};

static SensorState sensors;
static Thresholds  limits;

static const unsigned long STALE_AFTER_MS = 30000;
static bool stale_shown = true;

// ─────────────────────────────────────────────
// LVGL OBJECTS
// ─────────────────────────────────────────────
static lv_obj_t *scr_main;
static lv_obj_t *lbl_badge;
static lv_obj_t *tile_val[4];     // Temp, Humidity, TDS, VOC
static lv_obj_t *tile_accent[4];
static lv_obj_t *lbl_status;
static lv_obj_t *lbl_stamp;

static lv_obj_t *scr_limits;
static lv_obj_t *lbl_limit_rows;

static lv_obj_t *overlay_alert;   // NULL when no alert is showing
static lv_obj_t *lbl_alert_msg;

static uint8_t current_page = 0;  // 0 = readings, 1 = thresholds
static bool alert_active = false;

// ─────────────────────────────────────────────
// COLOUR / STATUS LOGIC
// Mirrors the Pico's evaluate(); thresholds now arrive from it rather than
// being hardcoded here.
// ─────────────────────────────────────────────
static uint32_t range_colour(float v, float lo, float hi) {
  if (!sensors.valid) return C_SUBTEXT;
  if (v < lo || v > hi) return C_CRITICAL;
  float band = (hi - lo) * 0.15f;
  if (v < lo + band || v > hi - band) return C_WARNING;
  return C_PRIMARY;
}

static uint32_t step_colour(float v, float warn, float crit) {
  if (!sensors.valid) return C_SUBTEXT;
  if (v > crit) return C_CRITICAL;
  if (v > warn) return C_WARNING;
  return C_PRIMARY;
}

static const char *range_status(float v, float lo, float hi) {
  if (!sensors.valid) return "??";
  if (v < lo) return "LOW";
  if (v > hi) return "HIGH";
  return "OK";
}

static const char *tds_status(float v) {
  if (!sensors.valid) return "??";
  if (v > limits.tds_crit) return "REPLACE";
  if (v > limits.tds_warn) return "CHECK";
  return "OK";
}

static const char *voc_status(float v) {
  if (!sensors.valid) return "??";
  if (v > limits.voc_crit) return "SPOILAGE";
  if (v > limits.voc_warn) return "STALE";
  return "FRESH";
}

// ─────────────────────────────────────────────
// UI CONSTRUCTION
// ─────────────────────────────────────────────
static lv_obj_t *make_tile(lv_obj_t *parent, const char *label,
                           const char *unit, int col, int row, int idx) {
  lv_obj_t *card = lv_obj_create(parent);
  lv_obj_set_size(card, TILE_W, TILE_H);
  lv_obj_set_pos(card, col * (TILE_W + 10), row * (TILE_H + 10));
  lv_obj_set_style_bg_color(card, lv_color_hex(C_CARD), 0);
  lv_obj_set_style_border_width(card, 0, 0);
  lv_obj_set_style_radius(card, 10, 0);
  lv_obj_set_style_pad_all(card, 8, 0);
  lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

  // Accent bar across the top, recoloured per reading severity
  lv_obj_t *accent = lv_obj_create(card);
  lv_obj_set_size(accent, TILE_W - 16, 4);
  lv_obj_align(accent, LV_ALIGN_TOP_MID, 0, -4);
  lv_obj_set_style_border_width(accent, 0, 0);
  lv_obj_set_style_radius(accent, 2, 0);
  lv_obj_set_style_bg_color(accent, lv_color_hex(C_SUBTEXT), 0);
  tile_accent[idx] = accent;

  lv_obj_t *cap = lv_label_create(card);
  lv_label_set_text(cap, label);
  lv_obj_set_style_text_font(cap, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(cap, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(cap, LV_ALIGN_TOP_LEFT, 0, 6);

  lv_obj_t *val = lv_label_create(card);
  lv_label_set_text(val, "--");
  lv_obj_set_style_text_font(val, &lv_font_montserrat_34, 0);
  lv_obj_set_style_text_color(val, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(val, LV_ALIGN_LEFT_MID, 0, 6);
  tile_val[idx] = val;

  lv_obj_t *u = lv_label_create(card);
  lv_label_set_text(u, unit);
  lv_obj_set_style_text_font(u, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(u, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(u, LV_ALIGN_BOTTOM_LEFT, 0, 0);

  return card;
}

static void page_tapped(lv_event_t *e);

static void build_main_page() {
  scr_main = lv_obj_create(NULL);
  lv_obj_set_style_bg_color(scr_main, lv_color_hex(C_BG), 0);
  lv_obj_clear_flag(scr_main, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_event_cb(scr_main, page_tapped, LV_EVENT_CLICKED, NULL);

  lv_obj_t *brand = lv_label_create(scr_main);
  lv_label_set_text(brand, "ShopSwarm");
  lv_obj_set_style_text_font(brand, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(brand, lv_color_hex(C_PRIMARY), 0);
  lv_obj_align(brand, LV_ALIGN_TOP_MID, 0, 74);

  lbl_badge = lv_label_create(scr_main);
  lv_label_set_text(lbl_badge, "OFFLINE");
  lv_obj_set_style_text_font(lbl_badge, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(lbl_badge, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(lbl_badge, LV_ALIGN_TOP_MID, 0, 98);

  // 2x2 grid of readings, centred inside the round-safe box
  lv_obj_t *grid = lv_obj_create(scr_main);
  lv_obj_set_size(grid, TILE_W * 2 + 10, TILE_H * 2 + 10);
  lv_obj_align(grid, LV_ALIGN_CENTER, 0, 6);
  lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(grid, 0, 0);
  lv_obj_set_style_pad_all(grid, 0, 0);
  lv_obj_clear_flag(grid, LV_OBJ_FLAG_SCROLLABLE);

  make_tile(grid, "Temp",      "\xC2\xB0""C", 0, 0, 0);   // UTF-8 degree sign
  make_tile(grid, "Humidity",  "%",           1, 0, 1);
  make_tile(grid, "TDS",       "ppm",         0, 1, 2);
  make_tile(grid, "VOC Index", "",            1, 1, 3);

  lbl_status = lv_label_create(scr_main);
  lv_label_set_text(lbl_status, "T: ??   Filter: ??   Air: ??");
  lv_obj_set_style_text_font(lbl_status, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(lbl_status, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(lbl_status, LV_ALIGN_BOTTOM_MID, 0, -92);

  lbl_stamp = lv_label_create(scr_main);
  lv_label_set_text(lbl_stamp, "waiting for data");
  lv_obj_set_style_text_font(lbl_stamp, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(lbl_stamp, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(lbl_stamp, LV_ALIGN_BOTTOM_MID, 0, -70);
}

static void build_limits_page() {
  scr_limits = lv_obj_create(NULL);
  lv_obj_set_style_bg_color(scr_limits, lv_color_hex(C_BG), 0);
  lv_obj_clear_flag(scr_limits, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_event_cb(scr_limits, page_tapped, LV_EVENT_CLICKED, NULL);

  lv_obj_t *title = lv_label_create(scr_limits);
  lv_label_set_text(title, "Thresholds");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(title, lv_color_hex(C_TEXT), 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 90);

  lbl_limit_rows = lv_label_create(scr_limits);
  lv_label_set_text(lbl_limit_rows, "waiting for config");
  lv_obj_set_style_text_font(lbl_limit_rows, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(lbl_limit_rows, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_set_style_text_line_space(lbl_limit_rows, 8, 0);
  lv_obj_set_width(lbl_limit_rows, SAFE_BOX);
  lv_obj_set_style_text_align(lbl_limit_rows, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(lbl_limit_rows, LV_ALIGN_CENTER, 0, 0);
}

// ─────────────────────────────────────────────
// UI REFRESH  (caller must hold the LVGL lock)
// ─────────────────────────────────────────────
static void refresh_main_page() {
  char buf[32];
  const bool fresh = sensors.valid && !stale_shown;

  lv_label_set_text(lbl_badge, fresh ? "LIVE" : "OFFLINE");
  lv_obj_set_style_text_color(lbl_badge,
      lv_color_hex(fresh ? C_PRIMARY : C_SUBTEXT), 0);

  const float vals[4] = {sensors.temperature_c, sensors.humidity_pct,
                         sensors.tds_ppm, sensors.voc_index};
  const uint32_t cols[4] = {
      range_colour(sensors.temperature_c, limits.temp_min, limits.temp_max),
      range_colour(sensors.humidity_pct,  limits.hum_min,  limits.hum_max),
      step_colour(sensors.tds_ppm,  limits.tds_warn, limits.tds_crit),
      step_colour(sensors.voc_index, limits.voc_warn, limits.voc_crit),
  };

  for (int i = 0; i < 4; i++) {
    // Only a missing reading shows "--". A real 0.0 is a legitimate value and
    // must render as 0.0 — the old sketch could not tell the two apart.
    if (!sensors.valid) {
      lv_label_set_text(tile_val[i], "--");
    } else {
      snprintf(buf, sizeof(buf), "%.1f", vals[i]);
      lv_label_set_text(tile_val[i], buf);
    }
    lv_obj_set_style_text_color(tile_val[i], lv_color_hex(cols[i]), 0);
    lv_obj_set_style_bg_color(tile_accent[i], lv_color_hex(cols[i]), 0);
  }

  snprintf(buf, sizeof(buf), "T: %s   Filter: %s",
           range_status(sensors.temperature_c, limits.temp_min, limits.temp_max),
           tds_status(sensors.tds_ppm));
  lv_label_set_text_fmt(lbl_status, "%s   Air: %s", buf,
                        voc_status(sensors.voc_index));

  if (sensors.timestamp.length() > 0) {
    lv_label_set_text(lbl_stamp, sensors.timestamp.c_str());
  } else if (!sensors.valid) {
    lv_label_set_text(lbl_stamp, "waiting for data");
  }
}

static void refresh_limits_page() {
  lv_label_set_text_fmt(lbl_limit_rows,
      "Temp    %.0f - %.0f C\n"
      "Humidity  %.0f - %.0f %%\n"
      "TDS     < %.0f ok / > %.0f replace\n"
      "VOC     < %.0f ok / > %.0f spoilage\n"
      "\n%s",
      limits.temp_min, limits.temp_max,
      limits.hum_min,  limits.hum_max,
      limits.tds_warn, limits.tds_crit,
      limits.voc_warn, limits.voc_crit,
      limits.from_pico ? "from Pico /config" : "defaults - link down");
}

// ─────────────────────────────────────────────
// ALERT OVERLAY
// Tapping it acknowledges, which is the only ack path this board has:
// the knob display has no A/B/C buttons.
// ─────────────────────────────────────────────
static void send_ack() {
  picoSerial.println("{\"type\":\"ack\"}");
  Serial.println("[ShopSwarm] ACK sent to Pico");
}

static void alert_tapped(lv_event_t *e) {
  (void)e;
  alert_active = false;
  send_ack();
  if (overlay_alert) {
    lv_obj_del(overlay_alert);
    overlay_alert = NULL;
    lbl_alert_msg = NULL;
  }
}

static void show_alert(const char *message, const char *severity) {
  const bool critical = (severity && strcmp(severity, "critical") == 0);
  alert_active = true;

  if (overlay_alert) lv_obj_del(overlay_alert);

  overlay_alert = lv_obj_create(lv_layer_top());
  lv_obj_set_size(overlay_alert, 480, 480);
  lv_obj_center(overlay_alert);
  lv_obj_set_style_bg_color(overlay_alert, lv_color_hex(C_CARD), 0);
  lv_obj_set_style_border_width(overlay_alert, 6, 0);
  lv_obj_set_style_border_color(overlay_alert,
      lv_color_hex(critical ? C_CRITICAL : C_WARNING), 0);
  lv_obj_set_style_radius(overlay_alert, 240, 0);
  lv_obj_clear_flag(overlay_alert, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(overlay_alert, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(overlay_alert, alert_tapped, LV_EVENT_CLICKED, NULL);

  lv_obj_t *head = lv_label_create(overlay_alert);
  lv_label_set_text(head, critical ? "CRITICAL" : "WARNING");
  lv_obj_set_style_text_font(head, &lv_font_montserrat_28, 0);
  lv_obj_set_style_text_color(head,
      lv_color_hex(critical ? C_CRITICAL : C_WARNING), 0);
  lv_obj_align(head, LV_ALIGN_CENTER, 0, -80);

  lbl_alert_msg = lv_label_create(overlay_alert);
  lv_label_set_text(lbl_alert_msg, message ? message : "");
  lv_label_set_long_mode(lbl_alert_msg, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(lbl_alert_msg, SAFE_BOX);
  lv_obj_set_style_text_align(lbl_alert_msg, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(lbl_alert_msg, &lv_font_montserrat_18, 0);
  lv_obj_set_style_text_color(lbl_alert_msg, lv_color_hex(C_TEXT), 0);
  lv_obj_align(lbl_alert_msg, LV_ALIGN_CENTER, 0, -10);

  lv_obj_t *hint = lv_label_create(overlay_alert);
  lv_label_set_text(hint, "tap to acknowledge");
  lv_obj_set_style_text_font(hint, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(hint, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(hint, LV_ALIGN_CENTER, 0, 90);
}

// A drop event is informational: a toast, not a modal.
static void show_drop_toast(const char *location, float drop_c) {
  lv_obj_t *toast = lv_obj_create(lv_layer_top());
  lv_obj_set_size(toast, SAFE_BOX, 64);
  lv_obj_align(toast, LV_ALIGN_CENTER, 0, 150);
  lv_obj_set_style_bg_color(toast, lv_color_hex(C_WARNING), 0);
  lv_obj_set_style_border_width(toast, 0, 0);
  lv_obj_set_style_radius(toast, 12, 0);
  lv_obj_clear_flag(toast, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *t = lv_label_create(toast);
  lv_label_set_text_fmt(t, "TEMP DROP @ %s\n%.1f C",
                        location ? location : "unknown", drop_c);
  lv_obj_set_style_text_align(t, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(t, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(t, lv_color_hex(C_BG), 0);
  lv_obj_center(t);

  // ponytail: self-deleting timer instead of the old blocking delay(4000),
  // which stalled the UART reader for four seconds every drop event.
  lv_timer_t *kill = lv_timer_create([](lv_timer_t *tm) {
    lv_obj_t *obj = (lv_obj_t *)tm->user_data;
    if (obj) lv_obj_del(obj);
    lv_timer_del(tm);
  }, 4000, toast);
  lv_timer_set_repeat_count(kill, 1);
}

// ─────────────────────────────────────────────
// PAGE SWITCHING
// ─────────────────────────────────────────────
static void page_tapped(lv_event_t *e) {
  (void)e;
  current_page = (current_page + 1) % 2;
  if (current_page == 0) {
    refresh_main_page();
    lv_scr_load(scr_main);
  } else {
    refresh_limits_page();
    lv_scr_load(scr_limits);
  }
}

// ─────────────────────────────────────────────
// PICO MESSAGE HANDLING
//
// Uses ArduinoJson rather than substring scanning. The old hand-rolled parser
// caused two defects this replaces:
//   - every frame overwrote all four sensor floats, so a drop/alert frame
//     (which carries none of them) blanked the readings;
//   - the timestamp offset was off by one, so it never displayed at all.
// ─────────────────────────────────────────────
static void handle_pico_line(const String &line) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    Serial.printf("[ShopSwarm] Bad JSON from Pico: %s\n", err.c_str());
    return;
  }

  const char *type = doc["type"] | "";

  if (strcmp(type, "readings") == 0) {
    // Only a readings frame may touch the readings.
    sensors.temperature_c = doc["temperature_c"] | 0.0f;
    sensors.humidity_pct  = doc["humidity_pct"]  | 0.0f;
    sensors.tds_ppm       = doc["tds_ppm"]       | 0.0f;
    sensors.voc_index     = doc["voc_index"]     | 0.0f;
    sensors.timestamp     = (const char *)(doc["timestamp"] | "");
    sensors.valid         = true;
    sensors.last_update_ms = millis();
    stale_shown = false;

    lvgl_port_lock(-1);
    if (current_page == 0) refresh_main_page();
    lvgl_port_unlock();

  } else if (strcmp(type, "config") == 0) {
    limits.temp_min  = doc["temp_min"]     | limits.temp_min;
    limits.temp_max  = doc["temp_max"]     | limits.temp_max;
    limits.hum_min   = doc["humidity_min"] | limits.hum_min;
    limits.hum_max   = doc["humidity_max"] | limits.hum_max;
    limits.tds_warn  = doc["tds_warning"]  | limits.tds_warn;
    limits.tds_crit  = doc["tds_critical"] | limits.tds_crit;
    limits.voc_warn  = doc["voc_warning"]  | limits.voc_warn;
    limits.voc_crit  = doc["voc_critical"] | limits.voc_crit;
    limits.from_pico = true;
    Serial.println("[ShopSwarm] Thresholds updated from Pico");

    lvgl_port_lock(-1);
    if (current_page == 1) refresh_limits_page();
    else                   refresh_main_page();   // colours depend on limits
    lvgl_port_unlock();

  } else if (strcmp(type, "alert") == 0) {
    const char *msg = doc["message"]  | "";
    const char *sev = doc["severity"] | "warning";
    Serial.printf("[ShopSwarm] ALERT (%s): %s\n", sev, msg);
    lvgl_port_lock(-1);
    show_alert(msg, sev);
    lvgl_port_unlock();

  } else if (strcmp(type, "drop") == 0) {
    // The Pico nests this payload under "data"; read it properly rather than
    // relying on a substring hit at the top level.
    JsonObjectConst d = doc["data"];
    const char *loc = d["location"] | "unknown";
    float drop_c    = d["drop_c"]   | 0.0f;
    Serial.printf("[ShopSwarm] Temp drop @ %s: %.1f\n", loc, drop_c);
    lvgl_port_lock(-1);
    show_drop_toast(loc, drop_c);
    lvgl_port_unlock();

  } else {
    Serial.printf("[ShopSwarm] Unknown frame type: %s\n", type);
  }
}

static String rx_line;
static const size_t RX_LINE_MAX = 512;

static void poll_pico() {
  while (picoSerial.available()) {
    char c = (char)picoSerial.read();
    if (c == '\n') {
      rx_line.trim();
      if (rx_line.length() > 0) handle_pico_line(rx_line);
      rx_line = "";
    } else if (c != '\r') {
      if (rx_line.length() < RX_LINE_MAX) {
        rx_line += c;
      } else {
        // Newline-less garbage: drop it rather than grow without bound.
        rx_line = "";
      }
    }
  }
}

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[ShopSwarm] Initializing board");

  picoSerial.begin(PICO_BAUD, SERIAL_8N1, PICO_UART_RX, PICO_UART_TX);

  Board *board = new Board();
  board->init();
  if (!board->begin()) {
    Serial.println("[ShopSwarm] board->begin() FAILED - wrong board macro?");
    return;
  }

  Serial.println("[ShopSwarm] Initializing LVGL");
  lvgl_port_init(board->getLCD(), board->getTouch());

  lvgl_port_lock(-1);

  // Splash, shown until the first frame arrives.
  lv_obj_t *splash = lv_scr_act();
  lv_obj_set_style_bg_color(splash, lv_color_hex(C_BG), 0);
  lv_obj_t *brand = lv_label_create(splash);
  lv_label_set_text(brand, "ShopSwarm");
  lv_obj_set_style_text_font(brand, &lv_font_montserrat_40, 0);
  lv_obj_set_style_text_color(brand, lv_color_hex(C_PRIMARY), 0);
  lv_obj_align(brand, LV_ALIGN_CENTER, 0, -16);
  lv_obj_t *sub = lv_label_create(splash);
  lv_label_set_text(sub, "Thermal Monitor v1.0");
  lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(sub, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align(sub, LV_ALIGN_CENTER, 0, 26);

  build_main_page();
  build_limits_page();

  lvgl_port_unlock();

  Serial.println("[ShopSwarm] Waiting for Pico on GPIO44/43");
}

// ─────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────
void loop() {
  static bool splash_cleared = false;
  static unsigned long boot_ms = millis();

  poll_pico();

  // Leave the splash up for 2 s, then show the (empty) readings page.
  if (!splash_cleared && millis() - boot_ms > 2000) {
    splash_cleared = true;
    lvgl_port_lock(-1);
    refresh_main_page();
    lv_scr_load(scr_main);
    lvgl_port_unlock();
  }

  // Mark the link stale if the Pico goes quiet.
  if (sensors.valid && !stale_shown &&
      millis() - sensors.last_update_ms > STALE_AFTER_MS) {
    stale_shown = true;
    Serial.println("[ShopSwarm] Pico link stale");
    lvgl_port_lock(-1);
    if (current_page == 0) refresh_main_page();
    lvgl_port_unlock();
  }

  delay(10);
}
