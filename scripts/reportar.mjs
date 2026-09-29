// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Reporta um problema, uma melhoria ou uma duvida para o projeto.
//
// CADA COISA NO SEU LUGAR: problema vira ISSUE (é trabalho a fazer, tem de
// entrar na fila de quem mantém); duvida e melhoria viram DISCUSSAO — dúvida
// numa categoria de pergunta e resposta, onde fica pesquisável para o próximo
// gestor com o mesmo aperto, e melhoria onde outros podem opinar antes de
// virar tarefa. Se o repositório não tiver Discussions (ou a categoria certa),
// tudo volta a ser issue automaticamente: o relato do gestor nunca se perde.
//
// O gestor nao sabe o que e GitHub — quem redige e envia e o assistente, e
// SEMPRE com o texto aprovado pelo gestor antes (issue e conteudo publico).
// Este script cuida da parte mecanica e da seguranca:
//   - remove automaticamente senhas, seriais e usuarios configurados que
//     apareceriam no texto (e sequencias que parecam token);
//   - anexa versao do assistente e sistema operacional, que ajudam a MHI a
//     reproduzir o problema;
//   - envia pelo GitHub CLI se houver um autenticado; senao, abre o navegador
//     com a issue ja preenchida para o gestor so confirmar (o GitHub pede
//     login — o assistente deve avisar isso antes).
//
// Uso:
//   node --no-warnings scripts/reportar.mjs bug|melhoria|duvida \
//        --titulo "resumo curto" --texto "descricao completa" [--simular]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EH_WINDOWS, EH_MAC, abrirNoSistema } from './plataforma.mjs';
import { carregarConexoes } from './conexoes.mjs';

// O GitHub CLI nem sempre e encontravel pelo PATH quando chamado sem shell
// (em especial no Windows) — procura nos locais de instalacao conhecidos.
function acharGh() {
  const candidatos = EH_WINDOWS
    ? [
      'C:/Program Files/GitHub CLI/gh.exe',
      'C:/Program Files (x86)/GitHub CLI/gh.exe',
      join(homedir(), 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
      join(homedir(), 'scoop', 'shims', 'gh.exe'),
    ]
    : EH_MAC
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
      : ['/usr/bin/gh', '/usr/local/bin/gh', '/snap/bin/gh'];
  return candidatos.find((c) => existsSync(c)) ?? (EH_WINDOWS ? 'gh.exe' : 'gh');
}
const GH = acharGh();

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'mhi-sistemas/totvs-food-linha-chef-gestor';
const TIPOS = {
  bug: { prefixo: '[problema]', rotulo: 'bug', destino: 'issue' },
  melhoria: { prefixo: '[melhoria]', rotulo: 'enhancement', destino: 'ideias' },
  duvida: { prefixo: '[duvida]', rotulo: 'question', destino: 'duvidas' },
};

// A categoria é descoberta em TEMPO DE EXECUÇÃO, nunca por id fixo: quem
// mantém o repositório pode renomear as categorias a qualquer momento, e o
// assistente instalado na casa do gestor não pode quebrar por causa disso.
//   duvidas -> a categoria de pergunta e resposta (isAnswerable)
//   ideias  -> a que fala de ideia/sugestão; na falta, a conversa geral
function acharCategoria(destino) {
  try {
    const saida = execFileSync(GH, ['api', 'graphql', '-f', `query={
      repository(owner: "${REPO.split('/')[0]}", name: "${REPO.split('/')[1]}") {
        hasDiscussionsEnabled
        discussionCategories(first: 25) { nodes { id name slug isAnswerable } }
      } }`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const repo = JSON.parse(saida)?.data?.repository;
    if (!repo?.hasDiscussionsEnabled) return null;
    const cats = repo.discussionCategories?.nodes ?? [];
    if (destino === 'duvidas') return cats.find((c) => c.isAnswerable) ?? null;
    const texto = (c) => `${c.name} ${c.slug}`.toLowerCase();
    return cats.find((c) => /ideia|ideas|sugest/.test(texto(c)))
      ?? cats.find((c) => /geral|general/.test(texto(c)))
      ?? null;
  } catch { return null; }
}

function criarDiscussao(categoriaId, titulo, corpo) {
  const escapar = (t) => JSON.stringify(String(t));
  const saida = execFileSync(GH, ['api', 'graphql', '-f', `query=
    mutation {
      createDiscussion(input: {
        repositoryId: ${escapar(idDoRepositorio())},
        categoryId: ${escapar(categoriaId)},
        title: ${escapar(titulo)},
        body: ${escapar(corpo)}
      }) { discussion { url } }
    }`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const url = JSON.parse(saida)?.data?.createDiscussion?.discussion?.url;
  if (!url) throw new Error('o GitHub não devolveu o endereço da discussão');
  return url;
}

function idDoRepositorio() {
  const saida = execFileSync(GH, ['api', 'graphql', '-f', `query={
    repository(owner: "${REPO.split('/')[0]}", name: "${REPO.split('/')[1]}") { id } }`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(saida).data.repository.id;
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

// Remove do texto qualquer credencial configurada (senha, serial, usuario) e
// sequencias longas que parecam token. Melhor redigir demais que vazar.
function removerSensiveis(texto) {
  let limpo = String(texto);
  let conexoes = [];
  try { conexoes = carregarConexoes(); } catch { /* sem configuracao */ }
  for (const c of conexoes) {
    for (const valor of [c.senha, c.serial, c.usuario]) {
      if (valor && String(valor).length >= 3) {
        limpo = limpo.split(String(valor)).join('[removido]');
      }
    }
  }
  // Tokens da API (sequencias base64/jwt longas) nunca fazem falta num relato.
  limpo = limpo.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[removido]');
  return limpo;
}

function versaoDoAssistente() {
  try { return JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).version; } catch { return '?'; }
}

function montarCorpo(texto) {
  const sistema = platform() === 'win32' ? `Windows (${release()})`
    : platform() === 'darwin' ? `macOS (${release()})` : `${platform()} (${release()})`;
  return `${removerSensiveis(texto).trim()}

---
Versão do assistente: ${versaoDoAssistente()} · Sistema: ${sistema} · Node: ${process.versions.node}
_Relato redigido com ajuda do assistente; dados de acesso são removidos automaticamente._`;
}

function ghAutenticado() {
  try {
    execFileSync(GH, ['auth', 'status'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

const tipo = TIPOS[process.argv[2]];
const args = lerArgs();
if (!tipo || typeof args.titulo !== 'string' || typeof args.texto !== 'string') {
  console.error('Uso: reportar.mjs bug|melhoria|duvida --titulo "resumo" --texto "descricao" [--simular]');
  console.error('Lembrete: leia o texto para o gestor e só envie com a aprovação dele.');
  process.exitCode = 1;
} else {
  const titulo = `${tipo.prefixo} ${removerSensiveis(args.titulo).trim()}`;
  const corpo = montarCorpo(args.texto);

  if (args.simular) {
    console.log('--- SIMULAÇÃO (nada foi enviado) ---');
    console.log(`Título: ${titulo}`);
    console.log(`Rótulo: ${tipo.rotulo}`);
    const cat = tipo.destino !== 'issue' && ghAutenticado() ? acharCategoria(tipo.destino) : null;
    console.log(`Destino: ${cat ? `discussão na categoria "${cat.name}"` : 'issue'}`);
    console.log(`Envio: ${ghAutenticado() ? 'direto (GitHub CLI autenticado)' : 'navegador já preenchido'}`);
    console.log('--- corpo ---');
    console.log(corpo);
  } else if (ghAutenticado()) {
    // Dúvida e melhoria preferem discussão; qualquer tropeço volta para issue,
    // porque o que não pode acontecer é o relato do gestor se perder.
    const categoria = tipo.destino === 'issue' ? null : acharCategoria(tipo.destino);
    let enviado = null;
    if (categoria) {
      try {
        enviado = criarDiscussao(categoria.id, titulo, corpo);
        console.log(`Relato enviado como discussão em "${categoria.name}": ${enviado}`);
      } catch (erro) {
        console.warn(`Não consegui abrir a discussão (${String(erro.message).slice(0, 120)}); `
          + 'registrando como issue.');
      }
    }
    if (!enviado) {
      try {
        const url = execFileSync(
          GH,
          ['issue', 'create', '--repo', REPO, '--title', titulo, '--body', corpo, '--label', tipo.rotulo],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim();
        console.log(`Relato enviado: ${url}`);
      } catch (erro) {
        console.error(`Não consegui enviar pelo GitHub CLI: ${String(erro.stderr || erro.message).slice(0, 200)}`);
        process.exitCode = 1;
      }
    }
  } else {
    // Sem GitHub CLI: abre o navegador com tudo preenchido. O GitHub pede
    // login (conta gratuita) — o assistente deve ter avisado o gestor antes.
    // Sem CLI nao da para descobrir a categoria (a consulta exige token), entao
    // o formulario de discussao vai sem ela — o GitHub pede que o gestor
    // escolha na tela, que e um clique.
    const url = tipo.destino === 'issue'
      ? `https://github.com/${REPO}/issues/new?labels=${encodeURIComponent(tipo.rotulo)}`
        + `&title=${encodeURIComponent(titulo)}&body=${encodeURIComponent(corpo)}`
      : `https://github.com/${REPO}/discussions/new?title=${encodeURIComponent(titulo)}`
        + `&body=${encodeURIComponent(corpo)}`;
    abrirNoSistema(url, () => {
      console.error('Não consegui abrir o navegador. Endereço para abrir manualmente:');
      console.error(url);
    });
    console.log(tipo.destino === 'issue'
      ? 'Abri no navegador a página de envio, já preenchida — é só clicar em "Submit new issue".'
      : 'Abri no navegador a página de envio, já preenchida — escolha a categoria e clique em "Start discussion".');
    console.log('(O site pede uma conta do GitHub, que é gratuita.)');
  }
}
