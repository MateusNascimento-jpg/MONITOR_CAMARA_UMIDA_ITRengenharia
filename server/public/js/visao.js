// Visão geral: a tela da TV.
import { $, h, s, icone, etiqueta, rolar, segmentado, semMovimento } from './dom.js';
import { Grafico } from './grafico.js';
import { Proveta } from './regua.js';
import {
  NOME, NIVEIS, MEDIDA, HORA, DIA, normalizar, intervalos, duracoes, minMax, emAlarme, fraseEstado,
  n1, hora, dia, duracao, quando, dataHora,
} from './regras.js';

const PERIODOS = { 6: 'Últimas 6 horas', 24: 'Últimas 24 horas', 168: 'Últimos 7 dias', 720: 'Últimos 30 dias' };
const CHAVES = ['temp', 'umid'];

export function criarVisao({ api, malha, agora }) {
  const prov = Object.fromEntries(CHAVES.map((k) => [k, new Proveta($(`#prov-${k}`), k)]));
  const graf = new Grafico($('#graf-visao'), { rotulo: 'Temperatura e umidade no período. Use as setas do teclado para percorrer as leituras.' });
  let horas = 24, limites = null, vez = 0, chaveBusca = '', aberto = false;

  const marcar = segmentado($('#periodo'), (v) => { horas = Number(v); buscar(true); });
  marcar(24);

  async function buscar(animar) {
    if (!limites) return;
    const meu = ++vez;
    const ate = agora();
    $('#periodo-titulo').textContent = PERIODOS[horas];
    $('#cartao-graf').classList.add('carregando');
    try {
      const serie = normalizar(await api.historico(ate - horas * HORA, ate));
      if (meu !== vez) return;
      graf.mostrar(serie, limites, animar && (aberto ? 'trocar' : 'abrir'));
      aberto = true;
      extremosDoPeriodo(serie);
      rosca(serie);
    } catch { /* o indicador de conexão já mostra a falha; o último gráfico fica na tela */ }
    if (meu === vez) $('#cartao-graf').classList.remove('carregando');
  }

  function extremosDoPeriodo(serie) {
    const curto = serie.ate - serie.de <= DIA;
    for (const k of CHAVES) {
      const mm = minMax(serie, k);
      for (const q of ['min', 'max']) {
        const el = $(`#${k}-${q}`);
        $('strong', el).textContent = mm ? `${n1(mm[q].v)} ${MEDIDA[k].unidade}` : '–';
        $('small', el).textContent = mm ? (curto ? `às ${hora(mm[q].t)}` : `em ${dia(mm[q].t)}`) : '';
      }
    }
  }

  // Rosca: quanto tempo o período passou em cada estado
  const anel = $('#rosca-anel'), lista = $('#rosca-lista');
  function rosca(serie) {
    const soma = duracoes(intervalos(serie, limites.sem_dados_min));
    const total = Object.values(soma).reduce((a, b) => a + b, 0) || 1;
    const estados = [...NIVEIS, 'sem_dados'].filter((e) => soma[e]);
    const R = 42, C = 2 * Math.PI * R, vao = estados.length > 1 ? 1.6 : 0;
    let ac = 0;
    const arcos = estados.map((e) => {
      const f = soma[e] / total;
      const len = Math.max(0.8, f * C - vao);
      const c = s('circle', {
        class: `arco e-${e}`, cx: 60, cy: 60, r: R, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -(ac * C),
      }, s('title', {}, `${NOME[e]}: ${duracao(soma[e])}`));
      ac += f;
      return c;
    });
    const anima = !anel.childElementCount && !semMovimento();
    anel.replaceChildren(...arcos);
    if (anima) anel.animate([{ strokeDashoffset: 0, opacity: 0, transform: 'rotate(-120deg)' }, { opacity: 1, transform: 'none' }], { duration: 1300, easing: 'cubic-bezier(.2,.7,.1,1)' });
    const pct = ((soma.otimo || 0) + (soma.bom || 0)) / total * 100;
    // Nunca arredonda para 100 % quando houve desvio
    $('#rosca-centro').hidden = !serie.pontos.length;
    rolar($('#rosca-pct'), pct > 99.9 && pct < 100 ? '99,9' : n1(pct), `${n1(pct)} por cento do tempo em Ótimo ou Bom`);
    lista.replaceChildren(...estados.map((e) => h('li', { class: `e-${e}` }, icone(e), h('span', {}, NOME[e]), h('strong', {}, duracao(soma[e])))));
    $('#rosca-nota').textContent = serie.passo ? 'Cada hora conta pelo pior estado.' : '';
  }

  return {
    buscar,
    // Chamado a cada resposta da API
    receber(atual, forcar) {
      limites = atual.limites;
      const chave = JSON.stringify([atual.leitura && atual.leitura.medido_em, limites, Math.floor(agora() / (5 * 60e3))]);
      if (chave !== chaveBusca || forcar) {
        chaveBusca = chave;
        buscar(forcar);
      }
    },
    // Chamado a cada segundo e a cada resposta
    pintar(sit, lim) {
      const { estado, leitura, idade } = sit;
      const painel = $('#estado');
      if (painel.dataset.estado !== estado) {
        painel.dataset.estado = estado;
        painel.className = `cartao estado e-${estado}`;
        $('#estado-icone').replaceChildren(icone(estado));
        $('#estado-nome').textContent = NOME[estado];
        malha.estado(estado);
      }
      // Em alarme, a frase está na faixa do topo
      $('#estado-frase').textContent = emAlarme(estado) ? '' : fraseEstado(estado, leitura, lim);
      $('#ult-hora').textContent = leitura ? quando(leitura.medido_em, agora()) : '–';
      $('#ult-ha').textContent = leitura ? `há ${duracao(idade)}` : 'nenhuma leitura recebida';
      if (leitura) $('#ult-hora').title = dataHora(leitura.medido_em);

      const velho = estado === 'sem_dados';
      for (const k of CHAVES) {
        const cartao = $(`#cartao-${k}`);
        cartao.classList.toggle('velho', velho);
        const num = $(`#num-${k}`);
        if (leitura) {
          rolar(num, n1(leitura[k]), `${n1(leitura[k])} ${MEDIDA[k].unidade}`);
          const e = velho ? 'sem_dados' : NIVEIS[leitura[`nivel_${k}`]];
          etiqueta($(`#nivel-${k}`), e, velho ? 'Última leitura' : NOME[e]);
        } else {
          num.textContent = '–';
          delete num.dataset.v;
          delete num.dataset.forma;
          etiqueta($(`#nivel-${k}`), 'sem_dados', NOME.sem_dados);
        }
        if (lim) prov[k].mostrar(lim, leitura ? leitura[k] : null);
      }
    },
  };
}
