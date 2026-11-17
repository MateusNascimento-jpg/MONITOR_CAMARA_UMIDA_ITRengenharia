'use strict';

/*
 * Classificação do estado da câmara (ótimo → alerta) com histerese.
 *
 * Regras de faixa:
 *  - Temperatura: "otimo" é [min, max] inclusivo; "bom", "medio" e "ruim" são
 *    [min, max) — ex.: 26,0 °C já é "medio" (atenção a partir de 26 °C).
 *    Fora da faixa "ruim" → "alerta" (≥ 30 °C ou < 20 °C nos padrões).
 *  - Umidade: cada nível tem um mínimo; abaixo do mínimo de "ruim" → "alerta".
 *  - Estado da câmara = o PIOR entre temperatura e umidade.
 */

const NIVEIS = ['otimo', 'bom', 'medio', 'ruim', 'alerta'];

const LIMITES_PADRAO = Object.freeze({
  temp: {
    otimo: { min: 21, max: 25 },
    bom:   { min: 20, max: 26 },
    medio: { min: 20, max: 28 },
    ruim:  { min: 20, max: 30 },
  },
  umid: { otimo: 95, bom: 90, medio: 85, ruim: 80 },
  histerese: { temp: 0.3, umid: 1 },
  sem_dados_min: 25,
});

function copiarLimites(limites) {
  return JSON.parse(JSON.stringify(limites));
}

function nivelTemp(t, lim) {
  const f = lim.temp;
  if (t >= f.otimo.min && t <= f.otimo.max) return 0;
  if (t >= f.bom.min && t < f.bom.max) return 1;
  if (t >= f.medio.min && t < f.medio.max) return 2;
  if (t >= f.ruim.min && t < f.ruim.max) return 3;
  return 4;
}

function nivelUmid(u, lim) {
  const f = lim.umid;
  if (u >= f.otimo) return 0;
  if (u >= f.bom) return 1;
  if (u >= f.medio) return 2;
  if (u >= f.ruim) return 3;
  return 4;
}

/*
 * Histerese: piorar é imediato; melhorar exige que o valor esteja pelo menos
 * `margem` para dentro da faixa melhor. Evita que um valor parado na fronteira
 * (ex.: 24,9 / 25,1 °C) fique alternando de estado a cada leitura.
 */
function nivelComHisterese(fnNivel, valor, margem, anterior) {
  const bruto = fnNivel(valor);
  if (anterior === null || anterior === undefined || bruto >= anterior) return bruto;
  const pessimista = Math.max(fnNivel(valor - margem), fnNivel(valor + margem));
  return Math.min(anterior, Math.max(bruto, pessimista));
}

function classificar(temp, umid, limites, anterior) {
  const ant = anterior || {};
  const nt = nivelComHisterese((v) => nivelTemp(v, limites), temp, limites.histerese.temp, ant.nivel_temp);
  const nu = nivelComHisterese((v) => nivelUmid(v, limites), umid, limites.histerese.umid, ant.nivel_umid);
  return { nivel_temp: nt, nivel_umid: nu, estado: NIVEIS[Math.max(nt, nu)] };
}

// ---- Validação dos limites enviados pela interface -------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validarLimites(l) {
  if (!l || typeof l !== 'object') return 'limites ausentes';

  const t = l.temp;
  const faixas = ['otimo', 'bom', 'medio', 'ruim'];
  if (!t || faixas.some((k) => !t[k] || !num(t[k].min) || !num(t[k].max))) {
    return 'temp: informe min e max numéricos para otimo, bom, medio e ruim';
  }
  // Cada faixa deve conter a anterior: ruim ⊇ medio ⊇ bom ⊇ otimo
  for (let i = 1; i < faixas.length; i++) {
    const dentro = t[faixas[i - 1]];
    const fora = t[faixas[i]];
    if (fora.min > dentro.min || fora.max < dentro.max) {
      return `temp: a faixa "${faixas[i]}" precisa conter a faixa "${faixas[i - 1]}"`;
    }
  }
  if (t.otimo.min >= t.otimo.max) return 'temp: em "otimo", min deve ser menor que max';
  if (t.ruim.min < -40 || t.ruim.max > 125) return 'temp: limites fora da faixa do sensor (-40 a 125 °C)';

  const u = l.umid;
  if (!u || faixas.some((k) => !num(u[k]))) return 'umid: informe otimo, bom, medio e ruim numéricos';
  if (!(u.otimo >= u.bom && u.bom >= u.medio && u.medio >= u.ruim)) {
    return 'umid: a ordem deve ser otimo ≥ bom ≥ medio ≥ ruim';
  }
  if (u.ruim < 0 || u.otimo > 100) return 'umid: limites devem ficar entre 0 e 100 %';

  const h = l.histerese;
  if (!h || !num(h.temp) || !num(h.umid)) return 'histerese: informe temp e umid numéricos';
  if (h.temp < 0 || h.temp > 5 || h.umid < 0 || h.umid > 10) {
    return 'histerese: temp entre 0 e 5 °C, umid entre 0 e 10 %';
  }

  if (!Number.isInteger(l.sem_dados_min) || l.sem_dados_min < 11 || l.sem_dados_min > 1440) {
    return 'sem_dados_min: inteiro entre 11 e 1440 (precisa ser maior que o intervalo de 10 min)';
  }
  return null;
}

// Mantém só os campos conhecidos (descarta qualquer extra enviado pelo cliente)
function normalizarLimites(l) {
  const faixa = (f) => ({ min: f.min, max: f.max });
  return {
    temp: {
      otimo: faixa(l.temp.otimo),
      bom: faixa(l.temp.bom),
      medio: faixa(l.temp.medio),
      ruim: faixa(l.temp.ruim),
    },
    umid: { otimo: l.umid.otimo, bom: l.umid.bom, medio: l.umid.medio, ruim: l.umid.ruim },
    histerese: { temp: l.histerese.temp, umid: l.histerese.umid },
    sem_dados_min: l.sem_dados_min,
  };
}

module.exports = {
  NIVEIS,
  LIMITES_PADRAO,
  copiarLimites,
  classificar,
  validarLimites,
  normalizarLimites,
};
