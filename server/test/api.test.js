'use strict';

// DATABASE_URL=postgres://.../camara_teste npm test   (apaga os dados desse banco!)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

if (!new URL(process.env.DATABASE_URL || 'postgres:').pathname.endsWith('teste')) throw new Error('use um banco com "teste" no nome');
Object.assign(process.env, { API_KEY: 'chave', ADMIN_TOKEN: 'token' });
const { app } = require('../server');
const { pool, migrar } = require('../db');
const { LIMITES_PADRAO } = require('../estado');

let base, servidor;
before(async () => {
  await migrar();
  await pool.query('TRUNCATE leituras, configuracao');
  servidor = app.listen(0);
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(async () => { servidor.close(); await pool.end(); });

const pedir = async (url, opcoes) => {
  const r = await fetch(base + url, opcoes);
  const texto = await r.text();
  return { status: r.status, texto, json: () => JSON.parse(texto), headers: r.headers };
};
const enviar = (metodo, url, corpo, headers) => pedir(url, {
  method: metodo, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(corpo),
});
const ler = (corpo, chave = 'chave') => enviar('POST', '/api/leituras', { temp: 23.4, umid: 96.2, motivo: 'periodico', ...corpo }, { 'x-api-key': chave });
const contar = async (d) => (await pool.query('SELECT count(*)::int AS n FROM leituras WHERE device_id = $1', [d])).rows[0].n;
const seg = () => Math.floor(Date.now() / 1000);

test('contrato da placa', async () => {
  const r = await ler({ device_id: 'placa' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { ok: true, estado: 'otimo', limites: LIMITES_PADRAO });
  assert.equal((await ler({}, 'errada')).status, 401);
  assert.equal((await ler({ temp: 'x' })).status, 400);
  const atual = (await pedir('/api/atual?device_id=placa')).json();
  assert.equal(atual.sem_dados, false);
  assert.equal(atual.leitura.estado, 'otimo');
});

test('reenvio da mesma leitura não duplica, leituras distintas não somem', async () => {
  const ts = seg() - 3600;
  await ler({ device_id: 'fila', ts });
  assert.equal((await ler({ device_id: 'fila', ts })).status, 200);
  assert.equal(await contar('fila'), 1);
  await ler({ device_id: 'perdida' });
  await ler({ device_id: 'perdida', ts: seg() + 8 });
  assert.equal(await contar('perdida'), 1);
  for (const o of [{ ts: ts + 600 }, { ts: ts + 1, temp: 23.5 }, { ts: ts + 2, motivo: 'mudanca_estado' }]) await ler({ device_id: 'fila', ...o });
  assert.equal(await contar('fila'), 4);
});

test('reenvios simultâneos da mesma leitura não duplicam', async () => {
  const ts = seg() - 7200;
  for (let i = 0; i < 20; i++) await Promise.all([1, 2, 3].map(() => ler({ device_id: 'juntas', ts: ts + i * 60 })));
  assert.equal(await contar('juntas'), 20);
});

test('gravação que expira não aparece depois', async () => {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('LOCK TABLE leituras IN SHARE ROW EXCLUSIVE MODE'); // segura as gravações, como um banco lento
  const ts = seg() - 9000;
  assert.equal((await ler({ device_id: 'lenta', ts })).status, 500); // a placa guarda e reenvia
  await c.query('ROLLBACK');
  c.release();
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal((await ler({ device_id: 'lenta', ts })).status, 200);
  assert.equal(await contar('lenta'), 1);
});

test('a placa nunca recebe 429, mesmo com a fila de 24 h', async () => {
  for (let i = 0; i < 144; i++) assert.equal((await ler({ device_id: 'dia', ts: seg() - 86400 + i * 600 })).status, 200);
  assert.equal(await contar('dia'), 144);
});

test('CSV sai inteiro e em ordem quando passa de um lote', async () => {
  await pool.query(`INSERT INTO leituras (device_id, temp, umid, medido_em, motivo, nivel_temp, nivel_umid, estado)
    SELECT 'csv', 23, 97, ts, 'periodico', 0, 0, 'otimo' FROM generate_series('2026-01-01T03:00:00Z'::timestamptz, '2026-01-01T03:00:00Z'::timestamptz + interval '10000 minutes', '1 minute') ts`);
  const r = await pedir('/api/historico.csv?device_id=csv&de=2026-01-01T03:00:00Z&ate=2026-02-01T00:00:00Z');
  const linhas = r.texto.trimEnd().split('\r\n');
  assert.equal(linhas.length, 10002);
  assert.equal(linhas[1], '01/01/2026 00:00:00;23,0;97,0;Ótimo;Ótimo;Ótimo');
  assert.equal(new Set(linhas).size, 10002);
  assert.equal(linhas.at(-1).slice(0, 19), '07/01/2026 22:40:00');
});

test('parâmetros inválidos respondem 400, nunca 500', async () => {
  for (const q of ['agrupamento=toString', 'agrupamento=__proto__', 'agrupamento=2h', 'de=abc', 'de=-271821-04-20T00:00:00Z&ate=-271820-04-20T00:00:00Z', 'horas=0', 'device_id=A!']) {
    assert.equal((await pedir(`/api/historico?${q}`)).status, 400, q);
  }
  assert.equal((await pedir('/api/atual')).headers.get('cache-control'), 'no-store');
});

test('conexão ociosa derrubada pelo banco não encerra o processo', async () => {
  await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.1)'))); // abre 3 conexões, que ficam ociosas
  await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal((await pedir('/health')).status, 200);
});

test('limites: token, validação e trava depois de 10 tokens errados', async () => {
  const salvar = (limites, token = 'token') => enviar('PUT', '/api/limites', { limites }, { 'x-admin-token': token });
  const novo = { ...LIMITES_PADRAO, umid: { ...LIMITES_PADRAO.umid, otimo: 94 } };
  assert.deepEqual((await salvar({ ...novo, extra: 1 })).json().limites, novo);
  assert.deepEqual((await pedir('/api/limites')).json().limites, novo);
  for (let i = 0; i < 12; i++) assert.equal((await salvar({ ...novo, sem_dados_min: 5 })).status, 400); // erro de dados não conta
  for (let i = 0; i < 10; i++) assert.equal((await salvar(novo, `x${i}`)).status, 401);
  assert.equal((await salvar(novo, 'x')).status, 429);
  assert.equal((await ler({ device_id: 'apos-trava' })).status, 200); // a placa segue enviando
});
