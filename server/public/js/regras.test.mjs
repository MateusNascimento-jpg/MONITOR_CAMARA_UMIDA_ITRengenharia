// node server/public/js/regras.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as r from './regras.js';

const s = createRequire(import.meta.url)('../../estado.js');
const L = r.LIMITES_PADRAO;

// Mesmos padrões e mesma classificação do servidor, de 0 a 110 em passos de 0,1
assert.deepEqual(L, s.copiarLimites(s.LIMITES_PADRAO));
for (let i = 0; i <= 1100; i++) {
  const v = i / 10;
  const c = s.classificar(v, v, L);
  assert.equal(r.nivelTemp(v, L), c.nivel_temp);
  assert.equal(r.nivelUmid(v, L), c.nivel_umid);
}

// Bandas cobrem o domínio sem buracos
for (const k of ['temp', 'umid']) {
  const b = r.bandas(k, L);
  assert.deepEqual([b[0].de, b.at(-1).ate], r.dominio(k, L));
  b.slice(1).forEach((x, i) => assert.equal(x.de, b[i].ate));
}

// Tudo que o servidor recusa, o formulário também recusa (e vice-versa)
const muda = (f) => { const l = structuredClone(L); f(l); return l; };
for (const l of [
  L,
  muda((x) => { x.temp.bom.max = 24; }), muda((x) => { x.temp.ruim.max = 130; }), muda((x) => { x.temp.otimo.min = NaN; }),
  muda((x) => { x.temp.otimo = { min: 25, max: 25 }; }), muda((x) => { x.umid.bom = 96; }), muda((x) => { x.umid.otimo = 101; }),
  muda((x) => { x.umid.ruim = -1; }), muda((x) => { x.histerese.temp = 6; }), muda((x) => { x.sem_dados_min = 10; }),
  muda((x) => { x.sem_dados_min = 12.5; }),
]) assert.equal(Object.keys(r.validar(l)).length === 0, s.validarLimites(l) === null);

// Intervalos: lacuna de 1 h vira "sem dados" depois de 25 min
const t0 = Date.parse('2026-11-19T12:00:00Z');
const serie = r.normalizar({
  agrupamento: 'bruto', de: new Date(t0).toISOString(), ate: new Date(t0 + 2 * r.HORA).toISOString(),
  leituras: [0, 10, 70, 80, 90, 100, 110, 120].map((m) => ({ medido_em: new Date(t0 + m * r.MIN).toISOString(), temp: 23, umid: 97, estado: 'otimo' })),
});
const d = r.duracoes(r.intervalos(serie, 25));
assert.equal(d.sem_dados, 35 * r.MIN);
assert.equal(d.otimo, 85 * r.MIN);

// Frases
const lei = { temp: 23, umid: 77.8, nivel_temp: 0, nivel_umid: 4, medido_em: new Date(t0).toISOString() };
const ok = { servidorOk: true };
assert.equal(r.fraseAlarme({ estado: 'alerta', leitura: lei, idade: 0 }, L, ok), 'Alerta: umidade em 77,8 %, abaixo do mínimo de 80 %.');
assert.match(r.fraseAlarme({ estado: 'alerta', leitura: { ...lei, umid: 80.4 }, idade: 0 }, L, ok), /voltando para dentro do limite/);
assert.match(r.fraseAlarme({ estado: 'sem_dados', leitura: lei, idade: 47 * r.MIN }, L, ok), /^Sem dados há 47 min: a câmara não envia leituras desde /);
assert.equal(r.situacao({ leitura: { ...lei, estado: 'bom' }, limites: L }, t0 + 26 * r.MIN).estado, 'sem_dados');
assert.equal(r.situacao({ leitura: { ...lei, estado: 'bom' }, limites: L }, t0 + 25 * r.MIN).estado, 'bom');
assert.equal(r.doCampo(r.paraCampo(t0)), t0);

console.log('regras: ok');
