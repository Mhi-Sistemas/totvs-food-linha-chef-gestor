// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// LEITOR de planilhas (.xlsx) e de texto separado (.csv/.tsv), em Node puro —
// sem dependencia npm, como todo o resto do projeto (exportar.mjs ja ESCREVE
// xlsx; aqui fechamos o outro lado).
//
// Existe porque nem tudo o que o gestor precisa esta na API: o inventario
// contado, por exemplo, so sai pela tela do ChefWeb, exportado em planilha.
//
// Um .xlsx e um ZIP com XML dentro. Lemos o diretorio central do ZIP,
// descomprimimos com zlib e extraimos as celulas com expressoes regulares —
// suficiente e estavel para planilhas geradas por sistemas, que nao usam os
// recursos exoticos do formato.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------- ZIP ----------

// Le o diretorio central e devolve { nome: Buffer } com os arquivos internos.
// So o necessario para um .xlsx: sem ZIP64, sem criptografia.
function abrirZip(buf) {
  // O fim do diretorio central (EOCD) fica no rodape, depois de um comentario
  // de tamanho variavel — por isso a busca de tras para a frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('arquivo não parece uma planilha .xlsx válida (fim do pacote não encontrado)');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('planilha muito grande (formato ZIP64), não suportada');

  const arquivos = {};
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const tamNome = buf.readUInt16LE(p + 28);
    const tamExtra = buf.readUInt16LE(p + 30);
    const tamComentario = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + tamNome);

    // O cabecalho local repete o nome e o extra, com tamanhos PROPRIOS —
    // usar os do diretorio central aqui e um erro classico.
    const nomeLocal = buf.readUInt16LE(offset + 26);
    const extraLocal = buf.readUInt16LE(offset + 28);
    const inicio = offset + 30 + nomeLocal + extraLocal;
    const bruto = buf.subarray(inicio, inicio + tamComprimido);
    arquivos[nome] = metodo === 0 ? bruto : inflateRawSync(bruto);

    p += 46 + tamNome + tamExtra + tamComentario;
  }
  return arquivos;
}

// ---------- XML ----------

function desescapar(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // por ultimo, senao desfaz os anteriores
}

// "BC" -> 54. Coluna do Excel em letras para indice base zero.
function indiceDaColuna(ref) {
  const letras = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Serial de data do Excel -> AAAA-MM-DD. A epoca e 30/12/1899 por causa do
// bug historico do Lotus 1-2-3 (1900 tratado como bissexto), que o Excel
// preserva ate hoje.
export function dataDoExcel(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- leitura ----------

// Devolve as linhas da primeira aba como array de arrays de STRING.
// As celulas vazias viram '' e a posicao e respeitada mesmo quando a planilha
// omite celulas (o Excel grava esparso: <c r="D11"/> pode simplesmente faltar).
export function lerXlsx(caminho) {
  const arquivos = abrirZip(readFileSync(caminho));
  const nomeAba = Object.keys(arquivos)
    .filter((n) => /^xl\/worksheets\/.*\.xml$/.test(n))
    .sort()[0];
  if (!nomeAba) throw new Error('a planilha não tem nenhuma aba legível');

  const compartilhadas = [];
  if (arquivos['xl/sharedStrings.xml']) {
    const xml = arquivos['xl/sharedStrings.xml'].toString('utf8');
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      // Um <si> pode vir partido em varios <t> (formatacao no meio da frase).
      const partes = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
      compartilhadas.push(desescapar(partes.map((t) => t.replace(/<[^>]*>/g, '')).join('')));
    }
  }

  const xml = arquivos[nomeAba].toString('utf8');
  const linhas = [];
  for (const linha of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) ?? []) {
    const celulas = [];
    for (const c of linha.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) ?? []) {
      const ref = c.match(/\br="([A-Z]+\d+)"/)?.[1];
      const tipo = c.match(/\bt="([^"]+)"/)?.[1];
      let valor = '';
      if (tipo === 'inlineStr') {
        const partes = c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
        valor = desescapar(partes.map((t) => t.replace(/<[^>]*>/g, '')).join(''));
      } else {
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v !== undefined) {
          valor = tipo === 's' ? (compartilhadas[Number(v)] ?? '') : desescapar(v);
        }
      }
      const i = ref ? indiceDaColuna(ref) : celulas.length;
      while (celulas.length < i) celulas.push('');
      celulas[i] = valor;
    }
    linhas.push(celulas);
  }
  return linhas;
}

// Le .csv/.tsv respeitando o BOM. O ChefWeb exporta em UTF-16 little-endian,
// que sem tratamento vira texto com um \0 entre cada letra.
export function lerTexto(caminho) {
  const buf = readFileSync(caminho);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const trocado = Buffer.from(buf.subarray(2));
    trocado.swap16();
    return trocado.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

// Separador por maioria na primeira linha longa — evita errar em arquivo que
// tem ';' dentro de um nome de produto.
function descobrirSeparador(linhas) {
  const amostra = linhas.filter((l) => l.trim()).slice(0, 30);
  let melhor = ';';
  let placar = -1;
  for (const sep of [';', '\t', ',']) {
    const contagens = amostra.map((l) => l.split(sep).length - 1);
    const total = contagens.reduce((s, n) => s + n, 0);
    if (total > placar) { placar = total; melhor = sep; }
  }
  return melhor;
}

export function lerCsv(caminho) {
  const texto = lerTexto(caminho).replace(/\r\n?/g, '\n');
  const linhas = texto.split('\n');
  const sep = descobrirSeparador(linhas);
  return linhas.map((l) => l.split(sep).map((c) => c.trim()));
}

// Le planilha ou texto conforme a extensao.
export function lerPlanilha(caminho) {
  return /\.xlsx?$/i.test(caminho) ? lerXlsx(caminho) : lerCsv(caminho);
}
