/*
 * ITR Monitor Ambiental — Fase 3 (Wi-Fi + envio para a API)
 * SHT4x (0x44) + OLED SSD1306 128x64 (0x3C) + LEDs de estado + HTTPS
 *
 * Placa: "ESP32 Dev Module" | Monitor Serial: 115200
 * Bibliotecas (Gerenciador de Bibliotecas):
 *   - "Adafruit SSD1306" + "Adafruit GFX Library"
 *   - "ArduinoJson" (Benoit Blanchon, versão 7)
 *
 * Arquivos desta pasta (abrem como abas na Arduino IDE):
 *   fase3_wifi.ino   este código
 *   segredos.h       Wi-Fi e API_KEY (é seu: não vai para o GitHub)
 *   certificados.h   raízes públicas do Let's Encrypt (HTTPS verificado)
 *
 * Ligações:
 *   I2C (SHT4x + OLED): 3V3, GND, SDA = GPIO21, SCL = GPIO22
 *   LED Verde GPIO25 | LED Vermelho GPIO26 | LED Amarelo GPIO27 (resistor 220/330 Ω)
 *   Buzzer: (+) GPIO14, (-) GND
 *   Botão silenciar: GPIO13 e GND (pull-up interno, sem resistor)
 *
 * Buzzer/botão:
 *   ALERTA → melodia de alarme em loop (buzzer passivo) ou bipes (ativo).
 *   Botão → silencia até sair do alerta;
 *   se entrar em alerta de novo, volta a tocar. Fora do alerta, o botão dá
 *   um bipe curto de teste. Erro do sensor não toca (só o vermelho pisca).
 *
 * LEDs = estado da CÂMARA:
 *   Verde = ÓTIMO/BOM | Amarelo = MÉDIO | Amarelo+Vermelho = RUIM
 *   Vermelho = ALERTA | Vermelho piscando = ERRO no sensor
 * Status da REDE fica no canto superior direito do OLED:
 *   "NET" ok | "OFF" sem Wi-Fi | "API" Wi-Fi ok mas servidor não respondeu | "KEY" chave recusada
 *
 * Envio: a cada 10 min e imediatamente quando o estado muda.
 * Sem rede: guarda até 24 h de leituras (com horário do NTP) e reenvia ao voltar.
 * Limites: vêm na resposta da API e ficam salvos na memória do ESP32.
 */
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include <math.h>
#include <esp_system.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "segredos.h"
#include "certificados.h"

// ---- Pinos -----------------------------------------------------------------
#define PINO_SDA          21
#define PINO_SCL          22
#define PINO_LED_VERDE    25
#define PINO_LED_VERMELHO 26
#define PINO_LED_AMARELO  27
#define PINO_BUZZER       14
#define PINO_BOTAO        13

// Buzzer PASSIVO (padrão) toca a melodia de alarme — o ESP32 gera cada nota.
// Buzzer ATIVO só tem um tom fixo: se o seu apitar contínuo sozinho quando ligado
// ao 3,3 V, troque para true e o alarme vira bipes (200 ms a cada 1 s).
const bool BUZZER_ATIVO = false;
const uint16_t FREQ_BIPE_TESTE = 2000;   // Hz
const uint8_t  CANAL_BUZZER    = 0;      // canal PWM (LEDC) usado pelo buzzer passivo

// Melodia de alarme (original): arpejo subindo, repetido enquanto durar o ALERTA.
// hz = 0 é pausa. Ciclo de ~2,4 s.
struct Nota { uint16_t hz; uint16_t ms; };
const Nota MELODIA_ALARME[] = {
  {1047, 120}, {0, 40}, {1047, 120}, {0, 40}, {1319, 120}, {0, 40}, {1568, 260}, {0, 200},
  {1568, 120}, {0, 40}, {1319, 120}, {0, 40}, {1568, 260}, {0, 700}
};
const uint8_t TAM_MELODIA = sizeof(MELODIA_ALARME) / sizeof(MELODIA_ALARME[0]);

// ---- I2C -------------------------------------------------------------------
// Se aparecerem falhas de leitura no Serial, teste 20000 (e depois pull-ups de 4,7 kΩ).
const uint32_t I2C_HZ = 50000;
#define SHT4X_ADDR 0x44
#define OLED_ADDR  0x3C
Adafruit_SSD1306 display(128, 64, &Wire, -1, I2C_HZ, I2C_HZ);

// ---- Wi-Fi -----------------------------------------------------------------
// Potência de transmissão. Menor = pico de corrente menor (evita "Brownout" com
// alimentação fraca), porém menos alcance. Opções: WIFI_POWER_19_5dBm (padrão do
// ESP32), WIFI_POWER_15dBm, WIFI_POWER_11dBm, WIFI_POWER_8_5dBm.
const wifi_power_t POTENCIA_WIFI = WIFI_POWER_11dBm;

// ---- Identificação e tempos -------------------------------------------------
const char*         DEVICE_ID              = "camara-01";
const unsigned long INTERVALO_LEITURA_MS   = 2000;
const unsigned long INTERVALO_ENVIO_MS     = 10UL * 60UL * 1000UL;  // 10 min
const unsigned long INTERVALO_PISCA_MS     = 500;
const unsigned long INTERVALO_FILA_MS      = 3000;    // entre itens da fila
const unsigned long ESPERA_APOS_FALHA_MS   = 60000;   // pausa após falha de envio
const unsigned long RECONEXAO_WIFI_MS      = 30000;
const uint8_t       FALHAS_PARA_ERRO       = 3;
const uint16_t      TAM_FILA               = 144;     // 24 h de leituras de 10 min
const time_t        EPOCH_MINIMO           = 1700000000;  // relógio já sincronizado?

// ---- Estados e limites -----------------------------------------------------
enum Estado : uint8_t { OTIMO = 0, BOM, MEDIO, RUIM, ALERTA, ERRO };

struct Faixa { float min, max; };
struct Limites {
  Faixa tOtimo, tBom, tMedio, tRuim;   // °C
  float uOtimo, uBom, uMedio, uRuim;   // % (mínimo de cada nível)
  float histT, histU;                  // histerese
};

// Padrão de fábrica (iguais aos da API). Substituídos pelos que vierem do servidor.
const Limites LIMITES_PADRAO = {
  {21.0f, 25.0f}, {20.0f, 26.0f}, {20.0f, 28.0f}, {20.0f, 30.0f},
  95.0f, 90.0f, 85.0f, 80.0f,
  0.3f, 1.0f
};
Limites lim = LIMITES_PADRAO;

// ---- Rede ------------------------------------------------------------------
enum StatusRede : uint8_t { REDE_OFF, REDE_SEM_API, REDE_OK, REDE_CHAVE };
enum ResultadoEnvio : uint8_t { ENVIO_OK, ENVIO_REJEITADO, ENVIO_FALHOU };

struct LeituraPendente { time_t ts; float temp; float umid; bool mudanca; };

WiFiClientSecure clienteTls;
Preferences      prefs;
StatusRede       statusRede = REDE_OFF;

LeituraPendente fila[TAM_FILA];
uint16_t filaInicio = 0;
uint16_t filaQtd    = 0;

// ---- Variáveis de execução --------------------------------------------------
bool     oledOk          = false;
bool     temLeitura      = false;
float    ultimaTemp      = 0;
float    ultimaUmid      = 0;
int      nivelTAnt       = -1;
int      nivelUAnt       = -1;
uint8_t  falhasSeguidas  = 0;
Estado   estadoAtual     = OTIMO;
int      estadoAnterior  = -1;      // estado da leitura válida anterior
bool     piscaLigado     = false;
bool     wifiConectado   = false;
bool     primeiroEnvio   = true;
unsigned long ultimaLeitura      = 0;
unsigned long ultimoPisca        = 0;
unsigned long ultimoEnvio        = 0;
unsigned long ultimaTentativaFila = 0;
unsigned long ultimaFalhaEnvio   = 0;
bool          houveFalhaEnvio    = false;
unsigned long ultimaReconexao    = 0;

// Buzzer e botão
// O loop decide SE toca (alarmeAtivo, bipeTesteAte); a tarefa do buzzer decide
// O QUE toca, nota a nota, sem depender do loop (que trava na tela e no HTTPS).
bool             silenciado      = false;
volatile bool    alarmeAtivo     = false;
volatile unsigned long bipeTesteAte = 0;
uint16_t         freqAtual       = 0;      // só a tarefa do buzzer mexe nestas
bool             melodiaTocando  = false;
uint8_t          notaAtual       = 0;
unsigned long    inicioNota      = 0;
volatile bool    botaoApertado   = false;
volatile unsigned long ultimoToqueBotao = 0;

// Diagnóstico
const char*      motivoFalhaSensor = "";
volatile uint8_t motivoDesconexao  = 0;     // preenchido pelo evento do Wi-Fi
volatile bool    houveDesconexao   = false;
bool             pedirVarredura    = false;
unsigned long    ultimaVarredura   = 0;
bool             relogioAvisado    = false;

void desenharTela();         // definidas mais abaixo
void diagnosticoDeBoot();
void scannerI2C();

// =============================================================================
// Classificação (mesmas regras da API)
// =============================================================================
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

// =============================================================================
// Limites: validação, memória (NVS) e atualização pela resposta da API
// =============================================================================
bool limitesValidos(const Limites &l) {
  const float v[] = { l.tOtimo.min, l.tOtimo.max, l.tBom.min, l.tBom.max, l.tMedio.min, l.tMedio.max,
                      l.tRuim.min, l.tRuim.max, l.uOtimo, l.uBom, l.uMedio, l.uRuim, l.histT, l.histU };
  for (float x : v) if (isnan(x) || isinf(x)) return false;
  if (l.tOtimo.min >= l.tOtimo.max) return false;
  // Cada faixa contém a anterior: ruim ⊇ médio ⊇ bom ⊇ ótimo
  if (l.tBom.min   > l.tOtimo.min || l.tBom.max   < l.tOtimo.max) return false;
  if (l.tMedio.min > l.tBom.min   || l.tMedio.max < l.tBom.max)   return false;
  if (l.tRuim.min  > l.tMedio.min || l.tRuim.max  < l.tMedio.max) return false;
  if (!(l.uOtimo >= l.uBom && l.uBom >= l.uMedio && l.uMedio >= l.uRuim)) return false;
  if (l.uRuim < 0 || l.uOtimo > 100) return false;
  if (l.histT < 0 || l.histT > 5 || l.histU < 0 || l.histU > 10) return false;
  return true;
}

void carregarLimitesSalvos() {
  prefs.begin("itr", true);
  Limites salvo;
  bool ok = prefs.getBytesLength("lim") == sizeof(Limites) &&
            prefs.getBytes("lim", &salvo, sizeof(Limites)) == sizeof(Limites) &&
            limitesValidos(salvo);
  prefs.end();
  if (ok) {
    lim = salvo;
    Serial.println("[limites] carregados da memória");
  } else {
    Serial.println("[limites] usando o padrão de fábrica");
  }
}

float numero(JsonVariantConst v) {
  return v.is<float>() ? v.as<float>() : NAN;
}

void aplicarLimitesDaResposta(const char *json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  JsonVariantConst l = doc["limites"];
  if (l.isNull()) return;

  Limites novo;
  novo.tOtimo = { numero(l["temp"]["otimo"]["min"]), numero(l["temp"]["otimo"]["max"]) };
  novo.tBom   = { numero(l["temp"]["bom"]["min"]),   numero(l["temp"]["bom"]["max"]) };
  novo.tMedio = { numero(l["temp"]["medio"]["min"]), numero(l["temp"]["medio"]["max"]) };
  novo.tRuim  = { numero(l["temp"]["ruim"]["min"]),  numero(l["temp"]["ruim"]["max"]) };
  novo.uOtimo = numero(l["umid"]["otimo"]);
  novo.uBom   = numero(l["umid"]["bom"]);
  novo.uMedio = numero(l["umid"]["medio"]);
  novo.uRuim  = numero(l["umid"]["ruim"]);
  novo.histT  = numero(l["histerese"]["temp"]);
  novo.histU  = numero(l["histerese"]["umid"]);

  if (!limitesValidos(novo)) {
    Serial.println("[limites] resposta com limites inválidos — mantidos os atuais");
    return;
  }
  if (memcmp(&novo, &lim, sizeof(Limites)) == 0) return;   // nada mudou

  lim = novo;
  prefs.begin("itr", false);
  prefs.putBytes("lim", &lim, sizeof(Limites));
  prefs.end();
  Serial.println("[limites] atualizados pelo servidor e salvos na memória");
}

// =============================================================================
// Sensor SHT4x
// =============================================================================
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
  uint8_t r = Wire.endTransmission();
  if (r != 0) {
    // 2 = ninguém respondeu no 0x44 (fio solto/trocado, sem 3V3); 5 = barramento travado
    motivoFalhaSensor = (r == 2) ? "sensor nao respondeu no 0x44 (confira 3V3, GND, SDA/SCL)"
                      : (r == 5) ? "tempo esgotado no I2C (barramento travado ou cabo longo)"
                                 : "erro no I2C ao enviar o comando";
    return false;
  }
  delay(10);                              // conversão: máx. ~8,3 ms
  if (Wire.requestFrom(SHT4X_ADDR, 6) != 6) {
    motivoFalhaSensor = "resposta incompleta do sensor (ruido no cabo? teste I2C_HZ menor)";
    return false;
  }
  uint8_t buf[6];
  for (int i = 0; i < 6; i++) buf[i] = Wire.read();
  if (crc8Sht4x(buf, 2) != buf[2] || crc8Sht4x(buf + 3, 2) != buf[5]) {
    motivoFalhaSensor = "dados corrompidos (CRC) — ruido no cabo; teste I2C_HZ menor";
    return false;
  }

  uint16_t rawT = ((uint16_t)buf[0] << 8) | buf[1];
  uint16_t rawU = ((uint16_t)buf[3] << 8) | buf[4];
  tempC = -45.0f + 175.0f * (float)rawT / 65535.0f;
  umid  =  -6.0f + 125.0f * (float)rawU / 65535.0f;
  if (umid < 0.0f)   umid = 0.0f;
  if (umid > 100.0f) umid = 100.0f;
  return true;
}

// =============================================================================
// Buzzer e botão de silenciar
// =============================================================================
// Interrupção: registra o toque mesmo se o loop estiver ocupado (ex.: envio HTTPS)
void IRAM_ATTR aoApertarBotao() {
  unsigned long agora = millis();
  if (agora - ultimoToqueBotao > 250) {     // ignora o "repique" do contato
    ultimoToqueBotao = agora;
    botaoApertado = true;
  }
}

// Prepara o PWM do buzzer passivo (a API mudou da versão 2.x para a 3.x do pacote ESP32)
void iniciarBuzzer() {
  if (BUZZER_ATIVO) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PINO_BUZZER, FREQ_BIPE_TESTE, 8);
  ledcWriteTone(PINO_BUZZER, 0);
#else
  ledcSetup(CANAL_BUZZER, FREQ_BIPE_TESTE, 8);
  ledcAttachPin(PINO_BUZZER, CANAL_BUZZER);
  ledcWriteTone(CANAL_BUZZER, 0);
#endif
}

// Toca uma frequência (0 = silêncio). Só mexe no hardware quando muda.
void tocar(uint16_t hz) {
  if (hz == freqAtual) return;
  freqAtual = hz;
  if (BUZZER_ATIVO) {
    digitalWrite(PINO_BUZZER, hz > 0 ? HIGH : LOW);
  } else {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWriteTone(PINO_BUZZER, hz);
#else
    ledcWriteTone(CANAL_BUZZER, hz);
#endif
  }
}

// Avança a melodia sem travar o loop (cada nota tem sua duração)
uint16_t notaDaMelodia(unsigned long agora) {
  if (!melodiaTocando) {
    melodiaTocando = true;
    notaAtual = 0;
    inicioNota = agora;
  }
  while (agora - inicioNota >= MELODIA_ALARME[notaAtual].ms) {
    inicioNota += MELODIA_ALARME[notaAtual].ms;
    notaAtual = (notaAtual + 1) % TAM_MELODIA;
    if (agora - inicioNota > 5000) inicioNota = agora;   // voltou de um envio longo: recomeça daqui
  }
  return MELODIA_ALARME[notaAtual].hz;
}

void cuidarDoBotao(unsigned long agora) {
  if (!botaoApertado) return;
  botaoApertado = false;
  if (estadoAtual == ALERTA && !silenciado) {
    silenciado = true;
    Serial.println("[alarme] silenciado pelo botão");
    desenharTela();
  } else {
    bipeTesteAte = agora + 150;             // bipe curto de teste
    Serial.println("[alarme] botão ok (bipe de teste)");
  }
}

// Roda no loop: só decide se o alarme deve tocar
void cuidarDoBuzzer(unsigned long agora) {
  if (estadoAtual != ALERTA) silenciado = false;   // saiu do alerta: rearma
  alarmeAtivo = (estadoAtual == ALERTA && !silenciado);
}

// Roda na tarefa do buzzer: qual frequência tocar agora
uint16_t frequenciaDesejada(unsigned long agora) {
  if ((long)(bipeTesteAte - agora) > 0) {         // bipe de teste do botão
    melodiaTocando = false;
    return FREQ_BIPE_TESTE;
  }
  if (alarmeAtivo && BUZZER_ATIVO) return (agora % 1000 < 200) ? 1 : 0;   // ativo: bipes
  if (alarmeAtivo) return notaDaMelodia(agora);                          // passivo: melodia
  melodiaTocando = false;
  return 0;
}

// Tarefa independente do loop: troca as notas no tempo certo (o PWM toca sozinho)
void tarefaBuzzer(void *) {
  for (;;) {
    tocar(frequenciaDesejada(millis()));
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// =============================================================================
// Rede: Wi-Fi, envio HTTPS e fila offline
// =============================================================================
bool relogioOk() {
  return time(nullptr) > EPOCH_MINIMO;
}

// Traduz os códigos de desconexão mais comuns do ESP32
const char* explicarDesconexao(uint8_t motivo) {
  switch (motivo) {
    case 2:   return "autenticacao expirou";
    case 8:   return "desconectado pelo proprio ESP32";
    case 15:  return "senha incorreta (handshake 4-way falhou)";
    case 201: return "rede nao encontrada (nome errado, longe, ou so 5 GHz)";
    case 202: return "autenticacao recusada (senha ou seguranca da rede)";
    case 203: return "associacao recusada pelo roteador";
    case 204: return "tempo esgotado no handshake (senha incorreta?)";
    case 205: return "falha de conexao";
    default:  return "motivo nao mapeado";
  }
}

// Evento do Wi-Fi: roda em outra tarefa, por isso só anota e o loop imprime
void aoEventoWifi(arduino_event_id_t evento, arduino_event_info_t info) {
  if (evento == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    motivoDesconexao = info.wifi_sta_disconnected.reason;
    houveDesconexao = true;
  }
}

// Lista as redes visíveis — ajuda a ver se a rede aparece e com que sinal
void varrerRedes() {
  Serial.println("[wifi] procurando redes visiveis...");
  int n = WiFi.scanNetworks();
  if (n <= 0) {
    Serial.println("[wifi] nenhuma rede encontrada (radio sem sinal? antena? alimentacao?)");
  } else {
    bool achou = false;
    for (int i = 0; i < n; i++) {
      bool essa = WiFi.SSID(i) == String(WIFI_SSID);
      achou |= essa;
      Serial.printf("  %s\"%s\"  sinal %d dBm  canal %d\n",
                    essa ? ">> " : "   ", WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
    }
    if (!achou) Serial.printf("[wifi] a rede \"%s\" NAO apareceu na lista (confira o nome e se e 2,4 GHz)\n", WIFI_SSID);
  }
  WiFi.scanDelete();
}

void cuidarDoWifi(unsigned long agora) {
  if (houveDesconexao) {
    houveDesconexao = false;
    uint8_t m = motivoDesconexao;
    Serial.printf("[wifi] falhou/desconectou: codigo %u — %s\n", m, explicarDesconexao(m));
    if (m == 201) pedirVarredura = true;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConectado) {
      wifiConectado = true;
      houveFalhaEnvio = false;   // rede voltou: a fila pode sair logo, sem esperar 60 s
      Serial.printf("[wifi] conectado, IP %s, sinal %d dBm\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      if (statusRede == REDE_OFF) statusRede = REDE_SEM_API;   // até o primeiro envio ok
    }
    if (!relogioAvisado && relogioOk()) {
      relogioAvisado = true;
      time_t t = time(nullptr);
      struct tm local;
      localtime_r(&t, &local);
      Serial.printf("[ntp] relogio sincronizado: %02d/%02d/%04d %02d:%02d\n",
                    local.tm_mday, local.tm_mon + 1, local.tm_year + 1900, local.tm_hour, local.tm_min);
    }
    return;
  }

  // Rede não encontrada: lista as redes visíveis (no máximo 1 vez por minuto)
  if (pedirVarredura && agora - ultimaVarredura >= 60000) {
    pedirVarredura = false;
    ultimaVarredura = agora;
    WiFi.disconnect();
    varrerRedes();
    WiFi.begin(WIFI_SSID, WIFI_SENHA);
    ultimaReconexao = millis();
  }
  if (wifiConectado) {
    wifiConectado = false;
    statusRede = REDE_OFF;
    ultimaReconexao = agora;
    Serial.println("[wifi] conexão perdida");
  }
  if (agora - ultimaReconexao >= RECONEXAO_WIFI_MS) {
    ultimaReconexao = agora;
    Serial.println("[wifi] tentando reconectar...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_SENHA);
  }
}

void enfileirar(const LeituraPendente &l) {
  if (filaQtd == TAM_FILA) {                 // cheia: descarta a mais antiga
    filaInicio = (filaInicio + 1) % TAM_FILA;
    filaQtd--;
  }
  fila[(filaInicio + filaQtd) % TAM_FILA] = l;
  filaQtd++;
}

void guardarNaFila(float t, float u, bool mudanca) {
  if (!relogioOk()) {
    Serial.println("[fila] sem horário do NTP ainda — leitura não pode ser guardada");
    return;
  }
  enfileirar({ time(nullptr), t, u, mudanca });
  Serial.printf("[fila] guardada para reenvio (%u na fila)\n", filaQtd);
}

ResultadoEnvio enviar(float t, float u, bool mudanca, time_t ts) {
  if (WiFi.status() != WL_CONNECTED) return ENVIO_FALHOU;

  char corpo[200];
  const char *motivo = mudanca ? "mudanca_estado" : "periodico";
  if (ts > 0) {
    snprintf(corpo, sizeof(corpo),
             "{\"device_id\":\"%s\",\"temp\":%.2f,\"umid\":%.2f,\"motivo\":\"%s\",\"ts\":%ld}",
             DEVICE_ID, t, u, motivo, (long)ts);
  } else {
    snprintf(corpo, sizeof(corpo),
             "{\"device_id\":\"%s\",\"temp\":%.2f,\"umid\":%.2f,\"motivo\":\"%s\"}",
             DEVICE_ID, t, u, motivo);
  }

  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(8000);
  if (!http.begin(clienteTls, API_URL)) return ENVIO_FALHOU;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  int codigo = http.POST(String(corpo));
  String resposta = codigo > 0 ? http.getString() : String();
  http.end();

  if (codigo == 200) {
    statusRede = REDE_OK;
    Serial.printf("[envio] %s %.2f C / %.1f %%%s -> 200\n",
                  motivo, t, u, ts > 0 ? " (da fila)" : "");
    aplicarLimitesDaResposta(resposta.c_str());
    return ENVIO_OK;
  }
  if (codigo == 401) {
    statusRede = REDE_CHAVE;
    Serial.println("[envio] 401: API_KEY recusada — confira o segredos.h");
    return ENVIO_FALHOU;        // guarda: a leitura volta a valer quando a chave for corrigida
  }
  if (codigo >= 400 && codigo < 500) {
    Serial.printf("[envio] %d rejeitado pelo servidor: %s\n", codigo, resposta.c_str());
    return ENVIO_REJEITADO;     // dado inválido: não adianta reenviar
  }
  statusRede = REDE_SEM_API;
  if (codigo < 0) {
    // Erro antes de o servidor responder: conexão, DNS ou HTTPS
    char erroTls[120] = "";
    clienteTls.lastError(erroTls, sizeof(erroTls));
    Serial.printf("[envio] falhou: %s%s%s\n", HTTPClient::errorToString(codigo).c_str(),
                  erroTls[0] ? " | TLS: " : "", erroTls);
  } else {
    Serial.printf("[envio] falhou: servidor respondeu %d\n", codigo);
  }
  return ENVIO_FALHOU;
}

void enviarLeituraAtual(float t, float u, bool mudanca) {
  ultimoEnvio = millis();
  primeiroEnvio = false;
  bool comWifi = WiFi.status() == WL_CONNECTED;
  ResultadoEnvio r = enviar(t, u, mudanca, 0);
  if (r == ENVIO_FALHOU) {
    if (comWifi) {               // Wi-Fi ok mas servidor falhou: dá um tempo antes da fila
      houveFalhaEnvio = true;
      ultimaFalhaEnvio = millis();
    }
    guardarNaFila(t, u, mudanca);
  } else {
    houveFalhaEnvio = false;
  }
}

// Reenvia a fila, um item por vez, sem travar o resto do sistema
void cuidarDaFila(unsigned long agora) {
  if (filaQtd == 0 || WiFi.status() != WL_CONNECTED) return;
  unsigned long espera = houveFalhaEnvio ? ESPERA_APOS_FALHA_MS : INTERVALO_FILA_MS;
  unsigned long referencia = houveFalhaEnvio ? ultimaFalhaEnvio : ultimaTentativaFila;
  if (agora - referencia < espera) return;

  ultimaTentativaFila = agora;
  const LeituraPendente &l = fila[filaInicio];
  ResultadoEnvio r = enviar(l.temp, l.umid, l.mudanca, l.ts);
  if (r == ENVIO_FALHOU) {
    houveFalhaEnvio = true;
    ultimaFalhaEnvio = millis();
    return;
  }
  houveFalhaEnvio = false;
  filaInicio = (filaInicio + 1) % TAM_FILA;     // enviado (ou rejeitado): sai da fila
  filaQtd--;
  if (filaQtd == 0) Serial.println("[fila] todas as leituras pendentes foram enviadas");
}

// =============================================================================
// Saídas: LEDs e OLED
// =============================================================================
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

const char* rotuloRede() {
  switch (statusRede) {
    case REDE_OK:      return "NET";
    case REDE_SEM_API: return "API";
    case REDE_CHAVE:   return "KEY";
    default:           return "OFF";
  }
}

void desenharTela() {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Faixa amarela: estado da câmara à esquerda, rede à direita
  display.setTextSize(1);
  display.setCursor(0, 0);
  if (estadoAtual == ALERTA && silenciado) {
    display.print("ALERTA (MUDO)");
  } else {
    display.print("STATUS: ");
    display.print(temLeitura || estadoAtual == ERRO ? nomeEstado(estadoAtual) : "...");
  }
  display.setCursor(110, 0);
  display.print(rotuloRede());
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  // Faixa azul
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

// =============================================================================
// Ciclo de leitura e decisão de envio
// =============================================================================
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

    Serial.printf("Temp: %.2f C | Umid: %.1f %% | Estado: %s | Rede: %s | Fila: %u\n",
                  t, u, nomeEstado(estadoAtual), rotuloRede(), filaQtd);

    bool mudou = estadoAnterior >= 0 && estadoAtual != (Estado)estadoAnterior;
    estadoAnterior = estadoAtual;

    // O primeiro envio espera o Wi-Fi conectar; depois disso vale o intervalo de 10 min
    bool primeiroPronto = primeiroEnvio && WiFi.status() == WL_CONNECTED;
    bool periodico = !primeiroEnvio && millis() - ultimoEnvio >= INTERVALO_ENVIO_MS;
    if (mudou) {
      Serial.println("[envio] estado mudou — enviando agora");
      enviarLeituraAtual(t, u, true);
    } else if (primeiroPronto || periodico) {
      enviarLeituraAtual(t, u, false);
    }
  } else {
    if (falhasSeguidas < 255) falhasSeguidas++;
    Serial.printf("Falha na leitura do SHT4x (%u seguida%s): %s\n",
                  falhasSeguidas, falhasSeguidas > 1 ? "s" : "", motivoFalhaSensor);
    if (falhasSeguidas >= FALHAS_PARA_ERRO) {
      // Sem leitura não há o que enviar; o painel avisa por "sem dados" após 25 min.
      estadoAtual = ERRO;
      nivelTAnt = -1;
      nivelUAnt = -1;
      estadoAnterior = -1;
    }
  }
  atualizarLeds();
  desenharTela();
}

// =============================================================================
// Arduino
// =============================================================================
void setup() {
  // Buzzer desligado o quanto antes (o GPIO14 oscila durante o boot)
  pinMode(PINO_BUZZER, OUTPUT);
  digitalWrite(PINO_BUZZER, LOW);

  Serial.begin(115200);
  delay(500);
  Serial.println("ITR Monitor Ambiental - Fase 3 (Wi-Fi + API + buzzer)");

  pinMode(PINO_BOTAO, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PINO_BOTAO), aoApertarBotao, FALLING);

  // Buzzer: PWM pronto e tarefa própria (prioridade 2, acima do loop, no núcleo 1)
  iniciarBuzzer();
  xTaskCreatePinnedToCore(tarefaBuzzer, "buzzer", 2048, nullptr, 2, nullptr, 1);

  pinMode(PINO_LED_VERDE, OUTPUT);
  pinMode(PINO_LED_AMARELO, OUTPUT);
  pinMode(PINO_LED_VERMELHO, OUTPUT);
  const uint8_t leds[] = {PINO_LED_VERDE, PINO_LED_AMARELO, PINO_LED_VERMELHO};
  for (uint8_t pino : leds) { digitalWrite(pino, HIGH); delay(250); }
  delay(250);
  for (uint8_t pino : leds) digitalWrite(pino, LOW);

  diagnosticoDeBoot();
  carregarLimitesSalvos();

  Wire.begin(PINO_SDA, PINO_SCL);
  Wire.setClock(I2C_HZ);
  scannerI2C();
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR, true, false);
  if (!oledOk) Serial.println("[oled] falha ao iniciar no 0x3C (seguindo só com Serial e LEDs)");

  // Lê e mostra o sensor ANTES de ligar o Wi-Fi: se a alimentação não aguentar
  // o rádio, ao menos a tela e os LEDs já funcionam e o problema fica visível.
  cicloDeLeitura();
  ultimaLeitura = millis();

  // Wi-Fi (conecta em segundo plano) e relógio por NTP no horário de Brasília
  Serial.printf("[wifi] ligando o radio e conectando em \"%s\"...\n", WIFI_SSID);
  WiFi.onEvent(aoEventoWifi);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(POTENCIA_WIFI);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  ultimaReconexao = millis();
  configTzTime("<-03>3", "a.st1.ntp.br", "pool.ntp.org");
  clienteTls.setCACert(CERTIFICADOS_RAIZ);
  Serial.println("[wifi] radio ligado (se a placa reiniciar aqui, e alimentacao)");
}

// Mostra por que a placa reiniciou e a frequência do cristal
void diagnosticoDeBoot() {
  esp_reset_reason_t motivo = esp_reset_reason();
  const char *txt;
  switch (motivo) {
    case ESP_RST_POWERON:  txt = "ligada na energia"; break;
    case ESP_RST_SW:       txt = "reinicio por software"; break;
    case ESP_RST_PANIC:    txt = "TRAVOU (erro no programa)"; break;
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      txt = "TRAVOU (watchdog)"; break;
    case ESP_RST_BROWNOUT: txt = "QUEDA DE TENSAO (brownout) — alimentacao insuficiente"; break;
    case ESP_RST_EXT:      txt = "botao EN/RST"; break;
    default:               txt = "outro"; break;
  }
  Serial.printf("[boot] motivo do ultimo reinicio: %s\n", txt);
  Serial.printf("[boot] cristal: %u MHz | CPU: %u MHz\n", (unsigned)getXtalFrequencyMhz(), (unsigned)getCpuFrequencyMhz());

  if (motivo == ESP_RST_BROWNOUT) {
    Serial.println("[boot] DICA: cabo USB curto/grosso direto no PC, carregador 5V 1A+,");
    Serial.println("[boot]       capacitor 470 uF entre 3V3 e GND, ou POTENCIA_WIFI menor.");
  }
}

// Lista quem responde no I2C: esperado 0x3C (OLED) e 0x44 (SHT4x)
void scannerI2C() {
  bool achouSensor = false, achouOled = false;
  Serial.print("[i2c] dispositivos:");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", a);
      achouSensor |= (a == SHT4X_ADDR);
      achouOled   |= (a == OLED_ADDR);
    }
  }
  Serial.println();
  if (!achouSensor) Serial.println("[i2c] SHT4x (0x44) NAO encontrado — confira fios do sensor");
  if (!achouOled)   Serial.println("[i2c] OLED (0x3C) NAO encontrado — confira fios do display");
}

void loop() {
  unsigned long agora = millis();

  cuidarDoWifi(agora);
  cuidarDoBotao(agora);
  cuidarDoBuzzer(agora);

  if (agora - ultimoPisca >= INTERVALO_PISCA_MS) {
    ultimoPisca = agora;
    piscaLigado = !piscaLigado;
    if (estadoAtual == ERRO) atualizarLeds();
  }

  if (agora - ultimaLeitura >= INTERVALO_LEITURA_MS) {
    ultimaLeitura = agora;
    cicloDeLeitura();
  }

  cuidarDaFila(millis());
}
