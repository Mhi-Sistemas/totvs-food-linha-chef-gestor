// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// CONFERENCIA DE COMPLETUDE DAS VENDAS — o assistente nao pode entregar
// analise sobre periodo com buraco sem avisar.
//
// Por que existe (relato de gestor, issue #3): a API de vendas as vezes
// devolve o DIA INCOMPLETO respondendo "sucesso". Num caso real, um dia cujo
// caixa fechou em ~R$ 4,8 mil voltou com UMA venda, e a sincronizacao anotou
// isso como coleta normal. O assistente entao gerou painel, DRE, CMV e ranking
// sobre dados faltando, sem nenhum aviso — e o gestor tomou decisao com numero
// errado. Numa loja a receita do mes saiu 38% menor que a real.
//
// Como se descobre: o FECHAMENTO DE CAIXA vem de outro endpoint e bateu
// exatamente com o relatorio do proprio ChefWeb. Entao ele serve de testemunha
// do que aquele dia deveria ter vendido. Duas evidencias de buraco:
//
//   1. dia SEM BUSCA registrada no sync_log     -> nunca foi coletado
//   2. vendas do dia abaixo de 85% do caixa     -> veio parcial
//
// O limiar de 85% nao e chute: na base de validacao, 492 de 544 dias (90%)
// ficaram entre 95% e 105% do caixa — quando a coleta esta boa, os dois numeros
// praticamente coincidem. Abaixo de 85% e buraco, nao ruido.
//
// Dia sem fechamento de caixa nao pode ser conferido (a loja pode ter fechado
// ou o fechamento ainda nao ter sido coletado); isso e dito, nao escondido.

const LIMIAR = 0.85;

const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Dias (loja, dia) do periodo em que NENHUMA busca de vendas foi registrada.
// Respeita a janela que o gestor escolheu para cada loja (`inicio_coleta`) e
// ignora loja encerrada depois da data de encerramento — cobrar dado de loja
// fechada seria alarme falso.
function diasSemBusca(db, conexao, de, ate, loja) {
  const fLoja = loja ? ' AND l.codigo_loja = ?' : '';
  const p = loja ? [Number(loja)] : [];
  return db.prepare(`
    WITH RECURSIVE dias(d) AS (
      SELECT ? UNION ALL SELECT date(d, '+1 day') FROM dias WHERE d < ?
    ),
    alvo AS (
      SELECT l.codigo_loja, l.nome, dias.d AS dia
        FROM lojas l, dias
       WHERE l.conexao = ?${fLoja}
         AND (l.inicio_coleta IS NULL OR dias.d >= l.inicio_coleta)
         AND (COALESCE(l.loja_parada, 0) = 0 OR l.data_loja_parada IS NULL
              OR dias.d <= l.data_loja_parada)
    )
    SELECT a.codigo_loja, a.nome, a.dia FROM alvo a
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_log s
        WHERE s.conexao = ? AND s.dominio = 'vendas'
          AND (s.codigo_loja IS NULL OR s.codigo_loja = a.codigo_loja)
          AND a.dia BETWEEN s.periodo_inicio AND s.periodo_fim)
     ORDER BY a.codigo_loja, a.dia`)
    .all(de, ate, conexao, ...p, conexao);
}

// Dias buscados cuja venda ficou muito abaixo do que as TESTEMUNHAS dizem.
//
// Sao duas testemunhas independentes do movimento de um dia, cada uma de um
// endpoint diferente: o FECHAMENTO DE CAIXA e a CONFERENCIA DE VENDAS (cupom a
// cupom). A referencia e a MAIOR das duas — se qualquer uma delas viu mais
// movimento do que as vendas coletadas, falta dado. Numa validacao real as
// tres bateram ao centavo (R$ 220,89 nas tres), o que e o esperado quando a
// coleta esta inteira.
function diasIncompletos(db, conexao, de, ate, loja) {
  const fCaixa = loja ? ' AND f.codigo_loja = ?' : '';
  const fConf = loja ? ' AND cf.codigo_loja = ?' : '';
  const p = loja ? [Number(loja)] : [];
  return db.prepare(`
    WITH caixa AS (
      SELECT f.codigo_loja, f.data_caixa AS dia, SUM(f.valor_total_sistema) AS valor
        FROM fechamentos_caixa f
       WHERE f.conexao = ? AND f.data_caixa BETWEEN ? AND ?${fCaixa}
       GROUP BY 1, 2 HAVING SUM(f.valor_total_sistema) > 0
    ),
    conferencia AS (
      SELECT cf.codigo_loja, cf.data_caixa AS dia, SUM(cf.valor_total) AS valor
        FROM conferencia_vendas cf
       WHERE cf.conexao = ? AND cf.data_caixa BETWEEN ? AND ?${fConf}
       GROUP BY 1, 2 HAVING SUM(cf.valor_total) > 0
    ),
    testemunhas AS (
      SELECT codigo_loja, dia, MAX(caixa) AS caixa, MAX(conf) AS conf FROM (
        SELECT codigo_loja, dia, valor AS caixa, NULL AS conf FROM caixa
        UNION ALL
        SELECT codigo_loja, dia, NULL, valor FROM conferencia
      ) GROUP BY 1, 2
    ),
    venda AS (
      SELECT v.codigo_loja, v.data_movimento AS dia, SUM(v.valor_total) AS vendas
        FROM vendas v
       WHERE v.conexao = ? AND v.cancelada = 0 AND v.data_movimento BETWEEN ? AND ?
       GROUP BY 1, 2
    )
    SELECT t.codigo_loja, t.dia,
           MAX(COALESCE(t.caixa, 0), COALESCE(t.conf, 0)) AS caixa,
           t.caixa AS valor_caixa, t.conf AS valor_conferencia,
           COALESCE(v.vendas, 0) AS vendas, l.nome
      FROM testemunhas t
      LEFT JOIN venda v ON v.codigo_loja = t.codigo_loja AND v.dia = t.dia
      LEFT JOIN lojas l ON l.conexao = ? AND l.codigo_loja = t.codigo_loja
     WHERE COALESCE(v.vendas, 0) < MAX(COALESCE(t.caixa, 0), COALESCE(t.conf, 0)) * ?
     ORDER BY (MAX(COALESCE(t.caixa, 0), COALESCE(t.conf, 0)) - COALESCE(v.vendas, 0)) DESC`)
    .all(conexao, de, ate, ...p, conexao, de, ate, ...p, conexao, de, ate, conexao, LIMIAR);
}

// Confere um periodo e devolve o veredito, pronto para virar aviso ao gestor.
export function conferirVendas(db, { conexao, de, ate, loja = null }) {
  let semBusca = [];
  let incompletos = [];
  try { semBusca = diasSemBusca(db, conexao, de, ate, loja); } catch { /* sem cadastro de lojas */ }
  try { incompletos = diasIncompletos(db, conexao, de, ate, loja); } catch { /* sem fechamentos */ }

  const faltaEmReais = incompletos.reduce((s, d) => s + (d.caixa - d.vendas), 0);
  // Base do percentual: o maior movimento que as testemunhas viram no periodo.
  const pLoja = loja ? [Number(loja)] : [];
  const fLoja = loja ? ' AND codigo_loja = ?' : '';
  const somaCaixa = db.prepare(
    `SELECT COALESCE(SUM(valor_total_sistema), 0) AS t FROM fechamentos_caixa
      WHERE conexao = ? AND data_caixa BETWEEN ? AND ?${fLoja}`
  ).get(conexao, de, ate, ...pLoja).t;
  let somaConf = 0;
  try {
    somaConf = db.prepare(
      `SELECT COALESCE(SUM(valor_total), 0) AS t FROM conferencia_vendas
        WHERE conexao = ? AND data_caixa BETWEEN ? AND ?${fLoja}`
    ).get(conexao, de, ate, ...pLoja).t;
  } catch { /* banco de versao anterior */ }
  const caixaDoPeriodo = Math.max(somaCaixa, somaConf);

  return {
    grupo: conexao,
    periodo: { de, ate },
    ok: semBusca.length === 0 && incompletos.length === 0,
    dias_sem_busca: semBusca,
    dias_incompletos: incompletos,
    falta_em_reais: faltaEmReais,
    // Peso do buraco: o quanto do caixa conhecido do periodo esta faltando nas
    // vendas. E o numero que faz o gestor entender a gravidade.
    falta_pct: caixaDoPeriodo > 0 ? (100 * faltaEmReais) / caixaDoPeriodo : null,
  };
}

// Confere todos os grupos de uma vez.
export function conferirTodos(db, { de, ate, grupo = null, loja = null }) {
  const grupos = grupo
    ? [grupo]
    : db.prepare('SELECT DISTINCT conexao FROM vendas ORDER BY conexao').all().map((r) => r.conexao);
  return grupos.map((c) => conferirVendas(db, { conexao: c, de, ate, loja }));
}

// Somar "dias faltando" entre lojas produz numero sem sentido para o gestor
// (23 lojas x 31 dias = 713 "dias" num mes de 31). Entao separamos: loja que
// nao tem NENHUM dia do periodo e uma loja sem dados; o resto sao dias avulsos.
function agruparFaltas(conferencia) {
  const totalDias = Math.round(
    (Date.parse(conferencia.periodo.ate) - Date.parse(conferencia.periodo.de)) / 86400000) + 1;
  const porLoja = new Map();
  for (const d of conferencia.dias_sem_busca) {
    porLoja.set(d.codigo_loja, (porLoja.get(d.codigo_loja) ?? 0) + 1);
  }
  const lojasSemNada = [];
  let diasAvulsos = 0;
  for (const [loja, n] of porLoja) {
    if (n >= totalDias) lojasSemNada.push(loja);
    else diasAvulsos += n;
  }
  return { lojasSemNada, diasAvulsos };
}

// Marca os dias incompletos para RECOLETA, na mesma fila que ja recupera as
// falhas de servidor (coleta_falhas). Sem isso o buraco seria apenas
// denunciado na hora da analise e nunca se fecharia sozinho.
//
// Cada passagem incrementa `verificacoes`: um dia que continua incompleto
// depois de varias tentativas nao e mais problema de coleta, e sim defeito do
// lado da TOTVS — e ai vira alerta e texto de chamado, em vez de ficar
// tentando para sempre.
export function marcarParaRecoleta(db, { conexao, de, ate, loja = null }) {
  const c = conferirVendas(db, { conexao, de, ate, loja });

  const existente = db.prepare(
    `SELECT id, verificacoes FROM coleta_falhas
      WHERE conexao = ? AND dominio = 'vendas' AND codigo_loja = ?
        AND periodo_inicio = ? AND periodo_fim = ?`
  );
  const inserir = db.prepare(
    `INSERT INTO coleta_falhas (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, motivo, verificacoes)
     VALUES (?, 'vendas', ?, ?, ?, ?, 1)`
  );
  const atualizar = db.prepare(
    'UPDATE coleta_falhas SET verificacoes = verificacoes + 1, resolvido = 0, motivo = ? WHERE id = ?'
  );

  // Dia que estava na fila e agora esta completo sai dela — senao a recoleta
  // ficaria repetindo para sempre um dia que ja se resolveu.
  const aindaRuins = new Set(c.dias_incompletos.map((d) => `${d.codigo_loja}|${d.dia}`));
  for (const pend of db.prepare(
    `SELECT id, codigo_loja, periodo_inicio AS dia FROM coleta_falhas
      WHERE conexao = ? AND dominio = 'vendas' AND resolvido = 0
        AND periodo_inicio = periodo_fim AND periodo_inicio BETWEEN ? AND ?`
  ).all(conexao, de, ate)) {
    if (!aindaRuins.has(`${pend.codigo_loja}|${pend.dia}`)) {
      db.prepare('UPDATE coleta_falhas SET resolvido = 1 WHERE id = ?').run(pend.id);
    }
  }

  let marcados = 0;
  const persistentes = [];
  for (const d of c.dias_incompletos) {
    const pct = d.caixa > 0 ? Math.round((100 * d.vendas) / d.caixa) : 0;
    const motivo = `dia incompleto: ${brl(d.vendas)} nas vendas contra ${brl(d.caixa)} `
      + `nas testemunhas (${pct}%)`;
    const ja = existente.get(conexao, d.codigo_loja, d.dia, d.dia);
    if (ja) {
      atualizar.run(motivo, ja.id);
      if (ja.verificacoes + 1 >= 3) persistentes.push({ ...d, tentativas: ja.verificacoes + 1 });
    } else {
      inserir.run(conexao, d.codigo_loja, d.dia, d.dia, motivo);
    }
    marcados += 1;
  }
  return { marcados, persistentes };
}

// Dias marcados para recoleta que ainda nao foram resolvidos — a fila que a
// rotina diaria consome.
export function diasParaRecoletar(db, conexao, limite = 20) {
  try {
    return db.prepare(
      `SELECT codigo_loja, periodo_inicio AS dia, verificacoes FROM coleta_falhas
        WHERE conexao = ? AND dominio = 'vendas' AND resolvido = 0
          AND periodo_inicio = periodo_fim AND verificacoes < 3
        ORDER BY verificacoes, periodo_inicio DESC LIMIT ?`
    ).all(conexao, limite);
  } catch { return []; }
}

// Texto para o GESTOR — sem jargao, com o tamanho do problema em reais e a
// saida pratica. Devolve null quando esta tudo certo.
export function avisoParaGestor(conferencia) {
  if (conferencia.ok) return null;
  const { dias_incompletos: inc } = conferencia;
  const { lojasSemNada, diasAvulsos } = agruparFaltas(conferencia);
  const partes = [];
  if (lojasSemNada.length > 0) {
    partes.push(lojasSemNada.length === 1
      ? `a loja ${lojasSemNada[0]} não tem nenhum dado do período`
      : `${lojasSemNada.length} lojas não têm nenhum dado do período`);
  }
  if (diasAvulsos > 0) partes.push(`${diasAvulsos} dia(s) ainda não foram buscados`);
  if (inc.length > 0) {
    partes.push(`${inc.length} dia(s) vieram incompletos do sistema da TOTVS`);
  }
  const quanto = conferencia.falta_pct !== null && conferencia.falta_pct >= 0.5
    ? ` — cerca de ${conferencia.falta_pct.toFixed(1).replace('.', ',')}% do movimento do período`
      + ` (${brl(conferencia.falta_em_reais)}) não está nos dados`
    : '';
  return `Atenção: ${partes.join(' e ')}${quanto}. `
    + 'Qualquer número deste período sai menor que a realidade.';
}

// Detalhe para o assistente mostrar quando o gestor quiser ver a lista.
export function detalhar(conferencia, limite = 12) {
  const linhas = [];
  for (const d of conferencia.dias_incompletos.slice(0, limite)) {
    const pct = d.caixa > 0 ? (100 * d.vendas) / d.caixa : 0;
    // Dizer QUAL testemunha viu o movimento ajuda a decidir onde procurar.
    const fonte = d.valor_caixa && d.valor_conferencia ? 'caixa e cupons emitidos'
      : (d.valor_conferencia ? 'cupons emitidos' : 'fechamento de caixa');
    linhas.push(`  ${dmy(d.dia)}  loja ${d.codigo_loja}${d.nome ? ` (${d.nome})` : ''}: `
      + `${brl(d.vendas)} nas vendas contra ${brl(d.caixa)} no ${fonte} `
      + `(${pct.toFixed(0)}%)`);
  }
  const resto = conferencia.dias_incompletos.length - Math.min(limite, conferencia.dias_incompletos.length);
  if (resto > 0) linhas.push(`  ... e mais ${resto} dia(s) incompleto(s).`);

  const sem = conferencia.dias_sem_busca;
  if (sem.length > 0) {
    const porLoja = new Map();
    for (const d of sem) porLoja.set(d.codigo_loja, (porLoja.get(d.codigo_loja) ?? 0) + 1);
    for (const [cod, n] of porLoja) {
      linhas.push(`  loja ${cod}: ${n} dia(s) sem nenhuma busca no período`);
    }
  }
  return linhas;
}

// Linha de ressalva para sair IMPRESSA no relatorio/painel — o pedido do
// gestor foi explicito: a ressalva tem de acompanhar a entrega, nao ficar so
// no chat, que se perde.
export function ressalvaImpressa(conferencias) {
  const comProblema = conferencias.filter((c) => !c.ok);
  if (comProblema.length === 0) return null;
  let lojas = 0;
  let dias = 0;
  let incompletos = 0;
  for (const c of comProblema) {
    const g = agruparFaltas(c);
    lojas += g.lojasSemNada.length;
    dias += g.diasAvulsos;
    incompletos += c.dias_incompletos.length;
  }
  const falta = comProblema.reduce((s, c) => s + c.falta_em_reais, 0);
  const partes = [];
  if (lojas > 0) partes.push(`${lojas} loja(s) sem nenhum dado`);
  if (dias > 0) partes.push(`${dias} dia(s) não buscados`);
  if (incompletos > 0) partes.push(`${incompletos} dia(s) que vieram parciais`);
  return `⚠️ Dados incompletos neste período: ${partes.join(', ')}`
    + `${falta > 0 ? ` — cerca de ${brl(falta)} de movimento fora da conta` : ''}. `
    + 'Os números abaixo são menores que a realidade.';
}

export { LIMIAR };
