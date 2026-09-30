// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// INVENTARIOS CONTADOS, importados da planilha do ChefWeb.
//
// Por que existe: a API de estoque (Estoque/ListarEstoque) NAO aceita data —
// ela so devolve a posicao de hoje. Quem instala o assistente agora nao tem
// como calcular o CMV real de nenhum mes passado, porque o historico de
// estoque so comeca na primeira fotografia da rotina diaria. O inventario que
// o gestor ja conta no ChefWeb preenche esse buraco: com a contagem do
// primeiro e a do ultimo dia do mes, o CMV real do periodo fecha.
//
// Brinde importante: a coluna "Valor" da planilha e o valor da DIFERENCA (nao
// o do estoque contado). Dividido pela diferenca, devolve o CUSTO UNITARIO
// praticado NA DATA da contagem — o unico custo historico que o ChefWeb
// entrega, ja que o catalogo da API e sobrescrito a cada sincronizacao.
//
// De onde o gestor tira o arquivo: ChefWeb -> Relatorios -> Relatorios ->
// "41 - Listagem de Inventario". Passo a passo com imagens em
// docs/ajuda/exportar-inventario.md. EXPORTE EM EXCEL: a exportacao em CSV do
// ChefWeb ignora as colunas de Loja, Data e N. Inventario (defeito conhecido
// do sistema), e sem elas nao da para saber de qual contagem e cada linha.
//
// Uso:
//   node --no-warnings scripts/inventario.mjs importar --arquivo <planilha>
//        [--grupo <id>] [--loja <n>] [--data AAAA-MM-DD] [--simular]
//   node --no-warnings scripts/inventario.mjs listar [--grupo <id>]
//   node --no-warnings scripts/inventario.mjs remover --data AAAA-MM-DD
//        [--loja <n>] [--numero <n>] [--grupo <id>] --confirmar

import { existsSync } from 'node:fs';
import { abrirBanco, criarSchema } from './criar-banco.mjs';
import { selecionarConexoes } from './conexoes.mjs';
import { lerPlanilha, dataDoExcel } from './planilha.mjs';

function lerArgs() {
  const args = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const nome = argv[i].slice(2);
    const proximo = argv[i + 1];
    if (proximo && !proximo.startsWith('--')) { args[nome] = proximo; i += 1; }
    else args[nome] = true;
  }
  return args;
}

const brl = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

// Titulo de coluna -> chave interna. Sem acento, sem espaco, sem pontuacao,
// porque o mesmo relatorio sai como "Qtde Contada" na planilha e "Inventario"
// no CSV, e "Nº Inventario" pode vir com ou sem o ordinal.
function normalizar(t) {
  return String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A ordem importa: "ninventario" precisa ser testado antes de "inventario",
// senao o numero do inventario vira quantidade contada.
const COLUNAS = [
  ['numero', ['ninventario', 'numeroinventario', 'numinventario', 'ninv']],
  ['loja', ['loja', 'codigoloja', 'lojas', 'cdloja']],
  ['data', ['data', 'datainventario', 'dtinventario', 'datacontagem']],
  ['codigo_produto', ['codigo', 'codigoproduto', 'cdproduto']],
  ['nome', ['produto', 'nomeproduto', 'descricao', 'descricaoproduto']],
  ['grupo', ['grupo']],
  ['subgrupo', ['subgrupo']],
  ['contada', ['qtdecontada', 'inventario', 'quantidadecontada', 'qtdinventario']],
  ['sistema', ['qtdeatual', 'estoque', 'quantidadeatual', 'saldo']],
  ['diferenca', ['diferenca', 'dif']],
  ['unidade', ['un', 'unidade', 'unidademedida']],
  ['valor', ['valor', 'valordiferenca']],
  ['motivo', ['motivo']],
];

// O CSV do ChefWeb sai com campos A MAIS em algumas linhas: a planilha tem
// colunas em branco intercaladas, e o gerador de CSV as emite como separadores
// soltos so quando o produto nao tem nome. Sem corrigir, a linha inteira
// desliza e a quantidade contada vira vazio — errado em silencio, que e o pior
// tipo de erro. Como as colunas do fim (quantidades, unidade, valor, motivo)
// sao as que importam, descartamos os vazios excedentes do miolo ate o tamanho
// bater; se ainda sobrar excesso, e nome com separador dentro, e ai juntamos.
function ajustarLinha(campos, largura, iNome) {
  if (campos.length <= largura) return campos;
  const ajustada = [...campos];
  // Varre o miolo de tras para frente para nao mexer no codigo (primeira
  // coluna) nem nas colunas finais.
  for (let i = ajustada.length - 7; i > 0 && ajustada.length > largura; i -= 1) {
    if (ajustada[i] === '') ajustada.splice(i, 1);
  }
  if (ajustada.length > largura && iNome !== undefined && iNome >= 0) {
    const sobra = ajustada.length - largura;
    ajustada.splice(iNome, sobra + 1, ajustada.slice(iNome, iNome + sobra + 1).join(';'));
  }
  return ajustada;
}

function mapearCabecalho(linha) {
  const mapa = {};
  linha.forEach((titulo, i) => {
    const t = normalizar(titulo);
    if (!t) return;
    for (const [chave, apelidos] of COLUNAS) {
      if (mapa[chave] !== undefined) continue;
      if (apelidos.includes(t)) { mapa[chave] = i; return; }
    }
  });
  return mapa;
}

// Numero em qualquer das convencoes que o ChefWeb usa: a planilha grava com
// ponto decimal (formato invariante), a tela e o CSV com virgula, e o rodape
// de totais mistura ponto de milhar com virgula decimal.
function numero(txt) {
  const t = String(txt ?? '').trim();
  if (!t) return null;
  let limpo = t.replace(/\s/g, '');
  const temVirgula = limpo.includes(',');
  const temPonto = limpo.includes('.');
  if (temVirgula && temPonto) {
    // O separador que aparece por ULTIMO e o decimal.
    limpo = limpo.lastIndexOf(',') > limpo.lastIndexOf('.')
      ? limpo.replace(/\./g, '').replace(',', '.')
      : limpo.replace(/,/g, '');
  } else if (temVirgula) {
    limpo = limpo.replace(',', '.');
  }
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

// Data em serial do Excel, DD/MM/AAAA ou AAAA-MM-DD.
function data(txt) {
  const t = String(txt ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const br = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d+([.,]\d+)?$/.test(t)) return dataDoExcel(numero(t));
  return null;
}

function importar(db, args) {
  const caminho = args.arquivo;
  if (!caminho || caminho === true) {
    throw new Error('Diga qual é o arquivo: --arquivo "caminho/da/planilha.xlsx"');
  }
  if (!existsSync(caminho)) throw new Error(`Não encontrei o arquivo: ${caminho}`);

  const conexoes = selecionarConexoes(args.grupo === true ? undefined : args.grupo);
  if (conexoes.length > 1) {
    throw new Error(`Você tem mais de um grupo de lojas. Diga de qual é este inventário: `
      + `--grupo ${conexoes.map((c) => c.id).join(' | --grupo ')}`);
  }
  const conexao = conexoes[0].id;

  const linhas = lerPlanilha(caminho);
  const iCabecalho = linhas.findIndex((l) => {
    const m = mapearCabecalho(l);
    return m.codigo_produto !== undefined && m.contada !== undefined;
  });
  if (iCabecalho < 0) {
    throw new Error('Não reconheci as colunas desta planilha. Ela precisa ser o relatório '
      + '"41 - Listagem de Inventário" do ChefWeb, exportado em Excel.');
  }
  const mapa = mapearCabecalho(linhas[iCabecalho]);

  // Loja e data podem vir como coluna (Excel, com os campos arrastados do
  // agrupador para a lista) ou ser informadas por quem importa. Sem uma das
  // duas, nao da para saber a que contagem a linha pertence.
  const lojaFixa = args.loja && args.loja !== true ? Number(args.loja) : null;
  const dataFixa = args.data && args.data !== true ? data(args.data) : null;
  if (mapa.loja === undefined && lojaFixa === null) {
    throw new Error('A planilha não tem a coluna "Loja" e você não disse de qual loja é. '
      + 'Ou arraste o campo Loja para a lista no ChefWeb e exporte de novo '
      + '(veja docs/ajuda/exportar-inventario.md), ou informe --loja <número>.');
  }
  if (mapa.data === undefined && dataFixa === null) {
    throw new Error('A planilha não tem a coluna "Data" e você não disse de que dia é a contagem. '
      + 'Ou arraste o campo Data para a lista no ChefWeb e exporte de novo, ou informe '
      + '--data AAAA-MM-DD.');
  }

  const largura = linhas[iCabecalho].length;
  const registros = [];
  let deslocadas = 0;
  const descartadas = { semProduto: 0, semData: 0, rodape: 0 };
  for (const bruta of linhas.slice(iCabecalho + 1)) {
    const l = ajustarLinha(bruta, largura, mapa.nome);
    const codigo = numero(l[mapa.codigo_produto]);
    // Rodape de totais: o ChefWeb fecha a planilha com uma linha que traz a
    // contagem de registros na 1a coluna e a soma dos valores, sem produto.
    if (codigo === null || !Number.isInteger(codigo)) { descartadas.semProduto += 1; continue; }
    const dia = mapa.data !== undefined ? (data(l[mapa.data]) ?? dataFixa) : dataFixa;
    if (!dia) { descartadas.semData += 1; continue; }
    const loja = mapa.loja !== undefined ? (numero(l[mapa.loja]) ?? lojaFixa) : lojaFixa;
    if (loja === null) { descartadas.rodape += 1; continue; }

    let contada = numero(l[mapa.contada]);
    let nome = mapa.nome !== undefined ? String(l[mapa.nome] ?? '').trim() : '';
    const sistema = mapa.sistema !== undefined ? numero(l[mapa.sistema]) : null;
    const diferenca = mapa.diferenca !== undefined ? numero(l[mapa.diferenca]) : null;
    const valor = mapa.valor !== undefined ? numero(l[mapa.valor]) : null;

    // DEFEITO DO CHEFWEB (vale para Excel e CSV): quando o produto nao tem
    // nome cadastrado, os valores da linha DESLIZAM uma coluna — a quantidade
    // contada aparece onde deveria estar o nome, e a coluna da quantidade fica
    // vazia. Sem corrigir, esses itens entram no inventario com quantidade
    // nula e o estoque sai subestimado, em silencio.
    // So corrigimos quando a aritmetica confirma (contada - atual = diferenca),
    // para nao estragar um produto que legitimamente se chame "123".
    if (contada === null && nome && /^-?[\d.,]+$/.test(nome)) {
      const candidato = numero(nome);
      const confere = sistema === null || diferenca === null
        || Math.abs(candidato - sistema - diferenca) < 0.001;
      if (candidato !== null && confere) { contada = candidato; nome = ''; deslocadas += 1; }
    }
    registros.push({
      data: dia,
      loja,
      numero: mapa.numero !== undefined ? String(l[mapa.numero] ?? '').trim() : '',
      codigo_produto: codigo,
      nome: nome || null,
      unidade: mapa.unidade !== undefined ? (l[mapa.unidade] ?? '').trim() : null,
      contada,
      sistema,
      diferenca,
      valor,
      // O custo unitario so existe onde houve diferenca: sem diferenca, o
      // ChefWeb grava valor zero e nao ha o que dividir.
      custo: diferenca && valor !== null && diferenca !== 0
        ? Math.abs(valor / diferenca) : null,
      motivo: mapa.motivo !== undefined ? (l[mapa.motivo] ?? '').trim() : null,
    });
  }

  if (registros.length === 0) {
    throw new Error('A planilha não tem nenhuma linha de inventário aproveitável.');
  }

  // Sem o numero do inventario, duas contagens do mesmo produto no mesmo dia e
  // loja colidem na mesma chave — uma sobrescreve a outra em silencio.
  const chaves = new Set();
  let colisoes = 0;
  for (const r of registros) {
    const k = `${r.data}|${r.loja}|${r.numero}|${r.codigo_produto}`;
    if (chaves.has(k)) colisoes += 1;
    chaves.add(k);
  }

  const contagens = new Map();
  for (const r of registros) {
    const k = `${r.data}|${r.loja}`;
    const c = contagens.get(k) ?? { data: r.data, loja: r.loja, itens: 0, numeros: new Set() };
    c.itens += 1;
    if (r.numero) c.numeros.add(r.numero);
    contagens.set(k, c);
  }

  console.log(`INVENTÁRIO — ${conexao}`);
  console.log(`Arquivo: ${caminho}`);
  console.log(`${registros.length} linha(s) de contagem em ${contagens.size} inventário(s):`);
  for (const c of [...contagens.values()].sort((a, b) => a.data.localeCompare(b.data) || a.loja - b.loja)) {
    console.log(`  ${dmy(c.data)}  loja ${String(c.loja).padStart(3)}  ${String(c.itens).padStart(5)} item(ns)`
      + (c.numeros.size > 0 ? `  nº ${[...c.numeros].join(', ')}` : ''));
  }
  if (colisoes > 0) {
    console.log(`\n⚠️ ${colisoes} linha(s) repetem produto no mesmo dia e loja sem número de `
      + 'inventário que as diferencie — só a última de cada uma será guardada. '
      + 'Arraste o campo "Nº Inventario" para a lista no ChefWeb e exporte de novo.');
  }
  if (deslocadas > 0) {
    console.log(`
ℹ️ ${deslocadas} linha(s) vieram com as colunas deslocadas (produto sem nome `
      + 'no cadastro — defeito do ChefWeb); a quantidade foi recuperada pela própria planilha.');
  }
  const semCusto = registros.filter((r) => r.custo === null).length;
  console.log(`\nCusto unitário da época recuperado em ${registros.length - semCusto} de `
    + `${registros.length} linha(s) (só existe onde houve diferença entre contagem e sistema).`);

  if (args.simular) {
    console.log('\n(simulação: nada foi gravado)');
    return;
  }

  const ins = db.prepare(`INSERT OR REPLACE INTO inventarios
    (conexao, data, codigo_loja, numero, codigo_produto, nome_produto, unidade,
     quantidade_contada, quantidade_sistema, diferenca, valor_diferenca, custo_unitario,
     motivo, arquivo, importado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'))`);
  db.exec('BEGIN');
  try {
    for (const r of registros) {
      ins.run(conexao, r.data, r.loja, r.numero, r.codigo_produto, r.nome || null, r.unidade || null,
        r.contada, r.sistema, r.diferenca, r.valor, r.custo, r.motivo || null, caminho);
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
  console.log(`\n✅ ${registros.length} linha(s) guardada(s). Reimportar o mesmo arquivo não duplica.`);
}

function listar(db, args) {
  const grupo = args.grupo && args.grupo !== true ? args.grupo : null;
  const linhas = db.prepare(`SELECT conexao, data, codigo_loja, numero, COUNT(*) AS itens,
      SUM(CASE WHEN custo_unitario IS NOT NULL THEN 1 ELSE 0 END) AS com_custo,
      ROUND(SUM(quantidade_contada * COALESCE(custo_unitario, 0)), 2) AS valorizado
    FROM inventarios ${grupo ? 'WHERE conexao = ?' : ''}
    GROUP BY conexao, data, codigo_loja, numero
    ORDER BY data DESC, codigo_loja, numero`).all(...(grupo ? [grupo] : []));
  if (linhas.length === 0) {
    console.log('Nenhum inventário importado ainda.');
    console.log('O gestor exporta no ChefWeb: Relatórios → "41 - Listagem de Inventário" '
      + '(em Excel). Passo a passo: docs/ajuda/exportar-inventario.md');
    return;
  }
  console.log('INVENTÁRIOS IMPORTADOS');
  for (const l of linhas) {
    console.log(`  ${dmy(l.data)}  ${l.conexao}  loja ${String(l.codigo_loja).padStart(3)}`
      + `${l.numero ? `  nº ${l.numero}` : ''}  ${String(l.itens).padStart(5)} item(ns)`
      + `  ${l.com_custo} com custo da época  ${brl(l.valorizado)}`);
  }
  console.log('\nO valor acima usa o custo recuperado da própria contagem; itens sem '
    + 'diferença não têm custo e entram como zero — para valorizar o estoque inteiro, '
    + 'o cálculo do CMV completa com o cadastro.');
}

function remover(db, args) {
  const dia = args.data && args.data !== true ? data(args.data) : null;
  if (!dia) throw new Error('Diga de qual dia: --data AAAA-MM-DD');
  if (!args.confirmar) {
    throw new Error('Isto apaga o inventário importado desse dia. Repita com --confirmar '
      + 'se for mesmo o que você quer.');
  }
  const cond = ['data = ?'];
  const params = [dia];
  if (args.grupo && args.grupo !== true) { cond.push('conexao = ?'); params.push(args.grupo); }
  if (args.loja && args.loja !== true) { cond.push('codigo_loja = ?'); params.push(Number(args.loja)); }
  if (args.numero && args.numero !== true) { cond.push('numero = ?'); params.push(String(args.numero)); }
  const n = db.prepare(`DELETE FROM inventarios WHERE ${cond.join(' AND ')}`).run(...params).changes;
  console.log(`${n} linha(s) de inventário removida(s).`);
}

const acao = process.argv[2];
const args = lerArgs();
const db = abrirBanco();
try {
  criarSchema(db);
  if (acao === 'importar') importar(db, args);
  else if (acao === 'listar') listar(db, args);
  else if (acao === 'remover') remover(db, args);
  else {
    console.error('Uso: inventario.mjs importar --arquivo <planilha> [--grupo] [--loja] [--data] [--simular]');
    console.error('   |  inventario.mjs listar [--grupo]');
    console.error('   |  inventario.mjs remover --data AAAA-MM-DD [--loja] [--numero] [--grupo] --confirmar');
    process.exitCode = 1;
  }
} catch (erro) {
  console.error(erro.message);
  process.exitCode = 1;
} finally {
  db.close();
}
