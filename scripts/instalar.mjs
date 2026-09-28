// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Prepara o projeto no computador do gestor, logo depois do download.
//
// Este script existe para que a instalacao seja UMA acao, feita pelo
// assistente, e nao uma sequencia de comandos que o gestor precise entender:
// confere a versao do Node, cria as pastas locais, monta o banco e deixa um
// atalho na area de trabalho para reabrir o assistente com dois cliques.
//
// Uso:
//   node --no-warnings scripts/instalar.mjs [--sem-atalho]

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EH_WINDOWS, pastaAreaDeTrabalho } from './plataforma.mjs';
import { abrirBanco, criarSchema, CAMINHO_BANCO } from './criar-banco.mjs';
import { carregarConexoes } from './conexoes.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MINIMO = [22, 5, 0];
const NOME_ATALHO = 'Assistente de Gestao - TOTVS Chef';

function versaoAtendeMinimo() {
  const atual = process.versions.node.split('.').map(Number);
  for (let i = 0; i < NODE_MINIMO.length; i += 1) {
    if ((atual[i] ?? 0) > NODE_MINIMO[i]) return true;
    if ((atual[i] ?? 0) < NODE_MINIMO[i]) return false;
  }
  return true;
}

// Atalho que entra na pasta do projeto e abre o assistente de IA instalado.
// Tenta o Claude Code e, se nao houver, o Codex — o projeto funciona nos dois.
function conteudoDoAtalho() {
  if (EH_WINDOWS) {
    return [
      '@echo off',
      'title Assistente de Gestao - TOTVS Food Linha Chef',
      `cd /d "${RAIZ}"`,
      'where claude >nul 2>nul',
      'if %errorlevel%==0 (',
      '  call claude',
      '  goto fim',
      ')',
      'where codex >nul 2>nul',
      'if %errorlevel%==0 (',
      '  call codex',
      '  goto fim',
      ')',
      'echo.',
      'echo Nao encontrei o Claude Code nem o Codex neste computador.',
      'echo Instale um dos dois seguindo o guia docs/instalacao.md e tente de novo.',
      'echo.',
      'pause',
      ':fim',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/bash',
    `cd "${RAIZ}" || exit 1`,
    'if command -v claude >/dev/null 2>&1; then',
    '  exec claude',
    'elif command -v codex >/dev/null 2>&1; then',
    '  exec codex',
    'else',
    '  echo "Nao encontrei o Claude Code nem o Codex neste computador."',
    '  echo "Instale um dos dois seguindo o guia docs/instalacao.md e tente de novo."',
    '  read -n 1 -s -r -p "Pressione qualquer tecla para fechar."',
    'fi',
    '',
  ].join('\n');
}

function criarAtalho() {
  const area = pastaAreaDeTrabalho();
  if (!area) return null;
  const caminho = join(area, `${NOME_ATALHO}${EH_WINDOWS ? '.cmd' : '.command'}`);
  try {
    writeFileSync(caminho, conteudoDoAtalho(), 'utf8');
    if (!EH_WINDOWS) chmodSync(caminho, 0o755);
    return caminho;
  } catch {
    return null;
  }
}

// Memoria persistente do assistente DESTE gestor: aprendizados (preferencias,
// fatos da operacao, decisoes) e handoff (estado entre uma conversa e outra).
// Os modelos so sao criados se nao existirem — nunca sobrescrevem.
function criarMemoriaSeFaltar() {
  const pasta = join(RAIZ, 'data', 'memoria');
  const aprendizados = join(pasta, 'aprendizados.md');
  const handoff = join(pasta, 'handoff.md');
  if (!existsSync(aprendizados)) {
    writeFileSync(aprendizados, [
      '# Aprendizados sobre este gestor e esta operacao',
      '',
      'O assistente escreve aqui, com data, tudo que for duravel: preferencias',
      'do gestor, apelidos de produtos/lojas, fatos da operacao, decisoes e',
      'combinados. NUNCA registrar senhas, credenciais ou dados pessoais de',
      'clientes. Uma secao por tema; frases completas, legiveis sem a conversa',
      'original.',
      '',
      '## Preferencias do gestor',
      '',
      '(nenhuma registrada ainda)',
      '',
      '## Sobre a operacao',
      '',
      '(nada registrado ainda)',
      '',
      '## Decisoes e combinados',
      '',
      '(nenhum registrado ainda)',
      '',
    ].join('\n'), 'utf8');
  }
  if (!existsSync(handoff)) {
    writeFileSync(handoff, [
      '# Handoff — estado entre conversas',
      '',
      'Reescrito pelo assistente ao fim de cada conversa relevante (curto:',
      'pendencias, contexto em andamento, proximo passo combinado).',
      '',
      '(primeira conversa ainda nao aconteceu)',
      '',
    ].join('\n'), 'utf8');
  }
}

// ---------------------------------------------------------------------------

console.log('Preparando o assistente no seu computador...\n');

if (!versaoAtendeMinimo()) {
  console.error(
    `O Node.js instalado e a versao ${process.versions.node}, e o assistente precisa da ${NODE_MINIMO.join('.')} ou mais nova.\n`
    + 'Baixe a versao LTS em https://nodejs.org/pt, instale clicando em Avancar ate o fim,\n'
    + 'feche e abra o assistente de novo.'
  );
  process.exitCode = 1;
} else {
  for (const pasta of ['data', 'data/memoria', 'relatorios', 'personalizados']) {
    mkdirSync(join(RAIZ, pasta), { recursive: true });
  }
  criarMemoriaSeFaltar();
  console.log('1. Pastas de trabalho criadas (incluindo a memória do assistente).');

  const db = abrirBanco();
  try { criarSchema(db); } finally { db.close(); }
  console.log(`2. Banco de dados local pronto (${CAMINHO_BANCO}).`);

  const semAtalho = process.argv.includes('--sem-atalho');
  if (semAtalho) {
    console.log('3. Atalho na area de trabalho: dispensado a pedido.');
  } else {
    const atalho = criarAtalho();
    console.log(atalho
      ? `3. Atalho criado na area de trabalho: "${NOME_ATALHO}".`
      : '3. Nao consegui criar o atalho na area de trabalho (siga sem ele; nada se perde).');
  }

  const conexoes = carregarConexoes();
  console.log('');
  if (conexoes.length === 0) {
    console.log('Falta so conectar a loja. Proximo passo:');
    console.log('  node --no-warnings scripts/configurar.mjs');
  } else {
    const nomes = conexoes.map((c) => c.nome).join(', ');
    console.log(`Ja existe acesso configurado (${nomes}). O assistente pode sincronizar e analisar.`);
  }
}
