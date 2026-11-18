/*
 * ITR Monitor Ambiental — Fase 2 (local, sem Wi-Fi)
 * SHT4x (0x44) + OLED SSD1306 0.96" 128x64 (0x3C) + LEDs de estado
 *
 * Placa: "ESP32 Dev Module" | Monitor Serial: 115200
 * Bibliotecas (Gerenciador de Bibliotecas): "Adafruit SSD1306" + "Adafruit GFX Library"
 *
 * Ligações:
 *   I2C (SHT4x + OLED): 3V3, GND, SDA = GPIO21, SCL = GPIO22
 *   LED Verde:    GPIO25 -> resistor 220/330 Ω -> LED (+) -> LED (-) -> GND
 *   LED Vermelho: GPIO26 -> resistor 220/330 Ω -> LED (+) -> LED (-) -> GND
 *   LED Amarelo:  GPIO27 -> resistor 220/330 Ω -> LED (+) -> LED (-) -> GND
 *
 * LEDs:
 *   Verde               = ÓTIMO ou BOM
 *   Amarelo             = MÉDIO
 *   Amarelo + Vermelho  = RUIM
 *   Vermelho            = ALERTA
 *   Vermelho piscando   = ERRO (sensor sem resposta por 3 leituras seguidas)
 *
 * O alarme sonoro fica só no dashboard (sem buzzer no hardware).
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---- Pinos -----------------------------------------------------------------
#define PINO_SDA          21
#define PINO_SCL          22
#define PINO_LED_VERDE    25
#define PINO_LED_VERMELHO 26
#define PINO_LED_AMARELO  27

// ---- I2C -------------------------------------------------------------------
// 50 kHz: mais tolerante ao cabo longo da sonda que os 100 kHz padrão, e a tela
// atualiza em ~0,2 s (a 10 kHz levava ~1 s travando o ESP32).
// Se aparecerem falhas de leitura no Serial, teste 20000. Se continuar,
// o próximo passo é hardware: resistores de pull-up de 4,7 kΩ em SDA e SCL.
const uint32_t I2C_HZ = 50000;

#define SHT4X_ADDR 0x44
#define OLED_ADDR  0x3C

Adafruit_SSD1306 display(128, 64, &Wire, -1, I2C_HZ, I2C_HZ);

// ---- Tempos ----------------------------------------------------------------
const unsigned long INTERVALO_LEITURA_MS = 2000;
const unsigned long INTERVALO_PISCA_MS   = 500;
const uint8_t       FALHAS_PARA_ERRO     = 3;

// ---- Estados e limites -----------------------------------------------------
enum Estado : uint8_t { OTIMO = 0, BOM, MEDIO, RUIM, ALERTA, ERRO };

struct Faixa { float min, max; };
struct Limites {
  Faixa tOtimo, tBom, tMedio, tRuim;   // °C
  float uOtimo, uBom, uMedio, uRuim;   // % (mínimo de cada nível)
  float histT, histU;                  // histerese
};

// Padrão de fábrica — idênticos aos da API.
// Na fase do Wi-Fi, passam a ser atualizados pela resposta do servidor.
Limites lim = {
  {21.0f, 25.0f}, {20.0f, 26.0f}, {20.0f, 28.0f}, {20.0f, 30.0f},
  95.0f, 90.0f, 85.0f, 80.0f,
  0.3f, 1.0f
};

// ---- Variáveis de execução --------------------------------------------------
bool     oledOk        = false;
bool     temLeitura    = false;   // já houve ao menos uma leitura válida?
float    ultimaTemp    = 0;
float    ultimaUmid    = 0;
int      nivelTAnt     = -1;      // -1 = sem leitura anterior (sem histerese)
int      nivelUAnt     = -1;
uint8_t  falhasSeguidas = 0;
Estado   estadoAtual   = OTIMO;
bool     piscaLigado   = false;
unsigned long ultimaLeitura = 0;
unsigned long ultimoPisca   = 0;

// ---- Classificação (mesmas regras da API) ----------------------------------
// Temperatura: ÓTIMO é [min, max] inclusivo; BOM/MÉDIO/RUIM são [min, max).
uint8_t nivelTemp(float t) {
  if (t >= lim.tOtimo.min && t <= lim.tOtimo.max) return OTIMO;
  if (t >= lim.tBom.min   && t <  lim.tBom.max)   return BOM;
  if (t >= lim.tMedio.min && t <  lim.tMedio.max) return MEDIO;
  if (t >= lim.tRuim.min  && t <  lim.tRuim.max)  return RUIM;
  return ALERTA;
}

uint8_t nivelUmid(float u) {
  if (u >= lim.uOtimo) return OTIMO;
  if (u >= lim.uBom)   return BOM;
  if (u >= lim.uMedio) return MEDIO;
  if (u >= lim.uRuim)  return RUIM;
  return ALERTA;
}

// Piorar é imediato; melhorar exige o valor `margem` para dentro da faixa melhor.
uint8_t comHisterese(uint8_t (*fn)(float), float valor, float margem, int anterior) {
  uint8_t bruto = fn(valor);
  if (anterior < 0 || bruto >= anterior) return bruto;
  uint8_t a = fn(valor - margem);
  uint8_t b = fn(valor + margem);
  uint8_t pessimista = a > b ? a : b;
  uint8_t candidato  = bruto > pessimista ? bruto : pessimista;
  return candidato < (uint8_t)anterior ? candidato : (uint8_t)anterior;
}

const char* nomeEstado(Estado e) {
  switch (e) {
    case OTIMO:  return "OTIMO";
    case BOM:    return "BOM";
    case MEDIO:  return "MEDIO";
    case RUIM:   return "RUIM";
    case ALERTA: return "ALERTA";
    default:     return "ERRO";
  }
}

// ---- Sensor SHT4x -----------------------------------------------------------
uint8_t crc8Sht4x(const uint8_t *dados, uint8_t len) {
  uint8_t crc = 0xFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= dados[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

bool lerSht4x(float &tempC, float &umid) {
  Wire.beginTransmission(SHT4X_ADDR);
  Wire.write(0xFD);                       // medição de alta precisão
  if (Wire.endTransmission() != 0) return false;

  delay(10);                              // conversão: máx. ~8,3 ms

  if (Wire.requestFrom(SHT4X_ADDR, 6) != 6) return false;
  uint8_t buf[6];
  for (int i = 0; i < 6; i++) buf[i] = Wire.read();

  if (crc8Sht4x(buf, 2) != buf[2] || crc8Sht4x(buf + 3, 2) != buf[5]) return false;

  uint16_t rawT = ((uint16_t)buf[0] << 8) | buf[1];
  uint16_t rawU = ((uint16_t)buf[3] << 8) | buf[4];

  tempC = -45.0f + 175.0f * (float)rawT / 65535.0f;
  umid  =  -6.0f + 125.0f * (float)rawU / 65535.0f;
  if (umid < 0.0f)   umid = 0.0f;
  if (umid > 100.0f) umid = 100.0f;
  return true;
}

// ---- Saídas ------------------------------------------------------------------
void atualizarLeds() {
  bool verde    = (estadoAtual == OTIMO || estadoAtual == BOM);
  bool amarelo  = (estadoAtual == MEDIO || estadoAtual == RUIM);
  bool vermelho = (estadoAtual == RUIM  || estadoAtual == ALERTA) ||
                  (estadoAtual == ERRO  && piscaLigado);
  digitalWrite(PINO_LED_VERDE,    verde    ? HIGH : LOW);
  digitalWrite(PINO_LED_AMARELO,  amarelo  ? HIGH : LOW);
  digitalWrite(PINO_LED_VERMELHO, vermelho ? HIGH : LOW);
}

void textoCentralizado(const char *txt, uint8_t tamanho, int16_t y) {
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(tamanho);
  display.getTextBounds(txt, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((128 - (int16_t)w) / 2, y);
  display.print(txt);
}

void desenharTela() {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Faixa amarela (linhas 0–15): status
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("ITR | STATUS: ");
  display.print(temLeitura || estadoAtual == ERRO ? nomeEstado(estadoAtual) : "...");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  // Faixa azul: valores ou mensagem
  if (estadoAtual == ERRO) {
    textoCentralizado("ERRO", 2, 20);
    textoCentralizado("Sensor sem resposta", 1, 44);
  } else if (!temLeitura) {
    textoCentralizado("Aguardando sensor", 1, 34);
  } else {
    display.setTextSize(1);
    display.setCursor(0, 18);
    display.print("TEMP:");
    display.setTextSize(2);
    display.setCursor(38, 16);
    display.printf("%.1f", ultimaTemp);
    display.setTextSize(1);
    display.print(" C");

    display.setTextSize(1);
    display.setCursor(0, 44);
    display.print("UMID:");
    display.setTextSize(2);
    display.setCursor(38, 42);
    display.printf("%.1f", ultimaUmid);
    display.setTextSize(1);
    display.print(" %");
  }
  display.display();
}

// ---- Ciclo de leitura --------------------------------------------------------
void cicloDeLeitura() {
  float t, u;
  if (lerSht4x(t, u)) {
    falhasSeguidas = 0;
    temLeitura = true;
    ultimaTemp = t;
    ultimaUmid = u;

    uint8_t nt = comHisterese(nivelTemp, t, lim.histT, nivelTAnt);
    uint8_t nu = comHisterese(nivelUmid, u, lim.histU, nivelUAnt);
    nivelTAnt = nt;
    nivelUAnt = nu;
    estadoAtual = (Estado)(nt > nu ? nt : nu);

    Serial.printf("Temp: %.2f C | Umid: %.1f %% | T:%s U:%s | Estado: %s\n",
                  t, u, nomeEstado((Estado)nt), nomeEstado((Estado)nu), nomeEstado(estadoAtual));
  } else {
    if (falhasSeguidas < 255) falhasSeguidas++;
    Serial.printf("Falha na leitura do SHT4x (%u seguida%s)\n",
                  falhasSeguidas, falhasSeguidas > 1 ? "s" : "");
    // Uma falha isolada (ruído no cabo) não muda nada: mantém o último estado e valores.
    if (falhasSeguidas >= FALHAS_PARA_ERRO) {
      estadoAtual = ERRO;
      nivelTAnt = -1;   // ao voltar, classifica do zero
      nivelUAnt = -1;
    }
  }
  atualizarLeds();
  desenharTela();
}

// ---- Arduino ----------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ITR Monitor Ambiental - Fase 2 (SHT4x + OLED + LEDs)");

  pinMode(PINO_LED_VERDE, OUTPUT);
  pinMode(PINO_LED_AMARELO, OUTPUT);
  pinMode(PINO_LED_VERMELHO, OUTPUT);

  // Teste dos LEDs ao ligar: acendem em sequência
  const uint8_t leds[] = {PINO_LED_VERDE, PINO_LED_AMARELO, PINO_LED_VERMELHO};
  for (uint8_t pino : leds) { digitalWrite(pino, HIGH); delay(250); }
  delay(250);
  for (uint8_t pino : leds) digitalWrite(pino, LOW);

  Wire.begin(PINO_SDA, PINO_SCL);
  Wire.setClock(I2C_HZ);

  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR, true, false);
  if (!oledOk) Serial.println("Falha ao iniciar o OLED em 0x3C (seguindo só com Serial e LEDs).");

  desenharTela();          // mostra "Aguardando sensor"
  cicloDeLeitura();        // primeira leitura imediata
  ultimaLeitura = millis();
}

void loop() {
  unsigned long agora = millis();

  // Pisca o vermelho no estado ERRO (independente das leituras)
  if (agora - ultimoPisca >= INTERVALO_PISCA_MS) {
    ultimoPisca = agora;
    piscaLigado = !piscaLigado;
    if (estadoAtual == ERRO) atualizarLeds();
  }

  if (agora - ultimaLeitura >= INTERVALO_LEITURA_MS) {
    ultimaLeitura = agora;
    cicloDeLeitura();
  }
}
