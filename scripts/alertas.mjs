// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Alertas ao gestor: avisos gerados pelas execucoes automaticas (coleta
// historica, rotina diaria) para o assistente dar ao gestor NA PRIMEIRA
// CONVERSA DO DIA — em linguagem simples e com a orientacao pratica (ex.:
// abrir chamado no suporte da TOTVS). Ficam em data/alertas.json ate o
// assistente marcar como avisados.
//
// Uso:
//   node --no-warnings scripts/alertas.mjs listar [--json]
//   node --no-warnings scripts/alertas.mjs avisado <id|--todos>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = join(RAIZ, 'data', 'alertas.json');

function carregar() {
  try { return JSON.parse(readFileSync(ARQUIVO, 'utf8')); } catch { return []; }
}

function salvar(lista) {
  mkdirSync(join(RAIZ, 'data'), { recursive: true });
  writeFileSync(ARQUIVO, `${JSON.stringify(lista, null, 2)}\n`);
}

// Identidade de um alerta. O titulo e TEXTO PARA O GESTOR: muda quando se
// corrige um acento ou se melhora a frase — e alerta "unico" identificado
// pelo titulo renderizado nasce de novo a cada ajuste de redacao (aconteceu
// em 27/09/2026: os marcos de 50% e 75% duplicaram por causa de um acento).
// Por isso a identidade e a `chave` estavel de quem chama; na falta dela,
// o titulo normalizado (sem acento, sem caixa, sem pontuacao).
const identidade = (chave, titulo) => (chave ? `k:${chave}` : `t:${String(titulo)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`);

// Registra um alerta (ou atualiza o pendente de mesma identidade, para o
// gestor nao receber o mesmo aviso em duplicata a cada execucao). Com
// `unico`, o alerta so nasce UMA vez na vida (mesmo depois de avisado) — e o
// caso dos marcos de progresso ("vendas 75% carregadas").
export function registrarAlerta({ titulo, detalhe, orientacao, unico = false, chave = null }) {
  const lista = carregar();
  const id = identidade(chave, titulo);
  const mesmo = (a) => (a.chave ?? identidade(null, a.titulo)) === id;
  if (unico && lista.some(mesmo)) return;
  const agora = new Date().toISOString();
  const existente = lista.find((a) => !a.avisado && mesmo(a));
  if (existente) {
    existente.titulo = titulo;
    existente.detalhe = detalhe;
    if (orientacao) existente.orientacao = orientacao;
    existente.quando = agora;
  } else {
    lista.push({
      id: Math.random().toString(36).slice(2, 10),
      chave: id,
      quando: agora,
      titulo,
      detalhe,
      orientacao: orientacao ?? null,
      avisado: false,
    });
  }
  salvar(lista);
}

export function alertasPendentes() {
  return carregar().filter((a) => !a.avisado);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  if (acao === 'listar') {
    const pendentes = alertasPendentes();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(pendentes, null, 2));
    } else if (pendentes.length === 0) {
      console.log('Nenhum alerta pendente.');
    } else {
      for (const a of pendentes) {
        console.log(`[${a.id}] ${a.quando.slice(0, 10)} — ${a.titulo}`);
        console.log(`    ${a.detalhe}`);
        if (a.orientacao) console.log(`    Orientação: ${a.orientacao}`);
      }
    }
  } else if (acao === 'avisado') {
    const id = process.argv[3];
    if (!id) {
      console.error('Uso: alertas.mjs avisado <id|--todos>');
      process.exit(1);
    }
    const lista = carregar();
    let n = 0;
    for (const a of lista) {
      if (!a.avisado && (id === '--todos' || a.id === id)) { a.avisado = true; n += 1; }
    }
    // Avisados com mais de 30 dias saem do arquivo (historico curto basta).
    const limite = Date.now() - 30 * 24 * 3600 * 1000;
    salvar(lista.filter((a) => !a.avisado || Date.parse(a.quando) >= limite));
    console.log(`${n} alerta(s) marcado(s) como avisado(s).`);
  } else {
    console.error('Acao invalida. Use: listar [--json] | avisado <id|--todos>');
    process.exit(1);
  }
}
