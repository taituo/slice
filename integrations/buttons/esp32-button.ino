// Call-me-back button for ESP32 (Arduino core). One GPIO button: short press = call me back,
// double press = my usual order, hold 1.5 s = cancel. Fill in Wi-Fi, PRESS_URL and BUTTON_TOKEN
// from POST /v1/me/buttons. The device sleeps between presses.
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* PRESS_URL = "https://your-api-host/v1/buttons/btn_xxx/press";
const char* BUTTON_TOKEN = "sk_btn_xxx";
const int BUTTON_PIN = 0;       // boot button on most dev boards; wire yours to GND
const int LED_PIN = 2;

void send(const char* press) {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  }
  WiFiClientSecure client;
  client.setInsecure();  // pin the API's certificate in production
  HTTPClient http;
  http.begin(client, PRESS_URL);
  http.addHeader("content-type", "application/json");
  http.addHeader("x-button-token", BUTTON_TOKEN);
  int code = http.POST(String("{\"press\":\"") + press + "\"}");
  http.end();
  // 202 = accepted: blink once; anything else: blink fast three times
  int blinks = code == 202 ? 1 : 3;
  for (int i = 0; i < blinks; i++) { digitalWrite(LED_PIN, HIGH); delay(code == 202 ? 400 : 120); digitalWrite(LED_PIN, LOW); delay(120); }
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  if (digitalRead(BUTTON_PIN) == HIGH) return;
  unsigned long down = millis();
  while (digitalRead(BUTTON_PIN) == LOW) delay(10);
  unsigned long held = millis() - down;
  if (held > 1500) { send("long"); return; }
  // wait briefly for a second click
  unsigned long up = millis();
  while (millis() - up < 400) {
    if (digitalRead(BUTTON_PIN) == LOW) {
      while (digitalRead(BUTTON_PIN) == LOW) delay(10);
      send("double");
      return;
    }
    delay(10);
  }
  send("single");
}
