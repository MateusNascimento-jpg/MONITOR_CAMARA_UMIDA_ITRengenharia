# ITR Monitor Ambiental

Monitoramento de temperatura e umidade da câmara úmida da ITR Engenharia.

```
firmware/   sketches do ESP32 (Arduino IDE)
server/     API Node.js + PostgreSQL (deploy no Coolify) — também serve o dashboard em server/public
dashboard/  logos e materiais do dashboard (Fase 5)
referencias/ referências visuais
```

## API (server/)

| Método | Rota | Quem usa | Autenticação |
|---|---|---|---|
| POST | `/api/leituras` | ESP32 | header `x-api-key` |
| GET | `/api/atual` | Dashboard | — |
| GET | `/api/historico?horas=24` | Dashboard | — |
| GET | `/api/limites` | Dashboard / ESP32 | — |
| PUT | `/api/limites` | Dashboard (edição) | header `x-admin-token` |
| GET | `/health` | Coolify | — |

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
