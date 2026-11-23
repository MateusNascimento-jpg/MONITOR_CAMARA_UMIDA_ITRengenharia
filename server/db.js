'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  keepAlive: true,
  // A placa desiste em 8 s: com o banco travado, responder antes faz ela guardar a leitura na fila
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});

// Sem isto, uma conexão ociosa derrubada pelo banco (ex.: reinício) encerra o processo
pool.on('error', (e) => console.error('[banco] conexão perdida:', e.message));

// Cria as tabelas na primeira execução (idempotente: pode rodar sempre)
const MIGRACAO = `
CREATE TABLE IF NOT EXISTS leituras (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT        NOT NULL,
  temp        REAL        NOT NULL,
  umid        REAL        NOT NULL,
  medido_em   TIMESTAMPTZ NOT NULL,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo      TEXT        NOT NULL,
  nivel_temp  SMALLINT    NOT NULL,
  nivel_umid  SMALLINT    NOT NULL,
  estado      TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leituras_device_medido
  ON leituras (device_id, medido_em DESC);

CREATE TABLE IF NOT EXISTS configuracao (
  device_id     TEXT PRIMARY KEY,
  limites       JSONB       NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migrar() {
  await pool.query({ text: MIGRACAO, query_timeout: 60000 });
}

// Em erro, fecha a conexão: o banco desfaz o que não foi confirmado, inclusive o que expirou no meio
async function emTransacao(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    c.release();
  } catch (e) {
    c.release(e);
    throw e;
  }
}

module.exports = { pool, migrar, emTransacao };
