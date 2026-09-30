// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Categoriza os PLANOS DE CONTAS do gestor para indicadores — o primeiro uso
// e o CMO (Custo de Mao de Obra): quais planos sao gastos com PESSOAL.
//
// Regra definida pelo usuario do projeto: o agente analisa todos os planos e
// SUGERE, mas quem confirma e o GESTOR — mesmo padrao do agrupamento de
// formas de pagamento. Nada e assumido sem confirmacao.
//
// Uso:
//   node --no-warnings scripts/categorias-planos.mjs sugerir [--categoria pessoal]
//   node --no-warnings scripts/categorias-planos.mjs definir "PLANO1|PLANO2=pessoal" [...]
//   node --no-warnings scripts/categorias-planos.mjs remover "PLANO1|PLANO2"
//   node --no-warnings scripts/categorias-planos.mjs listar
//
// (PLANO2 pode ser * para marcar o plano 1 inteiro.)

import { abrirBanco, criarSchema } from './criar-banco.mjs';

const PADROES = {
  pessoal: /pessoal|sal[aá]rio|folha|encargo|fgts|inss|pr[oó][- ]?labore|vale[- ]?(transporte|refei|alimenta)|comiss|\b13\b|d[eé]cimo|f[eé]rias|rescis|benef[ií]cio|uniforme|treinament|admiss/i,
  // Compra de MERCADORIA para revenda/producao — a terceira forma de chegar ao
  // CMV, ao lado do teorico (ficha tecnica) e do real (estoque + compras).
  // Quem escolhe qual vai para a DRE e o GESTOR (dre.mjs cmv-fonte).
  // Deliberadamente amplo: e sugestao, e o gestor confirma item a item.
  mercadoria: /mercadoria|insumo|mat[eé]ria[- ]?prima|hortifr[uú]t|a[cç]ougue|carne|frios|latic[ií]nio|bebida|cervej|refrigerante|padaria|embalagem|descart[aá]vel|fornecedor|compra/i,
};

function garantirTabela(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS plano_categorias (
    plano1 TEXT NOT NULL,
    plano2 TEXT NOT NULL DEFAULT '*',
    categoria TEXT NOT NULL,
    PRIMARY KEY (plano1, plano2)
  )`);
}

// Todos os pares plano1/plano2 que existem nos lancamentos (contas a pagar e
// livro caixa), com o total movimentado — para o gestor decidir vendo o peso.
function planosExistentes(db) {
  return db.prepare(`
    SELECT plano1, plano2, SUM(total) AS total FROM (
      SELECT COALESCE(plano_contas1,'') AS plano1, COALESCE(plano_contas2,'') AS plano2, SUM(valor) AS total
        FROM contas_pagar GROUP BY 1,2
      UNION ALL
      SELECT COALESCE(plano_contas1,''), COALESCE(plano_contas2,''), SUM(valor)
        FROM livro_caixa WHERE tipo = 'saida' GROUP BY 1,2
    ) WHERE plano1 != '' GROUP BY 1,2 ORDER BY total DESC`).all();
}

function marcados(db) {
  return db.prepare('SELECT plano1, plano2, categoria FROM plano_categorias ORDER BY categoria, plano1, plano2').all();
}

const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function sugerir(db, categoria) {
  const padrao = PADROES[categoria];
  if (!padrao) {
    console.error(`Categoria "${categoria}" sem padrão de sugestão. Disponíveis: ${Object.keys(PADROES).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const existentes = planosExistentes(db);
  const jaMarcados = new Set(marcados(db).map((m) => `${m.plano1}|${m.plano2}`));
  console.log(`SUGESTÃO para a categoria "${categoria}" — confirme com o gestor antes de definir:\n`);
  let algum = false;
  for (const p of existentes) {
    const chave = `${p.plano1}|${p.plano2}`;
    const bate = padrao.test(p.plano1) || padrao.test(p.plano2);
    if (bate) {
      algum = true;
      console.log(`  ${jaMarcados.has(chave) ? '[já marcado] ' : ''}${chave}  (${brl(p.total)})`);
    }
  }
  if (!algum) console.log('  (nenhum plano parece ser desta categoria)');
  console.log('\nDemais planos existentes (para o gestor conferir se falta algum):');
  for (const p of existentes) {
    if (!(padrao.test(p.plano1) || padrao.test(p.plano2))) console.log(`  ${p.plano1}|${p.plano2}  (${brl(p.total)})`);
  }
  console.log(`\nPara gravar: categorias-planos.mjs definir "PLANO1|PLANO2=${categoria}" ...`);
}

function definir(db, pares) {
  const ins = db.prepare('INSERT OR REPLACE INTO plano_categorias (plano1, plano2, categoria) VALUES (?,?,?)');
  let n = 0;
  for (const par of pares) {
    const posicao = par.lastIndexOf('=');
    if (posicao < 1) { console.error(`Formato inválido: "${par}" (use "PLANO1|PLANO2=categoria")`); continue; }
    const categoria = par.slice(posicao + 1).trim().toLowerCase();
    const [plano1, plano2] = par.slice(0, posicao).split('|').map((x) => (x ?? '').trim());
    if (!plano1 || !categoria) { console.error(`Formato inválido: "${par}"`); continue; }
    ins.run(plano1, plano2 || '*', categoria);
    n += 1;
  }
  console.log(`${n} plano(s) marcados. Confira com: categorias-planos.mjs listar`);
}

function remover(db, chaves) {
  const del = db.prepare('DELETE FROM plano_categorias WHERE plano1 = ? AND plano2 = ?');
  let n = 0;
  for (const chave of chaves) {
    const [plano1, plano2] = chave.split('|').map((x) => (x ?? '').trim());
    n += del.run(plano1, plano2 || '*').changes;
  }
  console.log(`${n} marcação(ões) removida(s).`);
}

function listar(db) {
  const linhas = marcados(db);
  if (linhas.length === 0) { console.log('(nenhum plano categorizado ainda — rode "sugerir" e confirme com o gestor)'); return; }
  for (const l of linhas) console.log(`  [${l.categoria}] ${l.plano1}|${l.plano2}`);
}

const acao = process.argv[2];
const argumentos = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith('--')).map((a, i, arr) => {
  const nome = a.slice(2);
  return [nome, 'valor'];
}));
const categoriaFlag = (() => {
  const i = process.argv.indexOf('--categoria');
  return i >= 0 ? process.argv[i + 1] : 'pessoal';
})();

const db = abrirBanco();
try {
  criarSchema(db);
  garantirTabela(db);
  if (acao === 'sugerir') sugerir(db, categoriaFlag);
  else if (acao === 'definir' && argumentos.length > 0) definir(db, argumentos);
  else if (acao === 'remover' && argumentos.length > 0) remover(db, argumentos);
  else if (acao === 'listar') listar(db);
  else {
    console.error('Uso: sugerir [--categoria pessoal] | definir "P1|P2=categoria" ... | remover "P1|P2" ... | listar');
    process.exitCode = 1;
  }
} finally {
  db.close();
}
