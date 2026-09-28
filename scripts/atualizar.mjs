// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Verificacao e aplicacao de atualizacoes do proprio assistente.
//
// Sem isto, cada melhoria publicada so alcancaria instalacoes novas: o gestor
// nunca vai rodar "git pull" — ele nem sabe que isso existe. A rotina diaria
// chama a verificacao em silencio; quando ha versao nova, ela e aplicada e o
// que mudou fica registrado em data/atualizacao.json, para o assistente
// contar ao gestor na proxima conversa (e apagar o registro depois).
//
// A versao vem do package.json e o texto das mudancas do CHANGELOG.md — toda
// publicacao precisa atualizar os dois.
//
// Uso:
//   node --no-warnings scripts/atualizar.mjs verificar [--silencioso]
//   node --no-warnings scripts/atualizar.mjs aplicar
//
// Funciona nos dois modos de instalacao: com Git (fetch + merge só-avanço) e
// por ZIP (baixa o pacote e substitui os arquivos do projeto, preservando
// data/, personalizados/ e relatorios/).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EH_WINDOWS, comandoDoSistema } from './plataforma.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'mhi-sistemas/totvs-food-linha-chef-gestor';
const RAMO = 'master';
export const CAMINHO_AVISO = join(RAIZ, 'data', 'atualizacao.json');
// O que NUNCA e sobrescrito por uma atualizacao: dados e escolhas do gestor.
const NAO_COPIAR = new Set(['data', 'relatorios', 'personalizados', '.git', 'node_modules']);

const versaoLocal = () => JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).version;

// -1 se a < b, 0 se iguais, 1 se a > b (comparacao numerica por partes).
function compararVersoes(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

function git(argumentos) {
  return execFileSync('git', argumentos, {
    cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function instaladoComGit() {
  if (!existsSync(join(RAIZ, '.git'))) return false;
  try { git(['--version']); return true; } catch { return false; }
}

// Consulta a versao publicada. Devolve null quando nao da para saber (sem
// internet, sem acesso ao repositorio...) — nunca lanca: a verificacao diaria
// precisa falhar em silencio e tentar de novo amanha.
async function consultarPublicada() {
  if (instaladoComGit()) {
    try {
      git(['fetch', '--quiet', 'origin', RAMO]);
      const pacote = JSON.parse(git(['show', `origin/${RAMO}:package.json`]));
      let changelog = '';
      try { changelog = git(['show', `origin/${RAMO}:CHANGELOG.md`]); } catch { /* sem changelog */ }
      return { versao: pacote.version, changelog, via: 'git' };
    } catch { return null; }
  }
  try {
    const base = `https://raw.githubusercontent.com/${REPO}/${RAMO}`;
    const resposta = await fetch(`${base}/package.json`, { signal: AbortSignal.timeout(20_000) });
    if (!resposta.ok) return null;
    const pacote = await resposta.json();
    let changelog = '';
    try {
      const rc = await fetch(`${base}/CHANGELOG.md`, { signal: AbortSignal.timeout(20_000) });
      if (rc.ok) changelog = await rc.text();
    } catch { /* segue sem o texto */ }
    return { versao: pacote.version, changelog, via: 'zip' };
  } catch { return null; }
}

// Secoes do CHANGELOG mais novas que a versao local — e o texto que o
// assistente usa para contar ao gestor o que mudou.
function novidadesDesde(changelog, versaoDe) {
  const blocos = String(changelog).split(/^## /m).slice(1);
  const novas = [];
  for (const bloco of blocos) {
    const v = bloco.match(/\[?(\d+\.\d+\.\d+)\]?/)?.[1];
    if (v && compararVersoes(versaoDe, v) < 0) novas.push(`## ${bloco.trim()}`);
  }
  return novas.join('\n\n');
}

export async function verificarAtualizacao() {
  const local = versaoLocal();
  const publicada = await consultarPublicada();
  if (!publicada) return { situacao: 'indisponivel', local };
  if (compararVersoes(local, publicada.versao) >= 0) return { situacao: 'em-dia', local };
  return {
    situacao: 'nova-versao',
    local,
    nova: publicada.versao,
    via: publicada.via,
    novidades: novidadesDesde(publicada.changelog, local),
  };
}

function aplicarViaGit() {
  const pendencias = git(['status', '--porcelain']).trim();
  if (pendencias) {
    throw new Error('há alterações locais nos arquivos do projeto; resolva antes de atualizar (git status)');
  }
  git(['merge', '--ff-only', `origin/${RAMO}`]);
}

async function aplicarViaZip() {
  const resposta = await fetch(
    `https://codeload.github.com/${REPO}/zip/refs/heads/${RAMO}`,
    { signal: AbortSignal.timeout(120_000) }
  );
  if (!resposta.ok) throw new Error(`download recusado (HTTP ${resposta.status})`);
  const pastaTemporaria = join(tmpdir(), `chef-atualizacao-${Date.now()}`);
  mkdirSync(pastaTemporaria, { recursive: true });
  try {
    const zip = join(pastaTemporaria, 'projeto.zip');
    writeFileSync(zip, Buffer.from(await resposta.arrayBuffer()));
    // No Windows o tar do PATH pode ser o GNU tar, que nao abre .zip — o do
    // System32 (bsdtar) abre. No macOS o tar do sistema resolve.
    const tar = EH_WINDOWS ? comandoDoSistema('tar') : 'tar';
    const extracao = spawnSync(tar, ['-xf', zip, '-C', pastaTemporaria], { stdio: 'pipe' });
    if (extracao.status !== 0) throw new Error('não consegui abrir o pacote baixado');
    const pastaExtraida = readdirSync(pastaTemporaria).find((n) => n !== 'projeto.zip');
    if (!pastaExtraida) throw new Error('o pacote baixado veio vazio');
    const origem = join(pastaTemporaria, pastaExtraida);
    for (const item of readdirSync(origem)) {
      if (NAO_COPIAR.has(item)) continue;
      cpSync(join(origem, item), join(RAIZ, item), { recursive: true, force: true });
    }
  } finally {
    rmSync(pastaTemporaria, { recursive: true, force: true });
  }
}

// Verifica e, havendo versao nova, aplica. Registra o resultado em
// data/atualizacao.json para o assistente anunciar ao gestor uma unica vez.
export async function aplicarAtualizacao({ silencioso = false } = {}) {
  const resultado = await verificarAtualizacao();
  if (resultado.situacao !== 'nova-versao') return resultado;

  if (resultado.via === 'git') aplicarViaGit();
  else await aplicarViaZip();

  // Reaplica preparacao e migracoes do banco na versao nova.
  spawnSync(
    process.execPath,
    ['--no-warnings', join(RAIZ, 'scripts', 'instalar.mjs')],
    { cwd: RAIZ, stdio: silencioso ? 'ignore' : 'inherit' }
  );

  mkdirSync(join(RAIZ, 'data'), { recursive: true });
  writeFileSync(CAMINHO_AVISO, JSON.stringify({
    de: resultado.local,
    para: resultado.nova,
    aplicada_em: new Date().toISOString(),
    novidades: resultado.novidades,
  }, null, 2), 'utf8');
  return { ...resultado, situacao: 'atualizado' };
}

function imprimirNovidades(novidades) {
  if (novidades) console.log(`\n${novidades}`);
}

// So despacha quando chamado direto — a rotina diaria importa as funcoes.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  const silencioso = process.argv.includes('--silencioso');
  try {
    if (acao === 'verificar') {
      const r = await verificarAtualizacao();
      if (r.situacao === 'nova-versao') {
        console.log(`Versão nova disponível: ${r.nova} (você está na ${r.local}).`);
        imprimirNovidades(r.novidades);
        console.log('\nPara aplicar: node --no-warnings scripts/atualizar.mjs aplicar');
      } else if (!silencioso) {
        console.log(r.situacao === 'em-dia'
          ? `Você já está na versão mais recente (${r.local}).`
          : 'Não consegui consultar a versão publicada (sem internet?). Tento de novo na próxima rotina.');
      }
    } else if (acao === 'aplicar') {
      const r = await aplicarAtualizacao();
      if (r.situacao === 'atualizado') {
        console.log(`Assistente atualizado: ${r.local} -> ${r.nova}.`);
        imprimirNovidades(r.novidades);
      } else {
        console.log(r.situacao === 'em-dia'
          ? `Nada a fazer: você já está na versão mais recente (${r.local}).`
          : 'Não consegui consultar a versão publicada (sem internet?). Tente mais tarde.');
      }
    } else {
      console.error('Acao invalida. Use: verificar [--silencioso] | aplicar');
      process.exitCode = 1;
    }
  } catch (erro) {
    console.error(`Não consegui concluir a atualização: ${erro.message}`);
    process.exitCode = 1;
  }
}
