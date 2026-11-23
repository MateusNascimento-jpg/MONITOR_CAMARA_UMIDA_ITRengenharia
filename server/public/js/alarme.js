// Alarme sonoro: mesma melodia do buzzer da placa (onda quadrada).
const MELODIA = [[932, 120], [0, 40], [932, 120], [0, 40], [1175, 120], [0, 40], [1397, 260], [0, 200], [1397, 120], [0, 40], [1175, 120], [0, 40], [1397, 260], [0, 700]];
const VOLUME = 1; // máximo; acima de 1 distorce

let ctx = null, volume = null, laco = null;
let tipo = null;      // 'alerta' | 'sem_dados' | null
let silenciado = null; // tipo que foi silenciado
let avisar = () => {};

export const ativo = () => !!ctx && ctx.state === 'running';
export const estaSilenciado = () => !!tipo && silenciado === tipo;
export const aoMudar = (f) => { avisar = f; };

function tocar(notas) {
  let t = ctx.currentTime + 0.02;
  for (const [hz, ms] of notas) {
    if (hz) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(VOLUME, t + 0.005);
      g.gain.setValueAtTime(VOLUME, t + ms / 1000 - 0.008);
      g.gain.linearRampToValueAtTime(0, t + ms / 1000);
      o.connect(g).connect(volume);
      o.start(t);
      o.stop(t + ms / 1000);
    }
    t += ms / 1000;
  }
  return notas.reduce((s, [, ms]) => s + ms, 0);
}

function atualizar() {
  const deve = ativo() && tipo && silenciado !== tipo;
  if (deve && !laco) {
    const ciclo = () => { laco = setTimeout(ciclo, tocar(MELODIA)); };
    volume.gain.value = 1;
    ciclo();
  } else if (!deve && laco) {
    clearTimeout(laco);
    laco = null;
    // Corta na hora as notas já agendadas
    volume.disconnect();
    volume = ctx.createGain();
    volume.connect(ctx.destination);
  }
  avisar();
}

function criar() {
  ctx = new AudioContext();
  volume = ctx.createGain();
  volume.connect(ctx.destination);
  ctx.addEventListener('statechange', atualizar);
}

export async function ativar() {
  if (!ctx) criar();
  await ctx.resume();
  try { localStorage.setItem('som', '1'); } catch { /* navegação privada */ }
  if (!tipo) tocar([[1397, 120]]); // bipe de teste, como o botão da placa
  atualizar();
}

// Na TV com autoplay liberado, o som volta sozinho ao recarregar; senão, continua o botão
export function retomar() {
  try { if (localStorage.getItem('som') !== '1') return; } catch { return; }
  criar();
  atualizar();
}

export function definir(novo) {
  if (novo === tipo) return;
  tipo = novo;
  silenciado = null; // saiu do alarme ou mudou de problema: o som volta no próximo
  atualizar();
}

export function silenciar() {
  silenciado = tipo;
  atualizar();
}
