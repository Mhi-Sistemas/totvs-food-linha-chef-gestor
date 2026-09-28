// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Calendário de contexto: feriados e datas que explicam variação de movimento.
//
// Sem isso o assistente "descobre" quedas que eram só segunda-feira de
// carnaval, e perde altas que eram Dia das Mães. Toda comparação e toda
// anomalia passam por aqui.
//
// Feriados nacionais são calculados (inclusive os móveis, a partir da Páscoa),
// então funcionam para qualquer ano, sem internet. Datas comemorativas de
// food service entram porque mudam o movimento mesmo sem ser feriado.
// Eventos locais (reforma, greve, show na cidade) o gestor cadastra.
//
// Uso:
//   node --no-warnings scripts/calendario.mjs ano 2026
//   node --no-warnings scripts/calendario.mjs consultar 2026-05-10
//   node --no-warnings scripts/calendario.mjs registrar --data 2026-03-04 \
//        --evento "Reforma da cozinha" [--ate 2026-03-08] [--grupo X] [--loja 3] [--impacto negativo]
//   node --no-warnings scripts/calendario.mjs listar [--grupo X]

import { abrirBanco, criarSchema } from './criar-banco.mjs';

// Domingo de Páscoa pelo algoritmo de Meeus/Jones/Butcher.
function domingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const iso = (d) => d.toISOString().slice(0, 10);
const somarDias = (d, n) => new Date(d.getTime() + n * 86400000);

// Segundo domingo de maio, etc.
function nEsimoDiaDaSemana(ano, mes, diaSemana, ocorrencia) {
  const primeiro = new Date(Date.UTC(ano, mes - 1, 1));
  const ajuste = (diaSemana - primeiro.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(ano, mes - 1, 1 + ajuste + (ocorrencia - 1) * 7));
}

export function feriadosDoAno(ano) {
  const pascoa = domingoDePascoa(ano);
  const fixos = [
    [`${ano}-01-01`, 'Confraternização Universal', 'feriado'],
    [`${ano}-04-21`, 'Tiradentes', 'feriado'],
    [`${ano}-05-01`, 'Dia do Trabalho', 'feriado'],
    [`${ano}-09-07`, 'Independência', 'feriado'],
    [`${ano}-10-12`, 'Nossa Senhora Aparecida', 'feriado'],
    [`${ano}-11-02`, 'Finados', 'feriado'],
    [`${ano}-11-15`, 'Proclamação da República', 'feriado'],
    [`${ano}-11-20`, 'Consciência Negra', 'feriado'],
    [`${ano}-12-25`, 'Natal', 'feriado'],
    [`${ano}-12-24`, 'Véspera de Natal', 'data-forte'],
    [`${ano}-12-31`, 'Véspera de Ano-Novo', 'data-forte'],
    [`${ano}-06-12`, 'Dia dos Namorados', 'data-forte'],
  ];
  const moveis = [
    [iso(somarDias(pascoa, -48)), 'Carnaval (segunda)', 'feriado'],
    [iso(somarDias(pascoa, -47)), 'Carnaval (terça)', 'feriado'],
    [iso(somarDias(pascoa, -46)), 'Quarta-feira de Cinzas', 'meio-feriado'],
    [iso(somarDias(pascoa, -2)), 'Sexta-feira Santa', 'feriado'],
    [iso(pascoa), 'Páscoa', 'data-forte'],
    [iso(somarDias(pascoa, 60)), 'Corpus Christi', 'feriado'],
  ];
  const comemorativas = [
    [iso(nEsimoDiaDaSemana(ano, 5, 0, 2)), 'Dia das Mães', 'data-forte'],
    [iso(nEsimoDiaDaSemana(ano, 8, 0, 2)), 'Dia dos Pais', 'data-forte'],
  ];
  return [...fixos, ...moveis, ...comemorativas]
    .map(([data, nome, tipo]) => ({ data, nome, tipo }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

// Nome do feriado/data forte, ou null. Usado pelo motor de anomalias.
export function ehFeriado(dataIso) {
  if (!dataIso) return null;
  const ano = Number(dataIso.slice(0, 4));
  const achado = feriadosDoAno(ano).find((f) => f.data === dataIso);
  return achado ? achado.nome : null;
}

// Eventos cadastrados pelo gestor (reforma, greve, evento na cidade).
export function eventosDoPeriodo(db, de, ate, grupo) {
  try {
    return db.prepare(
      `SELECT data_inicio, data_fim, evento, impacto, codigo_loja FROM eventos
       WHERE data_inicio <= ? AND COALESCE(data_fim, data_inicio) >= ?
       ${grupo ? 'AND (conexao = ? OR conexao IS NULL)' : ''}
       ORDER BY data_inicio`
    ).all(ate, de, ...(grupo ? [grupo] : []));
  } catch {
    return [];
  }
}

// ---------- CLI ----------

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

const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

if (process.argv[1] && process.argv[1].endsWith('calendario.mjs')) {
  const acao = process.argv[2];
  const args = lerArgs();

  if (acao === 'ano') {
    const ano = Number(process.argv[3] ?? new Date().getFullYear());
    for (const f of feriadosDoAno(ano)) {
      console.log(`${dmy(f.data)} | ${f.nome} (${f.tipo})`);
    }
  } else if (acao === 'consultar') {
    const data = process.argv[3];
    const nome = ehFeriado(data);
    const db = abrirBanco();
    criarSchema(db);
    const eventos = eventosDoPeriodo(db, data, data, args.grupo);
    db.close();
    if (!nome && eventos.length === 0) console.log(`${dmy(data)}: dia comum.`);
    if (nome) console.log(`${dmy(data)}: ${nome}`);
    for (const e of eventos) console.log(`${dmy(data)}: ${e.evento} (${e.impacto ?? 'impacto não informado'})`);
  } else if (acao === 'registrar') {
    if (!args.data || !args.evento) {
      console.error('Uso: calendario.mjs registrar --data AAAA-MM-DD --evento "texto" '
        + '[--ate AAAA-MM-DD] [--grupo X] [--loja N] [--impacto positivo|negativo]');
      process.exit(1);
    }
    const db = abrirBanco();
    criarSchema(db);
    db.prepare(
      `INSERT INTO eventos (conexao, codigo_loja, data_inicio, data_fim, evento, impacto)
       VALUES (?,?,?,?,?,?)`
    ).run(args.grupo ?? null, args.loja ? Number(args.loja) : null,
      args.data, args.ate ?? args.data, args.evento, args.impacto ?? null);
    db.close();
    console.log(`Evento registrado: ${args.evento} (${dmy(args.data)}`
      + `${args.ate ? ` a ${dmy(args.ate)}` : ''}).`);
  } else if (acao === 'listar') {
    const db = abrirBanco();
    criarSchema(db);
    const linhas = db.prepare(
      `SELECT data_inicio, data_fim, evento, impacto, conexao, codigo_loja FROM eventos
       ${args.grupo ? 'WHERE conexao = ?' : ''} ORDER BY data_inicio DESC`
    ).all(...(args.grupo ? [args.grupo] : []));
    db.close();
    if (linhas.length === 0) console.log('(nenhum evento cadastrado)');
    for (const l of linhas) {
      console.log(`${dmy(l.data_inicio)}${l.data_fim && l.data_fim !== l.data_inicio ? ` a ${dmy(l.data_fim)}` : ''}`
        + ` | ${l.evento}${l.impacto ? ` (${l.impacto})` : ''}`
        + `${l.codigo_loja ? ` | loja ${l.codigo_loja}` : ''}`);
    }
  } else {
    console.error('Ação inválida. Use: ano | consultar | registrar | listar');
    process.exitCode = 1;
  }
}
