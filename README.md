# ITR Monitor Ambiental (sensor de umidade)

Monitoramento de temperatura e umidade da câmara úmida da ITR Engenharia.

```
firmware/   sketches do ESP32 (Arduino IDE)
server/     API Node.js + PostgreSQL (deploy no Coolify) — também serve o painel em server/public
dashboard/  logos originais
referencias/ referências visuais
```

Em produção: https://camara.itr.eng.br

## Hardware

ESP32 + sensor **SHT4x** (I2C 0x44) + OLED SSD1306 0.96" (I2C 0x3C) + 3 LEDs, com o barramento I2C em 50 kHz.

| Item | Pino |
|---|---|
| SDA / SCL (SHT4x e OLED) | GPIO21 / GPIO22, alimentação 3V3 |
| LED verde | GPIO25 (resistor 220–330 Ω) |
| LED vermelho | GPIO26 (resistor 220–330 Ω) |
| LED amarelo | GPIO27 (resistor 220–330 Ω) |
| Buzzer (+) | GPIO14; o (−) vai no GND |
| Botão de silenciar | GPIO13 ↔ GND, com pull-up interno |

| LEDs | Estado |
|---|---|
| Verde | Ótimo ou bom |
| Amarelo | Médio |
| Amarelo + vermelho | Ruim |
| Vermelho | Alerta |
| Vermelho piscando | Erro: sensor sem resposta em 3 leituras seguidas |

**Buzzer:** em ALERTA, toca em loop uma melodia de alarme original (buzzer passivo) ou bipes de 200 ms a cada 1 s (buzzer ativo). O botão silencia até a câmara sair do alerta; se ela voltar a entrar em alerta, o buzzer toca de novo. Fora do alerta, apertar o botão dá um bipe curto de teste. Erro do sensor não toca. O painel tem alarme próprio, independente do buzzer.

| Sketch | O que faz |
|---|---|
| `firmware/fase2_oled_leds` | Só local: sensor, OLED e LEDs |
| `firmware/fase3_wifi` | **Atual.** Tudo da Fase 2, mais Wi-Fi, envio HTTPS para a API, fila offline de 24 h e limites vindos do servidor |

Na Fase 3, copie `segredos.exemplo.h` para `segredos.h` e preencha o Wi-Fi e a `API_KEY`. O `segredos.h` não vai para o Git.
O canto superior direito do OLED mostra o status da rede:

| Indicação | Significado |
|---|---|
| `NET` | Tudo ok |
| `OFF` | Sem Wi-Fi |
| `API` | Wi-Fi ok, mas o servidor não respondeu |
| `KEY` | Chave recusada pelo servidor |

## Painel (server/public)

HTML, CSS e JS puros, sem build e sem CDN. Abre para qualquer pessoa com o link; só salvar limites exige o `ADMIN_TOKEN`.

| Página | O que mostra |
|---|---|
| Visão geral | Estado da câmara, temperatura e umidade nas faixas, última leitura, gráfico e tempo em cada estado (tela da TV) |
| Histórico | Período livre, zoom por arraste e exportação em CSV |
| Configurações | Edição dos limites, com validação e prévia |

- **Atualização:** consulta a API a cada 30 s. A câmara fica em "Sem dados" após `sem_dados_min` minutos sem leitura (padrão 25).
- **Alarme:** em Alerta ou Sem dados, aviso visual e a mesma melodia do buzzer. O navegador só libera o som depois de um clique em "Ativar som do alarme". "Silenciar alarme" vale até o próximo alarme.
- **TV com Chrome:** com `--autoplay-policy=no-user-gesture-required`, o som volta sozinho ao recarregar, depois da primeira ativação.
- **Demonstração:** `?demo` usa dados simulados (`?demo=otimo`, `medio`, `alerta` ou `sem_dados`). O token da demonstração é `demo`.

```
npx --yes http-server server/public -p 8080     # http://localhost:8080/?demo
node server/public/js/regras.test.mjs           # confere as regras do painel com server/estado.js
```

## Publicação

Trabalhe em um branch e abra um PR: o merge na `main` publica em produção pelo Coolify. Se não publicar em alguns minutos, use **Redeploy**.

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
`/api/historico.csv` aceita o mesmo período e exporta leitura a leitura (separador `;`, vírgula decimal, horário de Brasília). Colunas: Data e hora (Brasília); Temperatura (°C); Umidade (%); Nível da temperatura; Nível da umidade; Estado geral — valores com 1 casa decimal e estados escritos por extenso (Ótimo, Bom, Médio, Ruim, Alerta).
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
