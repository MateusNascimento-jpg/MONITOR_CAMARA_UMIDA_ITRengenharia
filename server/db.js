'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

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
  await pool.query(MIGRACAO);
}

module.exports = { pool, migrar };
