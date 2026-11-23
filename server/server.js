'use strict';

/*
 * ITR Monitor Ambiental — API (Fase 4)
 *
 * ESP32  → POST /api/leituras         (header x-api-key)
 * Painel → GET  /api/atual            leitura mais recente + estado + "sem dados"
 *          GET  /api/historico        série para os gráficos (período De/Até)
 *          GET  /api/historico.csv    exporta o período em CSV
 *          GET  /api/historico.xlsx   exporta o período em planilha do Excel
 *          GET  /api/limites          limites atuais
 *          PUT  /api/limites          altera limites (header x-admin-token)
 * Coolify → GET /health
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { pool, migrar, emTransacao } = require('./db');
const {
  LIMITES_PADRAO,
  copiarLimites,
  classificar,
  validarLimites,
  normalizarLimites,
} = require('./estado');
const { lerPeriodo, buscarHistorico, gerarCsv } = require('./historico');
const { gerarPlanilha } = require('./planilha');

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
    console.warn(`[acesso] ${header} recusado em ${req.method} ${req.path}, ip ${req.ip}`);
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

// Limites por IP. Nunca em /api/leituras: a placa descarta a leitura em qualquer 4xx que não seja 401.
function limitar(janelaMs, maximo, opcoes) {
  return rateLimit({
    windowMs: janelaMs,
    limit: maximo,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ ok: false, erro: 'muitas requisições; tente de novo em alguns minutos' }),
    ...opcoes,
  });
}
// Só tokens recusados contam: 10 erros em 15 min
const limiteToken = limitar(15 * 60e3, 10, {
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
});
const limiteHistorico = limitar(60e3, 120);

// ---- App -------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1); // atrás do proxy do Coolify
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(['/api/historico', '/api/historico.csv', '/api/historico.xlsx'], limiteHistorico);

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

    // Se a resposta se perde depois de gravar, a placa reenvia a mesma leitura com ts: não grava de novo.
    // 30 s cobrem os 8 s de espera da placa mais a diferença dos relógios.
    await emTransacao(async (cliente) => {
      // Uma gravação por vez em cada dispositivo, senão dois reenvios simultâneos passam pela checagem
      await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [deviceId]);
      await cliente.query(
        `INSERT INTO leituras (device_id, temp, umid, medido_em, motivo, nivel_temp, nivel_umid, estado)
         SELECT $1::text, $2::real, $3::real, $4::timestamptz, $5::text, $6::smallint, $7::smallint, $8::text
          WHERE NOT $9::boolean OR NOT EXISTS (
            SELECT 1 FROM leituras
             WHERE device_id = $1 AND temp = $2::real AND umid = $3::real AND motivo = $5
               AND medido_em BETWEEN $4::timestamptz - interval '30 seconds' AND $4::timestamptz + interval '30 seconds')`,
        [deviceId, temp, umid, medidoEm, motivo, c.nivel_temp, c.nivel_umid, c.estado, ts !== undefined]
      );
    });

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

    const partes = gerarCsv(pool, deviceId, periodo.de, periodo.ate);
    const primeira = await partes.next(); // erro do banco aqui ainda responde 500
    const dia = (d) => d.toISOString().slice(0, 10);
    const nome = `${deviceId}_${dia(periodo.de)}_${dia(periodo.ate)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nome}"`);
    res.write(primeira.value);
    await pipeline(Readable.from(partes), res);
  } catch (e) {
    if (e.code === 'ERR_STREAM_PREMATURE_CLOSE') return; // o navegador cancelou o download
    next(e);
  }
});

// O mesmo período em planilha do Excel, com as colunas já na largura certa
app.get('/api/historico.xlsx', async (req, res, next) => {
  try {
    const deviceId = deviceDe(req.query.device_id);
    if (!deviceId) return erro(res, 'device_id inválido');
    const periodo = lerPeriodo(req.query);
    if (periodo.erro) return erro(res, periodo.erro);

    const arquivo = await gerarPlanilha(pool, deviceId, periodo.de, periodo.ate);
    const dia = (d) => d.toISOString().slice(0, 10);
    res.type('xlsx');
    res.set('Content-Disposition', `attachment; filename="${deviceId}_${dia(periodo.de)}_${dia(periodo.ate)}.xlsx"`);
    res.send(arquivo);
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

app.put('/api/limites', limiteToken, exigir('x-admin-token', ADMIN_TOKEN), async (req, res, next) => {
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
    console.log(`[limites] ${deviceId} alterados, ip ${req.ip}: ${JSON.stringify(limites)}`);
    res.json({ ok: true, device_id: deviceId, limites });
  } catch (e) {
    next(e);
  }
});

// Rotas inexistentes da API
app.use('/api', (req, res) => res.status(404).json({ ok: false, erro: 'rota não encontrada' }));

// Tratamento central de erros
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return erro(res, 'JSON malformado');
  if (err.type === 'entity.too.large') return erro(res, 'corpo da requisição grande demais');
  // Requisição inválida (ex.: codificação desconhecida). Fora de /api/leituras, onde 4xx faria a placa descartar a leitura
  if (err.status >= 400 && err.status < 500 && req.path !== '/api/leituras') {
    return res.status(err.status).json({ ok: false, erro: 'requisição inválida' });
  }
  console.error('[erro]', err);
  res.status(500).json({ ok: false, erro: 'erro interno' });
});

// ---- Inicialização ---------------------------------------------------------

// O banco pode subir depois da API (ex.: servidor reiniciado): tenta por cerca de 30 s
async function esperarBanco() {
  for (let i = 1; ; i++) {
    try {
      return await migrar();
    } catch (e) {
      if (i === 6) throw e;
      console.warn(`[banco] indisponível (${e.message}), tentativa ${i} de 6`);
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}

async function iniciar() {
  await esperarBanco();
  const server = app.listen(PORT, () => console.log(`[api] ouvindo na porta ${PORT}`));

  const encerrar = () => {
    console.log('[api] encerrando...');
    setTimeout(() => process.exit(1), 8000).unref(); // antes dos 10 s do Docker
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
