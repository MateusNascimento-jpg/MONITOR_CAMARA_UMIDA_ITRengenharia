// Dados simulados. Só é baixado quando a URL tem ?demo (ver app.js).
import { NIVEIS, LIMITES_PADRAO, MIN, HORA, DIA, GRUPO_MS, NOME, nivelTemp, nivelUmid, validar, n1, dataHora } from './regras.js';

const T0 = Date.now() - 4 * MIN; // ao abrir, última leitura "há 4 min"
const PASSO = 10 * MIN;
const N = 366 * 144;
let limites = structuredClone(LIMITES_PADRAO);
let cenario = 'otimo';
let cache = null;
let corte = Infinity; // em "sem dados", as leituras param aqui
const ultimo = () => Math.floor((Date.now() - T0) / PASSO); // uma leitura nova a cada 10 min

const ruido = (i, k) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
const suave = (i, k, p) => {
  const a = Math.floor(i / p), u = (i / p - a) ** 2 * (3 - 2 * (i / p - a));
  return ruido(a, k) * (1 - u) + ruido(a + 1, k) * u;
};
const rampa = (i, fim, larg) => Math.max(0, Math.min(1, (i - (fim - larg)) / larg));
// Porta aberta, manutenção: subida rápida e volta lenta, pico em `c`
const pulso = (i, c, sobe, desce) => (i <= c ? Math.max(0, 1 - (c - i) / sobe) : Math.exp(-(i - c) / desce));

function ponto(i) { // i = 0 é a leitura mais recente ao abrir; negativo = passado
  const t = T0 + i * PASSO;
  const h = ((t / HORA - 3) % 24 + 24) % 24;
  let temp = 23.1 + 0.75 * Math.sin(((h - 10) / 24) * 2 * Math.PI) + 0.35 * suave(i, 1, 18) + 0.05 * ruido(i, 2);
  let umid = 97.2 + 0.9 * suave(i, 3, 24) - 0.25 * Math.sin(((h - 10) / 24) * 2 * Math.PI) + 0.14 * ruido(i, 4);
  for (const [c, dt, du] of [[-70, 0.9, 3.1], [-318, 1.2, 6.5], [-905, 3.4, 9], [-1870, 0.8, 18.8], [-3010, 5.4, 4], [-9000, 4.2, 17], [-21000, 6.6, 8], [-35000, 2, 18]]) {
    const p = pulso(i, c, 3, 9);
    temp += dt * p; umid -= du * p;
  }
  if (cenario === 'medio') umid -= 9.4 * rampa(i, 0, 15) ** 1.4;
  if (cenario === 'alerta') { umid -= 19.2 * rampa(i, 0, 12) ** 1.6; temp += 1.6 * rampa(i, 0, 14); }
  return { t, temp: Math.round(temp * 100) / 100, umid: Math.min(100, Math.round(umid * 100) / 100) };
}

const naLacuna = (i) => (i > -262 && i < -243) || (i > -2600 && i < -2540) || (i > -15100 && i < -14700);

function serie() {
  const fim = Math.min(ultimo(), corte);
  if (!cache || cache.fim !== fim) {
    cache = [];
    cache.fim = fim;
    let nt, nu;
    for (let i = -N; i <= fim; i++) {
      if (naLacuna(i)) continue;
      const p = ponto(i);
      const hist = (f, v, m, ant) => {
        const b = f(v, limites);
        if (ant === undefined || b >= ant) return b;
        return Math.min(ant, Math.max(b, f(v - m, limites), f(v + m, limites)));
      };
      nt = hist(nivelTemp, p.temp, limites.histerese.temp, nt);
      nu = hist(nivelUmid, p.umid, limites.histerese.umid, nu);
      cache.push({ ...p, nivel_temp: nt, nivel_umid: nu, estado: NIVEIS[Math.max(nt, nu)] });
    }
  }
  return cache;
}

const iso = (t) => new Date(t).toISOString();

function historico(de, ate) {
  const L = serie().filter((p) => p.t >= de && p.t <= ate);
  const per = ate - de;
  const agrupamento = per <= 3 * DIA ? 'bruto' : per <= 30 * DIA ? '1h' : per <= 180 * DIA ? '6h' : per <= 3 * 365 * DIA ? '1d' : '7d';
  const base = { ok: true, device_id: 'camara-01', de: iso(de), ate: iso(ate), agrupamento };
  if (agrupamento === 'bruto') return { ...base, leituras: L.map((p) => ({ medido_em: iso(p.t), temp: p.temp, umid: p.umid, estado: p.estado })) };
  const g = GRUPO_MS[agrupamento], grupos = new Map();
  for (const p of L) {
    const k = Math.floor((p.t - 3 * HORA) / g) * g + 3 * HORA;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(p);
  }
  const ar = (v) => Math.round(v * 100) / 100;
  return {
    ...base,
    leituras: [...grupos].map(([k, ps]) => {
      const e = (c) => { const v = ps.map((p) => p[c]); return [ar(v.reduce((a, b) => a + b) / v.length), Math.min(...v), Math.max(...v)]; };
      const [tm, ti, ta] = e('temp'), [um, ui, ua] = e('umid');
      return {
        inicio: iso(k), temp_media: tm, temp_min: ti, temp_max: ta, umid_media: um, umid_min: ui, umid_max: ua,
        leituras: ps.length, pior_estado: NIVEIS[Math.max(...ps.map((p) => Math.max(p.nivel_temp, p.nivel_umid)))],
      };
    }),
  };
}

export const cenarios = ['otimo', 'medio', 'alerta', 'sem_dados'];
export function escolher(c) {
  cenario = c;
  corte = c === 'sem_dados' ? ultimo() - 5 : Infinity;
  cache = null;
}

export const api = {
  async atual() {
    const p = serie().at(-1), agora = Date.now();
    return {
      ok: true, device_id: 'camara-01', agora: iso(agora), sem_dados: agora - p.t > limites.sem_dados_min * MIN,
      leitura: { temp: p.temp, umid: p.umid, medido_em: iso(p.t), estado: p.estado, nivel_temp: p.nivel_temp, nivel_umid: p.nivel_umid },
      limites: structuredClone(limites),
    };
  },
  async historico(de, ate) { return historico(de, ate); },
  async salvar(novos, token) {
    await new Promise((r) => { setTimeout(r, 500); });
    if (token !== 'demo') throw Object.assign(new Error('não autorizado'), { status: 401 });
    const erro = Object.values(validar(novos))[0];
    if (erro) throw Object.assign(new Error(erro), { status: 400 });
    limites = structuredClone(novos);
    cache = null;
    return structuredClone(limites);
  },
  csv(de, ate) {
    const nome = (nv) => NOME[NIVEIS[nv]];
    const linhas = serie().filter((p) => p.t >= de && p.t <= ate)
      .map((p) => [`${dataHora(p.t)}:00`, n1(p.temp), n1(p.umid), nome(p.nivel_temp), nome(p.nivel_umid), NOME[p.estado]].join(';'));
    const texto = `﻿Data e hora (Brasília);Temperatura (°C);Umidade (%);Nível da temperatura;Nível da umidade;Estado geral\r\n${linhas.join('\r\n')}\r\n`;
    return URL.createObjectURL(new Blob([texto], { type: 'text/csv' }));
  },
};
