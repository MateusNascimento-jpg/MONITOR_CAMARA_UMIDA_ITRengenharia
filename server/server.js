'use strict';

/*
 * ITR Monitor Ambiental — API (Fase 4)
 *
 * ESP32  → POST /api/leituras         (header x-api-key)
 * Painel → GET  /api/atual            leitura mais recente + estado + "sem dados"
 *          GET  /api/historico        série para os gráficos (período De/Até)
 *          GET  /api/historico.csv    exporta o período em CSV
 *          GET  /api/limites          limites atuais
 *          PUT  /api/limites          altera limites (header x-admin-token)
 * Coolify → GET /health
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { pool, migrar } = require('./db');
const {
  LIMITES_PADRAO,
  copiarLimites,
  classificar,
  validarLimites,
  normalizarLimites,
} = require('./estado');
const { lerPeriodo, buscarHistorico, gerarCsv } = require('./historico');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DEVICE_PADRAO = 'camara-01';
const MOTIVOS = ['periodico', 'mudanca_estado'];
const RE_DEVICE = /^[a-z0-9-]{1,32}$/;

for (const nome of ['DATABASE_URL', 'API_KEY', 'ADMIN_TOKEN']) {
  if (!process.env[nome]) {
    console.error(`[config] variável de ambiente ${nome} não definida`);
    process.exit(1);
  }
}

// ---- Utilidades ------------------------------------------------------------

// Compara segredos em tempo constante (evita descobrir o token por tempo de resposta)
function segredoConfere(recebido, esperado) {
  if (typeof recebido !== 'string' || recebido.length === 0) return false;
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

function exigir(header, segredo) {
  return (req, res, next) => {
    if (segredoConfere(req.get(header), segredo)) return next();
    res.status(401).json({ ok: false, erro: 'não autorizado' });
  };
}

function erro(res, msg) {
  return res.status(400).json({ ok: false, erro: msg });
}

function deviceDe(valor) {
  const d = valor === undefined ? DEVICE_PADRAO : valor;
  return typeof d === 'string' && RE_DEVICE.test(d) ? d : null;
}

function numeroEntre(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

async function obterLimites(deviceId) {
  const r = await pool.query('SELECT limites FROM configuracao WHERE device_id = $1', [deviceId]);
  return r.rows[0] ? r.rows[0].limites : copiarLimites(LIMITES_PADRAO);
}

// ---- App -------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1); // atrás do proxy do Coolify
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ESP32 envia uma leitura
app.post('/api/leituras', exigir('x-api-key', API_KEY), async (req, res, next) => {
  try {
    const { temp, umid, motivo, ts } = req.body || {};
    const deviceId = deviceDe(req.body && req.body.device_id);

    if (!deviceId) return erro(res, 'device_id inválido (use a-z, 0-9 e hífen)');
    if (!numeroEntre(temp, -40, 125)) return erro(res, 'temp inválida (-40 a 125)');
    if (!numeroEntre(umid, -10, 110)) return erro(res, 'umid inválida');
    if (!MOTIVOS.includes(motivo)) return erro(res, `motivo deve ser: ${MOTIVOS.join(' ou ')}`);

    // ts (epoch em segundos) só vem nas leituras reenviadas do buffer do ESP32
    const agora = Date.now();
    let medidoEm = new Date(agora);
    if (ts !== undefined) {
      if (!Number.isInteger(ts)) return erro(res, 'ts deve ser epoch em segundos (inteiro)');
      const ms = ts * 1000;
      if (ms > agora + 5 * 60e3 || ms < agora - 7 * 24 * 3600e3) {
        return erro(res, 'ts fora da janela aceita (até 7 dias atrás)');
      }
      medidoEm = new Date(ms);
    }

    const limites = await obterLimites(deviceId);
    const anterior = await pool.query(
      `SELECT nivel_temp, nivel_umid FROM leituras
        WHERE device_id = $1 AND medido_em <= $2
        ORDER BY medido_em DESC LIMIT 1`,
      [deviceId, medidoEm]
    );
    const c = classificar(temp, umid, limites, anterior.rows[0]);

    await pool.query(
      `INSERT INTO leituras (device_id, temp, umid, medido_em, motivo, nivel_temp, nivel_umid, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [deviceId, temp, umid, medidoEm, motivo, c.nivel_temp, c.nivel_umid, c.estado]
    );

    res.json({ ok: true, estado: c.estado, limites });
  } catch (e) {
    next(e);
  }
});

// Estado atual para o painel
app.get('/api/atual', async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.query.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');

    const limites = await obterLimites(deviceId);
    const r = await pool.query(
      `SELECT temp, umid, medido_em, estado, nivel_temp, nivel_umid
         FROM leituras WHERE device_id = $1
        ORDER BY medido_em DESC LIMIT 1`,
      [deviceId]
    );
    const leitura = r.rows[0] || null;
    const agora = new Date();
    const semDados = !leitura || agora - leitura.medido_em > limites.sem_dados_min * 60e3;

    res.json({ ok: true, device_id: deviceId, agora, sem_dados: semDados, leitura, limites });
  } catch (e) {
    next(e);
  }
});

// Série histórica para os gráficos.
// Período: ?de=...&ate=... (ISO 8601 ou epoch ms) ou ?horas=N; padrão: últimas 24 h.
// Agrupamento: ?agrupamento=auto|bruto|1h|6h|1d|7d (padrão auto).
app.get('/api/historico', async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.query.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');
    const periodo = lerPeriodo(req.query);
    if (periodo.erro) return erro(res, periodo.erro);

    const h = await buscarHistorico(pool, deviceId, periodo.de, periodo.ate, req.query.agrupamento);
    if (h.erro) return erro(res, h.erro);

    res.json({
      ok: true,
      device_id: deviceId,
      de: periodo.de,
      ate: periodo.ate,
      agrupamento: h.agrupamento,
      leituras: h.leituras,
    });
  } catch (e) {
    next(e);
  }
});

// Exporta as leituras do período em CSV (abre direto no Excel)
app.get('/api/historico.csv', async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.query.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');
    const periodo = lerPeriodo(req.query);
    if (periodo.erro) return erro(res, periodo.erro);

    const csv = await gerarCsv(pool, deviceId, periodo.de, periodo.ate);
    const dia = (d) => d.toISOString().slice(0, 10);
    const nome = `${deviceId}_${dia(periodo.de)}_${dia(periodo.ate)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(csv);
  } catch (e) {
    next(e);
  }
});

app.get('/api/limites', async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.query.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');
    res.json({ ok: true, device_id: deviceId, limites: await obterLimites(deviceId) });
  } catch (e) {
    next(e);
  }
});

app.put('/api/limites', exigir('x-admin-token', ADMIN_TOKEN), async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.body && req.body.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');
    const motivoInvalido = validarLimites(req.body && req.body.limites);
    if (motivoInvalido) return erro(res, motivoInvalido);

    const limites = normalizarLimites(req.body.limites);
    await pool.query(
      `INSERT INTO configuracao (device_id, limites, atualizado_em)
       VALUES ($1, $2, now())
       ON CONFLICT (device_id) DO UPDATE SET limites = EXCLUDED.limites, atualizado_em = now()`,
      [deviceId, limites]
    );
    res.json({ ok: true, device_id: deviceId, limites });
  } catch (e) {
    next(e);
  }
});

// Rotas inexistentes da API
app.use('/api', (req, res) => res.status(404).json({ ok: false, erro: 'rota não encontrada' }));

// Tratamento central de erros
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return erro(res, 'JSON malformado');
  if (err.type === 'entity.too.large') return erro(res, 'corpo da requisição grande demais');
  console.error('[erro]', err);
  res.status(500).json({ ok: false, erro: 'erro interno' });
});

// ---- Inicialização ---------------------------------------------------------

async function iniciar() {
  await migrar();
  const server = app.listen(PORT, () => console.log(`[api] ouvindo na porta ${PORT}`));

  const encerrar = () => {
    console.log('[api] encerrando...');
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

if (require.main === module) {
  iniciar().catch((e) => {
    console.error('[api] falha ao iniciar:', e);
    process.exit(1);
  });
}

module.exports = { app };
