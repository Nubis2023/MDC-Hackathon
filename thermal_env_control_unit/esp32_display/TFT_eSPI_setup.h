// Setup45 — ESP32-S3 VIEWE Smart Display (ILI9488 3.5" 480x320)
// Save to: ~/Arduino/libraries/TFT_eSPI/User_Setups/Setup45_ESP32_S3_VIEWE_ILI9488.h
// Then #define USER_SETUP_S45 before #include <TFT_eSPI.h> in your sketch.

#ifndef USER_SETUP_LOADED
#define USER_SETUP_LOADED

#define ILI9488_DRIVER   1
#define TFT_WIDTH  320
#define TFT_HEIGHT 480

// ── Parallel 8-bit interface (ESP32 native bus) ──────────────────────
// ESP32 → ILI9488 data bus on GPIO 38–47 (upper half of the bus)
#define ESP32_PARALLEL

// Control pins
#define TFT_CS    5    // Chip Select
#define TFT_DC    6    // Data / Command
#define TFT_RST   7    // Reset
#define TFT_WR    8    // Write strobe
#define TFT_RD    9    // Read strobe (set to -1 if not used)

// Data bus GPIO pins (D0 = LSB)
#define TFT_D0   38
#define TFT_D1   39
#define TFT_D2   40
#define TFT_D3   41
#define TFT_D4   42
#define TFT_D5   45
#define TFT_D6   46
#define TFT_D7   47

// ── SPI touch controller (XPT2046) ───────────────────────────────────
#define TOUCH_CS  40
#define TOUCH_IRQ 38

// ── Fonts ─────────────────────────────────────────────────────────────
#define LOAD_GLCD   1
#define LOAD_FONT2  1
#define LOAD_FONT4  1
#define LOAD_FONT7  1
#define SMOOTH_FONT 1

// ── SPI speed ────────────────────────────────────────────────────────
#define SPI_FREQUENCY       40000000
#define SPI_READ_FREQUENCY   6000000

#endif
