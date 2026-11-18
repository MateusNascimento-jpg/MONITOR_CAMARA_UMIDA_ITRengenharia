# ITR Monitor Ambiental

Monitoramento de temperatura e umidade da câmara úmida da ITR Engenharia.

```
firmware/   sketches do ESP32 (Arduino IDE)
server/     API Node.js + PostgreSQL (deploy no Coolify) — também serve o dashboard em server/public
dashboard/  logos e materiais do dashboard (Fase 5)
referencias/ referências visuais
```

## Hardware

ESP32 + sensor **SHT4x** (I2C 0x44) + OLED SSD1306 0.96" (I2C 0x3C) + 3 LEDs, com o barramento I2C em 50 kHz.

| Item | Pino |
|---|---|
| SDA / SCL (SHT4x e OLED) | GPIO21 / GPIO22, alimentação 3V3 |
| LED verde | GPIO25 (resistor 220–330 Ω) |
| LED vermelho | GPIO26 (resistor 220–330 Ω) |
| LED amarelo | GPIO27 (resistor 220–330 Ω) |

| LEDs | Estado |
|---|---|
| Verde | Ótimo ou bom |
| Amarelo | Médio |
| Amarelo + vermelho | Ruim |
| Vermelho | Alerta |
| Vermelho piscando | Erro: sensor sem resposta em 3 leituras seguidas |

O alarme sonoro fica só no dashboard. O sketch atual é `firmware/fase2_oled_leds`.

## API (server/)

| Método | Rota | Quem usa | Autenticação |
|---|---|---|---|
| POST | `/api/leituras` | ESP32 | header `x-api-key` |
| GET | `/api/atual` | Dashboard | — |
| GET | `/api/historico` | Dashboard | — |
| GET | `/api/historico.csv` | Dashboard (exportar) | — |
| GET | `/api/limites` | Dashboard / ESP32 | — |
| PUT | `/api/limites` | Dashboard (edição) | header `x-admin-token` |
| GET | `/health` | Coolify | — |

### Histórico (período livre, estilo Grafana)

| Parâmetro | Exemplo | Observação |
|---|---|---|
| `de`, `ate` | `2026-11-18T08:00:00-03:00` ou epoch em ms | Sem `ate` = agora; sem `de` = 24 h antes de `ate` |
| `horas` | `48` | Atalho para "últimas N horas" (usado só sem `de`/`ate`) |
| `agrupamento` | `auto` (padrão), `bruto`, `1h`, `6h`, `1d`, `7d` | Período máximo: 5 anos |

O `auto` devolve leitura a leitura até 3 dias, e acima disso agrupa: por hora até 30 dias, a cada 6 h até 180 dias, por dia até 3 anos e por semana acima disso.
Grupos trazem média, mínima, máxima, quantidade de leituras e o pior estado do período. Dias e semanas começam à meia-noite de Brasília.
`/api/historico.csv` aceita o mesmo período e exporta leitura a leitura (separador `;`, vírgula decimal, horário de Brasília).
Requer PostgreSQL 14 ou mais novo (`date_bin`).

### Contrato ESP32 → servidor

```json
{ "device_id": "camara-01", "temp": 23.4, "umid": 96.1, "motivo": "periodico" }
```

- `motivo`: `"periodico"` (a cada 10 min) ou `"mudanca_estado"` (envio imediato).
- `ts` (opcional, epoch em segundos): só nas leituras reenviadas do buffer.

Resposta: `{ "ok": true, "estado": "otimo", "limites": { ... } }`

### Estados

| Estado | Temperatura | Umidade |
|---|---|---|
| otimo | 21,0 – 25,0 °C | ≥ 95 % |
| bom | 20,0 – 21,0 ou 25,0 – 26,0 °C | 90 – 95 % |
| medio | 26,0 – 28,0 °C | 85 – 90 % |
| ruim | 28,0 – 30,0 °C | 80 – 85 % |
| alerta | ≥ 30 °C ou < 20 °C | < 80 % |

Estado da câmara = pior entre temperatura e umidade. Histerese padrão: 0,3 °C / 1 %.
Sem dados: alarme após 25 min sem leitura. Todos os limites são editáveis via `PUT /api/limites`.

### Variáveis de ambiente

`DATABASE_URL`, `API_KEY`, `ADMIN_TOKEN`, `PORT` (padrão 3000). Ver `server/.env.example`.
