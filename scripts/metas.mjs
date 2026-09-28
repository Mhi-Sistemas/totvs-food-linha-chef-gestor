// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Metas do gestor: %CMV, %CMO, faturamento do mes, ticket medio... definidas
// POR ELE em conversa e gravadas aqui. Toda analise que toque um indicador
// com meta definida compara com ela ("CMV 32,4% — 2,4pp acima da meta de
// 30%"), e o briefing alerta estouros.
//
// Convencao de unidade: indicador terminado em `_pct` e percentual; os
// demais sao em reais (ou unidades, ex.: ticket_medio em R$). O sentido
// (mais e melhor ou pior) vem do indicador: custos/percentuais de custo tem
// meta de TETO; receitas/ticket tem meta de PISO.
//
// Metas sao ABERTAS: qualquer indicador, com escopo geral, por grupo, por
// LOJA e por PRODUTO. Exemplos que o gestor pede:
//   cmv_pct=30 - cmo_pct=28 - faturamento_mes=250000 - ticket_medio=35
//   receita_mes=8000 --produto 123      (meta de venda de um produto)
//   unidades_dia=40 --produto 123 --loja 2
//   faturamento_mes=90000 --loja 1
//
// Uso:
//   node --no-warnings scripts/metas.mjs definir "indicador=valor" [...]
//        [--grupo <id>] [--loja <n>] [--produto <codigo>]
//   node --no-warnings scripts/metas.mjs listar
//   node --no-warnings scripts/metas.mjs remover <indicador> [--grupo] [--loja] [--produto]

import { abrirBanco, criarSchema } from './criar-banco.mjs';

const TETO = /(^|_)(cmv|cmo|prime|custo|despesa|desconto|quebra|cancelamento|perda)/i;

function garantirTabela(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS metas (
    indicador TEXT NOT NULL,
    conexao TEXT NOT NULL DEFAULT '*',
    loja TEXT NOT NULL DEFAULT '*',
    produto TEXT NOT NULL DEFAULT '*',
    valor REAL NOT NULL,
    definida_em TEXT NOT NULL DEFAULT (date('now','localtime')),
    PRIMARY KEY (indicador, conexao, loja, produto)
  )`);
  // Migra a versao inicial (sem loja/produto), preservando as metas.
  const colunas = db.prepare('PRAGMA table_info(metas)').all().map((c) => c.name);
  if (!colunas.includes('loja')) {
    db.exec(`BEGIN;
      ALTER TABLE metas RENAME TO metas_v1;
      CREATE TABLE metas (
        indicador TEXT NOT NULL, conexao TEXT NOT NULL DEFAULT '*',
        loja TEXT NOT NULL DEFAULT '*', produto TEXT NOT NULL DEFAULT '*',
        valor REAL NOT NULL, definida_em TEXT NOT NULL DEFAULT (date('now','localtime')),
        PRIMARY KEY (indicador, conexao, loja, produto));
      INSERT INTO metas (indicador, conexao, valor, definida_em)
        SELECT indicador, conexao, valor, definida_em FROM metas_v1;
      DROP TABLE metas_v1;
    COMMIT;`);
  }
}

const unidade = (indicador) => (/_pct$/i.test(indicador) ? '%' : 'R$');
const sentido = (indicador) => (TETO.test(indicador) ? 'teto (menor é melhor)' : 'piso (maior é melhor)');
const formatar = (indicador, valor) => unidade(indicador) === '%'
  ? `${valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
  : valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function lerFlag(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? String(process.argv[i + 1]) : '*';
}

const FLAGS = ['--grupo', '--loja', '--produto'];
const acao = process.argv[2];
const argumentos = process.argv.slice(3)
  .filter((a, i, arr) => !a.startsWith('--') && !FLAGS.includes(arr[i - 1]));
const grupo = lerFlag('grupo');
const loja = lerFlag('loja');
const produto = lerFlag('produto');

function descreverEscopo(l) {
  const partes = [];
  if (l.conexao !== '*') partes.push(`grupo ${l.conexao}`);
  if (l.loja !== '*') partes.push(`loja ${l.loja}`);
  if (l.produto !== '*') partes.push(`produto ${l.produto}${l.nome_produto ? ` (${l.nome_produto})` : ''}`);
  return partes.length ? ` [${partes.join(', ')}]` : '';
}

const db = abrirBanco();
try {
  criarSchema(db);
  garantirTabela(db);
  if (acao === 'definir' && argumentos.length > 0) {
    const ins = db.prepare('INSERT OR REPLACE INTO metas (indicador, conexao, loja, produto, valor) VALUES (?,?,?,?,?)');
    for (const par of argumentos) {
      const posicao = par.indexOf('=');
      const indicador = par.slice(0, posicao).trim().toLowerCase();
      const valor = Number(String(par.slice(posicao + 1)).replace(',', '.'));
      if (!indicador || !Number.isFinite(valor)) { console.error(`Formato inválido: "${par}" (use "indicador=valor")`); continue; }
      ins.run(indicador, grupo, loja, produto, valor);
      console.log(`Meta gravada: ${indicador} = ${formatar(indicador, valor)} — ${sentido(indicador)}${descreverEscopo({ conexao: grupo, loja, produto })}`);
    }
  } else if (acao === 'remover' && argumentos.length > 0) {
    const del = db.prepare('DELETE FROM metas WHERE indicador = ? AND conexao = ? AND loja = ? AND produto = ?');
    let n = 0;
    for (const indicador of argumentos) n += del.run(indicador.toLowerCase(), grupo, loja, produto).changes;
    console.log(`${n} meta(s) removida(s).`);
  } else if (acao === 'listar') {
    const linhas = db.prepare(`SELECT m.*, p.nome AS nome_produto FROM metas m
      LEFT JOIN produtos p ON m.produto != '*' AND CAST(p.codigo AS TEXT) = m.produto
        AND (m.conexao = '*' OR p.conexao = m.conexao)
      ORDER BY m.conexao, m.loja, m.produto, m.indicador`).all();
    if (linhas.length === 0) console.log('(nenhuma meta definida ainda — pergunte ao gestor quais são os objetivos dele)');
    for (const l of linhas) {
      console.log(`  ${l.indicador} = ${formatar(l.indicador, l.valor)} — ${sentido(l.indicador)}${descreverEscopo(l)} [desde ${l.definida_em}]`);
    }
  } else {
    console.error('Uso: definir "indicador=valor" ... [--grupo] [--loja] [--produto] | listar | remover <indicador> [--grupo] [--loja] [--produto]');
    process.exitCode = 1;
  }
} finally {
  db.close();
}
