// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Copia de seguranca do banco local — e a restauracao dela.
//
// O historico coletado e caro de reconstruir: a busca de periodos antigos so
// funciona de madrugada (23h-07h), em blocos, respeitando o limite de
// requisicoes da TOTVS. Se o computador do gestor morrer sem copia, sao
// semanas para voltar ao ponto onde estava. Por decisao do projeto, a copia
// fica em PASTA LOCAL (Documentos, na mesma maquina) — nada sai do computador;
// quem quiser outro destino (ex.: uma pasta sincronizada) aponta com --pasta.
// Credenciais (data/conexoes.json) NUNCA entram na copia.
//
// Uso:
//   node --no-warnings scripts/backup.mjs criar [--pasta <destino>]
//   node --no-warnings scripts/backup.mjs listar
//   node --no-warnings scripts/backup.mjs restaurar --arquivo <nome|caminho> --confirmar

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync, createReadStream, createWriteStream,
} from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';
import { pastaDocumentos } from './plataforma.mjs';
import { abrirBanco, criarSchema, CAMINHO_BANCO } from './criar-banco.mjs';

const PASTA_DADOS = dirname(CAMINHO_BANCO);
const CAMINHO_CONFIG = join(PASTA_DADOS, 'backup.json');
const NOME_SUBPASTA = 'Assistente TOTVS Chef - Backups';
const PREFIXO = 'chef-backup-';
const MANTER_COPIAS = 14;

const brBytes = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`);
const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

// Pasta de destino: a escolhida pelo gestor (data/backup.json), senao uma
// subpasta dentro de Documentos. Cria se nao existir.
export function pastaDeBackup() {
  let base = null;
  if (existsSync(CAMINHO_CONFIG)) {
    try { base = JSON.parse(readFileSync(CAMINHO_CONFIG, 'utf8')).pasta || null; } catch { /* ignora */ }
  }
  const pasta = base ?? join(pastaDocumentos(), NOME_SUBPASTA);
  mkdirSync(pasta, { recursive: true });
  return pasta;
}

function guardarPastaEscolhida(pasta) {
  mkdirSync(PASTA_DADOS, { recursive: true });
  writeFileSync(CAMINHO_CONFIG, JSON.stringify({ pasta }, null, 2), 'utf8');
}

export function listarCopias(pasta) {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta)
    .filter((n) => n.startsWith(PREFIXO) && n.endsWith('.db.gz'))
    .sort()
    .reverse()
    .map((nome) => {
      const caminho = join(pasta, nome);
      return { nome, caminho, bytes: statSync(caminho).size, dia: nome.slice(PREFIXO.length, PREFIXO.length + 10) };
    });
}

function aplicarRotacao(pasta) {
  const excedentes = listarCopias(pasta).slice(MANTER_COPIAS);
  for (const copia of excedentes) {
    try { rmSync(copia.caminho); } catch { /* ok */ }
  }
  return excedentes.length;
}

// Cria a copia do dia: VACUUM INTO gera um arquivo integro e compacto mesmo
// com o banco em uso; depois comprimimos em stream (bancos grandes nao cabem
// em memoria com folga). Exportada para a rotina diaria reusar.
export async function criarBackup({ silencioso = false } = {}) {
  if (!existsSync(CAMINHO_BANCO)) {
    throw new Error('Ainda nao ha dados para copiar — o banco local nao foi criado.');
  }
  // Disco cheio ja matou uma copia no meio (27/09/2026), deixando um
  // temporario de centenas de MB: melhor recusar com clareza do que morrer.
  const { statfsSync, statSync } = await import('node:fs');
  const disco = statfsSync(PASTA_DADOS);
  const livre = disco.bsize * disco.bavail;
  const necessario = statSync(CAMINHO_BANCO).size * 1.2 + 200 * 1024 * 1024;
  if (livre < necessario) {
    throw new Error('sem espaço em disco para a cópia de segurança '
      + `(livre: ${Math.round(livre / 1048576)} MB; necessário: ~${Math.round(necessario / 1048576)} MB). `
      + 'Libere espaço no computador.');
  }
  const pasta = pastaDeBackup();
  const hoje = new Date();
  const dia = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  const destino = join(pasta, `${PREFIXO}${dia}.db.gz`);
  const temporario = join(PASTA_DADOS, 'copia-em-andamento.db');

  try { rmSync(temporario); } catch { /* nao existia */ }
  const db = abrirBanco({ somenteLeitura: true });
  try {
    db.exec(`VACUUM INTO '${temporario.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  await pipeline(createReadStream(temporario), createGzip({ level: 6 }), createWriteStream(destino));
  rmSync(temporario);
  const apagadas = aplicarRotacao(pasta);

  const bytes = statSync(destino).size;
  if (!silencioso) {
    console.log(`Copia de seguranca criada: ${destino} (${brBytes(bytes)}).`);
    if (apagadas > 0) console.log(`Copias antigas removidas: ${apagadas} (ficam as ${MANTER_COPIAS} mais recentes).`);
  }
  return { caminho: destino, bytes };
}

async function restaurar(args) {
  if (!args.arquivo) {
    console.error('Informe qual copia restaurar: backup.mjs restaurar --arquivo <nome|caminho> --confirmar');
    process.exitCode = 1;
    return;
  }
  const origem = isAbsolute(args.arquivo) ? args.arquivo : join(pastaDeBackup(), args.arquivo);
  if (!existsSync(origem)) {
    console.error(`Nao encontrei a copia "${args.arquivo}". Veja as disponiveis com: backup.mjs listar`);
    process.exitCode = 1;
    return;
  }
  if (!args.confirmar) {
    console.error(
      'Restaurar SUBSTITUI os dados atuais pelos da copia. Confirme com o gestor antes\n'
      + 'e repita o comando acrescentando --confirmar.'
    );
    process.exitCode = 1;
    return;
  }

  // Guarda o banco atual antes de sobrescrever — restauracao errada nao pode
  // ser a segunda perda de dados do dia.
  const marcaTempo = new Date().toISOString().replace(/[:.]/g, '-');
  if (existsSync(CAMINHO_BANCO)) {
    renameSync(CAMINHO_BANCO, `${CAMINHO_BANCO}.substituido-${marcaTempo}`);
  }
  for (const sufixo of ['-wal', '-shm']) {
    try { rmSync(`${CAMINHO_BANCO}${sufixo}`); } catch { /* nao existia */ }
  }

  mkdirSync(PASTA_DADOS, { recursive: true });
  await pipeline(createReadStream(origem), createGunzip(), createWriteStream(CAMINHO_BANCO));

  // Reabre aplicando migracoes (a copia pode ser de uma versao mais antiga).
  const db = abrirBanco();
  let vendas = 0;
  try {
    criarSchema(db);
    vendas = db.prepare('SELECT COUNT(*) AS n FROM vendas').get()?.n ?? 0;
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
      throw new Error('a copia restaurada nao passou na verificacao de integridade');
    }
  } finally {
    db.close();
  }
  const diaDaCopia = origem.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  console.log(`Dados restaurados${diaDaCopia ? ` da copia de ${dmy(diaDaCopia)}` : ''}: ${vendas} vendas no banco.`);
  console.log(`O banco anterior ficou guardado como chef.db.substituido-${marcaTempo} (pode ser apagado depois).`);
}

function listar() {
  const pasta = pastaDeBackup();
  const copias = listarCopias(pasta);
  console.log(`Pasta das copias: ${pasta}`);
  if (copias.length === 0) {
    console.log('(nenhuma copia de seguranca ainda — crie com: backup.mjs criar)');
    return;
  }
  for (const c of copias) console.log(`  ${c.nome}  ${dmy(c.dia)}  ${brBytes(c.bytes)}`);
  console.log(`${copias.length} copia(s); as ${MANTER_COPIAS} mais recentes sao mantidas.`);
}

function lerArgs() {
  const args = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const nome = argv[i].slice(2);
      const proximo = argv[i + 1];
      if (proximo && !proximo.startsWith('--')) { args[nome] = proximo; i += 1; }
      else args[nome] = true;
    }
  }
  return args;
}

// So despacha quando chamado direto — a rotina diaria importa criarBackup().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  const args = lerArgs();
  try {
    if (acao === 'criar') {
      if (typeof args.pasta === 'string') guardarPastaEscolhida(args.pasta);
      await criarBackup();
    } else if (acao === 'listar') {
      listar();
    } else if (acao === 'restaurar') {
      await restaurar(args);
    } else {
      console.error('Acao invalida. Use: criar [--pasta <destino>] | listar | restaurar --arquivo <nome> --confirmar');
      process.exitCode = 1;
    }
  } catch (erro) {
    console.error(`Nao consegui concluir: ${erro.message}`);
    process.exitCode = 1;
  }
}
