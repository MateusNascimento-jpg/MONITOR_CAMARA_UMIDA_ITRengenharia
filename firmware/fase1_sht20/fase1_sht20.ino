/*
 * ITR Monitor Ambiental — Fase 1
 * Scanner I2C + leitura do SHT20 no monitor Serial (sem bibliotecas externas)
 *
 * Placa: "ESP32 Dev Module"  |  Monitor Serial: 115200 baud
 * Ligação: SHT20 e OLED no 3V3 do ESP32, SDA = GPIO21, SCL = GPIO22
 */
#include <Wire.h>

#define PINO_SDA   21
#define PINO_SCL   22
#define SHT20_ADDR 0x40

// Comandos do SHT20 (datasheet SHT2x)
#define CMD_TEMP_NOHOLD 0xF3   // medir temperatura (sem segurar o barramento)
#define CMD_UMID_NOHOLD 0xF5   // medir umidade (sem segurar o barramento)
#define CMD_SOFT_RESET  0xFE

const unsigned long INTERVALO_MS = 2000;
unsigned long ultimaLeitura = 0;

// CRC-8 do SHT2x: polinômio x^8 + x^5 + x^4 + 1 (0x31), valor inicial 0x00
uint8_t crc8(const uint8_t *dados, uint8_t len) {
  uint8_t crc = 0x00;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= dados[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

// Envia o comando, espera a conversão e lê 2 bytes de dado + 1 de CRC
bool lerBruto(uint8_t comando, uint16_t esperaMs, uint16_t &bruto) {
  Wire.beginTransmission(SHT20_ADDR);
  Wire.write(comando);
  if (Wire.endTransmission() != 0) return false;   // sensor não respondeu

  delay(esperaMs);

  if (Wire.requestFrom(SHT20_ADDR, 3) != 3) return false;
  uint8_t buf[3];
  for (int i = 0; i < 3; i++) buf[i] = Wire.read();

  if (crc8(buf, 2) != buf[2]) return false;         // dado corrompido no fio

  bruto = (((uint16_t)buf[0] << 8) | buf[1]) & 0xFFFC; // zera os 2 bits de status
  return true;
}

bool lerTemperatura(float &tempC) {
  uint16_t s;
  if (!lerBruto(CMD_TEMP_NOHOLD, 90, s)) return false;  // máx. 85 ms (14 bits)
  tempC = -46.85f + 175.72f * (float)s / 65536.0f;
  return true;
}

bool lerUmidade(float &umid) {
  uint16_t s;
  if (!lerBruto(CMD_UMID_NOHOLD, 35, s)) return false;  // máx. 29 ms (12 bits)
  umid = -6.0f + 125.0f * (float)s / 65536.0f;
  return true;
}

void scannerI2C() {
  Serial.println("\n--- Scanner I2C ---");
  int encontrados = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("Dispositivo em 0x%02X", addr);
      if (addr == 0x40) Serial.print("  <- SHT20");
      if (addr == 0x3C || addr == 0x3D) Serial.print("  <- OLED SSD1306");
      Serial.println();
      encontrados++;
    }
  }
  if (encontrados == 0) {
    Serial.println("Nenhum dispositivo encontrado.");
    Serial.println("Confira VCC/GND e tente inverter os fios branco e amarelo.");
  }
  Serial.println("-------------------\n");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ITR Monitor Ambiental - Fase 1 (SHT20)");

  Wire.begin(PINO_SDA, PINO_SCL);
  Wire.setClock(100000);   // 100 kHz: mais tolerante ao cabo longo da sonda

  scannerI2C();

  // Reset por software do sensor
  Wire.beginTransmission(SHT20_ADDR);
  Wire.write(CMD_SOFT_RESET);
  Wire.endTransmission();
  delay(20);
}

void loop() {
  if (millis() - ultimaLeitura < INTERVALO_MS) return;
  ultimaLeitura = millis();

  float t, u;
  bool okT = lerTemperatura(t);
  bool okU = lerUmidade(u);

  if (okT && okU) {
    Serial.printf("Temperatura: %.2f °C | Umidade: %.1f %%\n", t, u);
  } else {
    Serial.printf("Falha na leitura (temp:%s umid:%s)\n",
                  okT ? "ok" : "ERRO", okU ? "ok" : "ERRO");
  }
}
