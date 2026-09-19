// shopswarm_splash/shopswarm_splash.ino
// ShopSwarm splash — VIEWE UEDX48480021-MD80ESP32 (2.1" 480x480 knob display)
//
// Hardware: ESP32-S3 N16R8, ST7701S panel (3-wire SPI + RGB), CST826 touch.
// This board is NOT the ILI9488/TFT_eSPI target that ../esp32_display.ino assumes —
// it needs ESP32_Display_Panel + LVGL, which is what this sketch uses.
//
// Requires: ESP32_Display_Panel >= 1.0.3, LVGL 8.4.0, esp32 Arduino core >= 3.0.7
// Board selection lives in esp_panel_board_supported_conf.h next to this file.

#include <Arduino.h>
#include <esp_display_panel.hpp>
#include <lvgl.h>
#include "lvgl_v8_port.h"

using namespace esp_panel::drivers;
using namespace esp_panel::board;

// Palette carried over from the TFT_eSPI build so the brand reads the same.
#define C_BG      0x0F1418   // Dark navy background
#define C_BRAND   0x00E07A   // Green
#define C_SUBTEXT 0x8AA0A8   // Muted grey-cyan

void setup() {
  Serial.begin(115200);
  Serial.println("\n[ShopSwarm] Initializing board");

  // ponytail: skipped the example's anti-tearing / bounce-buffer block —
  // it only matters for animation, and this splash is static. Add it back
  // (LVGL_PORT_AVOID_TEARING_MODE) if the sensor UI starts animating.
  Board *board = new Board();
  board->init();
  if (!board->begin()) {
    Serial.println("[ShopSwarm] board->begin() FAILED — wrong board macro?");
    return;
  }

  Serial.println("[ShopSwarm] Initializing LVGL");
  lvgl_port_init(board->getLCD(), board->getTouch());

  // LVGL APIs are not thread-safe; the port runs its own task.
  lvgl_port_lock(-1);

  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_hex(C_BG), 0);

  lv_obj_t *brand = lv_label_create(lv_scr_act());
  lv_label_set_text(brand, "ShopSwarm");
  lv_obj_set_style_text_font(brand, &lv_font_montserrat_30, 0);
  lv_obj_set_style_text_color(brand, lv_color_hex(C_BRAND), 0);
  lv_obj_align(brand, LV_ALIGN_CENTER, 0, -12);

  lv_obj_t *sub = lv_label_create(lv_scr_act());
  lv_label_set_text(sub, "Thermal Monitor v1.0");
  lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(sub, lv_color_hex(C_SUBTEXT), 0);
  lv_obj_align_to(sub, brand, LV_ALIGN_OUT_BOTTOM_MID, 0, 10);

  lvgl_port_unlock();

  Serial.println("[ShopSwarm] Splash up");
}

void loop() {
  delay(1000);
}
