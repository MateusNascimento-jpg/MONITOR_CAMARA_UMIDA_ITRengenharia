// Histórico: período livre, zoom por arraste e exportação.
import { $, rolar, segmentado } from './dom.js';
import { Grafico } from './grafico.js';
import {
  MEDIDA, MIN, HORA, normalizar, intervalos, duracoes, minMax, media, n1, duracao, dataHora, paraCampo, doCampo,
} from './regras.js';

const GRUPO = {
  bruto: 'Leitura a leitura', '1h': 'Média por hora, com mínimo e máximo', '6h': 'Média a cada 6 h, com mínimo e máximo',
  '1d': 'Média por dia, com mínimo e máximo', '7d': 'Média por semana, com mínimo e máximo',
};
const INTERVALO = { '1h': 'Horas', '6h': 'Blocos de 6 h', '1d': 'Dias', '7d': 'Semanas' };

export function criarHistorico({ api, agora }) {
  const graf = new Grafico($('#graf-hist'), {
    rotulo: 'Histórico de temperatura e umidade. Arraste para ampliar. Use as setas do teclado para percorrer as leituras.',
    aoZoom: (de, ate) => {
      pilha.push({ ...janela });
      ir({ horas: null, de: Math.round(de), ate: Math.max(Math.round(ate), Math.round(de) + 60e3) });
    },
  });
  const pilha = [];
  let janela = { horas: 24 }, limites = null, vez = 0, ultima = null, ultimosLimites = null;
  const de = $('#hist-de'), ate = $('#hist-ate'), erro = $('#hist-erro'), voltar = $('#hist-voltar'), csv = $('#hist-csv');

  const marcar = segmentado($('#hist-atalhos'), (v) => { pilha.length = 0; ir({ horas: Number(v) }); });
  voltar.addEventListener('click', () => ir(pilha.pop()));
  $('#hist-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const a = doCampo(de.value), b = doCampo(ate.value);
    erro.textContent = Number.isNaN(a) || Number.isNaN(b) ? 'Preencha a data e a hora de início e de fim.'
      : a >= b ? 'O início precisa ser antes do fim.'
        : a >= agora() ? 'O início precisa estar no passado.' : '';
    if (erro.textContent) return;
    pilha.length = 0;
    ir({ horas: null, de: a, ate: b });
  });

  function ir(nova) {
    janela = nova.horas ? nova : { ...nova, ate: Math.min(nova.ate, agora()) }; // o que ainda não aconteceu não é "sem dados"
    buscar(true);
  }

  async function buscar(animar) {
    if (!limites) return;
    const meu = ++vez;
    const fim = janela.horas ? agora() : janela.ate;
    const ini = janela.horas ? fim - janela.horas * HORA : janela.de;
    marcar(janela.horas || '');
    voltar.hidden = !pilha.length;
    if (animar || document.activeElement !== de && document.activeElement !== ate) {
      de.value = paraCampo(ini);
      ate.value = paraCampo(Math.ceil(fim / MIN) * MIN); // o campo só tem minutos: para cima, para não cortar o último
    }
    if (csv.href.startsWith('blob:')) URL.revokeObjectURL(csv.href);
    csv.href = api.csv(ini, fim);
    csv.download = `camara-umida.${csv.href.startsWith('blob:') ? 'csv' : 'xlsx'}`; // a demonstração gera CSV
    erro.textContent = '';
    $('#cartao-hist').classList.add('carregando');
    try {
      const serie = normalizar(await api.historico(ini, fim));
      if (meu !== vez) return;
      graf.mostrar(serie, limites, animar && 'trocar');
      $('#hist-grupo').textContent = GRUPO[serie.agrupamento];
      $('#hist-titulo').textContent = `${dataHora(serie.de)} a ${dataHora(serie.ate)}`;
      resumo(serie);
    } catch (e) {
      if (meu === vez) erro.textContent = e.status === 400 ? `Período recusado pelo servidor: ${e.message}.` : 'Não foi possível buscar o histórico. Confira a conexão e tente de novo.';
    }
    if (meu === vez) $('#cartao-hist').classList.remove('carregando');
  }

  function resumo(serie) {
    for (const k of ['temp', 'umid']) {
      const m = media(serie, k), mm = minMax(serie, k), u = MEDIDA[k].unidade;
      const num = $(`#res-${k}`);
      if (m === null) { num.textContent = '–'; delete num.dataset.v; delete num.dataset.forma; } else rolar(num, n1(m), `${n1(m)} ${u}`);
      $(`#res-${k}-mm`).textContent = mm ? `de ${n1(mm.min.v)} a ${n1(mm.max.v)} ${u}` : 'sem leituras';
    }
    const d = duracoes(intervalos(serie, limites.sem_dados_min));
    const por = (id, texto) => { $(`#res-${id}`).textContent = texto || 'Nenhum'; $(`#res-${id}`).classList.toggle('zero', !texto); };
    // Agregado: o servidor manda só o pior estado de cada intervalo, então conta intervalos, não duração
    const alertas = serie.pontos.filter((p) => p.estado === 'alerta').length;
    const nome = INTERVALO[serie.agrupamento];
    $('#res-alerta-nome').textContent = nome ? `${nome} com Alerta` : 'Tempo em Alerta';
    por('alerta', nome ? alertas && String(alertas) : d.alerta && duracao(d.alerta));
    $('#res-alerta-nota').textContent = nome ? `de ${serie.pontos.length} com leitura` : 'no período';
    por('sem', d.sem_dados && duracao(d.sem_dados));
    $('#res-sem-nota').textContent = nome ? 'intervalos sem nenhuma leitura' : 'lacunas hachuradas no gráfico';
  }

  return {
    abrir: () => buscar(true),
    receber(atual) {
      limites = atual.limites;
      // A cada 5 min o período relativo anda, mesmo sem leitura nova: a lacuna precisa crescer
      const chave = JSON.stringify([atual.leitura && atual.leitura.medido_em, Math.floor(agora() / (5 * 60e3))]);
      const lim = JSON.stringify(limites);
      const andou = chave !== ultima && (janela.horas || !graf.serie), mudouLimite = lim !== ultimosLimites;
      ultima = chave;
      ultimosLimites = lim;
      if (!$('#historico').hidden && (andou || mudouLimite)) buscar(false);
    },
  };
}
