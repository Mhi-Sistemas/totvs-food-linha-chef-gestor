// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// DRE gerencial em HTML dinamico, com DOIS seletores na propria tela:
//
// VISAO (o ritual do gestor):
//   - MENSAL (padrao): o mes anterior FECHADO, lado a lado com o mes antes
//     dele e a variacao % — e assim que gestor analisa resultado.
//   - ANUAL: os ultimos 12 meses em colunas + Total + % sobre a base.
//
// REGIME (o criterio do gestor):
//   - COMPETENCIA: receitas = vendas por data de movimento; impostos sobre a
//     venda = ICMS+PIS+COFINS efetivos por cupom; CMV teorico = ficha tecnica
//     x custo; despesas = contas a pagar pela DATA DE COMPETENCIA (fallback:
//     emissao), pagas ou nao.
//   - CAIXA: entradas e saidas do LIVRO CAIXA pela data de lancamento — e o
//     caixa de fato, e evita dupla contagem (a baixa da conta a pagar gera
//     lancamento no livro).
//
// Linhas montadas pelo PLANO DE CONTAS do proprio gestor (plano 1 expansivel
// em plano 2). Cobertura: % do valor classificado — o quanto os lancamentos
// permitem confiar. E gerencial: sem depreciacao, nao substitui a peca
// contabil (o rodape avisa).
//
// Uso:
//   node --no-warnings scripts/dre.mjs gerar [--mes AAAA-MM] [--grupo <id>]
//        [--saida relatorios/dre.html] [--abrir]
//   (--mes padrao: o mes anterior ao atual)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { abrirBanco } from './criar-banco.mjs';
import { calcularCmv, fonteCmvDaDre, gravarPreferencia, FONTES_CMV, ROTULO_CMV } from './cmv.mjs';
import { conferirTodos, ressalvaImpressa } from './completude.mjs';
import { carregarConexoes } from './conexoes.mjs';
import { abrirNoSistema } from './plataforma.mjs';
import { carregarIdentidade } from './identidade.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function listaMeses(de, ate) {
  const meses = [];
  let [a, m] = de.split('-').map(Number);
  const [aF, mF] = ate.split('-').map(Number);
  while (a < aF || (a === aF && m <= mF)) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; a += 1; }
  }
  return meses;
}

const MES_NOME = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (am) => `${MES_NOME[Number(am.slice(5)) - 1]}/${am.slice(2, 4)}`;

// Executa uma soma por mes e devolve o vetor alinhado a `meses`.
function porMes(db, meses, sql, parametros = []) {
  const linhas = db.prepare(sql).all(...parametros);
  const mapa = new Map(linhas.map((l) => [l.mes, l.total ?? 0]));
  return meses.map((m) => mapa.get(m) ?? 0);
}

function somar(vetor) { return vetor.reduce((s, v) => s + (v ?? 0), 0); }
function subtrair(a, b) { return a.map((v, i) => (v ?? 0) - (b[i] ?? 0)); }

// ---------------------------------------------------------------------------
// Calculo dos dois regimes
// ---------------------------------------------------------------------------

function linhasDespesasPorPlano(db, meses, sqlBase, parametros) {
  // sqlBase deve devolver: mes, plano1, plano2, total
  const brutas = db.prepare(sqlBase).all(...parametros);
  const arvore = new Map();
  for (const l of brutas) {
    const p1 = l.plano1 || 'SEM CLASSIFICAÇÃO';
    const p2 = l.plano2 || '(sem detalhe)';
    if (!arvore.has(p1)) arvore.set(p1, new Map());
    const filhos = arvore.get(p1);
    if (!filhos.has(p2)) filhos.set(p2, meses.map(() => 0));
    filhos.get(p2)[meses.indexOf(l.mes)] += l.total ?? 0;
  }
  const grupos = [];
  for (const [p1, filhos] of [...arvore.entries()].sort((a, b) => somar([...b[1].values()].flat()) - somar([...a[1].values()].flat()))) {
    const detalhes = [...filhos.entries()]
      .map(([p2, valores]) => ({ rotulo: p2, valores }))
      .sort((a, b) => somar(b.valores) - somar(a.valores));
    const valores = meses.map((_, i) => detalhes.reduce((s, d) => s + d.valores[i], 0));
    grupos.push({ rotulo: p1, valores, detalhes });
  }
  return grupos;
}

// CMV do mes na fonte que o GESTOR escolheu. Quando a escolhida nao existe
// naquele mes — tipicamente o real, que precisa de estoque nas duas pontas e
// so passa a existir depois da instalacao — recua para o teorico e REGISTRA o
// recuo, para a nota da DRE dizer ao gestor o que aconteceu. Zerar a linha
// seria pior: inflaria o lucro bruto sem avisar.
function cmvDoMes(db, fonte, mes, grupo) {
  const de = `${mes}-01`;
  const ate = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  const conexoes = grupo
    ? [grupo]
    : db.prepare('SELECT DISTINCT conexao FROM vendas ORDER BY conexao').all().map((r) => r.conexao);

  let total = 0;
  let recuou = false;
  for (const cx of conexoes) {
    const r = calcularCmv(db, fonte, cx, de, ate, null);
    if (r.valor === null) {
      recuou = true;
      total += calcularCmv(db, 'teorico', cx, de, ate, null).valor ?? 0;
    } else {
      total += r.valor;
    }
  }
  return { valor: total, recuou };
}

function calcularCompetencia(db, meses, grupo, fonteCmv = 'teorico') {
  const fG = grupo ? ' AND conexao = ?' : '';
  const pG = grupo ? [grupo] : [];
  const fGv = grupo ? ' AND v.conexao = ?' : '';

  const receita = porMes(db, meses, `SELECT substr(data_movimento,1,7) AS mes, SUM(valor_total) AS total
    FROM vendas WHERE cancelada = 0${fG} AND substr(data_movimento,1,7) BETWEEN ? AND ? GROUP BY 1`, [...pG, meses[0], meses.at(-1)]);
  const impostos = porMes(db, meses, `SELECT substr(data_movimento,1,7) AS mes,
      SUM(COALESCE(json_extract(json_original,'$.TotalizadorVenda.ValorTotalICMS'),0)
        + COALESCE(json_extract(json_original,'$.TotalizadorVenda.ValorTotalPIS'),0)
        + COALESCE(json_extract(json_original,'$.TotalizadorVenda.ValorTotalCOFINS'),0)) AS total
    FROM vendas WHERE cancelada = 0${fG} AND substr(data_movimento,1,7) BETWEEN ? AND ? GROUP BY 1`, [...pG, meses[0], meses.at(-1)]);
  const cmvMeses = meses.map((m) => cmvDoMes(db, fonteCmv, m, grupo));
  const cmv = cmvMeses.map((c) => c.valor);
  const mesesQueRecuaram = meses.filter((_, i) => cmvMeses[i].recuou);

  // Compra de mercadoria NAO entra nas despesas operacionais: o custo dela ja
  // e a linha de CMV, logo acima. Contar nos dois lugares subtrai o mesmo
  // dinheiro duas vezes e afunda o resultado — era o que acontecia (R$ 5.577
  // em um unico mes na base de validacao). No regime de CAIXA nao se exclui:
  // la nao ha linha de CMV, e a saida de dinheiro para comprar mercadoria e
  // uma saida de caixa como qualquer outra.
  const semMercadoria = `AND NOT EXISTS (SELECT 1 FROM plano_categorias pc
        WHERE pc.categoria = 'mercadoria'
          AND pc.plano1 = COALESCE(contas_pagar.plano_contas1, '')
          AND (pc.plano2 = '*' OR pc.plano2 = COALESCE(contas_pagar.plano_contas2, '')))`;
  const grupos = linhasDespesasPorPlano(db, meses, `SELECT substr(COALESCE(data_competencia, data_emissao),1,7) AS mes,
      plano_contas1 AS plano1, plano_contas2 AS plano2, SUM(valor) AS total
    FROM contas_pagar WHERE COALESCE(deletado, 0) = 0 AND substr(COALESCE(data_competencia, data_emissao),1,7) BETWEEN ? AND ?${fG}
      ${semMercadoria}
    GROUP BY 1,2,3`, [meses[0], meses.at(-1), ...pG]);
  const despesas = meses.map((_, i) => grupos.reduce((s, g) => s + g.valores[i], 0));

  const cobertura = db.prepare(`SELECT SUM(CASE WHEN plano_contas1 IS NOT NULL AND plano_contas1 != '' THEN valor ELSE 0 END) AS com, SUM(valor) AS total
    FROM contas_pagar WHERE COALESCE(deletado, 0) = 0 AND substr(COALESCE(data_competencia, data_emissao),1,7) BETWEEN ? AND ?${fG}`).get(meses[0], meses.at(-1), ...pG);

  const receitaLiquida = subtrair(receita, impostos);
  const lucroBruto = subtrair(receitaLiquida, cmv);
  const resultado = subtrair(lucroBruto, despesas);
  return {
    base: receitaLiquida,
    cobertura: cobertura?.total ? (cobertura.com / cobertura.total) * 100 : null,
    nota: 'Receitas por data de movimento; despesas por competência (contas a pagar, pagas ou não); '
      + `impostos efetivos por cupom; ${ROTULO_CMV[fonteCmv]}.`
      + (mesesQueRecuaram.length > 0
        ? ` Em ${mesesQueRecuaram.map(rotuloMes).join(', ')} não havia como apurar o CMV escolhido `
          + '(falta posição de estoque ou plano de contas marcado), então esses meses usam o CMV teórico.'
        : ''),
    linhas: [
      { id: 'rb', tipo: 'total', rotulo: 'RECEITA BRUTA DE VENDAS', valores: receita },
      { id: 'imp', tipo: 'deducao', rotulo: '(−) Impostos sobre vendas', valores: impostos.map((v) => -v) },
      { id: 'rl', tipo: 'total', rotulo: '= RECEITA LÍQUIDA', valores: receitaLiquida },
      { id: 'cmv', tipo: 'deducao', rotulo: `(−) ${ROTULO_CMV[fonteCmv]}`, valores: cmv.map((v) => -v) },
      { id: 'lb', tipo: 'total', rotulo: '= LUCRO BRUTO', valores: lucroBruto },
      { id: 'dsp', tipo: 'secao', rotulo: '(−) DESPESAS OPERACIONAIS', valores: despesas.map((v) => -v), grupos },
      { id: 'res', tipo: 'resultado', rotulo: '= RESULTADO OPERACIONAL', valores: resultado },
    ],
  };
}

function calcularCaixa(db, meses, grupo) {
  const fG = grupo ? ' AND conexao = ?' : '';
  const pG = grupo ? [grupo] : [];
  const dataCx = 'COALESCE(data_lancamento, data)';

  const gruposEntrada = linhasDespesasPorPlano(db, meses, `SELECT substr(${dataCx},1,7) AS mes,
      plano_contas1 AS plano1, plano_contas2 AS plano2, SUM(valor) AS total
    FROM livro_caixa WHERE tipo = 'entrada' AND substr(${dataCx},1,7) BETWEEN ? AND ?${fG} GROUP BY 1,2,3`, [meses[0], meses.at(-1), ...pG]);
  const gruposSaida = linhasDespesasPorPlano(db, meses, `SELECT substr(${dataCx},1,7) AS mes,
      plano_contas1 AS plano1, plano_contas2 AS plano2, SUM(valor) AS total
    FROM livro_caixa WHERE tipo = 'saida' AND substr(${dataCx},1,7) BETWEEN ? AND ?${fG} GROUP BY 1,2,3`, [meses[0], meses.at(-1), ...pG]);

  const entradas = meses.map((_, i) => gruposEntrada.reduce((s, g) => s + g.valores[i], 0));
  const saidas = meses.map((_, i) => gruposSaida.reduce((s, g) => s + g.valores[i], 0));
  const resultado = subtrair(entradas, saidas);

  const cobertura = db.prepare(`SELECT SUM(CASE WHEN plano_contas1 IS NOT NULL AND plano_contas1 != '' THEN valor ELSE 0 END) AS com, SUM(valor) AS total
    FROM livro_caixa WHERE tipo = 'saida' AND substr(${dataCx},1,7) BETWEEN ? AND ?${fG}`).get(meses[0], meses.at(-1), ...pG);

  return {
    base: entradas,
    cobertura: cobertura?.total ? (cobertura.com / cobertura.total) * 100 : null,
    nota: 'Entradas e saídas do livro caixa pela data de lançamento — o dinheiro que de fato entrou e saiu. Contas a pagar não entram aqui (a baixa delas já vira lançamento no livro).',
    linhas: [
      { id: 'ent', tipo: 'secao', rotulo: 'ENTRADAS DE CAIXA', valores: entradas, grupos: gruposEntrada },
      { id: 'sai', tipo: 'secao', rotulo: '(−) SAÍDAS DE CAIXA', valores: saidas.map((v) => -v), grupos: gruposSaida },
      { id: 'res', tipo: 'resultado', rotulo: '= GERAÇÃO DE CAIXA', valores: resultado },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTML — visual de app financeiro, nao de planilha:
//   heroi com o resultado + grafico cascata; linhas da demonstracao com barra
//   de proporcao e chip de variacao; sparklines na visao anual em vez de
//   colunas de numeros. ECharts embutido (offline).
// ---------------------------------------------------------------------------

function gerarHtml({ titulo, visoes, grupoRotulo, ressalva = null }) {
  const agora = new Date();
  const echarts = readFileSync(join(RAIZ, 'assets', 'echarts.min.js'), 'utf8');
  const identidade = carregarIdentidade();
  const logo = identidade.logoDataUri ?? '';
  const carimbo = `${grupoRotulo ? `${grupoRotulo} · ` : ''}gerado em ${agora.toLocaleDateString('pt-BR')} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  const dadosJson = JSON.stringify({ visoes }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="author" content="MHI Sistemas">
<title>${esc(titulo)}</title>
<style>
  :root{--navy:${identidade.cabecalho};--ambar:${identidade.destaque};--tinta:#1e293b;--tinta2:#64748b;--fundo:#f4f6f8;--grade:#e8edf2;--pos:#047857;--neg:#b91c1c;--azul:#2563eb}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--fundo);margin:0;color:var(--tinta)}
  header{background:var(--navy);color:#fff;padding:18px 28px;display:flex;align-items:center;gap:16px}
  header img{height:40px}
  header h1{font-size:19px;margin:0;font-weight:650}
  header .carimbo{margin-left:auto;font-size:12.5px;opacity:.75;text-align:right}
  .ressalva{margin:0;padding:12px 22px;background:#fff4e5;color:#7a4a00;border-bottom:1px solid #f0d9b5;font-size:13.5px;line-height:1.5}
  main{max-width:1020px;margin:0 auto;padding:22px 20px 8px}
  .barra{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  .pills{display:flex;background:#e5eaf0;border-radius:12px;padding:3px}
  .pills button{border:0;background:none;padding:9px 16px;border-radius:9px;font-size:13.5px;font-weight:600;color:var(--tinta2);cursor:pointer;white-space:nowrap}
  .pills button.ativo{background:#fff;color:var(--navy);box-shadow:0 1px 3px rgba(2,32,51,.15)}
  .cobertura{font-size:12.5px;color:var(--tinta2);margin-left:auto}
  .cobertura b{color:var(--navy)}
  .heroi{display:grid;grid-template-columns:minmax(240px,1fr) minmax(300px,1.4fr);gap:16px;margin-bottom:16px}
  .cartao{background:#fff;border-radius:16px;padding:22px 24px;box-shadow:0 1px 2px rgba(2,32,51,.06),0 4px 14px rgba(2,32,51,.05)}
  .heroi .rotulo{font-size:13px;color:var(--tinta2);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
  .heroi .valorao{font-size:38px;font-weight:800;letter-spacing:-1px;margin:6px 0 2px;font-variant-numeric:tabular-nums}
  .heroi .valorao.pos{color:var(--pos)} .heroi .valorao.neg{color:var(--neg)}
  .chip{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;border-radius:99px;padding:3px 10px}
  .chip.pos{background:#e7f5ef;color:var(--pos)} .chip.neg{background:#fdecea;color:var(--neg)}
  .chip.neutro{background:#eef2f6;color:var(--tinta2);font-weight:500}
  .heroi .contexto{font-size:12.5px;color:var(--tinta2);margin-top:10px;line-height:1.5}
  #cascata{height:230px}
  .nota{font-size:12.5px;color:var(--tinta2);margin:4px 2px 14px;line-height:1.5}
  .linhas{display:flex;flex-direction:column;gap:10px;margin-bottom:8px}
  .linha{background:#fff;border-radius:14px;padding:14px 18px;box-shadow:0 1px 2px rgba(2,32,51,.05),0 3px 10px rgba(2,32,51,.04)}
  .linha .topo{display:flex;align-items:baseline;gap:12px}
  .linha .nome{font-size:14px;font-weight:600;color:var(--tinta)}
  .linha.forte .nome{font-weight:750;color:var(--navy)}
  .linha .spark{margin-left:auto;flex:0 0 auto}
  .linha .valor{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--tinta);min-width:120px;text-align:right}
  .linha.forte .valor{font-size:17px;color:var(--navy)}
  .linha .valor.pos{color:var(--pos)} .linha .valor.neg{color:var(--neg)}
  .linha .chip{flex:0 0 auto}
  .trilho{height:6px;border-radius:99px;background:#eef2f6;margin-top:10px;overflow:hidden}
  .trilho i{display:block;height:100%;border-radius:99px}
  .linha.resultado{border:1.5px solid var(--grade)}
  .linha.expansivel{cursor:pointer}
  .seta{display:inline-block;width:16px;color:var(--tinta2);transition:transform .15s;font-size:11px}
  .aberto>.topo .seta{transform:rotate(90deg)}
  .filhos{margin-top:12px;border-top:1px solid var(--grade);padding-top:6px;display:flex;flex-direction:column}
  .filho{padding:9px 4px 9px 20px;border-radius:10px}
  .filho:hover{background:#f6f9fb}
  .filho .topo{display:flex;align-items:center;gap:10px}
  .filho .nome{font-size:13.5px;color:var(--tinta)}
  .filho .valor{font-size:13.5px;font-weight:650;min-width:110px}
  .filho .trilho{margin-top:6px;height:4px}
  .neto{padding-left:40px}
  .neto .nome,.neto .valor{font-size:12.5px;color:var(--tinta2);font-weight:500}
  svg.sk{display:block}
  footer{max-width:1020px;margin:0 auto;padding:14px 20px 26px;color:#94a3b8;font-size:12px;text-align:center}
  @media (max-width:900px){.heroi{grid-template-columns:1fr}#cascata{height:200px}}
  @media (max-width:640px){
    header{flex-wrap:wrap;padding:14px 16px}header .carimbo{margin-left:0;text-align:left}
    main{padding:14px 12px 6px}
    .barra{gap:8px}
    .pills{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
    .cobertura{margin-left:0;width:100%}
    .cartao{padding:16px 16px}
    .heroi .valorao{font-size:28px}
    #cascata{height:180px}
    .linha{padding:12px 14px}
    .linha .topo{flex-wrap:wrap;row-gap:6px}
    .linha .nome{flex:1 1 auto;min-width:55%}
    .linha .valor{margin-left:auto;min-width:0}
    .linha .spark{display:none}
    .filho .topo{flex-wrap:wrap;row-gap:4px}
    .filho .spark{display:none}
    .neto{padding-left:24px}
    .chip small{display:none}
  }
  @media print{body{background:#fff}.cartao,.linha{box-shadow:none;border:1px solid var(--grade)}.pills{display:none}}
</style>
</head>
<body>
<header>${logo ? `<img src="${logo}" alt="TOTVS Chef">` : ''}<h1>${esc(titulo)}</h1><div class="carimbo">${esc(carimbo)}</div></header>
${ressalva ? `<div class="ressalva">${esc(ressalva)}</div>` : ''}
<main>
  <div class="barra">
    <div class="pills" id="pills-visao"></div>
    <div class="pills">
      <button id="btn-competencia" class="ativo">Competência</button>
      <button id="btn-caixa">Caixa</button>
    </div>
    <div class="cobertura" id="cobertura"></div>
  </div>
  <div class="heroi">
    <div class="cartao">
      <div class="rotulo" id="heroi-rotulo"></div>
      <div class="valorao" id="heroi-valor"></div>
      <div id="heroi-chip"></div>
      <div class="contexto" id="heroi-contexto"></div>
    </div>
    <div class="cartao"><div id="cascata"></div></div>
  </div>
  <p class="nota" id="nota"></p>
  <div class="linhas" id="linhas"></div>
</main>
<footer>DRE gerencial — não substitui a demonstração contábil. Assistente de Gestão, projeto da MHI Sistemas (revenda TOTVS Food Linha Chef). Não é um produto oficial TOTVS. Uso por conta e risco do usuário.</footer>
<script>${echarts}</script>
<script>
const DRE = ${dadosJson};
const MES_NOME = ${JSON.stringify(MES_NOME)};
const rotuloMes = (am) => MES_NOME[Number(am.slice(5)) - 1] + '/' + am.slice(2, 4);
const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCurto = (v) => {
  const abs = Math.abs(v);
  if (abs >= 1e6) return 'R$ ' + (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (abs >= 1e3) return 'R$ ' + (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return brl(v);
};
const soma = (vs) => vs.reduce((s, v) => s + (v ?? 0), 0);
let visao = 'mensal';
let regime = 'competencia';
const abertos = new Set();
let graficoCascata = null;

// Valor "do periodo": na visao mensal e o mes de referencia (ultimo);
// na anual, o acumulado.
const valorPeriodo = (vs, comparativo) => comparativo ? (vs[vs.length - 1] ?? 0) : soma(vs);

function chipVariacao(anterior, atual, invertido) {
  if (!anterior) return '';
  let delta = ((atual - anterior) / Math.abs(anterior)) * 100;
  const bom = invertido ? delta <= 0 : delta >= 0;
  return '<span class="chip ' + (bom ? 'pos' : 'neg') + '">' + (delta >= 0 ? '▲' : '▼') + ' '
    + Math.abs(delta).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% <small style="font-weight:500">vs ' + chipRef + '</small></span>';
}
let chipRef = '';

function sparkline(vs, cor) {
  const n = vs.length;
  if (n < 2) return '';
  const L = 120, A = 34, P = 3;
  const min = Math.min(...vs, 0), max = Math.max(...vs, 0);
  const faixa = (max - min) || 1;
  const px = (i) => P + (i * (L - 2 * P)) / (n - 1);
  const py = (v) => A - P - ((v - min) * (A - 2 * P)) / faixa;
  const pontos = vs.map((v, i) => px(i).toFixed(1) + ',' + py(v ?? 0).toFixed(1)).join(' ');
  return '<svg class="sk" width="' + L + '" height="' + A + '" aria-hidden="true">'
    + '<polyline points="' + pontos + '" fill="none" stroke="' + cor + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
    + '<circle cx="' + px(n - 1) + '" cy="' + py(vs[n - 1] ?? 0) + '" r="2.6" fill="' + cor + '"/></svg>';
}

function barra(pctBase, cor) {
  const larg = Math.max(0, Math.min(100, Math.abs(pctBase)));
  return '<div class="trilho"><i style="width:' + larg.toFixed(1) + '%;background:' + cor + '"></i></div>';
}

function linhaHtml({ classe, nome, vs, comparativo, cor, pctSobre, seta = false, id = null, cores = {} }) {
  const valor = valorPeriodo(vs, comparativo);
  const anterior = comparativo ? vs[0] : null;
  const negativo = nome.indexOf('−') >= 0;
  const spark = !comparativo ? '<span class="spark">' + sparkline(vs.map((x) => Math.abs(x)), cor) + '</span>' : '';
  const chip = comparativo ? chipVariacao(Math.abs(anterior ?? 0), Math.abs(valor), negativo) : '';
  const pct = pctSobre ? (Math.abs(valor) * 100) / pctSobre : 0;
  const classeValor = cores.porSinal ? (valor >= 0 ? 'pos' : 'neg') : '';
  return '<div class="linha ' + classe + '"' + (id ? ' data-id="' + id + '"' : '') + '>'
    + '<div class="topo">' + (seta ? '<span class="seta">▶</span>' : '')
    + '<div class="nome">' + nome + '</div>' + spark + chip
    + '<div class="valor ' + classeValor + '">' + brl(valor) + '</div></div>'
    + (pctSobre ? barra(pct, cor) : '')
    + '<div class="filhos" data-filhos style="display:none"></div>'
    + '</div>';
}

function renderCascata(d, comparativo) {
  if (!graficoCascata || typeof echarts === 'undefined') return;
  const pega = (id) => d.linhas.find((l) => l.id === id);
  const v = (id) => { const l = pega(id); return l ? Math.abs(valorPeriodo(l.valores, comparativo)) : 0; };
  let passos;
  if (regime === 'competencia') {
    passos = [
      { nome: 'Receita', valor: v('rb'), tipo: 'entrada' },
      { nome: 'Impostos', valor: -v('imp'), tipo: 'saida' },
      { nome: 'CMV', valor: -v('cmv'), tipo: 'saida' },
      { nome: 'Despesas', valor: -v('dsp'), tipo: 'saida' },
    ];
  } else {
    passos = [
      { nome: 'Entradas', valor: v('ent'), tipo: 'entrada' },
      { nome: 'Saídas', valor: -v('sai'), tipo: 'saida' },
    ];
  }
  const resultado = passos.reduce((s, p) => s + p.valor, 0);
  const nomes = passos.map((p) => p.nome).concat(['Resultado']);
  let acumulado = 0;
  const base = [], subida = [], descida = [];
  for (const p of passos) {
    if (p.valor >= 0) { base.push(acumulado); subida.push(p.valor); descida.push(0); acumulado += p.valor; }
    else { acumulado += p.valor; base.push(Math.max(acumulado, 0)); descida.push(Math.abs(p.valor)); subida.push(0); }
  }
  base.push(resultado >= 0 ? 0 : resultado); subida.push(resultado >= 0 ? resultado : 0); descida.push(resultado >= 0 ? 0 : Math.abs(resultado));
  graficoCascata.setOption({
    grid: { left: 8, right: 8, top: 28, bottom: 4, containLabel: true },
    textStyle: { fontFamily: 'system-ui, sans-serif' },
    title: { text: comparativo ? 'Como o mês virou resultado' : 'Como o período virou resultado', left: 0, top: 0, textStyle: { fontSize: 13, fontWeight: 650, color: '#002233' } },
    xAxis: { type: 'category', data: nomes, axisTick: { show: false }, axisLine: { lineStyle: { color: '#cbd5e1' } }, axisLabel: { color: '#64748b', fontSize: 11.5 } },
    yAxis: { show: false },
    tooltip: { trigger: 'item', formatter: (p) => p.name + ': ' + brl((p.seriesName === 'saida' ? -1 : 1) * p.value), textStyle: { fontSize: 12.5 } },
    series: [
      { type: 'bar', stack: 'c', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base },
      { type: 'bar', stack: 'c', name: 'entrada', barMaxWidth: 46, itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', formatter: (p) => p.value ? brlCurto(p.value) : '', color: '#475569', fontSize: 11 },
        data: subida.map((x, i) => i === nomes.length - 1 && resultado >= 0 ? { value: x, itemStyle: { color: '#047857' } } : x) },
      { type: 'bar', stack: 'c', name: 'saida', barMaxWidth: 46, itemStyle: { color: '#e5989b', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', formatter: (p) => p.value ? '−' + brlCurto(p.value) : '', color: '#9f4a4d', fontSize: 11 },
        data: descida.map((x, i) => i === nomes.length - 1 ? { value: x, itemStyle: { color: '#b91c1c' } } : x) },
    ],
  }, true);
}

function render() {
  const v = DRE.visoes[visao];
  const d = v.regimes[regime];
  const comparativo = v.comparativo;
  chipRef = comparativo ? rotuloMes(v.meses[0]) : '';

  const pillsVisao = document.getElementById('pills-visao');
  pillsVisao.innerHTML = Object.entries(DRE.visoes)
    .map(([id, vv]) => '<button data-visao="' + id + '" class="' + (id === visao ? 'ativo' : '') + '">' + vv.rotulo + '</button>').join('');
  pillsVisao.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { visao = b.dataset.visao; render(); }));
  document.getElementById('btn-competencia').classList.toggle('ativo', regime === 'competencia');
  document.getElementById('btn-caixa').classList.toggle('ativo', regime === 'caixa');
  document.getElementById('nota').textContent = 'Critério: ' + d.nota;
  document.getElementById('cobertura').innerHTML = d.cobertura === null ? ''
    : 'Cobertura dos lançamentos: <b>' + d.cobertura.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%</b>';

  // Heroi
  const resultado = d.linhas.find((l) => l.tipo === 'resultado');
  const valorRes = valorPeriodo(resultado.valores, comparativo);
  document.getElementById('heroi-rotulo').textContent = resultado.rotulo.replace('= ', '') + (comparativo ? ' — ' + rotuloMes(v.meses[1]) : ' — acumulado');
  const alvoValor = document.getElementById('heroi-valor');
  alvoValor.textContent = brl(valorRes);
  alvoValor.className = 'valorao ' + (valorRes >= 0 ? 'pos' : 'neg');
  document.getElementById('heroi-chip').innerHTML = comparativo
    ? (chipVariacao(resultado.valores[0], valorRes, false) || '<span class="chip neutro">sem base de comparação</span>')
    : '<span class="chip neutro">média mensal ' + brl(soma(resultado.valores) / v.meses.length) + '</span>';
  const baseValor = valorPeriodo(d.base, comparativo);
  document.getElementById('heroi-contexto').textContent = baseValor
    ? 'Margem sobre a base: ' + ((valorRes * 100) / baseValor).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% · base do período ' + brl(baseValor)
    : 'Sem base no período.';

  renderCascata(d, comparativo);

  // Linhas
  const baseAbs = Math.abs(baseValor) || null;
  const CORES = { rb: '#2563eb', imp: '#94a3b8', rl: '#2563eb', cmv: '#94a3b8', lb: '#2563eb', dsp: '#94a3b8', ent: '#2563eb', sai: '#94a3b8' };
  let html = '';
  for (const linha of d.linhas) {
    const forte = linha.tipo === 'total' || linha.tipo === 'secao' || linha.tipo === 'resultado';
    html += linhaHtml({
      classe: (forte ? 'forte ' : '') + (linha.tipo === 'resultado' ? 'resultado' : '') + (linha.tipo === 'secao' ? ' expansivel' : ''),
      nome: linha.rotulo, vs: linha.valores, comparativo,
      cor: CORES[linha.id] ?? '#94a3b8',
      pctSobre: linha.tipo === 'resultado' ? null : baseAbs,
      seta: linha.tipo === 'secao', id: linha.tipo === 'secao' ? linha.id : null,
      cores: { porSinal: linha.tipo === 'resultado' },
    });
  }
  document.getElementById('linhas').innerHTML = html;

  // Expansao das secoes (plano 1 -> plano 2)
  for (const linha of d.linhas.filter((l) => l.tipo === 'secao')) {
    const alvo = document.querySelector('.linha[data-id="' + linha.id + '"]');
    const caixaFilhos = alvo.querySelector('[data-filhos]');
    const desenharFilhos = () => {
      const aberto = abertos.has(linha.id);
      alvo.classList.toggle('aberto', aberto);
      caixaFilhos.style.display = aberto ? '' : 'none';
      if (!aberto) { caixaFilhos.innerHTML = ''; return; }
      const totalSecao = Math.abs(valorPeriodo(linha.valores, comparativo)) || 1;
      let filhosHtml = '';
      for (const [gi, g] of linha.grupos.entries()) {
        const idG = linha.id + ':' + gi;
        const abertoG = abertos.has(idG);
        const valorG = Math.abs(valorPeriodo(g.valores, comparativo));
        filhosHtml += '<div class="filho expansivel ' + (abertoG ? 'aberto' : '') + '" data-grupo="' + idG + '">'
          + '<div class="topo"><span class="seta">▶</span><div class="nome">' + g.rotulo + '</div>'
          + (comparativo ? chipVariacao(Math.abs(g.valores[0] ?? 0), valorG, true) : '<span class="spark">' + sparkline(g.valores.map(Math.abs), '#94a3b8') + '</span>')
          + '<div class="valor" style="margin-left:auto">' + brl(valorG) + '</div></div>'
          + barra((valorG * 100) / totalSecao, '#0a425f') + '</div>';
        if (abertoG) {
          for (const det of g.detalhes) {
            const valorDet = Math.abs(valorPeriodo(det.valores, comparativo));
            filhosHtml += '<div class="filho neto"><div class="topo"><div class="nome">' + det.rotulo + '</div>'
              + '<div class="valor" style="margin-left:auto">' + brl(valorDet) + '</div></div></div>';
          }
        }
      }
      caixaFilhos.innerHTML = filhosHtml;
      caixaFilhos.querySelectorAll('[data-grupo]').forEach((el) => {
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = el.dataset.grupo;
          if (abertos.has(id)) abertos.delete(id); else abertos.add(id);
          desenharFilhos();
        });
      });
    };
    alvo.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-grupo]')) return;
      if (abertos.has(linha.id)) abertos.delete(linha.id); else abertos.add(linha.id);
      desenharFilhos();
    });
    desenharFilhos();
  }
}

graficoCascata = typeof echarts !== 'undefined' ? echarts.init(document.getElementById('cascata')) : null;
document.getElementById('btn-competencia').addEventListener('click', () => { regime = 'competencia'; render(); });
document.getElementById('btn-caixa').addEventListener('click', () => { regime = 'caixa'; render(); });
window.addEventListener('resize', () => graficoCascata && graficoCascata.resize());
render();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  const args = lerArgs();
  try {
    if (acao === 'cmv-fonte') {
      // Qual CMV entra na DRE e ESCOLHA DO GESTOR — o assistente explica as
      // tres e pergunta, nunca decide sozinho (docs/ajuda/como-calculamos-o-cmv.md).
      const escolha = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
      const db = abrirBanco();
      try {
        const grupo = typeof args.grupo === 'string' ? args.grupo : '*';
        if (!escolha) {
          const atual = fonteCmvDaDre(db, grupo === '*' ? null : grupo);
          console.log(`CMV usado hoje na DRE: ${ROTULO_CMV[atual]}`);
          console.log('');
          console.log('Opções (pergunte ao gestor qual ele quer ver):');
          console.log('  teorico  — custo de ficha técnica dos itens vendidos. Funciona em qualquer');
          console.log('             período, mas mostra o que DEVERIA ter sido consumido: não enxerga');
          console.log('             desperdício, quebra nem desvio.');
          console.log('  real     — estoque inicial + compras − estoque final. É o consumo que de fato');
          console.log('             aconteceu, o único que revela perda. Precisa de posição de estoque');
          console.log('             nas duas pontas do mês (fotografia diária ou inventário importado).');
          console.log('  compras  — o que foi lançado nos planos de contas marcados como compra de');
          console.log('             mercadoria. Bate com o extrato, mas confunde comprar com consumir.');
          console.log('');
          console.log('Para definir: dre.mjs cmv-fonte teorico|real|compras [--grupo <id>]');
        } else if (!FONTES_CMV.includes(escolha)) {
          throw new Error(`fonte inválida "${escolha}". Use: ${FONTES_CMV.join(', ')}`);
        } else {
          gravarPreferencia(db, 'dre_cmv', escolha, grupo);
          console.log(`✅ A DRE passa a usar: ${ROTULO_CMV[escolha]}`
            + (grupo !== '*' ? ` (grupo ${grupo})` : ''));
          if (escolha === 'compras') {
            const n = db.prepare("SELECT COUNT(*) AS n FROM plano_categorias WHERE categoria = 'mercadoria'").get().n;
            if (n === 0) {
              console.log('⚠️ Nenhum plano de contas está marcado como compra de mercadoria ainda — '
                + 'sem isso a linha fica vazia. Rode: categorias-planos.mjs sugerir --categoria mercadoria, '
                + 'confirme com o gestor e defina com categorias-planos.mjs definir "PLANO|SUB=mercadoria".');
            }
          }
        }
      } finally { db.close(); }
    } else if (acao !== 'gerar') {
      console.error('Uso: dre.mjs gerar [--mes AAAA-MM] [--grupo <id>] [--saida x.html] [--abrir]');
      console.error('     (padrão: visão Mensal do mês anterior + visão Anual dos últimos 12 meses)');
      console.error('   |  dre.mjs cmv-fonte [teorico|real|compras] [--grupo <id>]');
      console.error('     (qual CMV aparece na DRE — pergunte ao gestor; sem argumento, mostra a escolha atual)');
      process.exitCode = 1;
    } else {
      // Mês de referência: o ANTERIOR ao atual (mês fechado) — o ritual do gestor.
      let mesRef = typeof args.mes === 'string' ? args.mes : null;
      if (mesRef && !/^\d{4}-\d{2}$/.test(mesRef)) throw new Error('--mes deve ser AAAA-MM');
      if (!mesRef) {
        const hoje = new Date();
        const anterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
        mesRef = `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}`;
      }
      const mesAntes = (am) => {
        const [a, m] = am.split('-').map(Number);
        const d = new Date(a, m - 2, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      };
      const inicioAnual = (() => { let x = mesRef; for (let i = 0; i < 11; i += 1) x = mesAntes(x); return x; })();

      const grupo = typeof args.grupo === 'string' ? args.grupo : null;
      let grupoRotulo = null;
      if (grupo) {
        const c = carregarConexoes().find((x) => x.id === grupo);
        if (!c) throw new Error(`grupo "${grupo}" não encontrado`);
        grupoRotulo = c.nome;
      }

      const db = abrirBanco({ somenteLeitura: true });
      let visoes;
      try {
        const fonteCmv = fonteCmvDaDre(db, grupo);
        const calcular = (meses) => ({
          meses,
          regimes: {
            competencia: calcularCompetencia(db, meses, grupo, fonteCmv),
            caixa: calcularCaixa(db, meses, grupo),
          },
        });
        visoes = {
          mensal: { rotulo: `Mensal (${rotuloMes(mesRef)})`, comparativo: true, ...calcular([mesAntes(mesRef), mesRef]) },
          anual: { rotulo: `Anual (${rotuloMes(inicioAnual)}–${rotuloMes(mesRef)})`, comparativo: false, ...calcular(listaMeses(inicioAnual, mesRef)) },
        };
      } finally { db.close(); }

      // A DRE e a peca que mais vira decisao — se o periodo tem buraco, isso
      // precisa estar escrito nela, nao so dito na conversa.
      let ressalva = null;
      try {
        const dbC = abrirBanco({ somenteLeitura: true });
        try {
          ressalva = ressalvaImpressa(conferirTodos(dbC, {
            de: `${mesRef}-01`,
            ate: new Date(Date.UTC(Number(mesRef.slice(0, 4)), Number(mesRef.slice(5, 7)), 0))
              .toISOString().slice(0, 10),
            grupo,
          }));
        } finally { dbC.close(); }
      } catch { /* nao bloqueia a DRE */ }

      const titulo = `DRE Gerencial${grupoRotulo ? ` — ${grupoRotulo}` : ''}`;
      const html = gerarHtml({ titulo, visoes, grupoRotulo, ressalva });
      const saida = args.saida ?? join(RAIZ, 'relatorios', 'dre', `dre-${mesRef}.html`);
      mkdirSync(dirname(resolve(saida)), { recursive: true });
      writeFileSync(saida, html, 'utf8');
      console.log(`✅ DRE gerada: ${resolve(saida)} (visões Mensal ${rotuloMes(mesRef)} e Anual, regimes competência e caixa)`);
      if (args.abrir) abrirNoSistema(resolve(saida), () => console.warn('Não consegui abrir o navegador; abra o arquivo manualmente.'));
    }
  } catch (erro) {
    console.error(`Não consegui gerar a DRE: ${erro.message}`);
    process.exitCode = 1;
  }
}
