'use strict';

/*
 * Histórico com período livre (De/Até) — no estilo do seletor de tempo do Grafana.
 *
 * - Períodos curtos voltam leitura a leitura ("bruto").
 * - Períodos longos voltam agrupados (média, mínima e máxima por hora/dia/semana),
 *   como a macro $__timeGroup do Grafana: o gráfico fica leve e os picos não somem.
 * - Os grupos diários/semanais começam à meia-noite de Brasília (UTC-3).
 */

const { NIVEIS } = require('./estado');

const HORA = 3600e3;
const DIA = 24 * HORA;
const MAX_PERIODO = 5 * 365 * DIA; // 5 anos
const LOTE_CSV = 5000;
const TEMPO_LONGO = 60000; // anos de leituras podem passar do limite padrão do pool

// Agrupamentos aceitos → intervalo do PostgreSQL
const AGRUPAMENTOS = {
  bruto: null,
  '1h': '1 hour',
  '6h': '6 hours',
  '1d': '1 day',
  '7d': '7 days',
};

// Origem dos grupos: segunda-feira, 00:00 em Brasília (alinha dias e semanas ao horário local)
const ORIGEM = '2000-01-03 00:00:00-03';

// Escolhe o agrupamento para manter o gráfico com no máximo ~1000 pontos
function agrupamentoAutomatico(periodoMs) {
  if (periodoMs <= 3 * DIA) return 'bruto'; // até ~430 leituras
  if (periodoMs <= 30 * DIA) return '1h';   // até 720 pontos
  if (periodoMs <= 180 * DIA) return '6h';  // até 720 pontos
  if (periodoMs <= 3 * 365 * DIA) return '1d';
  return '7d';
}

// Aceita ISO 8601 ("2026-11-18T08:00:00-03:00") ou epoch em milissegundos
function lerData(valor) {
  if (valor === undefined || valor === '') return undefined;
  const d = /^\d+$/.test(String(valor)) ? new Date(Number(valor)) : new Date(String(valor));
  const ano = d.getUTCFullYear(); // NaN se a data for inválida; fora de 1 a 9999 o PostgreSQL recusa
  return ano >= 1 && ano <= 9999 ? d : null;
}

/*
 * Interpreta os parâmetros da URL. Retorna { de, ate } ou { erro }.
 * Prioridade: de/ate → horas (últimas N horas) → padrão de 24 h.
 */
function lerPeriodo(query) {
  const agora = new Date();
  let de = lerData(query.de);
  let ate = lerData(query.ate);
  if (de === null) return { erro: 'de: data inválida (use ISO 8601 ou epoch em ms)' };
  if (ate === null) return { erro: 'ate: data inválida (use ISO 8601 ou epoch em ms)' };

  if (de === undefined && ate === undefined && query.horas !== undefined) {
    const horas = Number(query.horas);
    if (!Number.isInteger(horas) || horas < 1 || horas > MAX_PERIODO / HORA) {
      return { erro: `horas: inteiro de 1 a ${MAX_PERIODO / HORA}` };
    }
    return { de: new Date(agora - horas * HORA), ate: agora };
  }

  if (ate === undefined) ate = agora;
  if (de === undefined) de = new Date(ate - DIA);
  if (de >= ate) return { erro: 'de precisa ser anterior a ate' };
  if (ate - de > MAX_PERIODO) return { erro: 'período máximo: 5 anos' };
  return { de, ate };
}

async function buscarHistorico(pool, deviceId, de, ate, agrupamentoPedido) {
  let agrupamento = agrupamentoPedido || 'auto';
  if (agrupamento === 'auto') agrupamento = agrupamentoAutomatico(ate - de);
  if (!Object.hasOwn(AGRUPAMENTOS, agrupamento)) {
    return { erro: `agrupamento: use auto, ${Object.keys(AGRUPAMENTOS).join(', ')}` };
  }

  if (agrupamento === 'bruto') {
    const r = await pool.query({
      text: `SELECT medido_em, temp, umid, estado
         FROM leituras
        WHERE device_id = $1 AND medido_em >= $2 AND medido_em <= $3
        ORDER BY medido_em ASC`,
      values: [deviceId, de, ate],
      query_timeout: TEMPO_LONGO,
    });
    return { agrupamento, leituras: r.rows };
  }

  const r = await pool.query({
    text: `SELECT date_bin($4::interval, medido_em, TIMESTAMPTZ '${ORIGEM}') AS inicio,
            round(avg(temp)::numeric, 2)::float8 AS temp_media,
            round(min(temp)::numeric, 2)::float8  AS temp_min,
            round(max(temp)::numeric, 2)::float8  AS temp_max,
            round(avg(umid)::numeric, 2)::float8 AS umid_media,
            round(min(umid)::numeric, 2)::float8  AS umid_min,
            round(max(umid)::numeric, 2)::float8  AS umid_max,
            count(*)::int                       AS leituras,
            max(GREATEST(nivel_temp, nivel_umid))::int AS pior_nivel
       FROM leituras
      WHERE device_id = $1 AND medido_em >= $2 AND medido_em <= $3
      GROUP BY inicio
      ORDER BY inicio ASC`,
    values: [deviceId, de, ate, AGRUPAMENTOS[agrupamento]],
    query_timeout: TEMPO_LONGO,
  });

  const grupos = r.rows.map(({ pior_nivel, ...g }) => ({ ...g, pior_estado: NIVEIS[pior_nivel] }));
  return { agrupamento, leituras: grupos };
}

const NOMES_ESTADO = { otimo: 'Ótimo', bom: 'Bom', medio: 'Médio', ruim: 'Ruim', alerta: 'Alerta' };

// CSV no padrão do Excel em português: separador ";", vírgula decimal e horário de Brasília.
// Sai em partes de LOTE_CSV leituras: anos de dados não cabem de uma vez na memória.
async function* gerarCsv(pool, deviceId, de, ate) {
  const num = (v) => Number(v).toFixed(1).replace('.', ',');
  const nome = (estado) => NOMES_ESTADO[estado] || estado;
  // BOM no início para o Excel reconhecer acentos (UTF-8)
  let parte = '\ufeffData e hora (Brasília);Temperatura (°C);Umidade (%);Nível da temperatura;Nível da umidade;Estado geral\r\n';
  let cursor = de, id = 0, linhas;
  do {
    const r = await pool.query({
      text: `SELECT id, medido_em::text AS cursor,
                    to_char(medido_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') AS data_hora,
                    temp, umid, nivel_temp, nivel_umid, estado
               FROM leituras
              WHERE device_id = $1 AND (medido_em, id) > ($2::timestamptz, $3::bigint) AND medido_em <= $4
              ORDER BY medido_em ASC, id ASC
              LIMIT ${LOTE_CSV}`,
      values: [deviceId, cursor, id, ate],
      query_timeout: TEMPO_LONGO,
    });
    linhas = r.rows;
    for (const l of linhas) {
      parte += [
        l.data_hora, num(l.temp), num(l.umid),
        nome(NIVEIS[l.nivel_temp]), nome(NIVEIS[l.nivel_umid]), nome(l.estado),
      ].join(';') + '\r\n';
    }
    yield parte;
    parte = '';
    if (linhas.length) ({ cursor, id } = linhas[linhas.length - 1]);
  } while (linhas.length === LOTE_CSV);
}

module.exports = { lerPeriodo, buscarHistorico, gerarCsv, AGRUPAMENTOS };
