// Ponto de entrada: consulta a API, navega entre as páginas e cuida do alarme.
import { $, $$, h, icone, segmentado } from './dom.js';
import { Malha } from './malha.js';
import { criarVisao } from './visao.js';
import { criarHistorico } from './historico.js';
import { criarConfig } from './config.js';
import { abrir } from './abertura.js';
import * as alarme from './alarme.js';
import { NOME, MEDIDA, emAlarme, fraseAlarme, situacao, hora, seg, semana, n1 } from './regras.js';

const DEVICE = 'camara-01';

async function pedir(url, opcoes) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000), ...opcoes });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.ok) throw Object.assign(new Error(corpo.erro || `erro ${r.status}`), { status: r.status });
  return corpo;
}
const iso = (t) => encodeURIComponent(new Date(t).toISOString());
let api = {
  atual: () => pedir(`/api/atual?device_id=${DEVICE}`),
  historico: (de, ate) => pedir(`/api/historico?device_id=${DEVICE}&de=${iso(de)}&ate=${iso(ate)}`),
  csv: (de, ate) => `/api/historico.csv?device_id=${DEVICE}&de=${iso(de)}&ate=${iso(ate)}`,
  salvar: async (limites, token) => (await pedir('/api/limites', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ device_id: DEVICE, limites }),
  })).limites,
};

const demo = new URLSearchParams(location.search).has('demo') ? await import('./demo.js') : null;
if (demo) api = demo.api;

// ---- Estado da página ------------------------------------------------------

let atual = null, desvioRelogio = 0;
let pedido = 0, aplicado = 0; // consultas se cruzam: só vale a resposta mais nova
let revelado = false; // a abertura segura a primeira pintura para as animações não tocarem escondidas
const conexao = { servidorOk: true, falhaDesde: null };
const agora = () => Date.now() + desvioRelogio;

const malha = new Malha($('#malha'));
const visao = criarVisao({ api, malha, agora });
const historico = criarHistorico({ api, agora });
const config = criarConfig({ api, aoSalvar: () => consultar(true) });

let primeira;
const pronto = new Promise((r) => { primeira = r; });

function distribuir(forcar) {
  visao.receber(atual, forcar);
  historico.receber(atual);
  config.receber(atual);
}

async function consultar(forcar) {
  const meu = ++pedido;
  try {
    const resp = await api.atual();
    if (meu < aplicado) return;
    aplicado = meu;
    atual = resp;
    desvioRelogio = Date.parse(resp.agora) - Date.now();
    conexao.servidorOk = true;
    conexao.falhaDesde = null;
    if (revelado) distribuir(forcar);
    const pino = $('#conexao');
    pino.classList.remove('pulso');
    pino.offsetWidth;
    pino.classList.add('pulso');
  } catch {
    if (meu < aplicado) return;
    aplicado = meu;
    if (conexao.servidorOk) conexao.falhaDesde = agora();
    conexao.servidorOk = false;
  }
  pintar();
  primeira();
}

// ---- Pintura ---------------------------------------------------------------

function texto(el, t) { if (el.textContent !== t) el.textContent = t; }

function relogio() {
  const t = agora();
  texto($('#relogio-hm'), hora(t));
  texto($('#relogio-s'), seg(t));
  texto($('#relogio-dia'), semana(t));
}

function pintar() {
  if (!revelado || (!atual && conexao.servidorOk)) return; // ainda carregando
  const sit = situacao(atual, agora());
  const lim = atual && atual.limites;
  visao.pintar(sit, lim);

  const raiz = document.documentElement;
  raiz.dataset.estado = sit.estado;
  const alarmando = emAlarme(sit.estado);
  alarme.definir(alarmando ? sit.estado : null);
  const faixa = $('#faixa-alarme');
  if (alarmando) {
    texto($('#alarme-texto'), fraseAlarme(sit, lim, conexao));
    if (faixa.dataset.estado !== sit.estado) {
      faixa.dataset.estado = sit.estado;
      $('#alarme-icone').replaceChildren(icone(sit.estado));
    }
  }
  faixa.classList.toggle('ativa', alarmando);
  faixa.inert = !alarmando;

  const pino = $('#conexao');
  if (pino.dataset.ok !== String(conexao.servidorOk)) {
    pino.dataset.ok = String(conexao.servidorOk);
    pino.replaceChildren(icone(conexao.servidorOk ? 'vivo' : 'caiu'), h('span', {}, conexao.servidorOk ? 'Ao vivo' : 'Servidor inacessível'));
  }
  const l = sit.leitura;
  document.title = `${alarmando ? `${NOME[sit.estado].toUpperCase()} · ` : ''}${l ? `${n1(l.temp)} ${MEDIDA.temp.unidade} · ${n1(l.umid)} ${MEDIDA.umid.unidade} · ` : ''}Câmara úmida`;
}

// ---- Som -------------------------------------------------------------------

const botaoSom = $('#som'), botaoSilenciar = $('#silenciar');
let somAntes;
function pintarSom() {
  const ligado = alarme.ativo(), calado = alarme.estaSilenciado();
  const chave = `${ligado}${calado}`;
  if (chave === somAntes) return;
  somAntes = chave;
  botaoSom.hidden = ligado;
  $('#som-ok').hidden = !ligado;
  botaoSilenciar.hidden = !ligado;
  botaoSilenciar.disabled = calado;
  botaoSilenciar.replaceChildren(icone(calado ? 'mudo' : 'silenciar'), h('span', {}, calado ? 'Alarme silenciado' : 'Silenciar alarme'));
}
alarme.aoMudar(pintarSom);
botaoSom.addEventListener('click', () => alarme.ativar());
botaoSilenciar.addEventListener('click', () => alarme.silenciar());
alarme.retomar();
pintarSom();

// ---- Navegação -------------------------------------------------------------

const PAGINAS = ['visao', 'historico', 'config'];
function navegar() {
  const id = PAGINAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'visao';
  for (const p of PAGINAS) $(`#${p}`).hidden = p !== id;
  $$('#trilho a').forEach((a, i) => {
    const sim = a.hash === `#${id}`;
    if (sim) { a.setAttribute('aria-current', 'page'); $('#trilho').style.setProperty('--pos', i); } else a.removeAttribute('aria-current');
  });
  if (id === 'historico') historico.abrir();
  scrollTo(0, 0);
}
addEventListener('hashchange', navegar);
navegar();

// ---- Demonstração ----------------------------------------------------------

if (demo) {
  const caixa = $('#demo');
  caixa.hidden = false;
  const grupo = h('div', { class: 'seg vertical', role: 'group', 'aria-label': 'Cenário da demonstração' },
    ...demo.cenarios.map((c) => h('button', { type: 'button', 'data-valor': c }, NOME[c])));
  caixa.append(grupo);
  const marcar = segmentado(grupo, (c) => { demo.escolher(c); consultar(true); if (!$('#historico').hidden) historico.abrir(); });
  // ?demo=alerta abre direto no cenário
  const inicial = new URLSearchParams(location.search).get('demo');
  const c = demo.cenarios.includes(inicial) ? inicial : 'otimo';
  demo.escolher(c);
  marcar(c);
}

// ---- Início ----------------------------------------------------------------

relogio();
setInterval(() => { relogio(); pintar(); }, 1000);
setInterval(() => consultar(false), 30e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) consultar(false); });

const fontes = document.fonts.ready;
abrir(Promise.all([pronto, fontes]), malha, () => {
  revelado = true;
  pintar();
  if (atual) distribuir(true);
});
consultar(true);
