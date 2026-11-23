export const $ = (s, raiz = document) => raiz.querySelector(s);
export const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];

const NS = 'http://www.w3.org/2000/svg';

function montar(el, attrs, filhos) {
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  el.append(...filhos.filter((f) => f !== null && f !== undefined));
  return el;
}
export const h = (tag, attrs, ...filhos) => montar(document.createElement(tag), attrs, filhos);
export const s = (tag, attrs, ...filhos) => montar(document.createElementNS(NS, tag), attrs, filhos);
export const icone = (id) => s('svg', { class: 'ico', 'aria-hidden': 'true' }, s('use', { href: `img/icones.svg#${id}` }));

export const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Etiqueta de nível: cor + ícone + texto, nunca só a cor
export function etiqueta(el, estado, nome) {
  const chave = `${estado}|${nome}`;
  if (el.dataset.v === chave) return;
  el.dataset.v = chave;
  el.className = `nivel e-${estado}`;
  el.replaceChildren(icone(estado), nome);
}

// Número que rola dígito a dígito
export function rolar(el, texto, rotulo) {
  if (el.dataset.v === texto) return;
  el.dataset.v = texto;
  const forma = texto.replace(/\d/g, '0');
  if (el.dataset.forma !== forma) {
    el.dataset.forma = forma;
    el.parentElement.style.setProperty('--letras', [...texto].reduce((t, c) => t + (/\d/.test(c) ? 1 : 0.45), 0));
    el.replaceChildren(
      h('span', { class: 'lido' }),
      ...[...texto].map((c, i) => {
        if (!/\d/.test(c)) return h('span', { class: 'sinal', 'aria-hidden': 'true' }, c);
        const col = h('span', { class: 'dig', 'aria-hidden': 'true' }, h('u'), h('i', {}, '0 1 2 3 4 5 6 7 8 9'.split(' ').join('\n')));
        col.style.setProperty('--i', i);
        return col;
      }),
    );
    el.offsetWidth; // parte do zero na primeira vez
  }
  $('.lido', el).textContent = rotulo || texto;
  const digitos = texto.replace(/\D/g, '');
  $$('.dig', el).forEach((c, i) => {
    c.style.setProperty('--d', digitos[i]);
    $('u', c).textContent = digitos[i]; // dá a largura natural do algarismo
  });
}

// Controle segmentado com o indicador deslizante
export function segmentado(raiz, aoEscolher) {
  const marca = h('span', { class: 'seg-marca', 'aria-hidden': 'true' });
  raiz.prepend(marca);
  const botoes = $$('button', raiz);
  const mover = () => {
    const b = botoes.find((x) => x.getAttribute('aria-pressed') === 'true');
    marca.hidden = !b;
    if (!b) return;
    marca.style.setProperty('--x', `${b.offsetLeft}px`);
    marca.style.setProperty('--y', `${b.offsetTop}px`);
    marca.style.setProperty('--w', `${b.offsetWidth}px`);
    marca.style.setProperty('--h', `${b.offsetHeight}px`);
  };
  const marcar = (valor) => {
    botoes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.valor === String(valor))));
    mover();
  };
  botoes.forEach((b) => b.addEventListener('click', () => { marcar(b.dataset.valor); aoEscolher(b.dataset.valor); }));
  new ResizeObserver(mover).observe(raiz);
  return marcar;
}
