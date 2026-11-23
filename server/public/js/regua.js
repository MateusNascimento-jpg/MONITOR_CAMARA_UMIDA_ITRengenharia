// Proveta: coluna graduada com as faixas vindas dos limites da API e o nível do valor atual.
import { h } from './dom.js';
import { NOME, MEDIDA, bandas, dominio, ideal, extremos, n, n1 } from './regras.js';

export class Proveta {
  constructor(raiz, chave) {
    this.raiz = raiz;
    this.chave = chave;
    this.marcas = h('div', { class: 'prov-marcas', 'aria-hidden': 'true' });
    this.faixas = h('div', { class: 'prov-faixas', 'aria-hidden': 'true' });
    this.liquido = h('i');
    this.menisco = h('b');
    raiz.classList.add('proveta', 'sem-valor', `serie-${chave}`);
    raiz.setAttribute('role', 'img');
    raiz.append(this.marcas, this.faixas, h('div', { class: 'prov-tubo', 'aria-hidden': 'true' }, this.liquido), this.menisco);
    new ResizeObserver(() => this.rotulos()).observe(raiz);
  }

  mostrar(limites, valor) {
    const { chave, raiz } = this;
    const forma = JSON.stringify([limites.temp, limites.umid]);
    const [lo, hi] = dominio(chave, limites);
    const pc = (v) => ((v - lo) / (hi - lo)) * 100;
    if (forma !== this.forma) {
      this.forma = forma;
      this.limites = limites;
      this.faixas.replaceChildren(...bandas(chave, limites).map((b) => {
        const el = h('i', { class: `e-${b.estado}` });
        el.style.setProperty('--de', pc(b.de));
        el.style.setProperty('--alt', pc(b.ate) - pc(b.de));
        return el;
      }));
      this.rotulos();
    }
    raiz.classList.toggle('sem-valor', valor === null);
    const u = MEDIDA[chave].unidade, f = ideal(chave, limites);
    const faixaTxt = chave === 'temp' ? `Ideal de ${n(f[0])} a ${n(f[1])} ${u}` : `Ideal a partir de ${n(f[0])} ${u}`;
    if (valor !== null) raiz.style.setProperty('--v', Math.max(0, Math.min(100, pc(valor))));
    raiz.setAttribute('aria-label', `${MEDIDA[chave].nome}: ${valor === null ? NOME.sem_dados : `${n1(valor)} ${u}`}. ${faixaTxt}.`);
  }

  // Números dos limites; some com os que se sobrepõem, na ordem de importância
  rotulos() {
    if (!this.limites) return;
    const { chave, limites } = this;
    const [lo, hi] = dominio(chave, limites);
    const alt = this.raiz.clientHeight;
    const minimo = parseFloat(getComputedStyle(this.marcas).fontSize) * 1.25;
    const cortes = bandas(chave, limites).slice(1).map((b) => b.de);
    const ordem = [...new Set([...ideal(chave, limites), ...extremos(chave, limites), ...cortes])].filter((v) => v > lo && v <= hi);
    const usados = [];
    this.marcas.replaceChildren();
    for (const v of ordem) {
      const p = (v - lo) / (hi - lo);
      if (usados.some((q) => Math.abs(q - p) * alt < minimo)) continue;
      usados.push(p);
      const el = h('span', {}, n(v));
      el.style.setProperty('--p', p * 100);
      this.marcas.append(el);
    }
  }
}
