// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// CUSTO DA MERCADORIA VENDIDA — as tres formas legitimas de chegar ao numero,
// num modulo so, porque a DRE e a analise precisam responder a MESMA conta.
//
// Qual delas entra na DRE e ESCOLHA DO GESTOR (preferencia `dre_cmv`), nao do
// assistente: cada uma promete uma coisa diferente e nenhuma e "a certa".
//
//   teorico  — ficha tecnica dos itens vendidos. Funciona em qualquer periodo
//              do historico porque nao depende de estoque, mas descreve o que
//              DEVERIA ter sido consumido: nao enxerga desperdicio, quebra,
//              porcionamento errado nem desvio.
//   real     — estoque inicial + compras - estoque final. E o consumo que de
//              fato aconteceu, e por isso o unico que revela perda. Exige
//              posicao de estoque nas DUAS pontas do periodo.
//   compras  — o que foi lancado nos planos de contas marcados como compra de
//              mercadoria. E o que bate com o extrato e o que o contador
//              costuma usar, mas confunde comprar com consumir: um mes de
//              estocagem pesada infla o numero sem venda nenhuma a mais.
//
// A restricao que da origem a tudo isso: a API do ChefWeb nao devolve posicao
// de estoque de data passada, so a de hoje. Logo o CMV real so existe do dia
// da instalacao em diante — a menos que o gestor importe o INVENTARIO contado
// (scripts/inventario.mjs), que substitui a fotografia que nao pode ser tirada.

// Distancia maxima, em dias, entre a data pedida e a posicao de estoque
// encontrada. Alem disso a defasagem ja distorce mais do que ajuda.
export const DIAS_TOLERANCIA_ESTOQUE = 7;

export const FONTES_CMV = ['teorico', 'real', 'compras'];

export function filtroLoja(loja, alias) {
  return loja ? { sql: ` AND ${alias}.codigo_loja = ?`, params: [Number(loja)] } : { sql: '', params: [] };
}

// Estoque valorizado numa data, pela melhor fonte disponivel.
//
// Entre inventario e fotografia na MESMA distancia vale o inventario: contagem
// fisica manda sobre saldo de sistema. Fora da data exata vale a mais proxima,
// e a defasagem volta no resultado para ser dita em voz alta — cada dia de
// distancia e um dia de movimento entrando ou saindo da conta sem aparecer.
export function estoqueNaData(db, conexao, alvo, loja) {
  const f1 = filtroLoja(loja, 'i');
  const inv = db.prepare(`SELECT i.data,
      SUM(i.quantidade_contada * COALESCE(i.custo_unitario, p.preco_compra, 0)) AS valor,
      COUNT(*) AS itens,
      SUM(CASE WHEN COALESCE(i.custo_unitario, p.preco_compra) IS NULL THEN 1 ELSE 0 END) AS sem_custo,
      GROUP_CONCAT(DISTINCT i.numero) AS numeros
    FROM inventarios i
    LEFT JOIN produtos p ON p.conexao = i.conexao AND p.codigo = i.codigo_produto
    WHERE i.conexao = ? AND ABS(julianday(i.data) - julianday(?)) <= ?${f1.sql}
    GROUP BY i.data
    ORDER BY ABS(julianday(i.data) - julianday(?)) LIMIT 1`)
    .get(conexao, alvo, DIAS_TOLERANCIA_ESTOQUE, ...f1.params, alvo);

  const f2 = filtroLoja(loja, 'e');
  const foto = db.prepare(`SELECT e.data_leitura AS data,
      SUM(e.quantidade * COALESCE(e.custo, p.preco_compra, 0)) AS valor,
      COUNT(*) AS itens,
      SUM(CASE WHEN COALESCE(e.custo, p.preco_compra) IS NULL THEN 1 ELSE 0 END) AS sem_custo
    FROM estoque_posicoes e
    LEFT JOIN produtos p ON p.conexao = e.conexao AND p.codigo = e.codigo_produto
    WHERE e.conexao = ? AND ABS(julianday(e.data_leitura) - julianday(?)) <= ?${f2.sql}
    GROUP BY e.data_leitura
    ORDER BY ABS(julianday(e.data_leitura) - julianday(?)) LIMIT 1`)
    .get(conexao, alvo, DIAS_TOLERANCIA_ESTOQUE, ...f2.params, alvo);

  const dist = (r) => (r ? Math.abs((Date.parse(r.data) - Date.parse(alvo)) / 86400000) : Infinity);
  const usarInv = inv && dist(inv) <= dist(foto);
  const escolhida = usarInv ? inv : foto;
  if (!escolhida) return null;
  return {
    fonte: usarInv ? 'inventário' : 'fotografia',
    data: escolhida.data,
    valor: escolhida.valor ?? 0,
    itens: escolhida.itens,
    sem_custo: escolhida.sem_custo,
    numeros: usarInv ? escolhida.numeros : null,
    defasagem_dias: Math.round(dist(escolhida)),
  };
}

// COMPRAS DE MERCADORIA do periodo.
//
// Vem do CONTAS A PAGAR, por data de competencia, filtrado pelos planos que o
// gestor marcou como compra de mercadoria — e NAO das notas fiscais de
// entrada. A nota de entrada nao serve porque traz junto equipamento,
// utensilio, material de escritorio e servico: somar a nota inteira joga tudo
// isso dentro do custo da mercadoria e infla o CMV. (Na base de teste, as
// notas de entrada somavam 35% a mais do que deveriam, entre transferencias
// entre lojas do proprio grupo e itens que nao sao mercadoria.)
//
// A API do ChefWeb nao tem endpoint de compras; na falta dele, o lancamento
// financeiro ja classificado pelo gestor e a melhor aproximacao, porque a
// classificacao por plano de contas e justamente onde a operacao separa
// mercadoria de imobilizado.
//
// Consequencia: o CMV real DEPENDE da categoria `mercadoria` estar definida
// (categorias-planos.mjs), do mesmo jeito que o CMO depende da `pessoal`.
export function comprasDoPeriodo(db, conexao, de, ate, loja) {
  const marcados = db.prepare(
    "SELECT plano1, plano2 FROM plano_categorias WHERE categoria = 'mercadoria'"
  ).all();
  if (marcados.length === 0) {
    return {
      valor: null,
      lancamentos: 0,
      motivo: 'nenhum plano de contas marcado como compra de mercadoria — rode '
        + 'categorias-planos.mjs sugerir --categoria mercadoria, confirme com o gestor e defina',
    };
  }
  const cond = marcados
    .map(() => "(COALESCE(plano_contas1,'') = ? AND (? = '*' OR COALESCE(plano_contas2,'') = ?))")
    .join(' OR ');
  const params = marcados.flatMap((m) => [m.plano1, m.plano2, m.plano2]);
  const f = filtroLoja(loja, 'c');
  const r = db.prepare(`SELECT COALESCE(SUM(valor), 0) AS valor, COUNT(*) AS lancamentos
    FROM contas_pagar c
    WHERE c.conexao = ? AND COALESCE(c.data_competencia, c.data_emissao) BETWEEN ? AND ?
      AND COALESCE(c.deletado, 0) = 0${f.sql}
      AND (${cond})`).get(conexao, de, ate, ...f.params, ...params);
  return { valor: r.valor, lancamentos: r.lancamentos, planos: marcados.length };
}

// Receita de PRODUTOS (base B2): sem taxa de servico (999) nem entrega (997),
// que nao tem custo de mercadoria e reduziriam o %CMV artificialmente.
export function receitaDeProdutos(db, conexao, de, ate, loja) {
  const f = loja ? ' AND v.codigo_loja = ?' : '';
  return db.prepare(`SELECT COALESCE(SUM(i.valor_total), 0) AS b2
    FROM venda_itens i JOIN vendas v ON v.conexao = i.conexao AND v.chave_venda = i.chave_venda
    WHERE v.conexao = ? AND v.cancelada = 0 AND i.status = 1
      AND i.codigo_produto NOT IN (997, 999)
      AND v.data_movimento BETWEEN ? AND ?${f}`)
    .get(conexao, de, ate, ...(loja ? [Number(loja)] : [])).b2;
}

export function cmvReal(db, conexao, de, ate, loja) {
  // A posicao inicial e a da VESPERA: o movimento do primeiro dia do periodo
  // ja pertence ao periodo analisado.
  const vespera = new Date(Date.parse(de) - 86400000).toISOString().slice(0, 10);
  const inicial = estoqueNaData(db, conexao, vespera, loja);
  const final = estoqueNaData(db, conexao, ate, loja);
  const compras = comprasDoPeriodo(db, conexao, de, ate, loja);
  const valor = inicial && final && compras.valor !== null
    ? inicial.valor + compras.valor - final.valor : null;
  return { fonte: 'real', valor, estoque_inicial: inicial, estoque_final: final, compras };
}

export function cmvTeorico(db, conexao, de, ate, loja) {
  const f = loja ? ' AND v.codigo_loja = ?' : '';
  const r = db.prepare(`SELECT
      COALESCE(SUM(i.quantidade * COALESCE(i.preco_compra, p.preco_compra, 0)), 0) AS valor,
      COALESCE(SUM(CASE WHEN COALESCE(i.preco_compra, p.preco_compra, 0) > 0
                        THEN i.valor_total ELSE 0 END), 0) AS receita_com_custo,
      COALESCE(SUM(i.valor_total), 0) AS receita
    FROM venda_itens i
    JOIN vendas v ON v.conexao = i.conexao AND v.chave_venda = i.chave_venda
    LEFT JOIN produtos p ON p.conexao = i.conexao AND p.codigo = i.codigo_produto
    WHERE v.conexao = ? AND v.cancelada = 0 AND i.status = 1
      AND i.codigo_produto NOT IN (997, 999)
      AND v.data_movimento BETWEEN ? AND ?${f}`)
    .get(conexao, de, ate, ...(loja ? [Number(loja)] : []));
  return {
    fonte: 'teorico',
    valor: r.valor,
    // Quanto da receita vendida tinha custo cadastrado: um CMV teorico sobre
    // 40% da receita nao e um CMV, e uma amostra.
    cobertura_pct: r.receita > 0 ? (100 * r.receita_com_custo) / r.receita : null,
  };
}

// Compra de mercadoria pelos PLANOS DE CONTAS que o gestor marcou como tal
// (categorias-planos.mjs definir "PLANO|*=mercadoria"). Por competencia,
// mesmo criterio das demais despesas da DRE.
// A fonte "compras" da DRE e a MESMA apuracao que alimenta o CMV real — a
// diferenca esta no uso, nao na conta: aqui o valor comprado E o custo
// declarado; la ele e ajustado pela variacao do estoque.
export function cmvPorCompras(db, conexao, de, ate, loja) {
  return { fonte: 'compras', ...comprasDoPeriodo(db, conexao, de, ate, loja) };
}

export function calcularCmv(db, fonte, conexao, de, ate, loja) {
  if (fonte === 'real') return cmvReal(db, conexao, de, ate, loja);
  if (fonte === 'compras') return cmvPorCompras(db, conexao, de, ate, loja);
  return cmvTeorico(db, conexao, de, ate, loja);
}

// ---------- preferencia do gestor ----------

// A tabela faz parte do schema (criar-banco.mjs). Isto aqui e so a rede de
// seguranca para bancos de versoes anteriores, e SO e chamado em caminho de
// ESCRITA — quem le abre o banco em somente leitura e nao pode criar nada.
export function garantirPreferencias(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS preferencias (
      chave TEXT NOT NULL,
      conexao TEXT NOT NULL DEFAULT '*',
      valor TEXT NOT NULL,
      definida_em TEXT NOT NULL DEFAULT (date('now','localtime')),
      PRIMARY KEY (chave, conexao)
    )`);
  } catch { /* banco somente leitura: quem le nao precisa criar */ }
}

// LEITURA PURA: nao cria tabela, nao escreve nada. Banco sem a tabela devolve
// o padrao — e foi justamente o contrario disso que derrubou a DRE na 1.0.8,
// com "attempt to write a readonly database" em quem nunca definiu a
// preferencia.
export function lerPreferencia(db, chave, conexao = null, padrao = null) {
  try {
    const especifica = conexao
      ? db.prepare('SELECT valor FROM preferencias WHERE chave = ? AND conexao = ?').get(chave, conexao)
      : null;
    if (especifica) return especifica.valor;
    const geral = db.prepare("SELECT valor FROM preferencias WHERE chave = ? AND conexao = '*'").get(chave);
    return geral ? geral.valor : padrao;
  } catch {
    return padrao; // tabela ainda nao existe neste banco
  }
}

export function gravarPreferencia(db, chave, valor, conexao = '*') {
  garantirPreferencias(db);
  db.prepare(`INSERT OR REPLACE INTO preferencias (chave, conexao, valor, definida_em)
    VALUES (?, ?, ?, date('now','localtime'))`).run(chave, conexao, valor);
}

// Qual CMV o gestor escolheu para a DRE. O padrao e o teorico porque e o unico
// que funciona sem depender de estoque — mas o assistente deve PERGUNTAR, e a
// escolha do gestor prevalece.
export function fonteCmvDaDre(db, conexao = null) {
  const v = lerPreferencia(db, 'dre_cmv', conexao, 'teorico');
  return FONTES_CMV.includes(v) ? v : 'teorico';
}

export const ROTULO_CMV = {
  teorico: 'CMV teórico (ficha técnica)',
  real: 'CMV real (estoque + compras)',
  compras: 'Compra de mercadorias (plano de contas)',
};
