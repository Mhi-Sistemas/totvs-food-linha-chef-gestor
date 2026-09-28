// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Exporta relatórios como .xlsx, .docx e .pdf — sem dependências externas.
//
// Uso:
//   node scripts/exportar.mjs xlsx --saida relatorios/vendas.xlsx \
//        --aba "Vendas por dia=SELECT ..." [--aba "Top produtos=SELECT ..."]
//   node scripts/exportar.mjs docx --entrada rascunho.md --saida relatorios/relatorio.docx
//   node scripts/exportar.mjs pdf  --entrada relatorios/painel.html --saida relatorios/painel.pdf
//
// - xlsx: cada --aba vira uma planilha (nome=consulta SQL somente leitura).
// - docx: converte um markdown simples (#, ##, ###, parágrafos, listas com "-",
//         tabelas com |, **negrito**) em documento Word.
// - pdf:  imprime um HTML usando o Edge/Chrome instalado (headless).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { abrirBanco } from './criar-banco.mjs';
import { acharNavegadorChromium, urlDeArquivo, abrirNoSistema, DICA_IMPRIMIR_PDF } from './plataforma.mjs';

// ---------- utilitários ----------

const escXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function lerArgs() {
  const args = { abas: [] };
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--aba') { args.abas.push(argv[i + 1]); i += 1; }
    else if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

function garantirPasta(caminho) {
  mkdirSync(dirname(resolve(caminho)), { recursive: true });
}

// Autoria embutida nos arquivos gerados: aparece nas propriedades do
// documento no Excel e no Word, nao so no conteudo visivel.
const AUTOR = 'MHI Sistemas';
const APLICACAO = 'Assistente de Gestao TOTVS Food Linha Chef (MHI Sistemas)';

function docProps() {
  const agora = new Date().toISOString().slice(0, 19) + 'Z';
  return {
    'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
      + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      // Atencao: coreProperties aceita um conjunto FIXO de campos; dc:publisher
      // NAO esta nele e faz o Excel/Word abrirem com aviso de reparo.
      + '<dc:creator>' + AUTOR + '</dc:creator>'
      + '<cp:lastModifiedBy>' + AUTOR + '</cp:lastModifiedBy>'
      + '<dc:description>Gerado pelo ' + APLICACAO + '. Autoria: ' + AUTOR + '. Licenca MIT.</dc:description>'
      + '<dcterms:created xsi:type="dcterms:W3CDTF">' + agora + '</dcterms:created>'
      + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + agora + '</dcterms:modified>'
      + '</cp:coreProperties>',
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
      + '<Application>' + APLICACAO + '</Application>'
      + '<Company>' + AUTOR + '</Company>'
      + '</Properties>',
  };
}

const TIPOS_DOCPROPS =
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';

const RELS_DOCPROPS =
  '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>';

// ---------- gravador ZIP (método deflate) ----------

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Gera um .zip válido a partir de { nome: conteúdo-string }.
function gravarZip(caminho, arquivos) {
  const locais = [];
  const centrais = [];
  let offset = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const dados = Buffer.from(conteudo, 'utf8');
    const comprimido = deflateRawSync(dados);
    const crc = crc32(dados);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // versão
    local.writeUInt16LE(0x0800, 6);        // flags: nomes em UTF-8
    local.writeUInt16LE(8, 8);             // método: deflate
    local.writeUInt32LE(0, 10);            // data/hora (zerada)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nomeBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, nomeBuf);
    offset += local.length + nomeBuf.length + comprimido.length;
  }
  const centralBuf = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(Object.keys(arquivos).length, 8);
  fim.writeUInt16LE(Object.keys(arquivos).length, 10);
  fim.writeUInt32LE(centralBuf.length, 12);
  fim.writeUInt32LE(offset, 16);
  garantirPasta(caminho);
  writeFileSync(caminho, Buffer.concat([...locais, centralBuf, fim]));
}

// ---------- XLSX ----------

function colunaExcel(indice) { // 0 -> A, 26 -> AA...
  let nome = '';
  let n = indice;
  do { nome = String.fromCharCode(65 + (n % 26)) + nome; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return nome;
}

// ---------- formatacao automatica por coluna ----------
//
// O gestor abre a planilha no Excel: valor tem que aparecer como R$, data como
// DD/MM/AAAA e percentual com %. A deteccao e por coluna: datas pelo CONTEUDO
// (padrao ISO que o banco devolve), moeda e percentual pelo NOME da coluna.
const ESTILO = { cabecalho: 1, moeda: 2, data: 3, dataHora: 4, pctLiteral: 5, pctFracao: 6 };
const REGEX_MOEDA = /valor|faturamento|receita|pre[cç]o|custo|ticket|margem|l[ií]quido|bruto|saldo|desconto|cmv|sangria|pago|entrada|saida|total/i;
const REGEX_PCT = /pct|percent|%/i;
// A API devolve horarios com fracao de segundo ("16:22:13.07") — o padrao aceita.
const REGEX_DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

// Data ISO -> numero serial do Excel (dias desde 30/12/1899), em UTC puro
// para o fuso da maquina nao deslocar o dia.
function serialExcel(iso) {
  const [dataParte, horaParte] = iso.replace('T', ' ').split(' ');
  const [a, m, d] = dataParte.split('-').map(Number);
  let serial = (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  if (horaParte) {
    const [hh, mm, ss] = horaParte.split(':').map(parseFloat); // ss pode ter fracao
    serial += ((hh * 3600) + (mm || 0) * 60 + (ss || 0)) / 86400;
  }
  return serial;
}

function formatoDaColuna(nome, valores) {
  const amostra = valores.filter((v) => v !== null && v !== undefined && v !== '');
  if (amostra.length === 0) return null;
  const datas = amostra.filter((v) => typeof v === 'string' && REGEX_DATA_ISO.test(v));
  if (datas.length >= amostra.length * 0.8) {
    const comHora = datas.some((v) => /[T ]/.test(v));
    return { estilo: comHora ? ESTILO.dataHora : ESTILO.data, eData: true, comHora };
  }
  const numericos = amostra.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (numericos.length < amostra.length * 0.8) return null;
  if (REGEX_PCT.test(nome)) {
    // 87,5 (ja em pontos percentuais) ganha mascara literal; 0,875 (fracao)
    // ganha o formato do Excel que multiplica por 100. Os dois exibem 87,5%.
    const maiorAbs = Math.max(...numericos.map(Math.abs));
    return { estilo: maiorAbs > 1.5 ? ESTILO.pctLiteral : ESTILO.pctFracao };
  }
  if (REGEX_MOEDA.test(nome)) return { estilo: ESTILO.moeda };
  return null;
}

function planilhaXml(colunas, linhas) {
  const formatos = colunas.map((c) => formatoDaColuna(c, linhas.map((l) => l[c])));
  const larguras = colunas.map((c, i) => {
    const base = Math.min(50, Math.max(
      String(c).length, ...linhas.map((l) => String(l[c] ?? '').length), 8));
    if (formatos[i]?.eData) return Math.max(base, formatos[i].comHora ? 16 : 10);
    if (formatos[i]?.estilo === ESTILO.moeda) return Math.max(base, 14);
    return base;
  });
  const cols = larguras.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w + 2}" customWidth="1"/>`).join('');
  const celula = (valor, ref, formato, estiloFixo) => {
    if (estiloFixo === undefined && formato?.eData
        && typeof valor === 'string' && REGEX_DATA_ISO.test(valor)) {
      return `<c r="${ref}" s="${formato.estilo}"><v>${serialExcel(valor)}</v></c>`;
    }
    if (typeof valor === 'number' && Number.isFinite(valor)) {
      const estilo = estiloFixo ?? formato?.estilo;
      return `<c r="${ref}"${estilo ? ` s="${estilo}"` : ''}><v>${valor}</v></c>`;
    }
    if (valor === null || valor === undefined || valor === '') return `<c r="${ref}"/>`;
    return `<c r="${ref}"${estiloFixo ? ` s="${estiloFixo}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escXml(valor)}</t></is></c>`;
  };
  const linhaCabecalho = `<row r="1">${colunas.map((c, i) => celula(c, `${colunaExcel(i)}1`, null, ESTILO.cabecalho)).join('')}</row>`;
  const corpo = linhas.map((l, li) =>
    `<row r="${li + 2}">${colunas.map((c, ci) => celula(l[c], `${colunaExcel(ci)}${li + 2}`, formatos[ci])).join('')}</row>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${linhaCabecalho}${corpo}</sheetData></worksheet>`;
}

function exportarXlsx(args) {
  if (!args.saida || args.abas.length === 0) {
    console.error('Uso: exportar.mjs xlsx --saida arquivo.xlsx --aba "Nome=SELECT ..." [--aba ...]');
    process.exit(1);
  }
  const db = abrirBanco({ somenteLeitura: true });
  const abas = args.abas.map((par) => {
    const posicao = par.indexOf('=');
    const nome = par.slice(0, posicao).trim().slice(0, 31) || 'Dados';
    const sql = par.slice(posicao + 1).trim();
    if (!/^\s*(select|with)\b/i.test(sql)) {
      console.error(`Apenas consultas de leitura nas abas ("${nome}").`);
      process.exit(1);
    }
    const linhas = db.prepare(sql).all();
    const colunas = linhas.length > 0 ? Object.keys(linhas[0]) : ['(sem resultados)'];
    return { nome, colunas, linhas };
  });
  db.close();

  const arquivos = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${TIPOS_DOCPROPS}${abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>${RELS_DOCPROPS}</Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas.map((a, i) => `<sheet name="${escXml(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="5"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="167" formatCode="0.0&quot;%&quot;"/><numFmt numFmtId="168" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF002233"/><bgColor rgb="FF002233"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  Object.assign(arquivos, docProps());
  abas.forEach((a, i) => {
    arquivos[`xl/worksheets/sheet${i + 1}.xml`] = planilhaXml(a.colunas, a.linhas);
  });
  gravarZip(args.saida, arquivos);
  console.log(`✅ Planilha gerada: ${resolve(args.saida)} (${abas.map((a) => `${a.nome}: ${a.linhas.length} linha(s)`).join('; ')})`);
}

// ---------- DOCX ----------

function textoComNegrito(texto) {
  // Divide em runs preservando **negrito**
  const partes = String(texto).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return partes.map((p) => {
    const negrito = p.startsWith('**') && p.endsWith('**');
    const t = negrito ? p.slice(2, -2) : p;
    return `<w:r>${negrito ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escXml(t)}</w:t></w:r>`;
  }).join('');
}

function paragrafo(texto, estilo, marcador = false) {
  const pPr = [];
  if (estilo) pPr.push(`<w:pStyle w:val="${estilo}"/>`);
  if (marcador) pPr.push('<w:ind w:left="360"/>');
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${textoComNegrito(marcador ? `• ${texto}` : texto)}</w:p>`;
}

function tabelaDocx(linhas) {
  const celulas = (cols, cabecalho) => cols.map((c) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${cabecalho ? '<w:shd w:val="clear" w:fill="002233"/>' : ''}</w:tcPr><w:p>${cabecalho ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${escXml(c)}</w:t></w:r>` : textoComNegrito(c)}</w:p></w:tc>`
  ).join('');
  const [cab, ...corpo] = linhas;
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:color="CCCCCC"/><w:insideV w:val="single" w:sz="4" w:color="CCCCCC"/></w:tblBorders></w:tblPr><w:tr>${celulas(cab, true)}</w:tr>${corpo.map((l) => `<w:tr>${celulas(l, false)}</w:tr>`).join('')}</w:tbl><w:p/>`;
}

function markdownParaDocx(md) {
  const blocos = [];
  const linhas = md.split(/\r?\n/);
  let tabela = null;
  const fecharTabela = () => { if (tabela) { blocos.push(tabelaDocx(tabela)); tabela = null; } };
  for (const linha of linhas) {
    if (/^\s*\|.*\|\s*$/.test(linha)) {
      const cols = linha.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cols.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separador
      (tabela ??= []).push(cols);
      continue;
    }
    fecharTabela();
    const t = linha.trim();
    if (t === '') continue;
    if (t.startsWith('### ')) blocos.push(paragrafo(t.slice(4), 'Heading3'));
    else if (t.startsWith('## ')) blocos.push(paragrafo(t.slice(3), 'Heading2'));
    else if (t.startsWith('# ')) blocos.push(paragrafo(t.slice(2), 'Heading1'));
    else if (/^[-*] /.test(t)) blocos.push(paragrafo(t.slice(2), null, true));
    else blocos.push(paragrafo(t));
  }
  fecharTabela();
  return blocos.join('');
}

function exportarDocx(args) {
  if (!args.entrada || !args.saida) {
    console.error('Uso: exportar.mjs docx --entrada conteudo.md --saida arquivo.docx');
    process.exit(1);
  }
  const corpo = markdownParaDocx(readFileSync(args.entrada, 'utf8'));
  const arquivos = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${TIPOS_DOCPROPS}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${RELS_DOCPROPS}</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="002233"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="002233"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="0A425F"/></w:rPr></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corpo}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  };
  Object.assign(arquivos, docProps());
  gravarZip(args.saida, arquivos);
  console.log(`✅ Documento gerado: ${resolve(args.saida)}`);
}

// ---------- PDF (via Edge/Chrome headless) ----------

function exportarPdf(args) {
  if (!args.entrada || !args.saida) {
    console.error('Uso: exportar.mjs pdf --entrada arquivo.html --saida arquivo.pdf');
    process.exit(1);
  }
  garantirPasta(args.saida);
  const navegador = acharNavegadorChromium();
  if (!navegador) {
    // Sem navegador Chromium (comum em Mac so com Safari): abrimos o arquivo
    // e orientamos a impressao manual, em vez de falhar sem saida.
    console.error(
      'Nao encontrei Chrome, Edge nem Brave para gerar o PDF automaticamente. '
      + `Abri o relatorio no seu navegador: ${DICA_IMPRIMIR_PDF}.`
    );
    abrirNoSistema(resolve(args.entrada));
    process.exit(1);
  }
  execFileSync(navegador, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
    '--virtual-time-budget=5000',
    `--print-to-pdf=${resolve(args.saida)}`, urlDeArquivo(args.entrada),
  ], { stdio: 'ignore', timeout: 120_000 });
  if (!existsSync(resolve(args.saida))) {
    console.error(`O navegador nao gerou o PDF. Alternativa: ${DICA_IMPRIMIR_PDF}.`);
    process.exit(1);
  }
  console.log(`PDF gerado: ${resolve(args.saida)}`);
}

// ---------- execução ----------

const modo = process.argv[2];
const args = lerArgs();
if (modo === 'xlsx') exportarXlsx(args);
else if (modo === 'docx') exportarDocx(args);
else if (modo === 'pdf') exportarPdf(args);
else {
  console.error('Uso: node scripts/exportar.mjs xlsx|docx|pdf ...  (veja o cabeçalho do arquivo)');
  process.exit(1);
}
