// Gráfico duplo em SVG: temperatura e umidade empilhadas, mesmo eixo do tempo,
// linha do tempo de estados embaixo. Um eixo Y por painel.
import { h, s, icone, semMovimento } from './dom.js';
import {
  MEDIDA, NOME, NIVEIS, MIN, HORA, DIA, ideal, extremos, nivelDe, intervalos, minMax,
  n, n1, hora, dia, mes, dataHora, diaAno, alinhar, duracao,
} from './regras.js';

const CHAVES = ['temp', 'umid'];
const PASSOS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HORA, 2 * HORA, 3 * HORA, 4 * HORA, 6 * HORA, 12 * HORA, DIA, 2 * DIA, 5 * DIA, 7 * DIA, 14 * DIA, 30 * DIA, 61 * DIA, 122 * DIA, 365 * DIA];
let serial = 0;

function marcas(lo, hi, alvo) {
  const bruto = (hi - lo) / alvo, pot = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 5, 10].map((m) => m * pot).find((p) => p >= bruto);
  const out = [];
  for (let v = Math.ceil(lo / passo) * passo; v <= hi + 1e-9; v += passo) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// Cúbica monótona (Fritsch–Carlson): curva suave que nunca passa dos valores medidos
function curva(p, inicio = 'M') {
  if (!p.length) return '';
  let d = `${inicio}${p[0][0]},${p[0][1]}`;
  if (p.length < 2) return d;
  const dx = [], m = [], t = [];
  for (let i = 0; i < p.length - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  t[0] = m[0]; t[p.length - 1] = m[m.length - 1];
  for (let i = 1; i < p.length - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  }
  const f = (v) => v.toFixed(1);
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1], k = dx[i] / 3;
    d += `C${f(x0 + k)},${f(y0 + t[i] * k)} ${f(x1 - k)},${f(y1 - t[i + 1] * k)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

export class Grafico {
  constructor(raiz, { rotulo, aoZoom } = {}) {
    this.raiz = raiz;
    this.aoZoom = aoZoom;
    this.id = `g${++serial}`;
    this.svg = s('svg', { class: 'graf', role: 'group', tabindex: '0', 'aria-label': rotulo });
    this.dica = h('div', { class: 'dica', 'aria-hidden': 'true' });
    this.fala = h('p', { class: 'lido', 'aria-live': 'polite' });
    this.vazio = h('p', { class: 'graf-vazio' }, 'Nenhuma leitura neste período.');
    raiz.append(this.svg, this.dica, this.fala, this.vazio);
    new ResizeObserver(() => this.desenhar()).observe(raiz);
    this.ouvir();
  }

  // dados: { serie, limites }
  mostrar(serie, limites, animar) {
    this.serie = serie;
    this.limites = limites;
    this.faixas = intervalos(serie, limites.sem_dados_min);
    this.vazio.hidden = serie.pontos.length > 0;
    this.desenhar(animar);
  }

  desenhar(animar) {
    const { serie, limites, raiz, svg, id } = this;
    const W = raiz.clientWidth, H = raiz.clientHeight;
    if (!serie || W < 60 || H < 60) return;
    const r = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const m = { l: 3.1 * r, r: 1.1 * r, t: 1.75 * r, b: 1.7 * r };
    const faixaH = 0.7 * r, vao = 2.1 * r, vaoFaixa = 0.6 * r;
    const ph = (H - m.t - m.b - vao - vaoFaixa - faixaH) / 2;
    const { de, ate, passo, pontos } = serie;
    const x = (t) => m.l + ((t - de) / (ate - de)) * (W - m.l - m.r);
    this.geo = { x, W, H, m, inv: (px) => de + ((px - m.l) / (W - m.l - m.r)) * (ate - de) };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const base = s('g'), movel = s('g', { class: 'movel' });
    const defs = s('defs', {},
      s('clipPath', { id: `${id}-c` }, (this.cortina = s('rect', { x: m.l - 2, y: 0, width: W - m.l - m.r + 2 + 0.5 * r, height: H, class: 'cortina' }))),
      s('pattern', { id: `${id}-h`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 2, height: 7, class: 'hachura' })),
      ...CHAVES.map((k) => s('linearGradient', { id: `${id}-${k}`, x1: 0, x2: 0, y1: 0, y2: 1, class: `serie-${k}` },
        s('stop', { offset: '0', class: 'deg-a' }), s('stop', { offset: '1', class: 'deg-b' }))));

    // Eixo do tempo
    const cabe = Math.max(3, Math.floor((W - m.l - m.r) / (4.6 * r)));
    const pt = PASSOS.find((p) => (ate - de) / p <= cabe) || PASSOS[PASSOS.length - 1];
    const yFim = H - m.b;
    for (let t = alinhar(de, pt); t <= ate; t += pt) {
      const meiaNoite = hora(t) === '00:00';
      base.append(s('line', { class: 'grade', x1: x(t), x2: x(t), y1: m.t, y2: m.t + ph * 2 + vao }));
      const texto = pt >= 30 * DIA ? mes(t) : pt >= DIA || meiaNoite ? dia(t) : hora(t);
      if (x(t) < W - m.r - r * 0.6) base.append(s('text', { class: `eixo${meiaNoite && pt < DIA ? ' forte' : ''}`, x: x(t), y: yFim + 1.15 * r, 'text-anchor': 'middle' }, texto));
    }

    // Painéis
    this.pos = {};
    const limGap = passo ? passo * 1.5 : limites.sem_dados_min * MIN;
    const trechos = [];
    pontos.forEach((p, i) => {
      if (!i || p.ini - pontos[i - 1].ini > limGap) trechos.push([]); // pelo início: o meio de um intervalo parcial se desloca
      trechos[trechos.length - 1].push(p);
    });

    CHAVES.forEach((k, i) => {
      const y0 = m.t + i * (ph + vao), y1 = y0 + ph;
      const faixa = ideal(k, limites);
      const mm = minMax(serie, k);
      let lo = Math.min(faixa[0], mm ? mm.min.v : Infinity), hi = Math.max(faixa[1], mm ? mm.max.v : -Infinity);
      const folga = Math.max(0.4, (hi - lo) * 0.14);
      lo -= folga;
      hi = k === 'umid' ? Math.max(100, hi) : hi + folga;
      const y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
      this.pos[k] = { y, y0, y1 };
      const g = s('g', { class: `serie-${k}` });

      const ymax = Math.max(y0, y(faixa[1])), ymin = Math.min(y1, y(faixa[0]));
      g.append(s('rect', { class: 'ideal', x: m.l, width: W - m.l - m.r, y: ymax, height: ymin - ymax }));
      for (const v of marcas(lo, hi, Math.max(2, Math.floor(ph / (2.1 * r))))) {
        g.append(s('line', { class: 'grade', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
        g.append(s('text', { class: 'eixo', x: m.l - 0.55 * r, y: y(v) + 0.28 * r, 'text-anchor': 'end' }, n(v)));
      }
      // Limites de alerta, quando entram na escala
      for (const v of extremos(k, limites)) {
        if (v <= lo || v >= hi) continue;
        g.append(s('line', { class: 'limite', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      }
      // Momentos fora da faixa desta grandeza
      const meio = (a, b) => (a.t + b.t) / 2;
      for (const tr of trechos) {
        tr.forEach((p, j) => {
          const nv = Math.max(nivelDe(k, p[k].min, limites), nivelDe(k, p[k].max, limites));
          if (nv < 3) return;
          const a = j ? meio(tr[j - 1], p) : p.t - (passo || 10 * MIN) / 2;
          const b = tr[j + 1] ? meio(p, tr[j + 1]) : p.t + (passo || 10 * MIN) / 2;
          const xa = Math.max(m.l, x(a)), xb = Math.min(W - m.r, x(b));
          g.append(s('rect', { class: `fora e-${NIVEIS[nv]}`, x: xa, width: Math.max(0.5, xb - xa), y: y0, height: ph }));
        });
      }
      for (const f of this.faixas.filter((q) => q.estado === 'sem_dados')) {
        g.append(s('rect', { class: 'lacuna', fill: `url(#${id}-h)`, x: x(f.ini), width: x(f.fim) - x(f.ini), y: y0, height: ph }));
        if (i === 0 && pontos.length && x(f.fim) - x(f.ini) > 5.5 * r) {
          g.append(s('text', { class: 'eixo halo', x: (x(f.ini) + x(f.fim)) / 2, y: y0 + ph / 2 + 0.3 * r, 'text-anchor': 'middle' }, 'sem dados'));
        }
      }

      const tinta = s('g', { 'clip-path': `url(#${id}-c)` });
      for (const tr of trechos) {
        const L = tr.map((p) => [x(p.t), y(p[k].v)]);
        if (passo) {
          const topo = tr.map((p) => [x(p.t), y(p[k].max)]), pe = tr.map((p) => [x(p.t), y(p[k].min)]).reverse();
          if (tr.length > 1) tinta.append(s('path', { class: 'amplitude', d: `${curva(topo)}${curva(pe, 'L')}Z` }));
        } else if (tr.length > 1) {
          tinta.append(s('path', { fill: `url(#${id}-${k})`, d: `${curva(L)}L${L[L.length - 1][0]},${y1}L${L[0][0]},${y1}Z` }));
        }
        tinta.append(tr.length > 1 ? s('path', { class: 'linha', d: curva(L) }) : s('circle', { class: 'solto', cx: L[0][0], cy: L[0][1], r: 0.2 * r }));
      }
      g.append(tinta);

      g.append(s('line', { class: 'chave', x1: m.l, x2: m.l + 1.1 * r, y1: y0 - 0.85 * r, y2: y0 - 0.85 * r }));
      g.append(s('text', { class: 'painel-titulo', x: m.l + 1.5 * r, y: y0 - 0.55 * r }, `${MEDIDA[k].nome} (${MEDIDA[k].unidade})`));
      // Rótulo da faixa ideal no canto mais livre de dados
      if (ymin - ymax > 1.1 * r) {
        const larg = 5 * r;
        const cantos = [[true, true], [true, false], [false, true], [false, false]].map(([dir, topo]) => {
          const ty = topo ? ymax + 0.55 * r : ymin - 0.55 * r;
          const perto = pontos.filter((p) => (dir ? x(p.t) > W - m.r - larg : x(p.t) < m.l + larg));
          return { dir, ty, folga: Math.min(Infinity, ...perto.map((p) => Math.abs(y(p[k].v) - ty))) };
        });
        const c = cantos.find((q) => q.folga > 1.1 * r) || cantos.sort((a, b) => b.folga - a.folga)[0];
        g.append(s('text', { class: 'eixo halo', x: c.dir ? W - m.r - 0.4 * r : m.l + 0.4 * r, y: c.ty + 0.3 * r, 'text-anchor': c.dir ? 'end' : 'start' }, 'faixa ideal'));
      }
      const ult = pontos[pontos.length - 1];
      if (ult && ate - ult.t <= limGap) tinta.append(s('circle', { class: 'ponta', cx: x(ult.t), cy: y(ult[k].v), r: 0.3 * r }));
      base.append(g);
    });

    // Linha do tempo de estados
    const yf = H - m.b - faixaH;
    for (const f of this.faixas) {
      const w = x(f.fim) - x(f.ini);
      base.append(s('rect', { class: `faixa e-${f.estado}`, x: x(f.ini), y: yf, width: Math.max(1, w - (w > 6 ? 1.5 : 0)), height: faixaH, rx: Math.min(2, w / 3) }));
    }
    svg.replaceChildren(defs, base, movel);
    this.movel = movel;
    this.yf = yf;
    this.sair();

    if (animar && !semMovimento()) {
      this.cortina.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: animar === 'abrir' ? 1500 : 650, easing: 'cubic-bezier(.3,.1,.1,1)' });
    }
  }

  // ---- Interação -----------------------------------------------------------

  ouvir() {
    const { svg } = this;
    const px = (e) => {
      const c = svg.getBoundingClientRect();
      const { W, m } = this.geo;
      return Math.max(m.l, Math.min(W - m.r, e.clientX - c.left));
    };
    let ini = null, sel = null;
    svg.addEventListener('pointerdown', (e) => {
      if (!this.aoZoom || !this.geo || e.button) return;
      ini = px(e);
      sel = s('rect', { class: 'selecao', y: this.geo.m.t, height: this.yf - this.geo.m.t, x: ini, width: 0 });
      this.movel.append(sel);
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!this.geo || !this.serie.pontos.length) return;
      const p = px(e);
      this.apontar(this.geo.inv(p));
      if (ini !== null && sel) {
        sel.setAttribute('x', Math.min(ini, p));
        sel.setAttribute('width', Math.abs(p - ini));
        this.movel.append(sel);
      }
    });
    const soltar = (e) => {
      if (ini === null) return;
      const a = ini, b = px(e);
      ini = null; sel.remove(); sel = null;
      if (e.type === 'pointerup' && Math.abs(b - a) > 12) this.aoZoom(...[this.geo.inv(a), this.geo.inv(b)].sort((p, q) => p - q));
    };
    svg.addEventListener('pointerup', soltar);
    svg.addEventListener('pointercancel', soltar);
    svg.addEventListener('pointerleave', () => { if (ini === null) this.sair(); });
    svg.addEventListener('blur', () => this.sair());
    svg.addEventListener('keydown', (e) => {
      if (!this.serie || !this.serie.pontos.length) return;
      const ult = this.serie.pontos.length - 1;
      const atual = this.foco ?? ult + 1;
      const alvo = { ArrowLeft: atual - 1, ArrowRight: atual + 1, Home: 0, End: ult }[e.key];
      if (e.key === 'Escape') this.sair();
      if (alvo === undefined) return;
      e.preventDefault();
      this.foco = Math.max(0, Math.min(ult, alvo));
      const p = this.serie.pontos[this.foco];
      this.apontar(p.t);
      this.fala.textContent = `${dataHora(p.t)}: ${n1(p.temp.v)} °C, ${n1(p.umid.v)} %, ${NOME[p.estado]}`;
    });
  }

  sair() {
    this.foco = undefined;
    if (this.movel) this.movel.replaceChildren();
    this.dica.classList.remove('ativa');
  }

  apontar(t) {
    const { pontos, passo } = this.serie;
    let a = 0, b = pontos.length - 1;
    while (b - a > 1) { const c = (a + b) >> 1; if (pontos[c].t <= t) a = c; else b = c; }
    const p = Math.abs(pontos[a].t - t) <= Math.abs(pontos[b].t - t) ? pontos[a] : pontos[b];
    const f = this.faixas.find((q) => t >= q.ini && t <= q.fim);
    const lacuna = f && f.estado === 'sem_dados';
    const { x, W, m } = this.geo;
    const r = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const cx = x(lacuna ? t : p.t);

    const itens = [s('line', { class: 'mira', x1: cx, x2: cx, y1: m.t - 0.2 * r, y2: this.yf + 0.7 * r })];
    if (!lacuna) CHAVES.forEach((k) => itens.push(s('circle', { class: `ponta serie-${k}`, cx, cy: this.pos[k].y(p[k].v), r: 0.32 * r })));
    this.movel.replaceChildren(...itens);

    const linhas = [];
    if (lacuna) {
      linhas.push(h('b', {}, `${dataHora(f.ini)} a ${dataHora(f.fim)}`), h('span', { class: 'nivel e-sem_dados' }, icone('sem_dados'), `Sem dados por ${duracao(f.fim - f.ini)}`));
    } else {
      const ate = p.ini + passo;
      linhas.push(h('b', {}, passo >= DIA ? (passo > DIA ? `${diaAno(p.ini)} a ${diaAno(ate - 1)}` : diaAno(p.ini)) : passo ? `${dataHora(p.ini)} a ${hora(ate)}` : dataHora(p.t)));
      for (const k of CHAVES) {
        linhas.push(h('span', { class: `dica-linha serie-${k}` }, h('i'), h('strong', {}, `${n1(p[k].v)} ${MEDIDA[k].unidade}`),
          h('small', {}, passo ? `média, de ${n1(p[k].min)} a ${n1(p[k].max)}` : MEDIDA[k].nome.toLowerCase())));
      }
      linhas.push(h('span', { class: `nivel e-${p.estado}` }, icone(p.estado), `${passo ? 'Pior: ' : ''}${NOME[p.estado]}`));
    }
    this.dica.replaceChildren(...linhas);
    this.dica.classList.add('ativa');
    const larg = this.dica.offsetWidth;
    const lado = cx + larg + 1.2 * r > W ? cx - larg - 0.8 * r : cx + 0.8 * r;
    this.dica.style.setProperty('--x', `${Math.max(0, lado)}px`);
    this.dica.style.setProperty('--y', `${m.t}px`);
  }
}
