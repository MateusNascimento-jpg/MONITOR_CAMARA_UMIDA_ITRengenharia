// Abertura: a esfera da logo é desenhada, ganha vida e voa até o painel de estado.
import { $, semMovimento } from './dom.js';
import { Malha } from './malha.js';

const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });

export async function abrir(pronto, malha, aoRevelar) {
  const raiz = document.documentElement, capa = $('#abertura'), palco = $('#abertura-malha'), nome = $('#abertura-nome');
  const alvo = $('#malha');
  let b; // destino do voo, medido com a tela já montada e antes das animações de entrada
  const fim = () => { aoRevelar(); b = alvo.getBoundingClientRect(); raiz.classList.remove('abrindo'); raiz.classList.add('aberto'); };
  if (semMovimento()) {
    await Promise.race([pronto, espera(3000)]);
    fim();
    capa.remove();
    return;
  }

  let pular;
  const pulo = new Promise((r) => { pular = r; });
  addEventListener('keydown', pular, { once: true });
  capa.addEventListener('click', pular, { once: true });

  const m = new Malha(palco);
  m.giro = 0;
  m.progresso = 0;
  const t0 = performance.now();
  const traco = setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / 1250);
    m.progresso = 1 - (1 - p) ** 2.2;
    m.giro = Math.max(0, Math.min(1, (performance.now() - t0 - 1250) / 900));
  }, 16);
  capa.classList.add('tracar');

  await Promise.race([pulo, Promise.all([espera(2100), Promise.race([pronto, espera(6000)])])]);
  clearInterval(traco);
  m.progresso = 1;
  m.giro = 1;

  const visivel = alvo.offsetParent !== null;
  nome.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(-1rem)' }], { duration: 260, fill: 'forwards', easing: 'ease-in' });
  await espera(160);
  fim();
  m.alvo = malha.alvo; // a esfera já voa no estado em que vai ficar
  if (visivel) {
    const a = palco.getBoundingClientRect();
    const escala = Math.min(b.width, b.height) / Math.min(a.width, a.height);
    palco.style.setProperty('--cor-final', getComputedStyle(alvo).color);
    palco.classList.add('voar');
    palco.animate([
      { transform: 'none' },
      { transform: `translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top - a.height / 2}px) scale(${escala})` },
    ], { duration: 950, easing: 'cubic-bezier(.65,0,.15,1)', fill: 'forwards' });
    alvo.classList.add('espera');
  }
  capa.animate([{ backgroundColor: getComputedStyle(capa).backgroundColor }, { backgroundColor: 'transparent' }], { duration: 600, fill: 'forwards' });
  await espera(visivel ? 900 : 600);
  if (visivel) {
    // Mesma pose nas duas esferas: a que voou se dissolve sobre a do painel
    malha.fase = m.fase;
    alvo.classList.remove('espera');
    await palco.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: 'forwards' }).finished;
  }
  m.parar();
  capa.remove();
}
