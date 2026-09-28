// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Agenda tarefas do assistente no agendador do próprio sistema operacional,
// para que rodem sozinhas — mesmo com o assistente fechado.
//
// Por que existe: a API da TOTVS só libera o histórico de vendas entre 23h e
// 07h, e uma carga grande leva horas. Não faz sentido pedir ao gestor que
// fique acordado digitando comandos: o assistente agenda e avisa que o
// computador precisa ficar ligado (e sem entrar em suspensão) no período.
//
// Windows: Agendador de Tarefas (schtasks). macOS/Linux: crontab.
//
// SEGUNDA OPCAO: prefira o agendador do ambiente em que o assistente roda
// (Claude Code, Codex, Orca, Paseo...). Use este script quando esse ambiente
// nao oferecer agendamento.
//
// Uso:
//   node --no-warnings scripts/agendar.mjs criar --nome <id> --hora 23:10 \
//        --comando "lojas.mjs coletar --grupo minha-rede" [--diario]
//   node --no-warnings scripts/agendar.mjs listar
//   node --no-warnings scripts/agendar.mjs cancelar --nome <id>

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EH_WINDOWS, comandoDoSistema } from './plataforma.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_DADOS = join(RAIZ, 'data');
const PREFIXO = 'AssistenteChef';

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

// Gera o arquivo que o agendador vai executar. Escrevemos um arquivo em vez de
// passar tudo na linha de comando porque caminhos com espaço e aspas quebram
// facilmente no schtasks.
function criarExecutor(nome, comando) {
  mkdirSync(PASTA_DADOS, { recursive: true });
  const log = join(PASTA_DADOS, `${nome}.log`);
  const [script, ...resto] = comando.split(' ');
  const caminhoScript = join(RAIZ, 'scripts', script);
  const argumentos = resto.join(' ');

  if (EH_WINDOWS) {
    const arquivo = join(PASTA_DADOS, `${nome}.cmd`);
    const conteudo = [
      '@echo off',
      `cd /d "${RAIZ}"`,
      `echo ===== inicio %date% %time% ===== >> "${log}"`,
      `"${process.execPath}" --no-warnings "${caminhoScript}" ${argumentos} >> "${log}" 2>&1`,
      `echo ===== fim %date% %time% ===== >> "${log}"`,
      '',
    ].join('\r\n');
    writeFileSync(arquivo, conteudo, 'utf8');
    return { arquivo, log };
  }
  const arquivo = join(PASTA_DADOS, `${nome}.sh`);
  const conteudo = [
    '#!/bin/sh',
    `cd "${RAIZ}" || exit 1`,
    `echo "===== inicio $(date) =====" >> "${log}"`,
    `"${process.execPath}" --no-warnings "${caminhoScript}" ${argumentos} >> "${log}" 2>&1`,
    `echo "===== fim $(date) =====" >> "${log}"`,
    '',
  ].join('\n');
  writeFileSync(arquivo, conteudo, { encoding: 'utf8', mode: 0o755 });
  return { arquivo, log };
}

function criar(args) {
  if (!args.nome || !args.hora || !args.comando) {
    console.error('Uso: agendar.mjs criar --nome <id> --hora HH:MM --comando "<script.mjs args>" [--diario]');
    process.exit(1);
  }
  if (!/^\d{1,2}:\d{2}$/.test(args.hora)) {
    console.error('Hora inválida. Use o formato HH:MM (ex.: 23:10).');
    process.exit(1);
  }
  const [hora, minuto] = args.hora.split(':').map(Number);
  const tarefa = `${PREFIXO}-${args.nome}`;
  const { arquivo, log } = criarExecutor(args.nome, args.comando);

  try {
    if (EH_WINDOWS) {
      const frequencia = args.diario ? ['/sc', 'DAILY'] : ['/sc', 'ONCE'];
      execFileSync(comandoDoSistema('schtasks'), [
        '/create', '/tn', tarefa, '/tr', `"${arquivo}"`,
        ...frequencia, '/st', `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`,
        '/f',
      ], { stdio: 'pipe', encoding: 'utf8' });
    } else {
      // crontab: remove uma entrada anterior com o mesmo nome e acrescenta a nova
      let atual = '';
      try { atual = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: 'pipe' }); } catch { atual = ''; }
      const limpo = atual.split('\n').filter((l) => !l.includes(tarefa)).join('\n').trim();
      const linha = `${minuto} ${hora} * * * "${arquivo}" # ${tarefa}`;
      const novo = `${limpo ? `${limpo}\n` : ''}${linha}\n`;
      execFileSync('crontab', ['-'], { input: novo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } catch (erro) {
    console.error(`Não consegui criar o agendamento: ${erro.stderr || erro.message}`);
    process.exit(1);
  }

  const quando = args.diario ? `todos os dias às ${args.hora}` : `hoje às ${args.hora}`;
  console.log(`Agendamento criado: "${tarefa}" — ${quando}.`);
  console.log(`O que vai rodar: ${args.comando}`);
  console.log(`Registro da execução: ${log}`);
  console.log('IMPORTANTE: o computador precisa estar LIGADO e sem suspensão no horário.');
}

function listar() {
  try {
    if (EH_WINDOWS) {
      const saida = execFileSync(comandoDoSistema('schtasks'), ['/query', '/fo', 'LIST'], { encoding: 'utf8', stdio: 'pipe' });
      const blocos = saida.split(/\r?\n\r?\n/).filter((b) => b.includes(PREFIXO));
      if (blocos.length === 0) { console.log('(nenhuma tarefa do assistente agendada)'); return; }
      for (const b of blocos) {
        // O schtasks responde na codificacao antiga do Windows e em portugues
        // os rotulos vem com acentos corrompidos ("Pr¢xima execu‡Æo") — os
        // padroes abaixo casam sem depender de acento nem de maiusculas.
        const nome = b.match(/(?:TaskName|Nome da tarefa):\s*(.+)/i)?.[1]?.trim();
        const proxima = b.match(/(?:Next Run Time|Pr.xima[^:\r\n]*):\s*(.+)/i)?.[1]?.trim();
        console.log(`${nome ?? '?'} | próxima execução: ${proxima ?? '?'}`);
      }
    } else {
      let atual = '';
      try { atual = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: 'pipe' }); } catch { atual = ''; }
      const linhas = atual.split('\n').filter((l) => l.includes(PREFIXO));
      if (linhas.length === 0) { console.log('(nenhuma tarefa do assistente agendada)'); return; }
      for (const l of linhas) console.log(l.trim());
    }
  } catch (erro) {
    console.error(`Não consegui listar: ${erro.stderr || erro.message}`);
    process.exit(1);
  }
}

function cancelar(args) {
  if (!args.nome) {
    console.error('Uso: agendar.mjs cancelar --nome <id>');
    process.exit(1);
  }
  const tarefa = `${PREFIXO}-${args.nome}`;
  try {
    if (EH_WINDOWS) {
      execFileSync(comandoDoSistema('schtasks'), ['/delete', '/tn', tarefa, '/f'], { stdio: 'pipe', encoding: 'utf8' });
    } else {
      let atual = '';
      try { atual = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: 'pipe' }); } catch { atual = ''; }
      const novo = atual.split('\n').filter((l) => !l.includes(tarefa)).join('\n').trim();
      execFileSync('crontab', ['-'], { input: `${novo}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
    for (const ext of ['.cmd', '.sh']) {
      const f = join(PASTA_DADOS, `${args.nome}${ext}`);
      if (existsSync(f)) unlinkSync(f);
    }
    console.log(`Agendamento "${tarefa}" cancelado.`);
  } catch (erro) {
    console.error(`Não consegui cancelar: ${erro.stderr || erro.message}`);
    process.exit(1);
  }
}

const acao = process.argv[2];
const args = lerArgs();
if (acao === 'criar') criar(args);
else if (acao === 'listar') listar();
else if (acao === 'cancelar') cancelar(args);
else {
  console.error('Ação inválida. Use: criar | listar | cancelar');
  process.exitCode = 1;
}
