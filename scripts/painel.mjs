// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Gerador de paineis: uma ESPECIFICACAO (titulo, KPIs e graficos, cada um com
// sua consulta) vira um HTML bonito, padronizado e 100% autossuficiente —
// ECharts e logo embutidos, dados dentro do arquivo: abre offline e pode ser
// enviado para qualquer pessoa.
//
// Por que existe: painel escrito a mao sai diferente a cada sessao e exige o
// agente; com o gerador, o padrao visual e as boas praticas de leitura saem
// por construcao, e a rotina pode gerar paineis agendados sem agente.
//
// Filtro (ex.: por loja): cada opcao vira um CONJUNTO completo recalculado
// por consulta no momento da geracao — nada de somar no navegador, senao
// ticket medio e percentuais sairiam errados. O seletor troca KPIs, graficos
// e tabelas de uma vez.
//
// Regras visuais embutidas (nao configuraveis de proposito):
// - paleta de series fixa, validada para daltonismo sobre cartao branco;
//   7a serie em diante vira "Outros";
// - numero mais importante grande e direto; serie unica nao poe nome tecnico
//   no tooltip (o titulo do cartao identifica);
// - grades recessivas, marcas finas, legenda quando ha 2+ series, tooltip
//   sempre, tabela alternativa em cada grafico (acessibilidade);
// - feriados e eventos marcados nos graficos de linha (calendario.mjs).
//
// Uso:
//   node --no-warnings scripts/painel.mjs gerar --spec <arquivo.json|-> [--saida x.html] [--abrir]
//   node --no-warnings scripts/painel.mjs exemplo     (imprime uma especificacao modelo)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { abrirBanco } from './criar-banco.mjs';
import { feriadosDoAno, eventosDoPeriodo } from './calendario.mjs';
import { abrirNoSistema } from './plataforma.mjs';
import { carregarIdentidade } from './identidade.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// Paleta categorica FIXA (ordem nunca muda; validada: banda de luminancia,
// croma, separacao para daltonismo e contraste >= 3:1 sobre branco).
const PALETA = ['#2563eb', '#d97706', '#059669', '#7c3aed', '#dc2626', '#0891b2'];
const MAX_SERIES = 6;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function formatar(valor, formato) {
  if (valor === null || valor === undefined) return '—';
  const n = Number(valor);
  if (!Number.isFinite(n)) return String(valor);
  if (formato === 'moeda') {
    // A partir de R$ 100 mil os centavos so ocupam espaco (e estouram o
    // card de KPI): some com eles, a leitura agradece.
    const semCentavos = Math.abs(n) >= 100_000;
    return n.toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL',
      ...(semCentavos ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
    });
  }
  if (formato === 'pct') return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  if (formato === 'inteiro') return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

const dmy = (s) => (s ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)}` : '');

function validarSql(sql, onde) {
  if (!/^\s*(select|with)\b/i.test(String(sql ?? ''))) {
    throw new Error(`a consulta de "${onde}" precisa ser de leitura (SELECT/WITH)`);
  }
  return sql;
}

// Substitui o marcador {{parametro}} pelo valor da opcao do filtro (aspas
// simples escapadas). Valor vazio = opcao "Todos".
function aplicarFiltro(sql, parametro, valor) {
  if (!parametro) return sql;
  return String(sql).replaceAll(`{{${parametro}}}`, String(valor ?? '').replaceAll("'", "''"));
}

// Uma consulta de grafico devolve: 1a coluna = categoria/dia, 2a = valor,
// 3a (opcional) = nome da serie. Aqui viramos { categorias, series[] }.
function montarSeries(linhas) {
  if (linhas.length === 0) return { categorias: [], series: [] };
  const colunas = Object.keys(linhas[0]);
  const [cCat, cValor, cSerie] = colunas;
  const categorias = [...new Set(linhas.map((l) => l[cCat]))];
  if (!cSerie) {
    // Serie unica nao carrega nome: o titulo do cartao ja identifica (senao o
    // tooltip vaza o nome tecnico da consulta, tipo "COUNT(*)").
    return { categorias, series: [{ nome: '', valores: categorias.map((cat) => linhas.find((l) => l[cCat] === cat)?.[cValor] ?? null) }] };
  }
  const nomes = [...new Set(linhas.map((l) => l[cSerie]))];
  const principais = nomes.slice(0, MAX_SERIES - (nomes.length > MAX_SERIES ? 1 : 0));
  const series = principais.map((nome) => ({
    nome: String(nome),
    valores: categorias.map((cat) => linhas.find((l) => l[cCat] === cat && l[cSerie] === nome)?.[cValor] ?? null),
  }));
  if (nomes.length > principais.length) {
    const resto = nomes.slice(principais.length);
    series.push({
      nome: 'Outros',
      valores: categorias.map((cat) => resto.reduce((soma, nome) => soma + (Number(linhas.find((l) => l[cCat] === cat && l[cSerie] === nome)?.[cValor]) || 0), 0)),
    });
  }
  return { categorias, series };
}

// Rosca: no maximo 6 fatias; o excedente vira "Outros" (regra de leitura).
function montarFatias(linhas) {
  const colunas = Object.keys(linhas[0] ?? {});
  const [cNome, cValor] = colunas;
  const ordenadas = [...linhas].sort((a, b) => (b[cValor] ?? 0) - (a[cValor] ?? 0));
  const principais = ordenadas.slice(0, ordenadas.length > 6 ? 5 : 6);
  const fatias = principais.map((l) => ({ nome: String(l[cNome]), valor: Number(l[cValor]) || 0 }));
  const resto = ordenadas.slice(principais.length);
  if (resto.length > 0) fatias.push({ nome: 'Outros', valor: resto.reduce((s, l) => s + (Number(l[cValor]) || 0), 0) });
  return fatias;
}

// A tabela alternativa fala a lingua do painel: cabecalho amigavel (nunca a
// consulta crua tipo "ROUND(SUM(...),2)"), data em DD/MM/AAAA e a coluna de
// valor no formato do grafico (R$, %, numero).
const EH_ISO = /^\d{4}-\d{2}-\d{2}/;
function cabecalhoAmigavel(nome, indice) {
  if (/[()]/.test(nome)) return ['Categoria', 'Valor', 'Série'][indice] ?? 'Valor';
  const limpo = String(nome).replaceAll('_', ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}
function tabelaHtml(linhas, formato) {
  if (linhas.length === 0) return '<p>(sem dados no recorte)</p>';
  const colunas = Object.keys(linhas[0]);
  const MESES_ABREV_SRV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const celula = (valor, indice) => {
    if (typeof valor === 'string' && /^\d{4}-\d{2}$/.test(valor)) {
      return `${MESES_ABREV_SRV[Number(valor.slice(5, 7)) - 1]}/${valor.slice(2, 4)}`;
    }
    if (typeof valor === 'string' && EH_ISO.test(valor)) return dmy(valor);
    if (typeof valor === 'number') return indice === 1 ? formatar(valor, formato) : valor.toLocaleString('pt-BR');
    return valor;
  };
  return `<table><thead><tr>${colunas.map((c, i) => `<th>${esc(cabecalhoAmigavel(c, i))}</th>`).join('')}</tr></thead><tbody>${
    linhas.map((l) => `<tr>${colunas.map((c, i) => `<td>${esc(celula(l[c], i))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

// Executa KPIs e graficos para UM valor de filtro ('' = todos).
function executarConjunto(db, spec, valorFiltro) {
  const parametro = spec.filtro?.parametro;
  const kpis = (spec.kpis ?? []).map((k) => {
    const sql = aplicarFiltro(validarSql(k.sql, k.rotulo), parametro, valorFiltro);
    const valor = Object.values(db.prepare(sql).get() ?? {})[0] ?? null;
    let delta = null;
    if (k.delta_sql) {
      const anterior = Object.values(db.prepare(aplicarFiltro(validarSql(k.delta_sql, k.rotulo), parametro, valorFiltro)).get() ?? {})[0];
      if (Number(anterior) > 0 && valor !== null) delta = ((Number(valor) - Number(anterior)) / Number(anterior)) * 100;
    }
    return { valor, delta };
  });
  const graficos = (spec.graficos ?? []).map((g) => montarNo(db, spec, g, valorFiltro, 0, null));
  return { kpis, graficos };
}

// Colunas de uma TABELA interativa: rotulo amigavel + formato detectado
// (mesma filosofia da exportacao xlsx: datas pelo conteudo, moeda/percentual
// pelo nome). O cliente usa o formato para exibir, ordenar e filtrar direito.
const REGEX_MOEDA_T = /valor|faturamento|receita|pre[cç]o|custo|ticket|margem|l[ií]quido|bruto|saldo|desconto|cmv|total/i;
const REGEX_PCT_T = /pct|percent|%/i;
function metasDeColunas(linhas) {
  if (linhas.length === 0) return [];
  return Object.keys(linhas[0]).map((chave) => {
    const amostra = linhas.slice(0, 50).map((l) => l[chave]).filter((v) => v !== null && v !== undefined);
    const soDatas = amostra.length > 0 && amostra.every((v) => typeof v === 'string' && EH_ISO.test(v));
    const soNumeros = amostra.length > 0 && amostra.every((v) => typeof v === 'number');
    const formato = soDatas ? 'data'
      : (soNumeros && REGEX_PCT_T.test(chave)) ? 'pct'
        : (soNumeros && REGEX_MOEDA_T.test(chave)) ? 'moeda'
          : soNumeros ? 'numero' : 'texto';
    const limpo = /[()]/.test(chave) ? 'Valor' : chave.replaceAll('_', ' ');
    return { chave, rotulo: limpo.charAt(0).toUpperCase() + limpo.slice(1), formato };
  });
}
const MAX_LINHAS_TABELA = 2000;

// ---------- tipo "progresso": barras de progresso hierarquicas ----------
// Para acompanhar cargas/coberturas: uma barra geral, barras por item
// (ex.: loja) com sub-barras por parte (ex.: dominio) e, no ultimo nivel,
// "fichas" por unidade (ex.: mes) com o estado de cada uma. Tudo estatico
// (details/summary), sem echarts. O grafico recebe `dados`, nao `sql`:
//   { geral: {rotulo, segmentos}, itens: [{rotulo, segmentos, extra?,
//     filhos: [...mesma forma...], fichas: [{rotulo, estado, dica?}] }] }
// segmentos = { coletado: n, defeito: n, sem_acesso: n, pendente: n }.
const ESTADOS_PROGRESSO = {
  coletado: { nome: 'Coletado', cor: '#059669', texto: '#fff' },
  defeito: { nome: 'Defeito no servidor', cor: '#dc2626', texto: '#fff' },
  sem_acesso: { nome: 'Sem acesso (permissão)', cor: '#7c3aed', texto: '#fff' },
  pendente: { nome: 'Pendente', cor: '#d3dce6', texto: '#3d4c5c' },
};

function barraProgresso(segmentos) {
  const total = Object.values(segmentos ?? {}).reduce((s, n) => s + (n || 0), 0);
  if (!total) return { barra: '<div class="pg-barra"><span class="pg-seg" style="width:100%;background:#eef2f6"></span></div>', pct: 100 };
  const partes = Object.entries(ESTADOS_PROGRESSO)
    .map(([chave, e]) => ({ e, n: segmentos[chave] || 0 }))
    .filter((p) => p.n > 0)
    .map((p) => `<span class="pg-seg" style="width:${(p.n * 100 / total).toFixed(2)}%;background:${p.e.cor}" title="${esc(p.e.nome)}: ${p.n}"></span>`)
    .join('');
  const pct = Math.round(((segmentos.coletado || 0) * 1000) / total) / 10;
  return { barra: `<div class="pg-barra">${partes}</div>`, pct };
}

function linhaProgresso(no, nivel) {
  const { barra, pct } = barraProgresso(no.segmentos);
  const cab = `<span class="pg-rotulo">${esc(no.rotulo)}</span>${barra}`
    + `<span class="pg-pct">${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>`
    + (no.extra ? `<span class="pg-extra">${esc(no.extra)}</span>` : '');
  const fichas = (no.fichas ?? []).map((f) => {
    const e = ESTADOS_PROGRESSO[f.estado] ?? ESTADOS_PROGRESSO.pendente;
    return `<span class="pg-ficha" style="background:${e.cor};color:${e.texto}"${f.dica ? ` title="${esc(f.dica)}"` : ''}>${esc(f.rotulo)}</span>`;
  }).join('');
  const filhos = (no.filhos ?? []).map((f) => linhaProgresso(f, nivel + 1)).join('');
  const conteudo = `${filhos}${fichas ? `<div class="pg-fichas">${fichas}</div>` : ''}`;
  if (!conteudo) return `<div class="pg-linha pg-n${nivel}">${cab}</div>`;
  return `<details class="pg-item pg-n${nivel}"${nivel === 0 ? '' : ''}>`
    + `<summary class="pg-linha">${cab}</summary>`
    + `<div class="pg-filhos">${conteudo}</div></details>`;
}

function progressoHtml(dados) {
  const legenda = Object.values(ESTADOS_PROGRESSO)
    .map((e) => `<span class="pg-leg"><span class="pg-cor" style="background:${e.cor}"></span>${esc(e.nome)}</span>`)
    .join('');
  const geral = dados.geral ? linhaProgresso({ ...dados.geral, filhos: [], fichas: [] }, 0) : '';
  const itens = (dados.itens ?? []).map((i) => linhaProgresso(i, 1)).join('');
  return `<div class="pg"><div class="pg-geral">${geral}</div>${itens}<div class="pg-legenda">${legenda}</div></div>`;
}

// Monta um "no" de grafico. Com g.niveis (drill-down), pre-calcula tambem os
// filhos de cada categoria — tudo por consulta, na geracao: o clique no
// navegador so navega em dados que ja estao dentro do arquivo.
const MAX_FILHOS_DRILL = 30;
function montarNo(db, spec, g, valorFiltro, nivel, pai) {
  const parametro = spec.filtro?.parametro;
  if (g.tipo === 'progresso') {
    // Dados vem prontos na especificacao (nao ha SQL): render estatico.
    return { progressoHtml: progressoHtml(g.dados ?? {}), tabela: '' };
  }
  if (g.tipo === 'tabela') {
    const sqlT = aplicarFiltro(validarSql(g.sql, g.titulo), parametro, valorFiltro);
    const linhasT = db.prepare(sqlT).all();
    const cortadas = linhasT.slice(0, MAX_LINHAS_TABELA);
    return {
      colunas: metasDeColunas(cortadas),
      dados: cortadas.map((l) => Object.values(l)),
      truncada: linhasT.length > MAX_LINHAS_TABELA,
      tabela: '', // a propria entrega e a tabela interativa
    };
  }
  const niveis = Array.isArray(g.niveis) && g.niveis.length > 0 ? g.niveis : null;
  const sqlBase = niveis ? niveis[nivel].sql : g.sql;
  const sql = aplicarFiltro(validarSql(sqlBase, g.titulo), parametro, valorFiltro)
    .replaceAll('{{pai}}', String(pai ?? '').replaceAll("'", "''"));
  const linhas = db.prepare(sql).all();
  const tabela = tabelaHtml(linhas, g.formato ?? 'numero');
  const no = g.tipo === 'rosca'
    ? { fatias: montarFatias(linhas), tabela }
    : { ...montarSeries(linhas), tabela };
  if (niveis && nivel + 1 < niveis.length) {
    const nomes = (g.tipo === 'rosca' ? (no.fatias ?? []).map((f) => f.nome) : (no.categorias ?? []))
      .filter((n) => n !== 'Outros').slice(0, MAX_FILHOS_DRILL);
    if (nomes.length > 0) {
      no.filhos = {};
      for (const nome of nomes) no.filhos[nome] = montarNo(db, spec, g, valorFiltro, nivel + 1, nome);
    }
  }
  return no;
}

function executarSpec(spec) {
  const db = abrirBanco({ somenteLeitura: true });
  try {
    // Opcoes do filtro (se houver): 1a coluna = valor, 2a = rotulo.
    let opcoes = [{ valor: '', rotulo: spec.filtro?.todas ?? 'Todos' }];
    if (spec.filtro?.opcoes_sql) {
      const linhas = db.prepare(validarSql(spec.filtro.opcoes_sql, 'filtro')).all();
      opcoes = opcoes.concat(linhas.map((l) => {
        const v = Object.values(l);
        return { valor: String(v[0]), rotulo: String(v[1] ?? v[0]) };
      }));
    }
    const conjuntos = opcoes.map((o) => ({ ...o, ...executarConjunto(db, spec, o.valor) }));

    // Feriados e eventos do periodo, para marcar nos graficos de linha.
    let marcas = [];
    if (spec.periodo?.de && spec.periodo?.ate) {
      const anos = new Set([spec.periodo.de.slice(0, 4), spec.periodo.ate.slice(0, 4)]);
      for (const ano of anos) {
        for (const f of feriadosDoAno(Number(ano))) {
          if (f.data >= spec.periodo.de && f.data <= spec.periodo.ate) marcas.push({ data: f.data, nome: f.nome });
        }
      }
      try {
        for (const e of eventosDoPeriodo(db, spec.periodo.de, spec.periodo.ate, spec.grupo)) {
          marcas.push({ data: e.data, nome: e.nome ?? e.descricao ?? 'evento' });
        }
      } catch { /* sem tabela de eventos: segue so com feriados */ }
      marcas = marcas.slice(0, 12);
    }
    return { conjuntos, marcas };
  } finally {
    db.close();
  }
}

function gerarHtml(spec, dados) {
  const agora = new Date();
  const echarts = readFileSync(join(RAIZ, 'assets', 'echarts.min.js'), 'utf8');
  // Identidade visual: padrao ChefWeb ou, se o gestor enviou a logomarca
  // dele, a marca e as cores extraidas dela (ver scripts/identidade.mjs).
  const identidade = carregarIdentidade();
  const logo = identidade.logoDataUri ?? '';
  const periodoTexto = spec.periodo?.de ? `Período: ${dmy(spec.periodo.de)} a ${dmy(spec.periodo.ate)}` : '';
  const carimbo = `${periodoTexto}${periodoTexto ? ' · ' : ''}gerado em ${agora.toLocaleDateString('pt-BR')} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

  const metasKpis = (spec.kpis ?? []).map((k) => ({ rotulo: k.rotulo, formato: k.formato ?? 'numero' }));
  const metasGraficos = (spec.graficos ?? []).map((g) => ({
    tipo: g.tipo, titulo: g.titulo, formato: g.formato ?? 'numero',
    largura: g.largura === 'cheia' ? 'cheia' : 'meia',
  }));

  const filtroHtml = dados.conjuntos.length > 1
    ? `<div class="filtro"><label for="filtro">${esc(spec.filtro?.rotulo ?? 'Filtrar')}</label>
       <select id="filtro">${dados.conjuntos.map((c, i) => `<option value="${i}">${esc(c.rotulo)}</option>`).join('')}</select></div>`
    : '';

  // Valores do primeiro recorte ja renderizados no servidor: os numeros
  // aparecem mesmo se o JavaScript falhar (o seletor e os graficos, nao).
  const inicial = dados.conjuntos[0];
  const kpisHtml = metasKpis.map((k, i) => {
    const v = inicial?.kpis?.[i];
    let delta = '';
    let classe = 'delta';
    if (v && v.delta !== null && Number.isFinite(v.delta)) {
      const bom = v.delta >= 0;
      classe = `delta ${bom ? 'pos' : 'neg'}`;
      delta = `${bom ? '▲' : '▼'} ${Math.abs(v.delta).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% <span>vs período anterior</span>`;
    }
    return `
    <div class="kpi"><div class="rotulo">${esc(k.rotulo)}</div><div class="valor" id="kpi${i}">${esc(formatar(v?.valor, k.formato))}</div><div class="${classe}" id="kpiDelta${i}">${delta}</div></div>`;
  }).join('');

  const graficosHtml = metasGraficos.map((g, i) => (g.tipo === 'progresso'
    ? `
    <section class="card ${g.largura === 'cheia' ? 'cheia' : ''}">
      <h2>${esc(g.titulo)}</h2>
      ${dados.conjuntos[0]?.graficos?.[i]?.progressoHtml ?? ''}
    </section>`
    : `
    <section class="card ${g.largura === 'cheia' ? 'cheia' : ''}">
      <h2>${esc(g.titulo)}</h2>
      <div class="trilha" id="trilha${i}"></div>
      <div id="g${i}" class="grafico" role="img" aria-label="${esc(g.titulo)}"></div>
      <details><summary>Ver como tabela</summary><div id="tab${i}">${dados.conjuntos[0]?.graficos?.[i]?.tabela ?? ''}</div></details>
    </section>`)).join('');

  const dadosJson = JSON.stringify({ metasKpis, metasGraficos, conjuntos: dados.conjuntos, marcas: dados.marcas })
    .replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="author" content="MHI Sistemas">
<title>${esc(spec.titulo)}</title>
<style>
  :root{--navy:${identidade.cabecalho};--ambar:${identidade.destaque};--tinta:#1e293b;--tinta2:#64748b;--fundo:#f4f6f8;--card:#ffffff;--grade:#eef2f6}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--fundo);margin:0;color:var(--tinta)}
  header{background:var(--navy);color:#fff;padding:18px 28px;display:flex;align-items:center;gap:16px}
  header img{height:40px}
  header h1{font-size:19px;margin:0;font-weight:650;letter-spacing:.1px}
  header .carimbo{margin-left:auto;font-size:12.5px;opacity:.75;text-align:right}
  main{max-width:1180px;margin:0 auto;padding:22px 20px 8px}
  .filtro{display:flex;align-items:center;gap:10px;margin:0 0 18px}
  .filtro label{font-size:13.5px;font-weight:600;color:var(--navy)}
  .filtro select{padding:9px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;background:#fff;color:var(--tinta);min-width:220px}
  .filtro select:focus{outline:2px solid #0a425f}
  .observacao{background:#fff8e6;border-left:4px solid var(--ambar);border-radius:0 10px 10px 0;padding:12px 16px;margin:0 0 18px;font-size:14.5px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
  .kpi{background:var(--card);border-radius:14px;padding:18px 20px;box-shadow:0 1px 2px rgba(2,32,51,.06),0 4px 14px rgba(2,32,51,.05)}
  .kpi .rotulo{font-size:13px;color:var(--tinta2);font-weight:500}
  .kpi .valor{font-size:26px;font-weight:700;margin-top:6px;color:var(--navy);letter-spacing:-.3px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .kpi .delta{font-size:13px;margin-top:6px;font-weight:600;min-height:16px}
  .kpi .delta span{color:var(--tinta2);font-weight:400}
  .kpi .delta.pos{color:#047857}.kpi .delta.neg{color:#b91c1c}
  .pg{font-size:13.5px}
  .pg-geral .pg-linha{margin-bottom:14px}
  .pg-geral .pg-rotulo{font-weight:700;color:var(--navy)}
  .pg-geral .pg-barra{height:20px;border-radius:10px}
  .pg-linha{display:flex;align-items:center;gap:10px;padding:5px 0}
  .pg-item>summary.pg-linha{cursor:pointer;list-style:none}
  .pg-item>summary.pg-linha::before{content:'▸';color:var(--tinta2);width:12px;flex:0 0 12px;transition:transform .12s}
  .pg-item[open]>summary.pg-linha::before{transform:rotate(90deg)}
  .pg-linha:not(summary)::before{content:'';width:12px;flex:0 0 12px}
  .pg-rotulo{flex:0 0 190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .pg-n2 .pg-rotulo,.pg-n3 .pg-rotulo{font-weight:400}
  .pg-barra{flex:1;height:13px;border-radius:7px;overflow:hidden;display:flex;background:#eef2f6}
  .pg-seg{height:100%}
  .pg-pct{flex:0 0 52px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
  .pg-extra{flex:0 0 auto;color:var(--tinta2);font-size:12px}
  .pg-filhos{margin:2px 0 8px 22px;padding-left:10px;border-left:2px solid var(--grade)}
  .pg-fichas{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 8px 22px}
  .pg-ficha{font-size:11px;padding:2px 7px;border-radius:6px;font-variant-numeric:tabular-nums;cursor:default}
  .pg-legenda{display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;padding-top:10px;border-top:1px solid var(--grade);color:var(--tinta2);font-size:12.5px}
  .pg-leg{display:inline-flex;align-items:center;gap:6px}
  .pg-cor{width:12px;height:12px;border-radius:4px;display:inline-block}
  @media (max-width:640px){.pg-rotulo{flex-basis:110px}.pg-extra{display:none}}
  .graficos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr));gap:16px}
  .card{background:var(--card);border-radius:14px;padding:18px 20px 8px;box-shadow:0 1px 2px rgba(2,32,51,.06),0 4px 14px rgba(2,32,51,.05)}
  .card.cheia{grid-column:1/-1}
  .card h2{font-size:15px;margin:0 0 4px;font-weight:650;color:var(--navy)}
  .trilha{font-size:12.5px;min-height:18px;color:var(--tinta2);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .trilha button{border:0;background:none;color:#0a425f;cursor:pointer;font-size:12.5px;padding:0;font-weight:600}
  .trilha button:hover{text-decoration:underline}
  .trilha .atual{color:var(--tinta);font-weight:600}
  .trilha .dica{margin-left:auto;color:#94a3b8;font-style:italic}
  .grafico{height:320px;overflow:hidden}
  .card.cheia .grafico{height:340px}
  .grafico.tabela,.card .grafico.tabela,.card.cheia .grafico.tabela{height:auto;min-height:0;overflow:visible}
  .tb-barra{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 10px}
  .tb-barra input{flex:1;min-width:170px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px}
  .tb-barra input:focus{outline:2px solid #0a425f;border-color:#0a425f}
  .tb-barra select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:9px;font-size:12.5px;background:#fff;color:var(--tinta);max-width:200px}
  .tb-cont{margin-left:auto;font-size:12px;color:var(--tinta2)}
  .tb-rolagem{overflow:auto;max-height:440px;border:1px solid var(--grade);border-radius:10px}
  table.tb{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}
  .tb thead th{position:sticky;top:0;background:#f6f9fb;color:var(--navy);font-weight:650;text-align:left;padding:10px 12px;border-bottom:2px solid var(--grade);cursor:pointer;white-space:nowrap;user-select:none;z-index:1}
  .tb thead th.asc::after{content:' ▲';font-size:10px;color:#0a425f}
  .tb thead th.desc::after{content:' ▼';font-size:10px;color:#0a425f}
  .tb td{padding:8px 12px;border-bottom:1px solid var(--grade);white-space:nowrap}
  .tb tbody tr:hover{background:#f6f9fb}
  .tb .c-moeda,.tb .c-numero,.tb .c-pct{text-align:right}
  details{font-size:12.5px;color:var(--tinta2);padding:4px 0 10px}
  details table{border-collapse:collapse;margin-top:8px;font-variant-numeric:tabular-nums}
  details th,details td{border:1px solid var(--grade);padding:4px 10px;text-align:left}
  footer{max-width:1180px;margin:0 auto;padding:14px 20px 26px;color:#94a3b8;font-size:12px;text-align:center}
  details > div{overflow-x:auto}
  @media (max-width:640px){
    header{flex-wrap:wrap;padding:14px 16px}header .carimbo{margin-left:0;text-align:left}
    main{padding:16px 12px 6px}
    .graficos{grid-template-columns:1fr;gap:12px}
    .kpis{grid-template-columns:repeat(2,1fr);gap:10px}
    .kpi{padding:14px 14px}.kpi .valor{font-size:22px}
    .card{padding:14px 12px 6px}
    .grafico{height:260px}.card.cheia .grafico{height:280px}
    .filtro select{flex:1;min-width:0}
    .trilha button,.trilha .atual{padding:6px 2px}
    .trilha .dica{margin-left:0;width:100%}
    .tb-barra input{flex-basis:100%}
    .tb-barra select{max-width:47%}
    .tb-cont{margin-left:0;width:100%}
    .tb thead th,.tb td{padding:7px 9px;font-size:12px}
    .tb-rolagem{max-height:60vh}
    .grafico.tabela,.card.cheia .grafico.tabela{height:auto}
  }
  @media print{body{background:#fff}.card,.kpi{box-shadow:none;border:1px solid var(--grade)}details,.filtro{display:none}}
</style>
</head>
<body>
<header>${logo ? `<img src="${logo}" alt="TOTVS Chef">` : ''}<h1>${esc(spec.titulo)}</h1><div class="carimbo">${esc(carimbo)}</div></header>
<main>
  ${spec.observacao ? `<p class="observacao">${esc(spec.observacao)}</p>` : ''}
  ${filtroHtml}
  <div class="kpis">${kpisHtml}</div>
  <div class="graficos">${graficosHtml}</div>
</main>
<footer>Assistente de Gestão — projeto da MHI Sistemas (revenda TOTVS Food Linha Chef). Não é um produto oficial TOTVS. Uso por conta e risco do usuário.</footer>
<script>${echarts}</script>
<script>
const PAINEL = ${dadosJson};
const PALETA = ${JSON.stringify(PALETA)};
const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL',
  ...(Math.abs(v ?? 0) >= 100000 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) });
const fmt = (v, formato) => v === null || v === undefined ? '—'
  : formato === 'moeda' ? brl(v)
  : formato === 'pct' ? (Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%')
  : formato === 'inteiro' ? Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
  : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const abreviar = (v, formato) => {
  const abs = Math.abs(v);
  const corpo = abs >= 1e6 ? (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi'
    : abs >= 1e3 ? (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil'
    : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  return formato === 'moeda' ? 'R$ ' + corpo : corpo;
};
const ehDia = (s) => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(s));
// Regra pt-BR (nunca mostrar 2026-01 ao gestor): dia ISO vira DD/MM e mes
// ISO (AAAA-MM) vira "jan/26".
const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloDia = (s) => {
  const texto = String(s);
  if (ehDia(texto)) return texto.slice(8, 10) + '/' + texto.slice(5, 7);
  if (/^\\d{4}-\\d{2}$/.test(texto)) {
    return MESES_ABREV[Number(texto.slice(5, 7)) - 1] + '/' + texto.slice(2, 4);
  }
  return texto;
};

// Modo movel: reavaliado ao vivo (girar o celular, redimensionar a janela).
let EH_MOVEL = window.matchMedia('(max-width: 640px)').matches;

const EIXOS = {
  axisLine: { lineStyle: { color: '#cbd5e1' } },
  axisTick: { show: false },
  axisLabel: { color: '#64748b', fontSize: 11.5 },
  splitLine: { lineStyle: { color: '#eef2f6' } },
};

function opcoesBase(meta, series) {
  const varias = series && series.length > 1;
  return {
    color: PALETA,
    textStyle: { fontFamily: 'system-ui, sans-serif' },
    grid: { left: 8, right: 16, top: varias ? 42 : 18, bottom: 8, containLabel: true },
    legend: varias
      ? { top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: '#475569', fontSize: 12 } }
      : { show: false },
    tooltip: {
      trigger: meta.tipo === 'linha' ? 'axis' : 'item',
      confine: true, // nunca estoura a tela (essencial no toque)
      axisPointer: { type: meta.tipo === 'linha' ? 'cross' : 'shadow', label: { show: false } },
      textStyle: { fontSize: 12.5 },
      // Serie unica: so categoria e valor — sem nome tecnico de consulta.
      formatter: varias ? undefined : (p) => {
        const item = Array.isArray(p) ? p[0] : p;
        return '<b>' + rotuloDia(item.name) + '</b><br>' + fmt(item.value, meta.formato);
      },
      valueFormatter: (v) => fmt(v, meta.formato),
    },
  };
}

function marcasDeCalendario(categorias) {
  const dentro = PAINEL.marcas.filter((m) => categorias.includes(m.data));
  if (dentro.length === 0) return {};
  return { markLine: {
    symbol: 'none', silent: true,
    lineStyle: { color: '#feac0e', type: 'dashed', width: 1.5 },
    label: { formatter: (p) => p.name, color: '#92600a', fontSize: 10.5 },
    data: dentro.map((m) => ({ xAxis: m.data, name: m.nome })),
  } };
}

function montarOpcoes(meta, d) {
  const drillavel = !!(d.filhos && Object.keys(d.filhos).length);
  if (meta.tipo === 'rosca') {
    const total = (d.fatias ?? []).reduce((s, f) => s + f.valor, 0);
    return { ...opcoesBase(meta, []), series: [{
      type: 'pie', radius: EH_MOVEL ? ['38%', '62%'] : ['52%', '76%'], padAngle: 1.5, cursor: drillavel ? 'pointer' : 'default',
      itemStyle: { borderRadius: 5, borderColor: '#fff', borderWidth: 2 },
      label: { formatter: (p) => p.name + '\\n' + (total ? (p.value * 100 / total).toFixed(0) : 0) + '%', color: '#475569', fontSize: EH_MOVEL ? 10.5 : 12, lineHeight: EH_MOVEL ? 13 : 15 },
      labelLine: { lineStyle: { color: '#cbd5e1' } },
      data: (d.fatias ?? []).map((f) => ({ name: f.nome, value: f.valor })),
    }] };
  }
  const opcoes = opcoesBase(meta, d.series);
  if (meta.tipo === 'barras_h') {
    opcoes.xAxis = { type: 'value', ...EIXOS, axisLabel: { ...EIXOS.axisLabel, formatter: (v) => abreviar(v, meta.formato) } };
    opcoes.yAxis = { type: 'category', inverse: true, data: d.categorias, ...EIXOS, axisLabel: { ...EIXOS.axisLabel, width: EH_MOVEL ? 88 : 150, overflow: 'truncate' }, splitLine: { show: false } };
    opcoes.series = d.series.map((s) => ({
      type: 'bar', name: s.nome, data: s.valores, barMaxWidth: 20, cursor: drillavel ? 'pointer' : 'default',
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: { show: d.series.length === 1, position: 'right', formatter: (p) => abreviar(p.value, meta.formato), color: '#475569', fontSize: 11.5 },
    }));
  } else if (meta.tipo === 'barras') {
    opcoes.xAxis = { type: 'category', data: d.categorias.map(rotuloDia), ...EIXOS, splitLine: { show: false } };
    opcoes.yAxis = { type: 'value', ...EIXOS, axisLabel: { ...EIXOS.axisLabel, formatter: (v) => abreviar(v, meta.formato) } };
    opcoes.series = d.series.map((s) => ({ type: 'bar', name: s.nome, data: s.valores, barMaxWidth: 26, cursor: drillavel ? 'pointer' : 'default', itemStyle: { borderRadius: [4, 4, 0, 0] } }));
  } else { // linha
    opcoes.xAxis = { type: 'category', boundaryGap: false, data: d.categorias, ...EIXOS, axisLabel: { ...EIXOS.axisLabel, formatter: rotuloDia }, splitLine: { show: false } };
    opcoes.yAxis = { type: 'value', ...EIXOS, axisLabel: { ...EIXOS.axisLabel, formatter: (v) => abreviar(v, meta.formato) } };
    opcoes.series = d.series.map((s, si) => ({
      type: 'line', name: s.nome, data: s.valores, smooth: 0.15,
      lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 7, showSymbol: d.categorias.length <= 45,
      areaStyle: d.series.length === 1 ? { opacity: 0.07 } : undefined,
      ...(si === 0 ? marcasDeCalendario(d.categorias) : {}),
    }));
  }
  return opcoes;
}

const instancias = PAINEL.metasGraficos.map((meta, i) => {
  if (meta.tipo === 'tabela' || meta.tipo === 'progresso') return null; // nao usam echarts
  const alvo = document.getElementById('g' + i);
  return alvo && typeof echarts !== 'undefined' ? echarts.init(alvo) : null;
});

// ---------- tabela interativa (busca, filtros de coluna, ordenacao) ----------
const estadoTabelas = PAINEL.metasGraficos.map(() => ({ busca: '', filtros: {}, ord: null, dir: 1 }));

function fmtCelula(v, formato) {
  if (v === null || v === undefined || v === '') return '—';
  if (formato === 'data') {
    const d = String(v);
    return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(2, 4) + (d.length > 10 ? ' ' + d.slice(11, 16) : '');
  }
  if (formato === 'moeda') return brl(v);
  if (formato === 'pct') return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  if (formato === 'numero') return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  return String(v);
}

function renderTabela(i, no) {
  const alvo = document.getElementById('g' + i);
  if (!alvo) return;
  alvo.classList.add('tabela');
  const st = estadoTabelas[i];
  const cols = no.colunas ?? [];
  // filtros: colunas de texto com poucas opcoes distintas viram seletor
  const opcoesFiltro = cols.map((c, ci) => {
    if (c.formato !== 'texto') return null;
    const unicos = [...new Set(no.dados.map((l) => l[ci]).filter((v) => v !== null && v !== undefined))];
    return unicos.length >= 2 && unicos.length <= 15 ? unicos.sort() : null;
  });
  let linhas = no.dados;
  const busca = st.busca.trim().toLowerCase();
  if (busca) linhas = linhas.filter((l) => l.some((v) => String(v ?? '').toLowerCase().includes(busca)));
  for (const [ci, val] of Object.entries(st.filtros)) {
    if (val) linhas = linhas.filter((l) => String(l[ci]) === val);
  }
  if (st.ord !== null) {
    const ci = st.ord; const dir = st.dir;
    linhas = [...linhas].sort((a, b) => {
      const x = a[ci]; const y = b[ci];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }
  const cab = cols.map((c, ci) => '<th data-ci="' + ci + '" class="c-' + c.formato + ' ' + (st.ord === ci ? (st.dir === 1 ? 'asc' : 'desc') : '') + '">' + c.rotulo + '</th>').join('');
  const corpo = linhas.map((l) => '<tr>' + l.map((v, ci) => '<td class="c-' + cols[ci].formato + '">' + fmtCelula(v, cols[ci].formato) + '</td>').join('') + '</tr>').join('');
  const filtrosHtml = opcoesFiltro.map((op, ci) => op
    ? '<select data-fci="' + ci + '"><option value="">' + cols[ci].rotulo + ': todos</option>'
      + op.map((o) => '<option' + (st.filtros[ci] === String(o) ? ' selected' : '') + '>' + String(o) + '</option>').join('') + '</select>'
    : '').join('');
  alvo.innerHTML = '<div class="tb-barra"><input type="search" placeholder="Buscar em tudo..." value="' + st.busca.replace(/"/g, '&quot;') + '">' + filtrosHtml
    + '<span class="tb-cont">' + linhas.length.toLocaleString('pt-BR') + ' de ' + no.dados.length.toLocaleString('pt-BR') + ' linha(s)' + (no.truncada ? ' — mostrando as primeiras' : '') + '</span></div>'
    + '<div class="tb-rolagem"><table class="tb"><thead><tr>' + cab + '</tr></thead><tbody>' + corpo + '</tbody></table></div>';
  const campoBusca = alvo.querySelector('input[type=search]');
  campoBusca.addEventListener('input', () => {
    st.busca = campoBusca.value;
    renderTabela(i, no);
    const novo = alvo.querySelector('input[type=search]');
    novo.focus();
    novo.setSelectionRange(novo.value.length, novo.value.length);
  });
  alvo.querySelectorAll('select[data-fci]').forEach((sel) => sel.addEventListener('change', () => {
    st.filtros[sel.dataset.fci] = sel.value;
    renderTabela(i, no);
  }));
  alvo.querySelectorAll('th[data-ci]').forEach((th) => th.addEventListener('click', () => {
    const ci = Number(th.dataset.ci);
    if (st.ord === ci) st.dir = -st.dir;
    else { st.ord = ci; st.dir = cols[ci].formato === 'texto' ? 1 : -1; }
    renderTabela(i, no);
  }));
}
let conjuntoAtual = 0;
const caminhos = PAINEL.metasGraficos.map(() => []); // drill-down por grafico

function noAtual(i) {
  let no = PAINEL.conjuntos[conjuntoAtual].graficos[i];
  for (const passo of caminhos[i]) no = (no.filhos ?? {})[passo] ?? no;
  return no;
}

function desenharTrilha(i) {
  const alvo = document.getElementById('trilha' + i);
  if (!alvo) return;
  const caminho = caminhos[i];
  const no = noAtual(i);
  const drillavel = no.filhos && Object.keys(no.filhos).length;
  if (caminho.length === 0) {
    alvo.innerHTML = drillavel ? '<span class="dica">clique para detalhar</span>' : '';
    return;
  }
  let html = '<button data-nivel="0">Início</button>';
  caminho.forEach((nome, n) => {
    html += ' ▸ ' + (n === caminho.length - 1
      ? '<span class="atual"></span>'
      : '<button data-nivel="' + (n + 1) + '"></button>');
  });
  alvo.innerHTML = html + (drillavel ? '<span class="dica">clique para detalhar</span>' : '');
  // nomes via textContent (dados podem ter caracteres especiais)
  const botoes = alvo.querySelectorAll('button[data-nivel]');
  botoes.forEach((b) => {
    const nivel = Number(b.dataset.nivel);
    if (nivel > 0) b.textContent = caminho[nivel - 1];
    b.addEventListener('click', () => { caminhos[i] = caminho.slice(0, nivel); desenharGrafico(i); });
  });
  const atual = alvo.querySelector('.atual');
  if (atual) atual.textContent = caminho[caminho.length - 1];
}

function desenharGrafico(i) {
  const meta = PAINEL.metasGraficos[i];
  if (meta.tipo === 'progresso') return; // estatico, ja veio pronto no HTML
  const no = noAtual(i);
  const detalhes = document.getElementById('tab' + i)?.closest('details');
  if (meta.tipo === 'tabela') {
    renderTabela(i, no);
    if (detalhes) detalhes.style.display = 'none'; // a entrega JA e a tabela
    return;
  }
  if (instancias[i]) instancias[i].setOption(montarOpcoes(meta, no), true);
  const tabela = document.getElementById('tab' + i);
  if (tabela) tabela.innerHTML = no.tabela;
  desenharTrilha(i);
}

function render(indice) {
  conjuntoAtual = indice;
  const conjunto = PAINEL.conjuntos[indice];
  PAINEL.metasKpis.forEach((meta, i) => {
    const k = conjunto.kpis[i];
    document.getElementById('kpi' + i).textContent = fmt(k.valor, meta.formato);
    const alvoDelta = document.getElementById('kpiDelta' + i);
    if (k.delta !== null && k.delta !== undefined && isFinite(k.delta)) {
      const bom = k.delta >= 0;
      alvoDelta.className = 'delta ' + (bom ? 'pos' : 'neg');
      alvoDelta.innerHTML = (bom ? '▲' : '▼') + ' ' + Math.abs(k.delta).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% <span>vs período anterior</span>';
    } else { alvoDelta.className = 'delta'; alvoDelta.innerHTML = ''; }
  });
  PAINEL.metasGraficos.forEach((meta, i) => { caminhos[i] = []; desenharGrafico(i); });
}

instancias.forEach((grafico, i) => {
  if (!grafico) return;
  grafico.on('click', (params) => {
    const no = noAtual(i);
    const nome = params.name;
    if (no.filhos && no.filhos[nome]) { caminhos[i].push(nome); desenharGrafico(i); }
  });
});

render(0);
const seletor = document.getElementById('filtro');
if (seletor) seletor.addEventListener('change', () => render(Number(seletor.value)));
window.addEventListener('resize', () => {
  const movelAgora = window.matchMedia('(max-width: 640px)').matches;
  if (movelAgora !== EH_MOVEL) {
    EH_MOVEL = movelAgora;
    PAINEL.metasGraficos.forEach((_, i) => desenharGrafico(i));
  }
  instancias.forEach((g) => g && g.resize());
});
</script>
</body>
</html>`;
}

const SPEC_EXEMPLO = {
  titulo: 'Painel de Vendas — Minha Loja',
  periodo: { de: '2026-09-01', ate: '2026-09-23' },
  observacao: 'Frase curta do assistente com o principal destaque do período (opcional).',
  filtro: {
    rotulo: 'Loja', todas: 'Todas as lojas', parametro: 'loja',
    opcoes_sql: "SELECT DISTINCT codigo_loja, 'Loja ' || codigo_loja FROM vendas WHERE cancelada=0 ORDER BY 1",
  },
  kpis: [
    { rotulo: 'Faturamento', formato: 'moeda', sql: "SELECT SUM(valor_total) FROM vendas WHERE cancelada=0 AND ('{{loja}}'='' OR codigo_loja='{{loja}}') AND data_movimento BETWEEN '2026-09-01' AND '2026-09-23'" },
    { rotulo: 'Cupons', formato: 'inteiro', sql: "SELECT COUNT(*) FROM vendas WHERE cancelada=0 AND ('{{loja}}'='' OR codigo_loja='{{loja}}') AND data_movimento BETWEEN '2026-09-01' AND '2026-09-23'" },
  ],
  graficos: [
    { tipo: 'linha', titulo: 'Faturamento por dia', formato: 'moeda', largura: 'cheia', sql: "SELECT data_movimento, ROUND(SUM(valor_total),2) FROM vendas WHERE cancelada=0 AND ('{{loja}}'='' OR codigo_loja='{{loja}}') GROUP BY 1 ORDER BY 1" },
    { tipo: 'rosca', titulo: 'Meios de pagamento', formato: 'moeda', sql: "SELECT descricao, ROUND(SUM(valor_recebido),2) FROM venda_pagamentos GROUP BY 1" },
    { tipo: 'barras_h', titulo: 'Vendas por categoria', formato: 'moeda', niveis: [
      { sql: "SELECT grupo, ROUND(SUM(valor_total),2) FROM venda_itens WHERE status=1 AND codigo_produto NOT IN (997,999) GROUP BY 1 ORDER BY 2 DESC" },
      { sql: "SELECT subgrupo, ROUND(SUM(valor_total),2) FROM venda_itens WHERE status=1 AND grupo='{{pai}}' GROUP BY 1 ORDER BY 2 DESC" },
      { sql: "SELECT nome_produto, ROUND(SUM(valor_total),2) FROM venda_itens WHERE status=1 AND subgrupo='{{pai}}' GROUP BY 1 ORDER BY 2 DESC LIMIT 15" },
    ] },
  ],
};

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
    if (acao === 'exemplo') {
      console.log(JSON.stringify(SPEC_EXEMPLO, null, 2));
    } else if (acao === 'gerar') {
      if (!args.spec) {
        console.error('Uso: painel.mjs gerar --spec <arquivo.json|-> [--saida relatorios/painel.html] [--abrir]');
        process.exitCode = 1;
      } else {
        const bruto = args.spec === '-' ? readFileSync(0, 'utf8') : readFileSync(args.spec, 'utf8');
        const spec = JSON.parse(bruto);
        if (!spec.titulo) throw new Error('a especificação precisa de um "titulo"');
        const dados = executarSpec(spec);
        const html = gerarHtml(spec, dados);
        const saida = args.saida ?? join(RAIZ, 'relatorios', 'paineis', `painel-${new Date().toISOString().slice(0, 10)}.html`);
        mkdirSync(dirname(resolve(saida)), { recursive: true });
        writeFileSync(saida, html, 'utf8');
        console.log(`✅ Painel gerado: ${resolve(saida)} (${dados.conjuntos.length} recorte(s), ${(spec.kpis ?? []).length} indicador(es), ${(spec.graficos ?? []).length} gráfico(s), ${dados.marcas.length} marca(s) de calendário)`);
        if (args.abrir) abrirNoSistema(resolve(saida), () => console.warn('Não consegui abrir o navegador; abra o arquivo manualmente.'));
      }
    } else {
      console.error('Acao invalida. Use: gerar --spec <arquivo|-> [--saida x.html] [--abrir] | exemplo');
      process.exitCode = 1;
    }
  } catch (erro) {
    console.error(`Não consegui gerar o painel: ${erro.message}`);
    process.exitCode = 1;
  }
}
