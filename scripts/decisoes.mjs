// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Diário de decisões — o que transforma recomendação em aprendizado.
//
// Recomendação sem acompanhamento é opinião solta. Aqui o assistente registra
// o que sugeriu, o gestor marca o que de fato fez, e depois o próprio
// assistente VOLTA E MEDE o efeito, comparando janelas equivalentes antes e
// depois da mudança. É isso que cria memória e confiança ao longo do tempo.
//
// Uso:
//   node --no-warnings scripts/decisoes.mjs registrar --texto "..." [--grupo X]
//        [--produto N] [--categoria preco|cardapio|operacao|compras|financeiro]
//   node --no-warnings scripts/decisoes.mjs executar --id N [--data AAAA-MM-DD]
//   node --no-warnings scripts/decisoes.mjs descartar --id N [--motivo "..."]
//   node --no-warnings scripts/decisoes.mjs listar [--status pendente|feita|descartada]
//   node --no-warnings scripts/decisoes.mjs verificar [--id N] [--dias 30]

import { abrirBanco, criarSchema } from './criar-banco.mjs';

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

const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const hoje = () => new Date().toISOString().slice(0, 10);
const somarDias = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000)
  .toISOString().slice(0, 10);

function registrar(db, args) {
  if (!args.texto) {
    console.error('Uso: decisoes.mjs registrar --texto "o que foi recomendado" [--grupo X] [--produto N]');
    process.exit(1);
  }
  const r = db.prepare(
    `INSERT INTO decisoes (conexao, categoria, recomendacao, codigo_produto, prazo, status)
     VALUES (?,?,?,?,?, 'pendente')`
  ).run(args.grupo ?? null, args.categoria ?? null, args.texto,
    args.produto ? Number(args.produto) : null, args.prazo ?? null);
  console.log(`Decisão #${r.lastInsertRowid} registrada como pendente.`);
}

function executar(db, args) {
  if (!args.id) { console.error('Uso: decisoes.mjs executar --id N [--data AAAA-MM-DD]'); process.exit(1); }
  const data = args.data ?? hoje();
  const n = db.prepare(
    "UPDATE decisoes SET status = 'feita', data_execucao = ? WHERE id = ?"
  ).run(data, Number(args.id)).changes;
  console.log(n ? `Decisão #${args.id} marcada como feita em ${dmy(data)}.` : 'Decisão não encontrada.');
}

function descartar(db, args) {
  if (!args.id) { console.error('Uso: decisoes.mjs descartar --id N [--motivo "..."]'); process.exit(1); }
  const n = db.prepare(
    "UPDATE decisoes SET status = 'descartada', observacao = ? WHERE id = ?"
  ).run(args.motivo ?? null, Number(args.id)).changes;
  console.log(n ? `Decisão #${args.id} descartada.` : 'Decisão não encontrada.');
}

function listar(db, args) {
  const linhas = db.prepare(
    `SELECT * FROM decisoes ${args.status ? 'WHERE status = ?' : ''} ORDER BY id DESC`
  ).all(...(args.status ? [args.status] : []));
  if (linhas.length === 0) { console.log('(nenhuma decisão registrada)'); return; }
  for (const d of linhas) {
    console.log(`#${d.id} [${d.status}] ${d.categoria ? `(${d.categoria}) ` : ''}${d.recomendacao}`);
    const detalhes = [
      d.conexao ? `grupo ${d.conexao}` : null,
      d.codigo_produto ? `produto ${d.codigo_produto}` : null,
      d.data_execucao ? `feita em ${dmy(d.data_execucao)}` : null,
      d.resultado ? `resultado: ${d.resultado}` : null,
    ].filter(Boolean);
    if (detalhes.length) console.log(`    ${detalhes.join(' | ')}`);
  }
}

// Mede o efeito: compara a janela de N dias ANTES com a de N dias DEPOIS da
// execução. Só mede quando já houver dias suficientes depois da mudança.
function verificar(db, args) {
  const dias = Number(args.dias ?? 30);
  const linhas = db.prepare(
    `SELECT * FROM decisoes WHERE status = 'feita' AND data_execucao IS NOT NULL
     ${args.id ? 'AND id = ?' : ''} ORDER BY id`
  ).all(...(args.id ? [Number(args.id)] : []));
  if (linhas.length === 0) { console.log('(nenhuma decisão executada para verificar)'); return; }

  const resultados = [];
  for (const d of linhas) {
    const antesDe = somarDias(d.data_execucao, -dias);
    const antesAte = somarDias(d.data_execucao, -1);
    const depoisDe = d.data_execucao;
    const depoisAte = somarDias(d.data_execucao, dias - 1);
    const ultimoDia = db.prepare('SELECT MAX(data_movimento) AS d FROM vendas WHERE cancelada = 0').get()?.d;
    if (!ultimoDia || ultimoDia < depoisAte) {
      resultados.push({ id: d.id, recomendacao: d.recomendacao, status: 'aguardando',
        falta_ate: depoisAte, motivo: `ainda não há ${dias} dias completos depois da mudança` });
      continue;
    }

    const fG = d.conexao ? ' AND v.conexao = ?' : '';
    const pG = d.conexao ? [d.conexao] : [];
    const medir = (de, ate) => {
      if (d.codigo_produto) {
        return db.prepare(
          `SELECT COALESCE(SUM(i.quantidade), 0) AS quantidade,
                  COALESCE(SUM(i.valor_total), 0) AS receita,
                  COALESCE(SUM(i.valor_total) - SUM(i.quantidade * i.preco_compra), 0) AS margem,
                  ROUND(SUM(i.valor_total) / NULLIF(SUM(i.quantidade), 0), 2) AS preco_medio
           FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
           WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto = ?${fG}
             AND v.data_movimento BETWEEN ? AND ?`
        ).get(d.codigo_produto, ...pG, de, ate);
      }
      return db.prepare(
        `SELECT COUNT(*) AS cupons, COALESCE(SUM(v.valor_total), 0) AS receita,
                ROUND(SUM(v.valor_total) / NULLIF(COUNT(*), 0), 2) AS ticket
         FROM vendas v WHERE v.cancelada = 0${fG} AND v.data_movimento BETWEEN ? AND ?`
      ).get(...pG, de, ate);
    };

    const antes = medir(antesDe, antesAte);
    const depois = medir(depoisDe, depoisAte);
    const variacao = (a, b) => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null);
    const efeito = {
      receita_pct: variacao(antes.receita, depois.receita),
      quantidade_pct: d.codigo_produto ? variacao(antes.quantidade, depois.quantidade) : null,
      margem_pct: d.codigo_produto ? variacao(antes.margem, depois.margem) : null,
      ticket_pct: d.codigo_produto ? null : variacao(antes.ticket, depois.ticket),
    };
    resultados.push({ id: d.id, recomendacao: d.recomendacao, status: 'medida',
      janela: { antes: [antesDe, antesAte], depois: [depoisDe, depoisAte], dias },
      antes, depois, efeito });

    db.prepare('UPDATE decisoes SET verificado_em = ?, resultado = ? WHERE id = ?')
      .run(hoje(), JSON.stringify(efeito), d.id);
  }

  if (args.json) { console.log(JSON.stringify(resultados, null, 2)); return; }
  console.log(`VERIFICAÇÃO DE DECISÕES (janelas de ${dias} dias)`);
  for (const r of resultados) {
    console.log(`#${r.id} ${r.recomendacao}`);
    if (r.status === 'aguardando') {
      console.log(`    ${r.motivo} (medir a partir de ${dmy(r.falta_ate)}).`);
      continue;
    }
    console.log(`    antes: ${dmy(r.janela.antes[0])} a ${dmy(r.janela.antes[1])} | `
      + `depois: ${dmy(r.janela.depois[0])} a ${dmy(r.janela.depois[1])}`);
    console.log(`    receita ${brl(r.antes.receita)} -> ${brl(r.depois.receita)}`
      + (r.efeito.receita_pct === null ? '' : ` (${r.efeito.receita_pct >= 0 ? '+' : ''}${r.efeito.receita_pct}%)`));
    if (r.efeito.quantidade_pct !== null) {
      console.log(`    quantidade ${r.antes.quantidade} -> ${r.depois.quantidade} `
        + `(${r.efeito.quantidade_pct >= 0 ? '+' : ''}${r.efeito.quantidade_pct}%)`);
    }
    if (r.efeito.margem_pct !== null) {
      console.log(`    margem ${brl(r.antes.margem)} -> ${brl(r.depois.margem)} `
        + `(${r.efeito.margem_pct >= 0 ? '+' : ''}${r.efeito.margem_pct}%)`);
    }
    if (r.efeito.ticket_pct !== null) {
      console.log(`    ticket ${brl(r.antes.ticket)} -> ${brl(r.depois.ticket)} `
        + `(${r.efeito.ticket_pct >= 0 ? '+' : ''}${r.efeito.ticket_pct}%)`);
    }
  }
}

const acao = process.argv[2];
const args = lerArgs();
const db = abrirBanco();
criarSchema(db);
try {
  if (acao === 'registrar') registrar(db, args);
  else if (acao === 'executar') executar(db, args);
  else if (acao === 'descartar') descartar(db, args);
  else if (acao === 'listar') listar(db, args);
  else if (acao === 'verificar') verificar(db, args);
  else {
    console.error('Ação inválida. Use: registrar | executar | descartar | listar | verificar');
    process.exitCode = 1;
  }
} finally {
  db.close();
}
