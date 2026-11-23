// A malha: a esfera da logo da ITR em 3D. Regular quando a câmara está estável,
// deformada conforme o estado piora, com as ligações rompidas quando faltam dados.

// Coordenadas medidas na logo (px): [x, y, raio do nó]
const CX = 720, CY = 678, R = 606;
const NOS = {
  A: [720, 75, 20], B: [1150, 254, 20], C: [864, 345, 31], D: [557, 255, 20], E: [166, 433, 20],
  F: [627, 583, 20], G: [1216, 541, 20], H: [386, 748, 14], I: [910, 761, 14], J: [1295, 880, 31],
  K: [495, 1024, 20], L: [248, 1058, 14], M: [833, 1145, 31], N: [1089, 1158, 14], O: [574, 1264, 20],
};
const LIGACOES = 'AB AC AE ED DC DF DH CB CF CG BG FH FI EH EL HI HL HK IG IK IM GM GJ JM JN MN MK MO KL LO'.split(' ');
// Contorno facetado da logo, entre os nós da borda
const CONTORNO = [['A', 1060, 117, 'B'], ['B', 1343, 565, 'J'], ['J', 1238, 1070, 'N'], ['N', 820, 1282, 'O'], ['O', 293, 1170, 'L'], ['L', 61, 660, 'E'], ['E', 371, 147, 'A']];

const ALVO = {
  otimo: { amp: 0, vel: 0.5, corte: 0 },
  bom: { amp: 0.035, vel: 0.6, corte: 0 },
  medio: { amp: 0.09, vel: 0.8, corte: 0 },
  ruim: { amp: 0.15, vel: 1.1, corte: 0 },
  alerta: { amp: 0.26, vel: 2, corte: 0 },
  sem_dados: { amp: 0.07, vel: 0, corte: 0.36 },
};

const pts = [], arestas = [];
const idx = {};
const semente = (i, k) => { const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

function por(x, y, z, raio, tras) {
  const i = pts.length;
  pts.push({ x, y, z, raio, tras, vies: semente(i, 1), fase: semente(i, 2) * Math.PI });
  return i;
}
for (const [k, [px, py, r]] of Object.entries(NOS)) {
  const x = (px - CX) / R, y = (py - CY) / R, d = Math.hypot(x, y);
  idx[k] = d > 0.985 ? por(x / d, y / d, 0, r / R) : por(x, y, Math.sqrt(1 - d * d), r / R);
}
const borda = 'ABJNOLE'.split('').map((k) => idx[k]);
for (const [a, b] of LIGACOES) arestas.push([idx[a], idx[b]]);
for (const [a, px, py, b] of CONTORNO) {
  const i = por((px - CX) / R, (py - CY) / R, 0, 0);
  arestas.push([idx[a], i], [i, idx[b]]);
}
// Hemisfério de trás: antípodas dos nós internos, presas às da borda mais próximas
const costas = {};
for (const k of 'CDFGHIKM') {
  const p = pts[idx[k]];
  costas[k] = por(-p.x, -p.y, -p.z, p.raio * 0.6, true);
}
for (const [a, b] of LIGACOES) if (costas[a] !== undefined && costas[b] !== undefined) arestas.push([costas[a], costas[b], true]);
for (const i of Object.values(costas)) {
  const p = pts[i];
  const dist = (j) => (pts[j].x - p.x) ** 2 + (pts[j].y - p.y) ** 2 + (pts[j].z - p.z) ** 2;
  [...borda].sort((a, b) => dist(a) - dist(b)).slice(0, 2).forEach((j) => arestas.push([i, j, true]));
}

const calmo = matchMedia('(prefers-reduced-motion: reduce)');

export class Malha {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.p = { ...ALVO.otimo };
    this.alvo = ALVO.otimo;
    this.progresso = 1; // 0..1: usado na abertura para desenhar a esfera
    this.giro = 1;      // 0 = pose exata da logo
    this.fase = 0;
    this.ult = 0;
    new ResizeObserver(() => this.medir()).observe(canvas);
    this.medir();
    const laco = (t) => {
      if (this.parada) return;
      // 30 quadros por segundo bastam e poupam a TV
      if (t - this.ult >= 32) { this.quadro(t); }
      requestAnimationFrame(laco);
    };
    requestAnimationFrame(laco);
  }

  estado(e) { this.alvo = ALVO[e]; }

  medir() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ultimaChave = null;
  }

  quadro(t) {
    if (!this.canvas.width || !this.canvas.offsetParent) return;
    const dt = Math.min(0.1, (t - this.ult) / 1000);
    this.ult = t;
    const k = calmo.matches ? 1 : 1 - Math.exp(-dt * 2.6);
    for (const c of ['amp', 'vel', 'corte']) this.p[c] += (this.alvo[c] - this.p[c]) * k;
    if (!calmo.matches) this.fase += dt * this.p.vel;
    this.desenhar();
  }

  desenhar() {
    const { ctx, canvas, p, fase } = this;
    const W = canvas.width, H = canvas.height, raio = Math.min(W, H) * 0.4;
    const yaw = Math.sin(fase * 0.55) * 0.55 * this.giro, pitch = Math.sin(fase * 0.4) * 0.16 * this.giro;
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const pos = pts.map((q) => {
      const f = 1 + p.amp * (q.vies + 0.4 * Math.sin(fase * 2.4 + q.fase)) + (1 - p.corte) * 0.012 * this.giro * Math.sin(fase * 1.3);
      const x = q.x * f, y = q.y * f, z = q.z * f;
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      return [W / 2 + x1 * raio, H / 2 + (y * cp - z1 * sp) * raio, y * sp + z1 * cp];
    });
    const av = (ini, dur) => Math.max(0, Math.min(1, (this.progresso - ini) / dur));

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.lineCap = 'round';
    ctx.lineWidth = raio * 0.0115;

    // O círculo é a norma: a malha se afasta dele quando a câmara sai da faixa
    ctx.globalAlpha = 1 - p.corte * 0.7;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, raio, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * av(0.25, 0.75));
    ctx.stroke();

    arestas.forEach(([a, b, tras], i) => {
      const A = pos[a], B = pos[b];
      const f = av((i / arestas.length) * 0.55, 0.4);
      if (!f) return;
      ctx.globalAlpha = tras ? 0.22 * this.giro : 1;
      const meio = (1 - p.corte) / 2; // rompida: só sobram as pontas
      const ponta = (u) => [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
      ctx.beginPath();
      if (p.corte < 0.01) { ctx.moveTo(A[0], A[1]); ctx.lineTo(...ponta(f)); } else {
        ctx.moveTo(A[0], A[1]); ctx.lineTo(...ponta(meio));
        ctx.moveTo(B[0], B[1]); ctx.lineTo(...ponta(1 - meio));
      }
      ctx.stroke();
    });
    pts.forEach((q, i) => {
      if (!q.raio) return;
      ctx.globalAlpha = q.tras ? 0.35 * this.giro : 1;
      const f = av((i / pts.length) * 0.5, 0.2);
      ctx.beginPath();
      ctx.arc(pos[i][0], pos[i][1], q.raio * raio * f * (2 - f), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  parar() { this.parada = true; }
}
