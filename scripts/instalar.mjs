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
//
// Uso:
//   node --no-warnings scripts/instalar.mjs

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pastaAreaDeTrabalho } from './plataforma.mjs';
import { abrirBanco, criarSchema, CAMINHO_BANCO } from './criar-banco.mjs';
import { carregarConexoes } from './conexoes.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MINIMO = [22, 5, 0];

function versaoAtendeMinimo() {
  const atual = process.versions.node.split('.').map(Number);
  for (let i = 0; i < NODE_MINIMO.length; i += 1) {
    if ((atual[i] ?? 0) > NODE_MINIMO[i]) return true;
    if ((atual[i] ?? 0) < NODE_MINIMO[i]) return false;
  }
  return true;
}

// Versoes anteriores criavam um atalho na area de trabalho que abria o CLI
// num terminal. Nao servia: quem usa o app de desktop (Claude Desktop, por
// exemplo) so via uma janela preta abrir, e nao ha como um atalho mandar o
// app abrir uma pasta especifica. Removido — e removido tambem de quem ja o
// tinha, para nao ficar um atalho quebrado na area de trabalho do gestor.
function removerAtalhoAntigo() {
  const area = pastaAreaDeTrabalho();
  if (!area) return false;
  let removeu = false;
  for (const nome of ['Assistente de Gestao - TOTVS Chef.cmd', 'Assistente de Gestao - TOTVS Chef.command']) {
    try {
      const caminho = join(area, nome);
      if (existsSync(caminho)) { rmSync(caminho); removeu = true; }
    } catch { /* sem permissao: tudo bem, e so um atalho */ }
  }
  return removeu;
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

  if (removerAtalhoAntigo()) {
    console.log('3. Atalho antigo da area de trabalho removido (ele abria um terminal e nao ajudava).');
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
