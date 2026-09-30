// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Motor analítico do assistente — a camada que interpreta, não só mostra.
//
// Sai em JSON (para o agente raciocinar em cima) ou em texto legível.
// Ver docs/camada-de-inteligencia.md para o porquê de cada análise.
//
// Uso:
//   node --no-warnings scripts/analisar.mjs qualidade [--grupo X]
//   node --no-warnings scripts/analisar.mjs anomalias  --grupo X [--data AAAA-MM-DD] [--semanas 8]
//   node --no-warnings scripts/analisar.mjs variacao   --grupo X --de A --ate B --contra-de C --contra-ate D
//   node --no-warnings scripts/analisar.mjs benchmark  --grupo X --de A --ate B
//   node --no-warnings scripts/analisar.mjs cesta      --grupo X --de A --ate B [--minimo 20]
//   node --no-warnings scripts/analisar.mjs simular    --grupo X --produto N --variacao 5
//   node --no-warnings scripts/analisar.mjs fiscal     --grupo X --de A --ate B
//
// Acrescente --json para a saída estruturada.

import { abrirBanco } from './criar-banco.mjs';
import { estoqueNaData, comprasDoPeriodo, receitaDeProdutos } from './cmv.mjs';
import { conferirTodos, avisoParaGestor, detalhar } from './completude.mjs';
import { ehFeriado } from './calendario.mjs';

// ---------- utilitários ----------

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
const pct = (v) => `${(v ?? 0).toFixed(1).replace('.', ',')}%`;
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const NOMES_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function media(v) { return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function desvio(v) {
  if (v.length < 2) return 0;
  const m = media(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

// Filtro de grupo: só restringe quando há mais de um configurado.
function filtroGrupo(db, grupo, alias = '') {
  const p = alias ? `${alias}.` : '';
  if (grupo) return { sql: ` AND ${p}conexao = ?`, params: [grupo] };
  const grupos = db.prepare('SELECT DISTINCT conexao FROM vendas').all();
  if (grupos.length <= 1) return { sql: '', params: [] };
  return { sql: '', params: [] };
}

// ---------- 8. QUALIDADE DOS DADOS ----------

// CUSTO INCOERENTE: custo unitario fora da realidade do produto.
//
// A causa mais comum nao e digitacao, e CONVERSAO DE EMBALAGEM na entrada da
// mercadoria: compra-se a caixa com 1.000 potes por R$ 518 e, sem o fator de
// conversao preenchido, o pote passa a custar R$ 518 em vez de R$ 0,52. O
// mesmo com o barril de chopp de 50 litros lancado como 1 litro, ou o pacote
// de 18 aguas lancado como 1 agua. O foco sao insumos e produtos de revenda,
// onde a compra por embalagem acontece.
//
// O que NAO e defeito: produto ADICIONAL (item filho de um principal) com
// preco de venda 0 ou 0,01 por estrategia comercial. O custo fica altissimo
// em relacao ao preco por aritmetica, e isso e esperado — esses itens ficam
// fora do alerta, senao a lista enche de falso positivo.
//
// A API nao devolve o FatorCompra (vem sempre nulo), entao a deteccao usa
// tres sinais, do mais forte ao mais fraco.
const CUSTO_PISO = 1;            // abaixo de R$ 1 o ruido de centavos domina
const CUSTO_X_MEDIANA_UNIDADE = 5;   // com unidade de compra diferente
const CUSTO_X_MEDIANA_SOZINHO = 10;  // sem esse indicio, exige-se mais
const AMOSTRA_MINIMA_SUBGRUPO = 5;   // subgrupo pequeno nao tem mediana confiavel
// Adicional de preco simbolico fica fora do alerta (o custo alto em relacao ao
// preco e estrategia comercial, nao defeito) — MAS ha um limite para o
// absurdo: um adicional que custa mil vezes o que custam os seus pares esta
// errado, e o preco de venda nao tem nada a ver com isso.
const CUSTO_X_MEDIANA_ADICIONAL = 50;

function custosIncoerentes(db, grupo) {
  const g = filtroGrupo(db, grupo, 'p');
  let linhas;
  try {
    linhas = db.prepare(`
      WITH base AS (
        SELECT p.conexao, p.codigo, p.nome, p.subgrupo, p.unidade, p.unidade_compra,
               p.preco_compra AS custo, p.preco_venda AS venda,
               CASE WHEN COALESCE(p.eh_adicional, 0) = 1
                      OR COALESCE(p.subgrupo, '') LIKE '%ADICIONAL%' THEN 1 ELSE 0 END AS adicional,
               -- Adicional de preco simbolico: entra no calculo da mediana
               -- (ele faz parte do subgrupo e a mediana e robusta a outlier),
               -- mas so vira alerta no caso extremo, tratado adiante.
               CASE WHEN (COALESCE(p.eh_adicional, 0) = 1
                          OR COALESCE(p.subgrupo, '') LIKE '%ADICIONAL%')
                     AND COALESCE(p.preco_venda, 0) <= 0.01 THEN 1 ELSE 0 END AS simbolico
          FROM produtos p
         WHERE p.ativo = 1 AND p.preco_compra > 0 AND p.codigo NOT IN (997, 999)
           ${g.sql}),
      -- A mediana sai dos produtos de venda normal: incluir os adicionais de
      -- preco simbolico deslocaria a referencia de todos os subgrupos onde eles
      -- existem, mudando alertas que nada tem a ver com eles.
      ordenada AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY conexao, subgrupo ORDER BY custo) AS rn,
                  COUNT(*) OVER (PARTITION BY conexao, subgrupo) AS n
          FROM base WHERE simbolico = 0),
      medianas AS (
        SELECT conexao, subgrupo, AVG(custo) AS mediana, MAX(n) AS amostra
          FROM ordenada WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
         GROUP BY conexao, subgrupo)
      SELECT b.*, m.mediana, m.amostra
        FROM base b LEFT JOIN medianas m
          ON m.conexao = b.conexao AND m.subgrupo IS b.subgrupo`).all(...g.params);
  } catch {
    return []; // banco de versao anterior, sem as colunas de compra
  }

  const achados = [];
  for (const r of linhas) {
    const temMediana = r.amostra >= AMOSTRA_MINIMA_SUBGRUPO && r.mediana > 0;
    const vezes = temMediana ? r.custo / r.mediana : null;
    const unidadeDifere = !!r.unidade_compra && !!r.unidade && r.unidade_compra !== r.unidade;
    const vendido = (r.venda ?? 0) > 0.01;
    let motivo = null;
    let confianca = null;

    // Adicional de preco simbolico so aparece quando o custo e absurdo diante
    // dos proprios pares — a comparacao com o preco de venda nao vale para ele.
    if (r.simbolico && !(vezes >= CUSTO_X_MEDIANA_ADICIONAL)) continue;
    if (r.simbolico) {
      achados.push({
        grupo: r.conexao, codigo: r.codigo, nome: r.nome, subgrupo: r.subgrupo,
        unidade: r.unidade, unidade_compra: r.unidade_compra,
        custo: r.custo, preco_venda: r.venda,
        custo_tipico_subgrupo: Number(r.mediana.toFixed(2)),
        vezes_a_mediana: Number(vezes.toFixed(1)),
        confianca: 'alta',
        motivo: `${vezes.toFixed(0)}x o custo típico do subgrupo `
          + `(mediana ${brl(r.mediana)}) — é adicional de preço simbólico, onde custo alto `
          + 'costuma ser proposital, mas esta diferença é grande demais para ser estratégia',
      });
      continue;
    }

    if (r.custo >= CUSTO_PISO && unidadeDifere && vezes >= CUSTO_X_MEDIANA_UNIDADE) {
      motivo = `comprado em ${r.unidade_compra} e consumido em ${r.unidade} — o custo `
        + `parece ser o da embalagem inteira (${vezes.toFixed(0)}x o típico do subgrupo); `
        + 'confira o fator de conversão na entrada da mercadoria';
      confianca = 'alta';
    } else if (vendido && !r.adicional && r.custo > r.venda * 1.5 && r.custo >= CUSTO_PISO) {
      // O preco do adicional e subsidiado por decisao comercial, entao nao
      // serve de referencia para o custo — mesmo quando nao e simbolico. Para
      // eles vale so a comparacao com o padrao do proprio subgrupo (abaixo),
      // que ainda pega o caso escandaloso.

      motivo = `custo ${brl(r.custo)} maior que o próprio preço de venda ${brl(r.venda)}`;
      confianca = 'alta';
    } else if (r.custo >= CUSTO_PISO && vezes >= CUSTO_X_MEDIANA_SOZINHO) {
      motivo = `${vezes.toFixed(0)}x o custo típico do subgrupo `
        + `(mediana ${brl(r.mediana)}, ${r.amostra} produtos)`;
      confianca = 'media';
    }
    if (!motivo) continue;
    achados.push({
      grupo: r.conexao, codigo: r.codigo, nome: r.nome, subgrupo: r.subgrupo,
      unidade: r.unidade, unidade_compra: r.unidade_compra,
      custo: r.custo, preco_venda: r.venda,
      custo_tipico_subgrupo: temMediana ? Number(r.mediana.toFixed(2)) : null,
      vezes_a_mediana: vezes ? Number(vezes.toFixed(1)) : null,
      confianca, motivo,
    });
  }
  // Mais grave primeiro: confianca alta, depois o mais distante do tipico.
  achados.sort((a, b) => (a.confianca === b.confianca
    ? (b.vezes_a_mediana ?? 0) - (a.vezes_a_mediana ?? 0)
    : (a.confianca === 'alta' ? -1 : 1)));
  return achados;
}

function qualidade(db, args) {
  const g = filtroGrupo(db, args.grupo);
  const num = (sql, ...p) => db.prepare(sql).get(...p) ?? {};

  const produtos = num(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN preco_compra > 0 THEN 1 ELSE 0 END) AS com_custo,
            SUM(CASE WHEN preco_venda > 0 THEN 1 ELSE 0 END) AS com_preco,
            SUM(CASE WHEN subgrupo IS NULL OR subgrupo = '' THEN 1 ELSE 0 END) AS sem_categoria
     FROM produtos WHERE ativo = 1${g.sql}`, ...g.params);
  const estoque = num(
    `SELECT COUNT(*) AS itens, SUM(CASE WHEN quantidade < 0 THEN 1 ELSE 0 END) AS negativos
     FROM estoque_posicoes e
     WHERE e.data_leitura = (SELECT MAX(data_leitura) FROM estoque_posicoes)${g.sql}`, ...g.params);
  const vendas = num(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN cliente_codigo > 0 THEN 1 ELSE 0 END) AS com_cliente,
            SUM(CASE WHEN quantidade_pessoas > 0 THEN 1 ELSE 0 END) AS com_pessoas,
            MIN(data_movimento) AS de, MAX(data_movimento) AS ate
     FROM vendas WHERE cancelada = 0${g.sql}`, ...g.params);
  const itensSemCusto = num(
    `SELECT ROUND(100.0 * SUM(CASE WHEN i.preco_compra > 0 THEN i.valor_total ELSE 0 END)
       / NULLIF(SUM(i.valor_total), 0), 1) AS cobertura_receita
     FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
     WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)${g.sql ? ' AND v.conexao = ?' : ''}`,
    ...g.params);
  const lojasSemMovimento = db.prepare(
    `SELECT l.codigo_loja, l.nome FROM lojas l
     WHERE ${args.grupo ? 'l.conexao = ? AND' : ''} NOT EXISTS (
       SELECT 1 FROM vendas v WHERE v.conexao = l.conexao AND v.codigo_loja = l.codigo_loja)`
  ).all(...(args.grupo ? [args.grupo] : []));

  const cobertura = (parte, total) => (total > 0 ? Math.round((100 * parte) / total) : 0);
  const custoSuspeito = custosIncoerentes(db, args.grupo);
  const alertas = [];
  const covCusto = cobertura(produtos.com_custo, produtos.total);
  if (covCusto < 80) {
    alertas.push({
      grave: covCusto < 50,
      assunto: 'custo dos produtos',
      texto: `Só ${covCusto}% dos produtos ativos têm custo cadastrado `
        + `(${produtos.com_custo} de ${produtos.total}). `
        + (itensSemCusto.cobertura_receita !== null
          ? `Isso cobre ${pct(itensSemCusto.cobertura_receita)} da receita vendida. ` : '')
        + 'CMV, margem e engenharia de cardápio ficam incompletos.',
    });
  }
  if (estoque.negativos > 0) {
    alertas.push({
      grave: estoque.negativos > estoque.itens * 0.1,
      assunto: 'estoque negativo',
      texto: `${estoque.negativos} de ${estoque.itens} itens com saldo negativo — `
        + 'venda sem entrada ou ficha técnica errada. Compromete CMV real e sugestão de compra.',
    });
  }
  if (custoSuspeito.length > 0) {
    const altos = custoSuspeito.filter((c) => c.confianca === 'alta');
    alertas.push({
      grave: altos.length > 0,
      assunto: 'custos incoerentes',
      texto: `${custoSuspeito.length} produto(s) com custo fora da realidade`
        + (altos.length > 0 ? ` (${altos.length} com indício forte)` : '')
        + ' — quase sempre fator de conversão errado na entrada da mercadoria '
        + '(a caixa lançada como se fosse uma unidade). Distorce CMV, margem e '
        + 'valor do estoque. Exemplos: '
        + custoSuspeito.slice(0, 3).map((c) => `${c.nome} (${brl(c.custo)}/${c.unidade})`).join('; '),
      itens: custoSuspeito,
    });
  }
  if (produtos.sem_categoria > 0) {
    alertas.push({
      grave: false, assunto: 'categorias',
      texto: `${produtos.sem_categoria} produtos ativos sem categoria (subgrupo): `
        + 'ficam de fora do mix e da engenharia de cardápio.',
    });
  }
  const covCliente = cobertura(vendas.com_cliente, vendas.total);
  if (covCliente < 20) {
    alertas.push({
      grave: false, assunto: 'identificação do cliente',
      texto: `Apenas ${covCliente}% das vendas têm cliente identificado — `
        + 'análises de recorrência e fidelidade não são confiáveis.',
    });
  }
  if (lojasSemMovimento.length > 0) {
    alertas.push({
      grave: false, assunto: 'lojas sem dados',
      texto: `${lojasSemMovimento.length} loja(s) cadastrada(s) sem nenhuma venda coletada: `
        + lojasSemMovimento.slice(0, 8).map((l) => `${l.codigo_loja} ${l.nome ?? ''}`).join('; '),
    });
  }

  const resultado = {
    periodo_coletado: { de: vendas.de, ate: vendas.ate, vendas: vendas.total },
    cobertura: {
      produtos_com_custo: `${covCusto}%`,
      receita_com_custo: itensSemCusto.cobertura_receita !== null ? `${itensSemCusto.cobertura_receita}%` : null,
      vendas_com_cliente: `${covCliente}%`,
      vendas_com_pessoas: `${cobertura(vendas.com_pessoas, vendas.total)}%`,
      estoque_negativo: estoque.negativos,
    },
    custos_incoerentes: custoSuspeito,
    alertas,
  };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }
  console.log('CONFIABILIDADE DOS DADOS');
  console.log(`Período coletado: ${dmy(vendas.de)} a ${dmy(vendas.ate)} (${vendas.total} vendas)`);
  console.log(`Produtos com custo: ${covCusto}% | vendas com cliente: ${covCliente}%`
    + ` | estoque negativo: ${estoque.negativos} itens`);
  if (alertas.length === 0) console.log('Nenhum problema relevante de qualidade encontrado.');
  for (const a of alertas) console.log(`${a.grave ? '[GRAVE] ' : '[atenção] '}${a.texto}`);
  if (custoSuspeito.length > 0) {
    console.log(`
CUSTOS A CONFERIR NO CHEFWEB (${custoSuspeito.length})`);
    const mostrar = args.todos ? custoSuspeito : custoSuspeito.slice(0, 20);
    for (const c of mostrar) {
      console.log(`  ${c.codigo} ${(c.nome ?? '').slice(0, 42).padEnd(42)} `
        + `${brl(c.custo).padStart(12)}/${c.unidade ?? '?'}  [${c.confianca}]`);
      console.log(`      ${c.subgrupo ?? 'sem categoria'} — ${c.motivo}`);
    }
    if (mostrar.length < custoSuspeito.length) {
      console.log(`  ... e mais ${custoSuspeito.length - mostrar.length}. `
        + 'Use --todos para a lista completa ou --json para levar para planilha.');
    }
  }
}

// ---------- 1a. COMPLETUDE ----------
//
// A CONFERENCIA QUE VEM ANTES DE TUDO. Pedido expresso de gestor (issue #3):
// o assistente nao pode entregar analise de vendas de um periodo com dias
// faltando ou incompletos sem avisar antes. Rode isto antes de montar painel,
// relatorio, DRE ou qualquer numero de vendas; se houver buraco, diga ao
// gestor o tamanho dele e so siga se ele aceitar.
function completude(db, args) {
  const hoje = new Date();
  const de = args.de && args.de !== true ? args.de
    : new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1).toISOString().slice(0, 10);
  const ate = args.ate && args.ate !== true ? args.ate
    : new Date(hoje.getFullYear(), hoje.getMonth(), 0).toISOString().slice(0, 10);
  const conferencias = conferirTodos(db, {
    de, ate,
    grupo: args.grupo && args.grupo !== true ? args.grupo : null,
    loja: args.loja && args.loja !== true ? args.loja : null,
  });

  if (args.json) { console.log(JSON.stringify(conferencias, null, 2)); return; }

  console.log(`CONFERÊNCIA DOS DADOS — ${dmy(de)} a ${dmy(ate)}`);
  let algum = false;
  for (const c of conferencias) {
    const aviso = avisoParaGestor(c);
    console.log('');
    console.log(`Grupo ${c.grupo}: ${aviso ?? 'dados completos — pode analisar com confiança.'}`);
    if (aviso) {
      algum = true;
      for (const l of detalhar(c)) console.log(l);
    }
  }
  if (algum) {
    console.log('');
    console.log('NÃO entregue análise deste período sem antes contar isso ao gestor.');
    console.log('Ofereça buscar o que falta (sincronizar.mjs --dominio vendas --de ... --ate ...)');
    console.log('e só siga se ele aceitar — a ressalva sai impressa no painel e na DRE.');
    process.exitCode = 3; // permite ao chamador saber que houve buraco
  }
}

// ---------- 1b. CMV REAL ----------
//
// A conta e as tres fontes possiveis vivem em cmv.mjs, porque a DRE responde a
// MESMA pergunta e nao pode divergir desta tela.

function cmv(db, args) {
  const hoje = new Date();
  const inicioMesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const fimMesPassado = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const de = args.de && args.de !== true ? args.de : iso(inicioMesPassado);
  const ate = args.ate && args.ate !== true ? args.ate : iso(fimMesPassado);
  const loja = args.loja && args.loja !== true ? args.loja : null;

  const grupos = args.grupo && args.grupo !== true
    ? [args.grupo]
    : db.prepare('SELECT DISTINCT conexao FROM vendas ORDER BY conexao').all().map((r) => r.conexao);

  const resultados = [];
  for (const conexao of grupos) {
    // O estoque inicial e a posicao da VESPERA: o movimento do primeiro dia do
    // periodo ja pertence ao periodo analisado.
    const vespera = new Date(Date.parse(de) - 86400000).toISOString().slice(0, 10);
    const inicial = estoqueNaData(db, conexao, vespera, loja);
    const final = estoqueNaData(db, conexao, ate, loja);

    const compras = comprasDoPeriodo(db, conexao, de, ate, loja);
    const b2 = receitaDeProdutos(db, conexao, de, ate, loja);

    const valorCmv = inicial && final ? inicial.valor + compras.valor - final.valor : null;
    resultados.push({
      grupo: conexao,
      loja: loja ? Number(loja) : null,
      periodo: { de, ate },
      estoque_inicial: inicial,
      compras,
      estoque_final: final,
      cmv: valorCmv,
      receita_produtos: b2,
      cmv_pct: valorCmv !== null && b2 > 0 ? (100 * valorCmv) / b2 : null,
    });
  }

  if (args.json) { console.log(JSON.stringify(resultados, null, 2)); return; }

  for (const r of resultados) {
    console.log(`CMV REAL — ${r.grupo}${r.loja ? ` · loja ${r.loja}` : ' · todas as lojas'}`);
    console.log(`Período analisado: ${dmy(r.periodo.de)} a ${dmy(r.periodo.ate)}`);
    console.log('');
    if (r.compras.valor === null) {
      console.log('Não dá para calcular o CMV real ainda: falta dizer quais contas do seu plano');
      console.log('são compra de mercadoria. É por elas que as compras do período são apuradas');
      console.log('(a nota fiscal de entrada não serve: vem com equipamento, utensílio e serviço');
      console.log('misturados à mercadoria).');
      console.log('');
      console.log('  1) node --no-warnings scripts/categorias-planos.mjs sugerir --categoria mercadoria');
      console.log('  2) apresente a lista ao gestor em linguagem simples e confirme com ele');
      console.log('  3) node --no-warnings scripts/categorias-planos.mjs definir "PLANO|SUB=mercadoria"');
      console.log('');
      continue;
    }
    if (!r.estoque_inicial || !r.estoque_final) {
      const falta = !r.estoque_inicial ? 'do início' : 'do fim';
      console.log(`Não dá para calcular o CMV real: falta a posição de estoque ${falta} do período.`);
      console.log('A posição de uma data passada não existe na API. Ou havia fotografia do dia');
      console.log('(a rotina diária tira uma por dia), ou o gestor importa o inventário contado no');
      console.log('ChefWeb: scripts/inventario.mjs importar --arquivo <planilha>.');
      console.log('Enquanto isso, use o CMV teórico (ficha técnica), que não depende de estoque.');
      console.log('');
      continue;
    }
    const linha = (rot, v) => console.log(`  ${rot.padEnd(34)}${brl(v).padStart(16)}`);
    const itens = (n) => `${n} ${n === 1 ? 'item' : 'itens'}`;
    const orig = (e) => `${e.fonte} de ${dmy(e.data)}`
      + (e.numeros ? ` (nº ${String(e.numeros).split(',').sort().join(', ')})` : '')
      + (e.defasagem_dias > 0 ? ` — ${e.defasagem_dias} dia(s) de defasagem` : '');
    linha('Estoque inicial', r.estoque_inicial.valor);
    console.log(`      ${orig(r.estoque_inicial)}, ${itens(r.estoque_inicial.itens)}`);
    linha('(+) Compras do período', r.compras.valor ?? 0);
    console.log(`      ${r.compras.lancamentos} lançamento(s) de compra de mercadoria `
      + '(contas a pagar, por competência)');
    linha('(−) Estoque final', r.estoque_final.valor);
    console.log(`      ${orig(r.estoque_final)}, ${itens(r.estoque_final.itens)}`);
    linha('= CMV do período', r.cmv);
    linha('Receita de produtos (B2)', r.receita_produtos);
    console.log('');
    console.log(`  %CMV: ${r.cmv_pct !== null ? pct(r.cmv_pct) : '—'}`
      + '   (referência de mercado: 28% a 35% na maioria dos segmentos)');

    const avisos = [];
    if (r.estoque_inicial.sem_custo > 0 || r.estoque_final.sem_custo > 0) {
      avisos.push(`${r.estoque_inicial.sem_custo + r.estoque_final.sem_custo} item(ns) sem custo `
        + 'conhecido entraram como zero — o CMV sai subestimado.');
    }
    if (r.compras.lancamentos === 0) {
      avisos.push('Nenhum lançamento de compra de mercadoria no período: sem as compras, o CMV é '
        + 'só a variação do estoque e não tem significado.');
    }
    const equilibrio = Math.min(r.estoque_inicial.itens, r.estoque_final.itens)
      / Math.max(r.estoque_inicial.itens, r.estoque_final.itens, 1);
    if (equilibrio < 0.5) {
      avisos.push('As duas pontas cobrem quantidades de itens muito diferentes '
        + `(${r.estoque_inicial.itens} × ${r.estoque_final.itens}) — provavelmente uma delas é uma `
        + 'contagem parcial, e comparar as duas não fecha conta.');
    }
    if (r.cmv_pct !== null && (r.cmv_pct < 0 || r.cmv_pct > 80)) {
      avisos.push(`%CMV de ${pct(r.cmv_pct)} está fora de qualquer faixa plausível — confira se as `
        + 'duas pontas são contagens completas e se os custos estão corretos (analisar.mjs qualidade).');
    }
    for (const a of avisos) console.log(`\n  ⚠️ ${a}`);
    console.log('');
  }
}

// ---------- 2. ANOMALIAS ----------

function anomalias(db, args) {
  const semanas = Number(args.semanas ?? 8);
  const grupo = args.grupo;
  const paramsG = grupo ? [grupo] : [];
  const fG = grupo ? ' AND conexao = ?' : '';

  // Dia de referência: o informado ou o último com movimento.
  const ultimo = db.prepare(
    `SELECT MAX(data_movimento) AS d FROM vendas WHERE cancelada = 0${fG}`
  ).get(...paramsG)?.d;
  const dia = args.data ?? ultimo;
  if (!dia) { console.log('Sem vendas coletadas para analisar.'); return; }

  const diaSemana = new Date(`${dia}T12:00:00Z`).getUTCDay();
  // Histórico do MESMO dia da semana, excluindo feriados (que distorcem a base)
  const historico = db.prepare(
    `SELECT codigo_loja, data_movimento AS dia, COUNT(*) AS cupons,
            SUM(valor_total) AS faturamento
     FROM vendas
     WHERE cancelada = 0${fG}
       AND CAST(strftime('%w', data_movimento) AS INT) = ?
       AND data_movimento < ? AND data_movimento >= date(?, '-' || ? || ' day')
     GROUP BY codigo_loja, data_movimento`
  ).all(...paramsG, diaSemana, dia, dia, semanas * 7);

  const doDia = db.prepare(
    `SELECT codigo_loja, nome_loja, COUNT(*) AS cupons, SUM(valor_total) AS faturamento,
            SUM(valor_desconto) AS descontos
     FROM vendas WHERE cancelada = 0${fG} AND data_movimento = ?
     GROUP BY codigo_loja, nome_loja`
  ).all(...paramsG, dia);

  const porLoja = new Map();
  for (const h of historico) {
    if (!porLoja.has(h.codigo_loja)) porLoja.set(h.codigo_loja, []);
    porLoja.get(h.codigo_loja).push(h.faturamento);
  }

  const achados = [];
  for (const d of doDia) {
    const base = porLoja.get(d.codigo_loja) ?? [];
    if (base.length < 4) continue; // amostra insuficiente: não inventa alarme
    const m = media(base);
    const s = desvio(base);
    const variacao = m > 0 ? ((d.faturamento - m) / m) * 100 : 0;
    const z = s > 0 ? (d.faturamento - m) / s : 0;
    if (Math.abs(z) >= 2 && Math.abs(variacao) >= 15) {
      achados.push({
        tipo: 'faturamento',
        loja: d.codigo_loja,
        nome_loja: d.nome_loja,
        valor: Math.round(d.faturamento * 100) / 100,
        esperado: Math.round(m * 100) / 100,
        variacao_pct: Math.round(variacao * 10) / 10,
        desvios: Math.round(z * 10) / 10,
        amostra: base.length,
        sentido: variacao > 0 ? 'acima' : 'abaixo',
      });
    }
  }

  // Cancelamentos e descontos fora do padrão, por operador, no dia
  const cancel = db.prepare(
    `SELECT operador_cancelamento AS operador, COUNT(*) AS qtd, SUM(valor_total) AS valor
     FROM vendas WHERE cancelada = 1${fG} AND data_movimento = ?
     GROUP BY 1 ORDER BY valor DESC`
  ).all(...paramsG, dia);

  // Quebra de caixa no dia
  const quebras = db.prepare(
    `SELECT codigo_loja, numero_caixa, operador_caixa, valor_diferenca_dinheiro AS diferenca
     FROM fechamentos_caixa
     WHERE data_caixa = ?${grupo ? ' AND conexao = ?' : ''}
       AND ABS(COALESCE(valor_diferenca_dinheiro, 0)) > 0
     ORDER BY ABS(valor_diferenca_dinheiro) DESC`
  ).all(dia, ...paramsG);

  const feriado = ehFeriado(dia);
  const resultado = {
    dia,
    dia_semana: NOMES_SEMANA[diaSemana],
    feriado: feriado ?? null,
    base: `${diaSemana === 0 || diaSemana === 6 ? 'mesmos' : 'mesmas'} ${NOMES_SEMANA[diaSemana]}s das últimas ${semanas} semanas`,
    anomalias: achados,
    cancelamentos: cancel,
    quebras_de_caixa: quebras,
  };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`ANOMALIAS — ${dmy(dia)} (${NOMES_SEMANA[diaSemana]})`);
  if (feriado) console.log(`Atenção: ${feriado} — comparações com dias normais distorcem.`);
  console.log(`Base de comparação: ${resultado.base}`);
  if (achados.length === 0) console.log('Nenhum desvio relevante de faturamento.');
  for (const a of achados) {
    console.log(`  loja ${a.loja} ${a.nome_loja ?? ''}: ${brl(a.valor)} — `
      + `${pct(Math.abs(a.variacao_pct))} ${a.sentido} do esperado (${brl(a.esperado)}), `
      + `${Math.abs(a.desvios)} desvios, amostra de ${a.amostra} dias`);
  }
  for (const c of cancel) {
    console.log(`  cancelamentos: ${c.operador ?? 'sem operador'} — ${c.qtd} venda(s), ${brl(c.valor)}`);
  }
  for (const q of quebras) {
    console.log(`  quebra de caixa: loja ${q.codigo_loja} caixa ${q.numero_caixa} `
      + `(${q.operador_caixa ?? '?'}) — ${brl(q.diferenca)}`);
  }
}

// ---------- 3. DECOMPOSIÇÃO DE VARIAÇÃO ----------

function variacao(db, args) {
  const { de, ate } = args;
  const contraDe = args['contra-de'];
  const contraAte = args['contra-ate'];
  if (!de || !ate || !contraDe || !contraAte) {
    console.error('Uso: analisar.mjs variacao --de A --ate B --contra-de C --contra-ate D [--grupo X]');
    process.exit(1);
  }
  const fG = args.grupo ? ' AND conexao = ?' : '';
  const pG = args.grupo ? [args.grupo] : [];

  const totais = (d1, d2) => db.prepare(
    `SELECT COUNT(*) AS cupons, COALESCE(SUM(valor_total), 0) AS faturamento
     FROM vendas WHERE cancelada = 0${fG} AND data_movimento BETWEEN ? AND ?`
  ).get(...pG, d1, d2);

  const atual = totais(de, ate);
  const anterior = totais(contraDe, contraAte);
  const ticket0 = anterior.cupons > 0 ? anterior.faturamento / anterior.cupons : 0;
  const ticket1 = atual.cupons > 0 ? atual.faturamento / atual.cupons : 0;
  const dCupons = atual.cupons - anterior.cupons;
  const dTicket = ticket1 - ticket0;

  // R = clientes x ticket  =>  ΔR = Δclientes·T0 + ΔT·N0 + Δclientes·ΔT
  const efeitoVolume = dCupons * ticket0;
  const efeitoTicket = dTicket * anterior.cupons;
  const efeitoCombinado = dCupons * dTicket;
  const dReceita = atual.faturamento - anterior.faturamento;

  const porDimensao = (coluna, tabela = 'vendas') => {
    const sql = tabela === 'vendas'
      ? `SELECT ${coluna} AS chave, COALESCE(SUM(CASE WHEN data_movimento BETWEEN ? AND ? THEN valor_total END), 0) AS atual,
                COALESCE(SUM(CASE WHEN data_movimento BETWEEN ? AND ? THEN valor_total END), 0) AS anterior
         FROM vendas WHERE cancelada = 0${fG} GROUP BY 1`
      : `SELECT i.${coluna} AS chave,
                COALESCE(SUM(CASE WHEN v.data_movimento BETWEEN ? AND ? THEN i.valor_total END), 0) AS atual,
                COALESCE(SUM(CASE WHEN v.data_movimento BETWEEN ? AND ? THEN i.valor_total END), 0) AS anterior
         FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
         WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)
         ${args.grupo ? ' AND v.conexao = ?' : ''} GROUP BY 1`;
    return db.prepare(sql).all(de, ate, contraDe, contraAte, ...pG)
      .map((r) => ({ chave: r.chave, atual: r.atual, anterior: r.anterior, delta: r.atual - r.anterior }))
      .filter((r) => Math.abs(r.delta) > 0.01)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  };

  const lojas = porDimensao('codigo_loja');
  const categorias = porDimensao('subgrupo', 'itens');

  const resultado = {
    periodo: { de, ate }, comparado_com: { de: contraDe, ate: contraAte },
    faturamento: { atual: atual.faturamento, anterior: anterior.faturamento, delta: dReceita,
      delta_pct: anterior.faturamento > 0 ? (dReceita / anterior.faturamento) * 100 : null },
    cupons: { atual: atual.cupons, anterior: anterior.cupons, delta: dCupons },
    ticket: { atual: ticket1, anterior: ticket0, delta: dTicket },
    decomposicao: {
      efeito_volume: efeitoVolume, efeito_ticket: efeitoTicket, efeito_combinado: efeitoCombinado,
    },
    por_loja: lojas.slice(0, 15),
    por_categoria: categorias.slice(0, 15),
  };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`POR QUE MUDOU — ${dmy(de)} a ${dmy(ate)} vs ${dmy(contraDe)} a ${dmy(contraAte)}`);
  console.log(`Faturamento: ${brl(anterior.faturamento)} -> ${brl(atual.faturamento)} `
    + `(${dReceita >= 0 ? '+' : ''}${brl(dReceita)}`
    + (anterior.faturamento > 0 ? `, ${pct((dReceita / anterior.faturamento) * 100)})` : ')'));
  console.log(`  clientes (cupons): ${anterior.cupons} -> ${atual.cupons} (${dCupons >= 0 ? '+' : ''}${dCupons})`);
  console.log(`  ticket médio: ${brl(ticket0)} -> ${brl(ticket1)} (${dTicket >= 0 ? '+' : ''}${brl(dTicket)})`);
  console.log('Decomposição da diferença:');
  console.log(`  por mudança no nº de clientes: ${efeitoVolume >= 0 ? '+' : ''}${brl(efeitoVolume)}`);
  console.log(`  por mudança no ticket médio:   ${efeitoTicket >= 0 ? '+' : ''}${brl(efeitoTicket)}`);
  console.log(`  efeito combinado:              ${efeitoCombinado >= 0 ? '+' : ''}${brl(efeitoCombinado)}`);
  if (lojas.length) {
    console.log('Quem puxou (lojas):');
    for (const l of lojas.slice(0, 8)) {
      console.log(`  loja ${l.chave}: ${l.delta >= 0 ? '+' : ''}${brl(l.delta)} `
        + `(${brl(l.anterior)} -> ${brl(l.atual)})`);
    }
  }
  if (categorias.length) {
    console.log('Quem puxou (categorias):');
    for (const c of categorias.slice(0, 8)) {
      console.log(`  ${c.chave ?? 'sem categoria'}: ${c.delta >= 0 ? '+' : ''}${brl(c.delta)}`);
    }
  }
}

// ---------- 4. BENCHMARK ENTRE LOJAS ----------

function benchmark(db, args) {
  const { de, ate } = args;
  if (!de || !ate) {
    console.error('Uso: analisar.mjs benchmark --de A --ate B [--grupo X]');
    process.exit(1);
  }
  const fG = args.grupo ? ' AND v.conexao = ?' : '';
  const pG = args.grupo ? [args.grupo] : [];

  const lojas = db.prepare(
    `SELECT v.codigo_loja AS loja, MAX(v.nome_loja) AS nome,
            COUNT(*) AS cupons,
            ROUND(SUM(v.valor_total), 2) AS faturamento,
            ROUND(SUM(v.valor_total) / COUNT(*), 2) AS ticket,
            ROUND(100.0 * SUM(v.valor_desconto) / NULLIF(SUM(v.valor_total + v.valor_desconto), 0), 2) AS pct_desconto
     FROM vendas v
     WHERE v.cancelada = 0${fG} AND v.data_movimento BETWEEN ? AND ?
     GROUP BY v.codigo_loja HAVING COUNT(*) >= 5 ORDER BY faturamento DESC`
  ).all(...pG, de, ate);
  if (lojas.length < 2) {
    console.log('Benchmark precisa de pelo menos duas lojas com movimento no período.');
    return;
  }

  // Itens por cupom e taxa de anexação de bebida, por loja.
  const extras = db.prepare(
    `SELECT v.codigo_loja AS loja,
            ROUND(1.0 * SUM(i.quantidade) / COUNT(DISTINCT v.chave_venda), 2) AS itens_por_cupom,
            ROUND(100.0 * COUNT(DISTINCT CASE WHEN i.grupo = 'BEBIDAS' THEN v.chave_venda END)
              / COUNT(DISTINCT v.chave_venda), 1) AS pct_com_bebida
     FROM vendas v JOIN venda_itens i ON i.chave_venda = v.chave_venda
     WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)${fG}
       AND v.data_movimento BETWEEN ? AND ?
     GROUP BY v.codigo_loja`
  ).all(...pG, de, ate);
  const mapaExtras = new Map(extras.map((e) => [e.loja, e]));
  for (const l of lojas) Object.assign(l, mapaExtras.get(l.loja) ?? {});

  const cancel = db.prepare(
    `SELECT codigo_loja AS loja, COUNT(*) AS canceladas
     FROM vendas WHERE cancelada = 1${args.grupo ? ' AND conexao = ?' : ''}
       AND data_movimento BETWEEN ? AND ? GROUP BY 1`
  ).all(...pG, de, ate);
  const mapaCancel = new Map(cancel.map((c) => [c.loja, c.canceladas]));
  for (const l of lojas) {
    l.canceladas = mapaCancel.get(l.loja) ?? 0;
    l.pct_cancelamento = Math.round(((100 * l.canceladas) / (l.cupons + l.canceladas)) * 10) / 10;
  }

  // Oportunidade: quanto cada loja ganharia com o ticket da melhor.
  const melhorTicket = Math.max(...lojas.map((l) => l.ticket ?? 0));
  const melhorBebida = Math.max(...lojas.map((l) => l.pct_com_bebida ?? 0));
  const refTicket = lojas.find((l) => l.ticket === melhorTicket);
  const refBebida = lojas.find((l) => l.pct_com_bebida === melhorBebida);
  const oportunidades = lojas
    .filter((l) => l.ticket < melhorTicket)
    .map((l) => ({
      loja: l.loja,
      nome: l.nome,
      ganho_se_ticket_do_melhor: Math.round((melhorTicket - l.ticket) * l.cupons * 100) / 100,
      ticket_atual: l.ticket,
      ticket_referencia: melhorTicket,
    }))
    .sort((a, b) => b.ganho_se_ticket_do_melhor - a.ganho_se_ticket_do_melhor);

  const resultado = {
    periodo: { de, ate },
    lojas,
    referencias: {
      melhor_ticket: refTicket ? { loja: refTicket.loja, valor: melhorTicket } : null,
      melhor_anexacao_bebida: refBebida ? { loja: refBebida.loja, valor: melhorBebida } : null,
    },
    oportunidades,
  };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`BENCHMARK ENTRE LOJAS — ${dmy(de)} a ${dmy(ate)}`);
  console.log('loja | cupons | faturamento | ticket | itens/cupom | % c/ bebida | % desc | % cancel');
  for (const l of lojas) {
    console.log(`${String(l.loja).padStart(4)} | ${String(l.cupons).padStart(6)} | `
      + `${brl(l.faturamento).padStart(12)} | ${brl(l.ticket).padStart(9)} | `
      + `${String(l.itens_por_cupom ?? '-').padStart(11)} | ${String(l.pct_com_bebida ?? '-').padStart(11)} | `
      + `${String(l.pct_desconto ?? 0).padStart(6)} | ${String(l.pct_cancelamento ?? 0).padStart(8)}`);
  }
  if (refTicket) console.log(`Melhor ticket: loja ${refTicket.loja} (${brl(melhorTicket)})`);
  if (refBebida) console.log(`Melhor anexação de bebida: loja ${refBebida.loja} (${pct(melhorBebida)})`);
  if (oportunidades.length) {
    console.log('Oportunidade (se cada loja tivesse o ticket da melhor):');
    for (const o of oportunidades.slice(0, 10)) {
      console.log(`  loja ${o.loja}: +${brl(o.ganho_se_ticket_do_melhor)} no período `
        + `(ticket ${brl(o.ticket_atual)} para ${brl(o.ticket_referencia)})`);
    }
  }
}

// ---------- 5. CESTA DE COMPRAS ----------

function cesta(db, args) {
  const { de, ate } = args;
  if (!de || !ate) {
    console.error('Uso: analisar.mjs cesta --de A --ate B [--grupo X] [--minimo 20]');
    process.exit(1);
  }
  const minimo = Number(args.minimo ?? 20);
  const fG = args.grupo ? ' AND v.conexao = ?' : '';
  const pG = args.grupo ? [args.grupo] : [];

  const totalCupons = db.prepare(
    `SELECT COUNT(DISTINCT v.chave_venda) AS n FROM vendas v
     WHERE v.cancelada = 0${fG} AND v.data_movimento BETWEEN ? AND ?`
  ).get(...pG, de, ate)?.n ?? 0;
  if (totalCupons < minimo) {
    console.log(`Poucos cupons no período (${totalCupons}) para análise de cesta confiável. `
      + `Mínimo sugerido: ${minimo}.`);
    return;
  }

  // Coocorrência entre CATEGORIAS (subgrupo): mais estável que produto a produto.
  const pares = db.prepare(
    `WITH cat AS (
       SELECT DISTINCT v.chave_venda AS cupom, i.subgrupo AS categoria
       FROM vendas v JOIN venda_itens i ON i.chave_venda = v.chave_venda
       WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)
         AND i.subgrupo IS NOT NULL AND i.subgrupo <> ''${fG}
         AND v.data_movimento BETWEEN ? AND ?)
     SELECT a.categoria AS categoria_a, b.categoria AS categoria_b, COUNT(*) AS juntos
     FROM cat a JOIN cat b ON a.cupom = b.cupom AND a.categoria < b.categoria
     GROUP BY 1, 2 HAVING COUNT(*) >= 3 ORDER BY juntos DESC LIMIT 20`
  ).all(...pG, de, ate);

  const frequencia = db.prepare(
    `SELECT i.subgrupo AS categoria, COUNT(DISTINCT v.chave_venda) AS cupons,
            ROUND(AVG(i.valor_total), 2) AS valor_medio
     FROM vendas v JOIN venda_itens i ON i.chave_venda = v.chave_venda
     WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)
       AND i.subgrupo IS NOT NULL AND i.subgrupo <> ''${fG}
       AND v.data_movimento BETWEEN ? AND ?
     GROUP BY 1 ORDER BY cupons DESC`
  ).all(...pG, de, ate);
  const mapaFreq = new Map(frequencia.map((f) => [f.categoria, f]));

  const regras = pares.map((p) => {
    const a = mapaFreq.get(p.categoria_a);
    const b = mapaFreq.get(p.categoria_b);
    return {
      de: p.categoria_a,
      para: p.categoria_b,
      juntos: p.juntos,
      suporte_pct: Math.round(((100 * p.juntos) / totalCupons) * 10) / 10,
      confianca_a_para_b: a ? Math.round((100 * p.juntos) / a.cupons) : null,
      confianca_b_para_a: b ? Math.round((100 * p.juntos) / b.cupons) : null,
    };
  });

  // Oportunidade: quanto vale subir 10 pontos de penetração de cada categoria.
  // So projeta oportunidade de categoria com presenca minima: extrapolar
  // 10 pontos percentuais a partir de 1 ou 2 cupons produz numero bonito e falso.
  const MIN_CUPONS_CATEGORIA = 5;
  const oportunidades = frequencia
    .filter((f) => f.cupons < totalCupons && f.cupons >= MIN_CUPONS_CATEGORIA)
    .map((f) => ({
      categoria: f.categoria,
      cupons_sem: totalCupons - f.cupons,
      penetracao_pct: Math.round((100 * f.cupons) / totalCupons),
      valor_medio: f.valor_medio,
      potencial_10pp: Math.round(totalCupons * 0.1 * f.valor_medio * 100) / 100,
    }))
    .sort((a, b) => b.potencial_10pp - a.potencial_10pp);

  const resultado = { periodo: { de, ate }, total_cupons: totalCupons, regras, oportunidades };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`CESTA DE COMPRAS — ${dmy(de)} a ${dmy(ate)} (${totalCupons} cupons)`);
  if (totalCupons < 100) {
    console.log('ATENCAO: amostra pequena - trate como indicio, nao como conclusao.');
  }
  if (regras.length === 0) console.log('Nenhuma combinação recorrente encontrada.');
  for (const r of regras.slice(0, 10)) {
    console.log(`  ${r.de} + ${r.para}: ${r.juntos} cupons (${pct(r.suporte_pct)} do total). `
      + `Quem leva ${r.de} leva ${r.para} em ${r.confianca_a_para_b}% das vezes.`);
  }
  if (oportunidades.length === 0) {
    console.log('Nenhuma categoria com presenca suficiente para estimar oportunidade.');
  } else {
    console.log('Onde ha espaco para venda sugestiva (estimativa se subir 10 pontos de penetracao):');
  }
  for (const o of oportunidades.slice(0, 8)) {
    console.log(`  ${o.categoria}: está em ${o.penetracao_pct}% dos cupons `
      + `(${o.cupons_sem} sem). Mais 10 pontos valeriam ${brl(o.potencial_10pp)} no período.`);
  }
}

// ---------- 6. SIMULAÇÃO DE CENÁRIO ----------

function simular(db, args) {
  const variacaoPreco = Number(args.variacao ?? 5);
  const fG = args.grupo ? ' AND v.conexao = ?' : '';
  const pG = args.grupo ? [args.grupo] : [];
  const de = args.de ?? '0000-01-01';
  const ate = args.ate ?? '9999-12-31';
  const filtroProduto = args.produto ? ' AND i.codigo_produto = ?' : '';
  const pProduto = args.produto ? [Number(args.produto)] : [];

  const itens = db.prepare(
    `SELECT i.codigo_produto AS codigo, MAX(i.nome_produto) AS nome,
            SUM(i.quantidade) AS quantidade,
            SUM(i.valor_total) AS receita,
            SUM(i.quantidade * i.preco_compra) AS custo,
            ROUND(SUM(i.valor_total) / NULLIF(SUM(i.quantidade), 0), 2) AS preco_medio
     FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
     WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)
       ${filtroProduto}${fG} AND v.data_movimento BETWEEN ? AND ?
     GROUP BY i.codigo_produto HAVING SUM(i.quantidade) > 0
     ORDER BY receita DESC LIMIT ?`
  ).all(...pProduto, ...pG, de, ate, args.produto ? 1 : 10);

  if (itens.length === 0) { console.log('Nenhum item com venda no período.'); return; }

  // Sem histórico de mudança de preço não dá para estimar elasticidade real:
  // projetamos três cenários de sensibilidade e deixamos a incerteza explícita.
  const cenarios = [
    { nome: 'conservador', elasticidade: -1.5 },
    { nome: 'provável', elasticidade: -0.8 },
    { nome: 'otimista', elasticidade: -0.3 },
  ];

  const simulados = itens.map((it) => {
    const margemAtual = it.custo > 0 ? it.receita - it.custo : null;
    const custoUnit = it.quantidade > 0 ? it.custo / it.quantidade : 0;
    const projecoes = cenarios.map((c) => {
      const variacaoQtd = (c.elasticidade * variacaoPreco) / 100;
      const novaQtd = it.quantidade * (1 + variacaoQtd);
      const novoPreco = it.preco_medio * (1 + variacaoPreco / 100);
      const novaReceita = novaQtd * novoPreco;
      const novaMargem = it.custo > 0 ? novaReceita - novaQtd * custoUnit : null;
      return {
        cenario: c.nome,
        elasticidade: c.elasticidade,
        variacao_quantidade_pct: Math.round(variacaoQtd * 1000) / 10,
        receita: Math.round(novaReceita * 100) / 100,
        delta_receita: Math.round((novaReceita - it.receita) * 100) / 100,
        margem: novaMargem === null ? null : Math.round(novaMargem * 100) / 100,
        delta_margem: novaMargem === null ? null : Math.round((novaMargem - margemAtual) * 100) / 100,
      };
    });
    return {
      codigo: it.codigo,
      nome: it.nome,
      preco_medio: it.preco_medio,
      quantidade: it.quantidade,
      receita: Math.round(it.receita * 100) / 100,
      margem_atual: margemAtual === null ? null : Math.round(margemAtual * 100) / 100,
      tem_custo: it.custo > 0,
      projecoes,
    };
  });

  const resultado = { variacao_preco_pct: variacaoPreco, periodo: { de, ate }, itens: simulados };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`SIMULAÇÃO — preço ${variacaoPreco >= 0 ? '+' : ''}${variacaoPreco}%`);
  console.log('A reação do cliente é estimada em três cenários; não é previsão exata.');
  for (const s of simulados) {
    console.log(`${s.nome} (cód. ${s.codigo}) — preço médio ${brl(s.preco_medio)}, `
      + `${s.quantidade} unidades, receita ${brl(s.receita)}`
      + (s.tem_custo ? `, margem ${brl(s.margem_atual)}` : ', SEM custo cadastrado'));
    for (const p of s.projecoes) {
      console.log(`  ${p.cenario.padEnd(12)}: quantidade ${p.variacao_quantidade_pct >= 0 ? '+' : ''}`
        + `${p.variacao_quantidade_pct}% -> receita ${p.delta_receita >= 0 ? '+' : ''}${brl(p.delta_receita)}`
        + (p.delta_margem === null ? '' : `, margem ${p.delta_margem >= 0 ? '+' : ''}${brl(p.delta_margem)}`));
    }
  }
}

// ---------- 10. AUDITORIA FISCAL ----------
// Cadastro fiscal errado passa despercebido por meses no PDV e vira risco de
// autuação. Aqui varremos o que foi efetivamente tributado em cada item
// vendido e comparamos com o cadastro do produto e com o próprio cálculo.

function fiscal(db, args) {
  const de = args.de ?? '0000-01-01';
  const ate = args.ate ?? '9999-12-31';
  const fG = args.grupo ? ' AND v.conexao = ?' : '';
  const pG = args.grupo ? [args.grupo] : [];
  const base = `FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
    WHERE v.cancelada = 0 AND i.status = 1${fG} AND v.data_movimento BETWEEN ? AND ?`;

  const total = db.prepare(`SELECT COUNT(*) AS itens, COUNT(DISTINCT i.codigo_produto) AS produtos,
    SUM(CASE WHEN i.ncm IS NULL OR i.ncm = '' THEN 1 ELSE 0 END) AS sem_ncm,
    SUM(CASE WHEN i.ibscbs_cst IS NOT NULL THEN 1 ELSE 0 END) AS com_ibscbs
    ${base}`).get(...pG, de, ate);
  if (!total || total.itens === 0) {
    console.log('Nenhum item vendido no período (ou dados fiscais ainda não extraídos).');
    return;
  }

  // 1) NCM genérico: o mesmo código cobrindo categorias muito diferentes é o
  // sintoma clássico de cadastro feito "no atacado".
  const ncmAmplo = db.prepare(`SELECT i.ncm, COUNT(DISTINCT i.subgrupo) AS categorias,
    COUNT(*) AS itens, GROUP_CONCAT(DISTINCT i.subgrupo) AS lista
    ${base} AND i.ncm IS NOT NULL AND i.ncm <> ''
    GROUP BY i.ncm HAVING COUNT(DISTINCT i.subgrupo) >= 3 ORDER BY categorias DESC`)
    .all(...pG, de, ate);

  // 2) Taxas (serviço/entrega) tributadas como mercadoria.
  const taxasTributadas = db.prepare(`SELECT i.codigo_produto, MAX(i.nome_produto) AS nome,
    MAX(i.ncm) AS ncm, MAX(i.cfop) AS cfop, COUNT(*) AS ocorrencias
    ${base} AND i.codigo_produto IN (997, 999)
      AND (i.ncm IS NOT NULL AND i.ncm <> '' OR i.cfop IS NOT NULL AND i.cfop <> '')
    GROUP BY i.codigo_produto`).all(...pG, de, ate);

  // 3) Divergência entre o cadastro do produto e o que a venda tributou.
  const divergencias = db.prepare(`SELECT i.codigo_produto, MAX(i.nome_produto) AS nome,
      MAX(i.ncm) AS ncm_venda, MAX(p.ncm) AS ncm_cadastro,
      MAX(i.cfop) AS cfop_venda, MAX(p.cfop_venda) AS cfop_cadastro,
      MAX(i.csosn) AS csosn_venda, MAX(p.csosn_venda) AS csosn_cadastro,
      COUNT(*) AS ocorrencias
    FROM venda_itens i
    JOIN vendas v ON v.chave_venda = i.chave_venda
    JOIN produtos p ON p.codigo = i.codigo_produto AND p.conexao = i.conexao
    WHERE v.cancelada = 0 AND i.status = 1${fG} AND v.data_movimento BETWEEN ? AND ?
    GROUP BY i.codigo_produto
    HAVING (ncm_cadastro IS NOT NULL AND ncm_venda IS NOT NULL AND ncm_cadastro <> ncm_venda)
        OR (cfop_cadastro IS NOT NULL AND cfop_cadastro <> '' AND cfop_venda IS NOT NULL AND cfop_cadastro <> cfop_venda)
        OR (csosn_cadastro IS NOT NULL AND csosn_cadastro <> '' AND csosn_venda IS NOT NULL AND csosn_cadastro <> csosn_venda)
    ORDER BY ocorrencias DESC LIMIT 20`).all(...pG, de, ate);

  // 4) Conferência de cálculo: base x alíquota tem de bater com o valor.
  const erroCalculo = db.prepare(`SELECT 'ICMS' AS imposto, i.codigo_produto,
      MAX(i.nome_produto) AS nome, COUNT(*) AS ocorrencias,
      ROUND(SUM(ABS(i.icms_base * i.icms_aliquota / 100.0 - i.icms_valor)), 2) AS diferenca
    ${base} AND i.icms_aliquota > 0 AND i.icms_base > 0
      AND ABS(i.icms_base * i.icms_aliquota / 100.0 - i.icms_valor) > 0.01
    GROUP BY i.codigo_produto
    UNION ALL
    SELECT 'PIS', i.codigo_produto, MAX(i.nome_produto), COUNT(*),
      ROUND(SUM(ABS(i.pis_base * i.pis_aliquota / 100.0 - i.pis_valor)), 2)
    ${base} AND i.pis_aliquota > 0 AND i.pis_base > 0
      AND ABS(i.pis_base * i.pis_aliquota / 100.0 - i.pis_valor) > 0.01
    GROUP BY i.codigo_produto
    ORDER BY diferenca DESC LIMIT 20`).all(...pG, de, ate, ...pG, de, ate);

  // 5) Carga tributária efetiva por categoria.
  const carga = db.prepare(`SELECT i.subgrupo AS categoria,
    ROUND(SUM(i.valor_total), 2) AS receita,
    ROUND(SUM(COALESCE(i.icms_valor,0) + COALESCE(i.pis_valor,0) + COALESCE(i.cofins_valor,0)), 2) AS tributos,
    ROUND(100.0 * SUM(COALESCE(i.icms_valor,0) + COALESCE(i.pis_valor,0) + COALESCE(i.cofins_valor,0))
      / NULLIF(SUM(i.valor_total), 0), 2) AS carga_pct
    ${base} AND i.codigo_produto NOT IN (997, 999)
    GROUP BY i.subgrupo HAVING receita > 0 ORDER BY carga_pct DESC`).all(...pG, de, ate);

  // 6) Reforma tributária: o bloco IBS/CBS está vindo preenchido?
  const reforma = db.prepare(`SELECT COUNT(*) AS itens,
    SUM(CASE WHEN i.ibscbs_cst IS NULL OR i.ibscbs_cst = '' THEN 1 ELSE 0 END) AS sem_cst,
    SUM(CASE WHEN i.ibscbs_classtrib IS NULL OR i.ibscbs_classtrib = '' THEN 1 ELSE 0 END) AS sem_classtrib,
    ROUND(SUM(COALESCE(i.cbs_valor,0)), 2) AS cbs,
    ROUND(SUM(COALESCE(i.ibs_uf_valor,0) + COALESCE(i.ibs_mun_valor,0)), 2) AS ibs
    ${base}`).get(...pG, de, ate);

  const resultado = { periodo: { de, ate }, total, ncm_amplo: ncmAmplo,
    taxas_tributadas: taxasTributadas, divergencias, erro_calculo: erroCalculo,
    carga_por_categoria: carga, reforma };
  if (args.json) { console.log(JSON.stringify(resultado, null, 2)); return; }

  console.log(`AUDITORIA FISCAL — ${dmy(de)} a ${dmy(ate)}`);
  console.log(`${total.itens} itens vendidos, ${total.produtos} produtos distintos.`);

  if (total.sem_ncm > 0) {
    console.log(`[GRAVE] ${total.sem_ncm} itens vendidos SEM NCM — impede tributação correta.`);
  }
  for (const n of ncmAmplo) {
    console.log(`[atenção] NCM ${n.ncm} usado em ${n.categorias} categorias diferentes `
      + `(${n.itens} itens): ${String(n.lista).slice(0, 80)}. `
      + 'Um mesmo NCM cobrindo produtos distintos costuma ser cadastro genérico.');
  }
  for (const t of taxasTributadas) {
    console.log(`[GRAVE] ${t.nome} (cód. ${t.codigo_produto}) está sendo tributado como mercadoria `
      + `(NCM ${t.ncm ?? '-'}, CFOP ${t.cfop ?? '-'}) em ${t.ocorrencias} itens — `
      + 'taxa de serviço/entrega não é mercadoria.');
  }
  for (const d of divergencias) {
    const partes = [];
    if (d.ncm_cadastro !== d.ncm_venda) partes.push(`NCM ${d.ncm_cadastro} no cadastro x ${d.ncm_venda} na venda`);
    if (d.cfop_cadastro && d.cfop_cadastro !== d.cfop_venda) partes.push(`CFOP ${d.cfop_cadastro} x ${d.cfop_venda}`);
    if (d.csosn_cadastro && d.csosn_cadastro !== d.csosn_venda) partes.push(`CSOSN ${d.csosn_cadastro} x ${d.csosn_venda}`);
    if (partes.length) {
      console.log(`[atenção] ${d.nome} (cód. ${d.codigo_produto}): ${partes.join('; ')} `
        + `(${d.ocorrencias} itens).`);
    }
  }
  for (const e of erroCalculo) {
    console.log(`[GRAVE] ${e.imposto} de ${e.nome} (cód. ${e.codigo_produto}): base x alíquota `
      + `não bate com o valor em ${e.ocorrencias} itens (diferença de ${brl(e.diferenca)}).`);
  }
  // Regime: no Simples Nacional o documento traz CSOSN e os tributos nao vem
  // destacados (estao no recolhimento unificado). Carga zerada ali e normal —
  // apontar como erro seria alarme falso.
  const regime = db.prepare(`SELECT
      SUM(CASE WHEN i.csosn IS NOT NULL AND i.csosn <> '' THEN 1 ELSE 0 END) AS com_csosn,
      SUM(CASE WHEN i.cst IS NOT NULL AND i.cst <> '' THEN 1 ELSE 0 END) AS com_cst
    ${base}`).get(...pG, de, ate);
  const ehSimples = (regime?.com_csosn ?? 0) > (regime?.com_cst ?? 0);
  if (ehSimples) {
    console.log('Regime detectado: Simples Nacional (documentos com CSOSN). '
      + 'Os tributos não vêm destacados no cupom, então a carga abaixo aparece zerada — '
      + 'isso é esperado, não é erro.');
  }
  if (carga.length) {
    console.log('Carga tributária efetiva por categoria (ICMS + PIS + COFINS sobre a receita):');
    for (const c of carga.slice(0, 10)) {
      console.log(`  ${(c.categoria ?? 'sem categoria').padEnd(24)} ${String(c.carga_pct ?? 0).padStart(6)}% `
        + `(${brl(c.tributos)} de ${brl(c.receita)})`);
    }
  }
  const pctReforma = Math.round((100 * (reforma.itens - reforma.sem_cst)) / Math.max(reforma.itens, 1));
  console.log(`Reforma tributária (IBS/CBS): ${pctReforma}% dos itens com CST preenchido; `
    + `CBS apurado ${brl(reforma.cbs)}, IBS ${brl(reforma.ibs)}.`);
  if (reforma.sem_cst > 0) {
    console.log(`[atenção] ${reforma.sem_cst} itens sem CST de IBS/CBS — verifique a versão do PDV `
      + 'e o cadastro, porque a emissão já deveria trazer esses campos.');
  }
}

// ---------- execução ----------

const acao = process.argv[2];
const args = lerArgs();
const db = abrirBanco({ somenteLeitura: true });
try {
  if (acao === 'qualidade') qualidade(db, args);
  else if (acao === 'completude') completude(db, args);
  else if (acao === 'cmv') cmv(db, args);
  else if (acao === 'anomalias') anomalias(db, args);
  else if (acao === 'variacao') variacao(db, args);
  else if (acao === 'benchmark') benchmark(db, args);
  else if (acao === 'cesta') cesta(db, args);
  else if (acao === 'simular') simular(db, args);
  else if (acao === 'fiscal') fiscal(db, args);
  else {
    console.error('Ação inválida. Use: qualidade | completude | cmv | anomalias | variacao | benchmark | cesta | simular | fiscal');
    process.exitCode = 1;
  }
} finally {
  db.close();
}
