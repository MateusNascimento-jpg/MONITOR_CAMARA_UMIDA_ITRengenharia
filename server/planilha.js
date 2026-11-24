'use strict';

// Planilha do Excel (.xlsx = zip de XMLs). O CSV não guarda largura de coluna e o Excel
// mostrava a data como ########; aqui a largura vai junto.
const zlib = require('node:zlib');
const { once } = require('node:events');
const { NIVEIS } = require('./estado');
const { lerLotes, COLUNAS, nome, num } = require('./historico');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const OX = 'http://schemas.openxmlformats.org';
const REL = `${OX}/officeDocument/2006/relationships`;
const TIPO = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const LARGURAS = [25, 18, 14, 22, 18, 16];
const MAX_LINHAS = 1048575; // limite do Excel, sem contar o cabeçalho

const PARTES = {
  '[Content_Types].xml': `${XML}<Types xmlns="${OX}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="${TIPO}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${TIPO}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${TIPO}.styles+xml"/></Types>`,
  '_rels/.rels': `${XML}<Relationships xmlns="${OX}/package/2006/relationships"><Relationship Id="r1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `${XML}<workbook xmlns="${OX}/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Leituras" sheetId="1" r:id="r1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${OX}/package/2006/relationships"><Relationship Id="r1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  // Estilos: 0 normal, 1 cabeçalho, 2 data e hora, 3 número com 1 casa
  'xl/styles.xml': `${XML}<styleSheet xmlns="${OX}/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>`,
};

const texto = (v, estilo = 0) => `<c s="${estilo}" t="inlineStr"><is><t>${v}</t></is></c>`;
const numero = (v, estilo) => `<c s="${estilo}"><v>${v}</v></c>`;
const decimal = (v) => numero(num(v).replace(',', '.'), 3);

async function* folha(lotes) {
  const colunas = LARGURAS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  yield `${XML}<worksheet xmlns="${OX}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${colunas}</cols><sheetData><row>${COLUNAS.map((c) => texto(c, 1)).join('')}</row>`;
  let n = 0;
  for await (const linhas of lotes) {
    n += linhas.length;
    if (n > MAX_LINHAS) throw new Error('período grande demais para uma planilha');
    yield linhas.map((l) => `<row>${numero(l.data_excel, 2)}${decimal(l.temp)}${decimal(l.umid)}${texto(nome(NIVEIS[l.nivel_temp]))}${texto(nome(NIVEIS[l.nivel_umid]))}${texto(nome(l.estado))}</row>`).join('');
  }
  yield '</sheetData></worksheet>';
}

// Comprime lote a lote: só o resultado, bem menor que o XML, fica na memória
async function comprimir(partes) {
  const z = zlib.createDeflateRaw();
  const saida = [];
  z.on('data', (b) => saida.push(b));
  const fim = once(z, 'end');
  let crc = 0, tamanho = 0;
  for await (const p of partes) {
    const b = Buffer.from(p);
    crc = zlib.crc32(b, crc);
    tamanho += b.length;
    if (!z.write(b)) await once(z, 'drain');
  }
  z.end();
  await fim;
  return { crc, tamanho, dados: Buffer.concat(saida) };
}

async function gerarPlanilha(pool, deviceId, de, ate) {
  const entradas = { ...PARTES, 'xl/worksheets/sheet1.xml': folha(lerLotes(pool, deviceId, de, ate)) };
  const corpo = [], indice = [];
  let posicao = 0;
  for (const [caminho, conteudo] of Object.entries(entradas)) {
    const { crc, tamanho, dados } = await comprimir(typeof conteudo === 'string' ? [conteudo] : conteudo);
    const c = Buffer.alloc(26); // campos comuns ao cabeçalho de cada arquivo e ao índice do zip
    c.writeUInt16LE(20, 0); // versão 2.0
    c.writeUInt16LE(8, 4); // deflate
    c.writeUInt16LE(0x21, 8); // 01/01/1980
    c.writeUInt32LE(crc, 10);
    c.writeUInt32LE(dados.length, 14);
    c.writeUInt32LE(tamanho, 18);
    c.writeUInt16LE(caminho.length, 22);
    const resto = Buffer.alloc(14);
    resto.writeUInt32LE(posicao, 10);
    corpo.push(Buffer.from('504b0304', 'hex'), c, Buffer.from(caminho), dados);
    indice.push(Buffer.from('504b01021400', 'hex'), c, resto, Buffer.from(caminho));
    posicao += 30 + caminho.length + dados.length;
  }
  const tabela = Buffer.concat(indice);
  const fim = Buffer.alloc(22);
  fim.write('504b0506', 'hex');
  fim.writeUInt16LE(Object.keys(entradas).length, 8);
  fim.writeUInt16LE(Object.keys(entradas).length, 10);
  fim.writeUInt32LE(tabela.length, 12);
  fim.writeUInt32LE(posicao, 16);
  return Buffer.concat([...corpo, tabela, fim]);
}

module.exports = { gerarPlanilha };
