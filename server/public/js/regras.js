// Regras e formatos puros (sem DOM). Espelham server/estado.js; testados em regras.test.mjs.

export const NIVEIS = ['otimo', 'bom', 'medio', 'ruim', 'alerta'];
export const FAIXAS = ['otimo', 'bom', 'medio', 'ruim'];
export const NOME = {
  otimo: 'Ótimo', bom: 'Bom', medio: 'Médio', ruim: 'Ruim', alerta: 'Alerta', sem_dados: 'Sem dados',
};
export const MEDIDA = {
  temp: { nome: 'Temperatura', unidade: '°C' },
  umid: { nome: 'Umidade', unidade: '%' },
};
export const LIMITES_PADRAO = {
  temp: { otimo: { min: 21, max: 25 }, bom: { min: 20, max: 26 }, medio: { min: 20, max: 28 }, ruim: { min: 20, max: 30 } },
  umid: { otimo: 95, bom: 90, medio: 85, ruim: 80 },
  histerese: { temp: 0.3, umid: 1 },
  sem_dados_min: 25,
};

export const MIN = 60e3;
export const HORA = 60 * MIN;
export const DIA = 24 * HORA;
export const GRUPO_MS = { '1h': HORA, '6h': 6 * HORA, '1d': DIA, '7d': 7 * DIA };

// ---- Níveis ----------------------------------------------------------------

export function nivelTemp(t, lim) {
  const f = lim.temp;
  if (t >= f.otimo.min && t <= f.otimo.max) return 0;
  if (t >= f.bom.min && t < f.bom.max) return 1;
  if (t >= f.medio.min && t < f.medio.max) return 2;
  if (t >= f.ruim.min && t < f.ruim.max) return 3;
  return 4;
}

export function nivelUmid(u, lim) {
  const i = FAIXAS.findIndex((k) => u >= lim.umid[k]);
  return i < 0 ? 4 : i;
}

export const nivelDe = (chave, v, lim) => (chave === 'temp' ? nivelTemp(v, lim) : nivelUmid(v, lim));

// Escala da régua: um pouco além dos limites de alerta, sempre a partir dos limites da API
export function dominio(chave, lim) {
  if (chave === 'temp') {
    const { min, max } = lim.temp.ruim;
    const folga = Math.max(1, (max - min) * 0.2);
    return [min - folga, max + folga];
  }
  return [Math.max(0, lim.umid.ruim - Math.max(4, (100 - lim.umid.ruim) * 0.4)), 100];
}

export function bandas(chave, lim) {
  const [lo, hi] = dominio(chave, lim);
  let cortes, niveis;
  if (chave === 'temp') {
    const t = lim.temp;
    cortes = [lo, t.ruim.min, t.medio.min, t.bom.min, t.otimo.min, t.otimo.max, t.bom.max, t.medio.max, t.ruim.max, hi];
    niveis = [4, 3, 2, 1, 0, 1, 2, 3, 4];
  } else {
    const u = lim.umid;
    cortes = [lo, u.ruim, u.medio, u.bom, u.otimo, hi];
    niveis = [4, 3, 2, 1, 0];
  }
  return niveis
    .map((n, i) => ({ de: cortes[i], ate: cortes[i + 1], nivel: n, estado: NIVEIS[n] }))
    .filter((b) => b.ate > b.de);
}

export function ideal(chave, lim) {
  return chave === 'temp' ? [lim.temp.otimo.min, lim.temp.otimo.max] : [lim.umid.otimo, 100];
}

// Limites de alerta da grandeza
export function extremos(chave, lim) {
  return chave === 'temp' ? [lim.temp.ruim.min, lim.temp.ruim.max] : [lim.umid.ruim];
}

// ---- Estado atual ----------------------------------------------------------

// `atual` é a resposta de /api/atual; `agora` já corrigido pelo relógio do servidor.
// Recalcula "sem dados" aqui porque o servidor pode estar inacessível.
export function situacao(atual, agora) {
  if (!atual || !atual.leitura) return { estado: 'sem_dados', leitura: null, idade: null };
  const idade = Math.max(0, agora - Date.parse(atual.leitura.medido_em));
  const vencida = idade > atual.limites.sem_dados_min * MIN;
  return { estado: vencida ? 'sem_dados' : atual.leitura.estado, leitura: atual.leitura, idade };
}

export const emAlarme = (estado) => estado === 'alerta' || estado === 'sem_dados';

function desvio(chave, v, lim, nivelAlvo) {
  const { unidade } = MEDIDA[chave];
  const nome = chave === 'temp' ? 'temperatura' : 'umidade';
  const faixa = nivelAlvo === 4 ? extremos(chave, lim) : ideal(chave, lim);
  const alvo = nivelAlvo === 4 ? ['mínimo', 'máximo'] : ['ideal', 'ideal'];
  const valor = `${nome} em ${n1(v)} ${unidade}`;
  const lado = (texto, i) => `${valor}, ${texto} ${alvo[i]} de ${n(faixa[i])} ${unidade}`;
  if (v < faixa[0]) return lado('abaixo do', 0);
  if (chave === 'temp' && v > faixa[1]) return lado('acima do', 1);
  if (chave === 'temp' && v === faixa[1]) return lado('no', 1);
  // Valor já voltou, mas a histerese do servidor ainda segura o nível
  return `${valor}, voltando ${nivelAlvo === 4 ? 'para dentro do limite' : 'à faixa ideal'}`;
}

export function fraseEstado(estado, leitura, lim) {
  if (estado === 'otimo') return 'Temperatura e umidade na faixa ideal.';
  const pior = Math.max(leitura.nivel_temp, leitura.nivel_umid);
  const partes = ['temp', 'umid']
    .filter((k) => leitura[`nivel_${k}`] === pior)
    .map((k) => desvio(k, leitura[k], lim, pior === 4 ? 4 : 0));
  const frase = partes.join(' e ');
  return `${frase[0].toUpperCase()}${frase.slice(1)}.`;
}

export function fraseAlarme({ estado, leitura, idade }, lim, { servidorOk, falhaDesde }) {
  if (estado === 'alerta') {
    const f = fraseEstado(estado, leitura, lim);
    return `Alerta: ${f[0].toLowerCase()}${f.slice(1)}`;
  }
  if (!servidorOk) {
    const desde = falhaDesde ? ` desde ${hora(falhaDesde)}` : '';
    return `Sem dados: o painel não alcança o servidor${desde}. Verifique a internet e o servidor.`;
  }
  if (!leitura) return 'Sem dados: a câmara ainda não enviou nenhuma leitura. Verifique o equipamento e o Wi-Fi.';
  return `Sem dados há ${duracao(idade)}: a câmara não envia leituras desde ${quando(leitura.medido_em)}. Verifique o equipamento e o Wi-Fi.`;
}

// ---- Séries ----------------------------------------------------------------

// Unifica leituras brutas e agregadas
export function normalizar(h) {
  const passo = GRUPO_MS[h.agrupamento] || 0;
  const de = Date.parse(h.de), ate = Date.parse(h.ate);
  // Meio do intervalo, só da parte que cai dentro do período (o primeiro e o último podem ser parciais)
  const meio = (ini) => (Math.max(ini, de) + Math.min(ini + passo, ate)) / 2;
  const pontos = h.leituras.map((l) => passo
    ? {
      ini: Date.parse(l.inicio), t: meio(Date.parse(l.inicio)), estado: l.pior_estado, n: l.leituras,
      temp: { v: l.temp_media, min: l.temp_min, max: l.temp_max },
      umid: { v: l.umid_media, min: l.umid_min, max: l.umid_max },
    }
    : {
      ini: Date.parse(l.medido_em), t: Date.parse(l.medido_em), estado: l.estado, n: 1,
      temp: { v: l.temp, min: l.temp, max: l.temp },
      umid: { v: l.umid, min: l.umid, max: l.umid },
    });
  return { passo, agrupamento: h.agrupamento, de, ate, pontos };
}

// Linha do tempo de estados, com as lacunas como "sem_dados".
// Em leituras brutas, o trecho antes da primeira fica em branco enquanto a anterior ao período ainda podia valer.
export function intervalos(serie, semDadosMin) {
  const { passo, pontos, de, ate } = serie;
  const alcance = passo || semDadosMin * MIN;
  const out = [];
  const por = (ini, fim, estado) => {
    ini = Math.max(ini, de); fim = Math.min(fim, ate);
    if (fim <= ini) return;
    const u = out[out.length - 1];
    if (u && u.estado === estado && u.fim >= ini) u.fim = fim;
    else out.push({ ini, fim, estado });
  };
  let cursor = passo ? de : de + alcance;
  pontos.forEach((p, i) => {
    por(cursor, p.ini, 'sem_dados');
    const prox = pontos[i + 1] ? pontos[i + 1].ini : Infinity;
    const fim = Math.min(p.ini + alcance, prox);
    por(p.ini, fim, p.estado);
    cursor = fim;
  });
  por(cursor, ate, 'sem_dados');
  return out;
}

export function duracoes(lista) {
  const soma = {};
  for (const i of lista) soma[i.estado] = (soma[i.estado] || 0) + (i.fim - i.ini);
  return soma;
}

export function minMax(serie, chave) {
  if (!serie.pontos.length) return null;
  let min = serie.pontos[0], max = min;
  for (const p of serie.pontos) {
    if (p[chave].min < min[chave].min) min = p;
    if (p[chave].max > max[chave].max) max = p;
  }
  return { min: { v: min[chave].min, t: min.t }, max: { v: max[chave].max, t: max.t } };
}

export function media(serie, chave) {
  let soma = 0, peso = 0;
  for (const p of serie.pontos) { soma += p[chave].v * p.n; peso += p.n; }
  return peso ? soma / peso : null;
}

// ---- Validação dos limites --------------------------------------------------

// Devolve { campo: mensagem }. Campos: "temp.otimo", "umid.bom", "histerese.temp", "sem_dados_min".
export function validar(l) {
  const e = {};
  const ok = Number.isFinite;
  const nm = (k) => NOME[k];
  for (const k of FAIXAS) {
    const f = l.temp[k];
    if (!ok(f.min) || !ok(f.max)) e[`temp.${k}`] = 'Preencha o mínimo e o máximo.';
    else if (f.min < -40 || f.max > 125) e[`temp.${k}`] = 'Use valores entre −40 e 125 °C.';
    else if (f.min >= f.max) e[`temp.${k}`] = 'O mínimo precisa ser menor que o máximo.';
    if (!ok(l.umid[k])) e[`umid.${k}`] = 'Preencha o limite.';
    else if (l.umid[k] < 0 || l.umid[k] > 100) e[`umid.${k}`] = 'Use um valor entre 0 e 100 %.';
  }
  for (let i = 1; i < FAIXAS.length; i++) {
    const [a, b] = [FAIXAS[i - 1], FAIXAS[i]];
    const [x, y] = [l.temp[a], l.temp[b]];
    if (!e[`temp.${a}`] && !e[`temp.${b}`] && (y.min > x.min || y.max < x.max)) {
      e[`temp.${b}`] = `A faixa ${nm(b)} precisa conter a faixa ${nm(a)} (${n(x.min)} a ${n(x.max)} °C).`;
    }
    if (!e[`umid.${a}`] && !e[`umid.${b}`] && l.umid[b] > l.umid[a]) {
      e[`umid.${b}`] = `${nm(b)} não pode passar de ${nm(a)} (${n(l.umid[a])} %).`;
    }
  }
  if (!ok(l.histerese.temp) || l.histerese.temp < 0 || l.histerese.temp > 5) e['histerese.temp'] = 'Use um valor entre 0 e 5 °C.';
  if (!ok(l.histerese.umid) || l.histerese.umid < 0 || l.histerese.umid > 10) e['histerese.umid'] = 'Use um valor entre 0 e 10 %.';
  if (!Number.isInteger(l.sem_dados_min) || l.sem_dados_min < 11 || l.sem_dados_min > 1440) {
    e.sem_dados_min = 'Use um número inteiro de 11 a 1440 minutos.';
  }
  return e;
}

// ---- Formatos (pt-BR, Brasília) ---------------------------------------------

const TZ = 'America/Sao_Paulo';
const dtf = (o) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...o });
const fHora = dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fSeg = dtf({ second: '2-digit' });
const fDia = dtf({ day: '2-digit', month: '2-digit' });
const fDiaAno = dtf({ day: '2-digit', month: '2-digit', year: 'numeric' });
const fMes = dtf({ month: 'short', year: '2-digit' });
const fSemana = dtf({ weekday: 'long', day: 'numeric', month: 'long' });

export const n1 = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const n = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
export const hora = (d) => fHora.format(new Date(d));
export const seg = (d) => fSeg.format(new Date(d)).padStart(2, '0');
export const dia = (d) => fDia.format(new Date(d));
export const diaAno = (d) => fDiaAno.format(new Date(d));
export const mes = (d) => fMes.format(new Date(d)).replace('.', '').replace(' de ', '/');
export const semana = (d) => fSemana.format(new Date(d));
export const dataHora = (d) => `${diaAno(d)} ${hora(d)}`;
export const quando = (d, agora = Date.now()) => (dia(d) === dia(agora) ? hora(d) : `${dia(d)} às ${hora(d)}`);

export function duracao(ms) {
  const m = Math.floor(ms / MIN);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} dias`;
}

// shortcut: Brasília é UTC−3 fixo (sem horário de verão desde 2019); rever se ele voltar
const FUSO = 3 * HORA;
export const paraCampo = (ms) => new Date(ms - FUSO).toISOString().slice(0, 16);
export const doCampo = (s) => (s ? Date.parse(`${s}:00Z`) + FUSO : NaN);
export const alinhar = (ms, passo) => Math.ceil((ms - FUSO) / passo) * passo + FUSO;
