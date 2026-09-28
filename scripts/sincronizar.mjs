// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Sincroniza dados da API do ChefWeb para o banco local data/chef.db.
//
// Uso:
//   node scripts/sincronizar.mjs --dominio vendas --de 2026-09-01 --ate 2026-09-22
//   node scripts/sincronizar.mjs --dominio tudo --de 2026-09-01 --ate 2026-09-22
//   node scripts/sincronizar.mjs --dominio produtos            (sem período: catálogo atual)
//   node scripts/sincronizar.mjs --dominio estoque             (sem período: posição de hoje)
//
// Domínios: vendas, fechamentos, sangrias, provisao, contas-pagar, livro-caixa,
//           notas-venda, notas-entrada, produtos, estoque, clientes, tudo
//
// Rodar o mesmo período duas vezes não duplica dados (os registros do período
// são substituídos).

import {
  selecionarConexoes, chamarPost, chamarGet,
  dataInicioISO, dataFimISO, validarDia,
} from './chef-api.mjs';
import { abrirBanco, criarSchema } from './criar-banco.mjs';

// ---------- utilitários ----------

// Busca um campo no registro ignorando maiúsculas/minúsculas.
function campo(registro, ...nomes) {
  if (!registro || typeof registro !== 'object') return null;
  const mapa = new Map(Object.keys(registro).map((k) => [k.toLowerCase(), k]));
  for (const nome of nomes) {
    const real = mapa.get(nome.toLowerCase());
    if (real !== undefined && registro[real] !== undefined && registro[real] !== null) {
      return registro[real];
    }
  }
  return null;
}

function soDia(valor) {
  if (typeof valor !== 'string') return null;
  const m = valor.match(/^(\d{4}-\d{2}-\d{2})/);
  // "0001-01-01" é o "sem data" do ChefWeb (ex.: conta ainda não paga)
  if (m) return m[1] === '0001-01-01' ? null : m[1];
  const br = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})/); // 22/09/2026
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

// Extrai a lista principal de uma resposta { Sucesso, Erros, <Lista>: [...] }.
// Respostas paginadas usam chaves em inglês: { Success, Errors, Data: [...] }.
const CHAVES_CONTROLE = new Set([
  'sucesso', 'erros', 'success', 'errors', 'mensagens',
  'page', 'pagesize', 'totalrecords', 'totalpages', 'hasnextpage',
]);
function extrairLista(resposta) {
  if (Array.isArray(resposta.Data)) return resposta.Data;
  for (const [nome, valor] of Object.entries(resposta)) {
    if (CHAVES_CONTROLE.has(nome.toLowerCase())) continue;
    if (Array.isArray(valor)) return valor;
    if (valor && typeof valor === 'object') {
      const interna = extrairLista(valor);
      if (interna) return interna;
    }
  }
  return null;
}

function registrarSync(db, config, dominio, loja, de, ate, registros) {
  prepIns(db, config,
    'INSERT INTO sync_log (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, registros) '
    + 'VALUES (?, ?, ?, ?, ?, ?)'
  ).run(config.id, dominio, loja ?? null, de ?? null, ate ?? null, registros);
}

// Toda gravacao carrega a CONEXAO (grupo de lojas) a que pertence: dois grupos
// podem ter a loja 1, o produto 10 ou o fechamento 99 ao mesmo tempo.
// prepIns injeta a coluna conexao no INSERT; prepDel restringe o DELETE ao
// grupo corrente, para uma sincronizacao nunca apagar dados de outro grupo.
function prepIns(db, config, sql) {
  const sqlNovo = sql
    .replace(/INTO\s+(\w+)\s*\(/i, 'INTO $1 (conexao, ')
    .replace(/VALUES\s*\(/i, 'VALUES (?, ');
  const stmt = db.prepare(sqlNovo);
  return { run: (...args) => stmt.run(config.id, ...args) };
}

function prepDel(db, config, sql) {
  const sqlNovo = /where/i.test(sql) ? `${sql} AND conexao = ?` : `${sql} WHERE conexao = ?`;
  const stmt = db.prepare(sqlNovo);
  return { run: (...args) => stmt.run(...args, config.id) };
}

// Lojas cadastradas em `lojas` (lojas.mjs definir|importar).
// Servem de rede de seguranca quando o gestor nao preencheu "Código das lojas"
// na pagina de configuracao — o campo e opcional, mas `fechamentos` e
// `provisao` EXIGEM a lista (erro 11 da API) e falhariam sempre sem ela.
let cacheLojasCadastradas = null;
function lojasCadastradas(config) {
  if (cacheLojasCadastradas?.grupo === config.id) return cacheLojasCadastradas.lojas;
  let lojas = [];
  try {
    const db = abrirBanco({ somenteLeitura: true });
    try {
      lojas = db.prepare('SELECT codigo_loja FROM lojas WHERE conexao = ? ORDER BY codigo_loja')
        .all(config.id).map((l) => l.codigo_loja);
    } finally { db.close(); }
  } catch { /* banco novo ou sem a tabela: segue sem cadastro */ }
  cacheLojasCadastradas = { grupo: config.id, lojas };
  return lojas;
}

// Dominios em que a lista de lojas e OBRIGATORIA na API: sem ela o servidor
// responde erro 11 ("lojas nao informadas corretamente"), que sozinho nao
// diz ao gestor o que fazer. Melhor parar antes, com a orientacao certa.
function exigirLojas(lojas, dominio, config) {
  if (lojas.length > 0) return;
  throw new Error(`O domínio "${dominio}" exige saber de quais lojas buscar, e o grupo `
    + `"${config.id}" ainda não tem loja nenhuma informada. Caminhos: preencher "Código `
    + 'das lojas" na página de configuração, ou cadastrar cada loja com '
    + `"lojas.mjs definir --grupo ${config.id} --loja <n> --inicio AAAA-MM-DD".`);
}

// Loop por loja: a lista configurada manda; na falta dela, as lojas
// cadastradas; sem nenhuma das duas, uma chamada sem código de loja (que
// funciona nos domínios em que o filtro é opcional).
function lojasAlvo(config, lojaArg) {
  if (lojaArg !== undefined) return [Number(lojaArg)];
  if (config.lojas.length > 0) return config.lojas;
  const cadastradas = lojasCadastradas(config);
  return cadastradas.length > 0 ? cadastradas : [null];
}

// Regra da API CapaVenda (confirmada pela própria mensagem de erro do
// servidor): "Para requisições de vendas superiores a 16 dias, por favor
// efetuar as chamadas entre 23:00:00 e 07:00:00." Vale pela IDADE do período
// pedido — um intervalo curto, porém antigo, também é recusado fora da janela.
// A copia bruta do payload (json_original) custa ~3,4 KB por venda e os campos
// que interessam ja estao extraidos em colunas — inclusive os fiscais. Guardar
// a copia so faz sentido quando se esta investigando o mapeamento, entao e
// opcional (--com-json). Nas tabelas de baixo volume ela continua por padrao.
const GUARDAR_JSON_VENDAS = process.argv.includes('--com-json');

const DIAS_HISTORICO = 16;
function foraDaJanelaNoturna() {
  const hora = new Date().getHours();
  return hora >= 7 && hora < 23;
}
function periodoHistorico(de) {
  const limite = new Date(Date.now() - DIAS_HISTORICO * 86400_000).toISOString().slice(0, 10);
  return de < limite;
}

// ---------- domínio: vendas ----------

async function sincronizarVendas(db, config, de, ate, lojaArg) {
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = {
      DataMovimentoInicial: dataInicioISO(de),
      DataMovimentoFinal: dataFimISO(ate),
      Composicoes: true, // traz a ficha técnica consumida em cada item
    };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarPost(config, '/api/CapaVenda/ListPorDataMovimento', corpo);
    const vendas = resposta.Vendas ?? extrairLista(resposta) ?? [];

    // Aproveita o payload para guardar o CNPJ da loja no cadastro (usado na
    // identificacao de chamados ao suporte da TOTVS).
    const cnpjLoja = vendas.find((x) => x.Loja?.CNPJ)?.Loja;
    if (cnpjLoja?.CNPJ) {
      try {
        db.prepare('UPDATE lojas SET cnpj = ? WHERE conexao = ? AND codigo_loja = ?')
          .run(String(cnpjLoja.CNPJ), config.id, cnpjLoja.Codigo ?? loja);
      } catch { /* cadastro de lojas pode nao existir neste grupo */ }
    }

    const insVenda = prepIns(db, config, `INSERT OR REPLACE INTO vendas
      (chave_venda, codigo_loja, nome_loja, data_movimento, data_hora, numero_cupom, numero_nota,
       modelo_fiscal, status_venda, cancelada, data_cancelamento, motivo_cancelamento,
       operador_cancelamento,
       quantidade_pessoas, tela_venda, cliente_codigo, cliente_nome, cliente_documento,
       numero_fechamento, numero_caixa, operador_caixa,
       valor_subtotal, valor_desconto, valor_acrescimo, valor_servico, valor_taxa_entrega,
       valor_total, json_original)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insDesconto = prepIns(db, config, `INSERT INTO venda_descontos
      (chave_venda, codigo_operador, operador, motivo) VALUES (?,?,?,?)`);
    const insItemCancelado = prepIns(db, config, `INSERT INTO venda_itens_cancelados
      (chave_venda, data_hora, nome_produto, operador_lancamento, operador_cancelamento, motivo)
      VALUES (?,?,?,?,?,?)`);
    const delDescontos = prepDel(db, config, 'DELETE FROM venda_descontos WHERE chave_venda = ?');
    const delItensCancelados = prepDel(db, config, 'DELETE FROM venda_itens_cancelados WHERE chave_venda = ?');
    const insItem = prepIns(db, config, `INSERT INTO venda_itens
      (chave_venda, status, codigo_produto, nome_produto, unidade, codigo_grupo, grupo,
       codigo_subgrupo, subgrupo, quantidade, valor_unitario, valor_desconto, valor_acrescimo,
       valor_total, preco_compra, atendente,
       ncm, cfop, cst, csosn, cest, tributo,
       pis_cst, pis_aliquota, pis_base, pis_valor,
       cofins_cst, cofins_aliquota, cofins_base, cofins_valor,
       icms_aliquota, icms_base, icms_valor,
       ibscbs_cst, ibscbs_classtrib, ibscbs_base,
       ibs_uf_aliquota, ibs_uf_valor, ibs_mun_aliquota, ibs_mun_valor,
       cbs_aliquota, cbs_valor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
              ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?, ?,?)`);
    const insPag = prepIns(db, config, `INSERT INTO venda_pagamentos
      (chave_venda, tipo_forma_pagamento, descricao, valor_recebido, valor_efetivo,
       tipo_transacao_cartao, tipo_cartao, bandeira)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insComp = prepIns(db, config, `INSERT INTO venda_item_composicoes
      (venda_item_id, chave_venda, codigo_produto, codigo_insumo, nome_insumo,
       quantidade_insumo, unidade)
      VALUES (?,?,?,?,?,?,?)`);
    const delItens = prepDel(db, config, 'DELETE FROM venda_itens WHERE chave_venda = ?');
    const delPags = prepDel(db, config, 'DELETE FROM venda_pagamentos WHERE chave_venda = ?');
    const delComps = prepDel(db, config, 'DELETE FROM venda_item_composicoes WHERE chave_venda = ?');

    db.exec('BEGIN');
    try {
      for (const v of vendas) {
        const chave = v.ChaveVenda;
        if (!chave) continue;
        const tot = v.TotalizadorVenda ?? {};
        const cancel = v.DadosCancelamento ?? null;
        delItens.run(chave);
        delPags.run(chave);
        delComps.run(chave);
        delDescontos.run(chave);
        delItensCancelados.run(chave);
        insVenda.run(
          chave,
          v.Loja?.Codigo ?? loja,
          v.Loja?.Nome ?? null,
          soDia(v.DataMovimento),
          v.DataRecebimento ?? v.DataMovimento ?? null,
          v.NumeroCupom ?? null,
          v.NumeroNota ?? null,
          v.ModeloFiscal ?? null,
          v.StatusVenda ?? null,
          cancel?.Data ? 1 : 0,
          cancel?.Data ?? null,
          cancel?.Motivo ?? null,
          cancel?.Operador?.Nome ?? null,
          v.QuantidadePessoas ?? null,
          v.TelaVenda ?? null, // setor da venda: balcao/mesa/cartao/entrega
          v.Cliente?.Codigo ?? null,
          v.Cliente?.Nome ?? null,
          v.Cliente?.Documento ?? null,
          v.Caixa?.NumeroFechamento ?? null,
          v.Caixa?.Numero ?? null,
          v.Caixa?.Operador?.Nome ?? null,
          tot.ValorSubTotal ?? null,
          (tot.ValorTotalDescontoFiscal ?? 0) + (tot.ValorTotalDescontoSistema ?? 0),
          tot.ValorTotalAcrescimo ?? null,
          tot.ValorTotalServico ?? null,
          tot.ValorTotalTaxaEntrega ?? null,
          tot.ValorTotal ?? null,
          GUARDAR_JSON_VENDAS ? JSON.stringify(v) : null
        );
        for (const item of v.Itens ?? []) {
          const resultadoItem = insItem.run(
            chave,
            item.Status ?? null,
            item.Produto?.Codigo ?? null,
            item.Produto?.Nome ?? null,
            item.Produto?.Unidade ?? null,
            item.Produto?.CodigoGrupo ?? null,
            item.Produto?.Grupo ?? null,
            item.Produto?.CodigoSubGrupo ?? null,
            item.Produto?.SubGrupo ?? null,
            item.Quantidade ?? null,
            item.ValorUnitario ?? null,
            item.ValorDesconto ?? null,
            item.ValorAcrescimo ?? null,
            item.ValorTotal ?? null,
            item.PrecoCompra ?? null,
            item.AtendenteVenda ?? item.NomeAgenteVenda ?? null,
            // Fiscal: extraido para coluna (auditoria de tributacao e reforma)
            item.Produto?.NCM ?? null,
            item.Cfop ?? null, item.Cst ?? null, item.Csosn ?? null,
            item.CEST ?? null, item.Tributo ?? null,
            item.Pis?.Cst ?? null, item.Pis?.Aliquota ?? null,
            item.Pis?.BaseCalculo ?? null, item.Pis?.Valor ?? null,
            item.Cofins?.Cst ?? null, item.Cofins?.Aliquota ?? null,
            item.Cofins?.BaseCalculo ?? null, item.Cofins?.Valor ?? null,
            item.Icms?.Aliquota ?? null, item.Icms?.BaseCalculo ?? null, item.Icms?.Valor ?? null,
            item.IBSCBS?.CST ?? null, item.IBSCBS?.CClasstrib ?? null,
            item.IBSCBS?.gIBSCBS?.vBC ?? null,
            item.IBSCBS?.gIBSCBS?.gIBSUF?.pIBSUF ?? null,
            item.IBSCBS?.gIBSCBS?.gIBSUF?.vIBSUF ?? null,
            item.IBSCBS?.gIBSCBS?.gIBSMun?.pIBSMun ?? null,
            item.IBSCBS?.gIBSCBS?.gIBSMun?.vIBSMun ?? null,
            item.IBSCBS?.gIBSCBS?.gCBS?.pCBS ?? null,
            item.IBSCBS?.gIBSCBS?.gCBS?.vCBS ?? null
          );
          for (const comp of item.Produto?.Composicoes ?? []) {
            insComp.run(
              Number(resultadoItem.lastInsertRowid),
              chave,
              item.Produto?.Codigo ?? null,
              comp.CodigoInsumo ?? null,
              comp.NomeInsumo ?? null,
              comp.QuantidadeInsumo ?? null,
              comp.Unidade ?? null
            );
          }
        }
        for (const desc of v.Descontos ?? []) {
          insDesconto.run(
            chave,
            desc.CodigoOperador ?? null,
            desc.NomeOperador ?? null,
            desc.Motivo ?? null
          );
        }
        for (const ic of v.ItemCancelado ?? []) {
          insItemCancelado.run(
            chave,
            ic.DataHora ?? null,
            ic.NomeProduto ?? null,
            ic.NomeOperadorProduto ?? null,
            ic.NomeOperadorCancelamento ?? null,
            ic.Motivo ?? null
          );
        }
        for (const pag of v.Pagamentos ?? []) {
          insPag.run(
            chave,
            pag.TipoFormaPagamento ?? null,
            pag.Descricao ?? null,
            pag.ValorRecebido ?? null,
            pag.ValorEfetivo ?? null,
            pag.FormaPagamentoCartao?.TipoTransacao ?? null,
            pag.FormaPagamentoCartao?.TipoCartao ?? null,
            pag.FormaPagamentoCartao?.DadosTEF?.DescricaoBandeira ?? null
          );
        }
        total += 1;
      }
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    }
    registrarSync(db, config, 'vendas', loja, de, ate, vendas.length);
  }
  return total;
}

// ---------- domínio: fechamentos de caixa ----------

async function sincronizarFechamentos(db, config, de, ate, lojaArg) {
  const lojas = lojasAlvo(config, lojaArg).filter((l) => l !== null);
  exigirLojas(lojas, 'fechamentos', config);
  const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate), Lojas: lojas };
  const resposta = await chamarPost(config, '/api/FechamentoCaixa/ObterFechamentoCaixa', corpo);
  const fechamentos = resposta.Fechamentos ?? extrairLista(resposta) ?? [];

  const insCapa = prepIns(db, config, `INSERT OR REPLACE INTO fechamentos_caixa
    (id_fechamento, codigo_loja, nome_loja, numero_caixa, numero_bordero, data_caixa,
     data_abertura, data_fechamento, operador_caixa, valor_total_sistema, valor_total_recebido,
     valor_total_bordero, valor_total_dinheiro, valor_total_cheque, valor_diferenca_dinheiro,
     json_original)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insItem = prepIns(db, config, `INSERT INTO fechamento_itens
    (id_fechamento, id_forma_pagamento, descricao_forma_pagamento, valor_bordero,
     valor_sistema, valor_recebido, observacao)
    VALUES (?,?,?,?,?,?,?)`);
  const delItens = prepDel(db, config, 'DELETE FROM fechamento_itens WHERE id_fechamento = ?');

  db.exec('BEGIN');
  try {
    for (const f of fechamentos) {
      const id = f.IdFechamento;
      if (id === undefined || id === null) continue;
      delItens.run(id);
      insCapa.run(
        id,
        f.IdLoja ?? null,
        f.DescricaoLoja ?? null,
        f.Caixa ?? null,
        f.NrFechamentoBordero ?? null,
        soDia(f.DataCaixa) ?? soDia(f.DataAbertura),
        f.DataAbertura ?? null,
        f.DataFechamento ?? null,
        f.OperadorCaixa ?? null,
        f.ValorTotalSistema ?? null,
        f.ValorTotalRecebido ?? null,
        f.ValorTotalBordero ?? null,
        f.ValorTotalDinheiro ?? null,
        f.ValorTotalCheque ?? null,
        f.ValorDiferencaDinheiroRecebido ?? null,
        JSON.stringify(f)
      );
      for (const item of f.Itens ?? []) {
        insItem.run(
          id,
          item.IdFormaPagamento ?? null,
          item.DescricaoFormaPagamento ?? null,
          item.ValorBordero ?? null,
          item.ValorSistema ?? null,
          item.ValorRecebido ?? null,
          item.Observacao ?? null
        );
      }
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
  registrarSync(db, config, 'fechamentos', lojas[0] ?? null, de, ate, fechamentos.length);
  return fechamentos.length;
}

// ---------- domínios genéricos por período ----------
// Para respostas cujo layout exato ainda varia, gravamos os campos que
// conseguimos mapear + o registro completo em json_original.

function limparPeriodo(db, config, tabela, colunaData, loja, de, ate) {
  const filtroLoja = loja !== null ? 'AND codigo_loja = ?' : '';
  const params = [de, ate];
  if (loja !== null) params.push(loja);
  prepDel(db, config,
    `DELETE FROM ${tabela} WHERE ${colunaData} >= ? AND ${colunaData} <= ? ${filtroLoja}`
  ).run(...params);
}

async function sincronizarSangrias(db, config, de, ate, lojaArg) {
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate) };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarPost(config, '/api/sangria/Listar', corpo);
    const lista = extrairLista(resposta) ?? [];
    limparPeriodo(db, config, 'sangrias', 'data', loja, de, ate);
    const ins = prepIns(db, config,
      'INSERT INTO sangrias (codigo_loja, data, valor, operador, motivo, json_original) VALUES (?,?,?,?,?,?)'
    );
    for (const r of lista) {
      ins.run(
        campo(r, 'CodigoLoja', 'IdLoja') ?? loja,
        soDia(campo(r, 'Data', 'DataSangria', 'DataHora')),
        campo(r, 'Valor', 'ValorSangria'),
        campo(r, 'Operador', 'NomeOperador'),
        campo(r, 'Motivo', 'Observacao', 'Descricao'),
        JSON.stringify(r)
      );
      total += 1;
    }
    registrarSync(db, config, 'sangrias', loja, de, ate, lista.length);
  }
  return total;
}

async function sincronizarProvisao(db, config, de, ate, lojaArg) {
  const lojas = lojasAlvo(config, lojaArg).filter((l) => l !== null);
  exigirLojas(lojas, 'provisao', config);
  const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate), Lojas: lojas };
  const resposta = await chamarPost(config, '/api/ProvisaoCartoes/ObterProvisaoCartoes', corpo);
  const lista = extrairLista(resposta) ?? [];
  // Na carga historica a busca e POR LOJA: limpar o periodo inteiro aqui
  // apagaria o que a loja anterior acabou de gravar. Com --loja, o recorte
  // (e o registro no sync_log) tem de ser daquela loja.
  const lojaRecorte = lojaArg !== undefined ? Number(lojaArg) : null;
  limparPeriodo(db, config, 'provisao_cartoes', 'data_venda', lojaRecorte, de, ate);
  const ins = prepIns(db, config,
    `INSERT INTO provisao_cartoes
     (codigo_loja, data_venda, data_deposito, bandeira, valor_bruto, valor_taxa, valor_liquido, json_original)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  // Payload real (validado): IdLoja, DataMovimento, DataVencimento,
  // DescricaoFormaPagamento, ValorTotal, ValorTaxa, ValorLiquido.
  for (const r of lista) {
    ins.run(
      campo(r, 'IdLoja', 'CodigoLoja'),
      soDia(campo(r, 'DataMovimento', 'DataVenda', 'Data')),
      soDia(campo(r, 'DataVencimento', 'DataDeposito', 'DataPrevisaoDeposito')),
      campo(r, 'DescricaoFormaPagamento', 'Bandeira', 'DescricaoBandeira'),
      campo(r, 'ValorTotal', 'ValorBruto', 'Valor'),
      campo(r, 'ValorTaxa', 'Taxa'),
      campo(r, 'ValorLiquido'),
      JSON.stringify(r)
    );
  }
  registrarSync(db, config, 'provisao', lojaRecorte, de, ate, lista.length);
  return lista.length;
}

async function sincronizarFinanceiro(db, config, de, ate, lojaArg, qual) {
  // qual: 'contas-pagar' ou 'livro-caixa'
  const rota = qual === 'contas-pagar' ? '/api/Financeiro/ListContasPagar' : '/api/Financeiro/ListLivroCaixa';
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate) };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarGet(config, rota, corpo);
    const lista = extrairLista(resposta) ?? [];
    if (qual === 'contas-pagar') {
      // A API filtra por data de emissão/competência (não por vencimento)
      limparPeriodo(db, config, 'contas_pagar', 'data_emissao', loja, de, ate);
      const ins = prepIns(db, config,
        `INSERT INTO contas_pagar
         (codigo_loja, fornecedor, descricao, data_emissao, data_vencimento, data_pagamento,
          valor, valor_pago, plano_contas1, plano_contas2, data_competencia, pago, json_original)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      // Payload real (validado): NumeroControle, Credor, Valor, PlanoContas1/2,
      // Pago, DataPagamento, ValorPagamento, DataVencimento, DataEmissao, Loja.
      for (const r of lista) {
        const planos = [campo(r, 'PlanoContas1'), campo(r, 'PlanoContas2')].filter(Boolean).join(' / ');
        ins.run(
          campo(r, 'Loja', 'CodigoLoja', 'IdLoja') ?? loja,
          campo(r, 'Credor', 'Fornecedor', 'NomeFornecedor', 'RazaoSocial'),
          planos || campo(r, 'Descricao', 'Historico', 'Documento'),
          soDia(campo(r, 'DataEmissao', 'Emissao')),
          soDia(campo(r, 'DataVencimento', 'Vencimento')),
          campo(r, 'Pago') === false ? null : soDia(campo(r, 'DataPagamento', 'Pagamento', 'DataBaixa')),
          campo(r, 'Valor', 'ValorTitulo', 'ValorOriginal'),
          campo(r, 'ValorPagamento', 'ValorPago', 'ValorBaixado'),
          campo(r, 'PlanoContas1') ?? null,
          campo(r, 'PlanoContas2') ?? null,
          soDia(campo(r, 'DataCompetencia')) ?? null,
          campo(r, 'Pago') ? 1 : 0,
          JSON.stringify(r)
        );
        total += 1;
      }
    } else {
      limparPeriodo(db, config, 'livro_caixa', 'data', loja, de, ate);
      const ins = prepIns(db, config,
        `INSERT INTO livro_caixa (codigo_loja, data, descricao, natureza, tipo, valor, conta,
          plano_contas1, plano_contas2, data_lancamento, json_original)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      // Payload real (validado): Controle, DataEmissao, DataLancamento, Entrada,
      // Saida, NomeConta, Historico1..3, PlanoContas1/2, Loja, Compensado.
      for (const r of lista) {
        const entrada = campo(r, 'Entrada');
        const saida = campo(r, 'Saida');
        const planos = [campo(r, 'PlanoContas1'), campo(r, 'PlanoContas2')].filter(Boolean).join(' / ');
        ins.run(
          campo(r, 'Loja', 'CodigoLoja', 'IdLoja') ?? loja,
          soDia(campo(r, 'DataEmissao', 'Data', 'DataMovimento', 'DataLancamento')),
          campo(r, 'Historico1', 'Descricao', 'Historico'),
          planos || campo(r, 'Natureza', 'NaturezaFinanceira'),
          entrada > 0 ? 'entrada' : (saida > 0 ? 'saida' : campo(r, 'Tipo', 'TipoLancamento')),
          entrada > 0 ? entrada : (saida > 0 ? saida : campo(r, 'Valor')),
          campo(r, 'NomeConta'),
          campo(r, 'PlanoContas1') ?? null,
          campo(r, 'PlanoContas2') ?? null,
          soDia(campo(r, 'DataLancamento', 'DataEmissao')) ?? null,
          JSON.stringify(r)
        );
        total += 1;
      }
    }
    registrarSync(db, config, qual, loja, de, ate, lista.length);
  }
  return total;
}

async function sincronizarNotas(db, config, de, ate, lojaArg, tipo) {
  // tipo: 'venda' (paginada) ou 'entrada'
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const registros = [];
    if (tipo === 'venda') {
      let page = 1;
      const pageSize = 500;
      for (;;) {
        const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate) };
        if (loja !== null) corpo.CodigoLoja = loja;
        // page/pageSize vão na query string; o restante no corpo do GET
        const resposta = await chamarGet(
          config,
          `/api/Fiscal/ListNotasFiscaisVenda?page=${page}&pageSize=${pageSize}`,
          corpo
        );
        const lista = resposta.Data ?? extrairLista(resposta) ?? [];
        registros.push(...lista);
        const temMais = campo(resposta, 'HasNextPage', 'hasNextPage');
        if (!temMais || lista.length === 0) break;
        page += 1;
      }
    } else {
      const corpo = { DataInicial: dataInicioISO(de), DataFinal: dataFimISO(ate), TipoData: 0 };
      if (loja !== null) corpo.CodigoLoja = loja;
      const resposta = await chamarGet(config, '/api/Fiscal/ListNotasFiscaisEntrada', corpo);
      registros.push(...(extrairLista(resposta) ?? []));
    }

    // A chave SEFAZ das notas de venda embute o CNPJ do emitente (digitos
    // 7-20): aproveita para completar o cadastro da loja (identificacao de
    // chamados ao suporte).
    if (tipo === 'venda') {
      const chave = registros.map((r) => String(campo(r, 'ChaveSefaz') ?? ''))
        .find((c) => /^\d{44}$/.test(c));
      if (chave && loja !== null) {
        const d = chave.slice(6, 20);
        const cnpj = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
        try {
          db.prepare('UPDATE lojas SET cnpj = ? WHERE conexao = ? AND codigo_loja = ? AND cnpj IS NULL')
            .run(cnpj, config.id, loja);
        } catch { /* cadastro de lojas pode nao existir */ }
      }
    }

    prepDel(db, config,
      "DELETE FROM notas_fiscais WHERE tipo = ? AND data >= ? AND data <= ?" +
      (loja !== null ? ' AND codigo_loja = ?' : '')
    ).run(...(loja !== null ? [tipo, de, ate, loja] : [tipo, de, ate]));
    const ins = prepIns(db, config,
      `INSERT INTO notas_fiscais
       (tipo, codigo_loja, numero_nota, serie, data, fornecedor_ou_cliente, valor_total, json_original)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    // Payloads reais (validados):
    // - venda: DataEmissao, ChaveSefaz, NumeroCaixa, SerieNota, NumeroNota,
    //   ValorNota, CodigoLoja, XML
    // - entrada: NumeroNota, Serie, ChaveDeAcesso, DtLancamento (emissão),
    //   DtEntrada, XMLNota — fornecedor e valor só existem dentro do XML
    //   (<emit><xNome> e <vNF>).
    for (const r of registros) {
      // O XML completo da NF-e infla o banco; extraímos o que interessa e
      // guardamos o registro sem ele.
      const xml = campo(r, 'XML', 'XMLNota') ?? '';
      const { XML: _x1, XMLNota: _x2, Xml: _x3, xml: _x4, ...semXml } = r;
      const emitente = xml.match(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/)?.[1] ?? null;
      const valorNotaXml = xml.match(/<vNF>([\d.]+)<\/vNF>/)?.[1];
      ins.run(
        tipo,
        campo(r, 'CodigoLoja', 'IdLoja') ?? loja,
        campo(r, 'NumeroNota', 'Numero', 'NumeroNF'),
        campo(r, 'SerieNota', 'Serie'),
        soDia(campo(r, 'DataEmissao', 'DtEntrada', 'DtLancamento', 'Data', 'DataMovimento')),
        campo(r, 'Fornecedor', 'NomeFornecedor', 'Cliente', 'NomeCliente', 'RazaoSocial') ?? (tipo === 'entrada' ? emitente : null),
        campo(r, 'ValorNota', 'ValorTotal', 'Valor') ?? (valorNotaXml ? Number(valorNotaXml) : null),
        JSON.stringify(semXml)
      );
      total += 1;
    }
    registrarSync(db, config, `notas-${tipo}`, loja, de, ate, registros.length);
  }
  return total;
}

// ---------- domínios sem período (catálogos e posição atual) ----------

async function sincronizarProdutos(db, config, lojaArg) {
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = { Completa: true };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarGet(config, '/api/produto/listarProdutos', corpo);
    const lista = extrairLista(resposta) ?? [];
    const ins = prepIns(db, config,
      `INSERT OR REPLACE INTO produtos
       (codigo, nome, unidade, codigo_grupo, grupo, codigo_subgrupo, subgrupo, preco_venda, preco_compra, ativo,
        composto, processado, pesavel, exibir_no_cardapio,
        ncm, cfop_venda, cst_venda, csosn_venda, aliquota_venda, tributo_venda,
        cst_pis, cst_cofins, json_original)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?)`
    );
    // Payload real (validado): CodigoProduto, DescricaoProduto, UnidadeVenda,
    // Grupo, SubGrupo, PrecoVenda, PrecoCompra, ProdutoComposto, Composicoes.
    for (const r of lista) {
      const codigo = campo(r, 'CodigoProduto', 'Codigo');
      if (codigo === null) continue;
      ins.run(
        codigo,
        campo(r, 'DescricaoProduto', 'Nome', 'Descricao', 'NomeProduto'),
        campo(r, 'UnidadeVenda', 'Unidade', 'UnidadeMedida'),
        campo(r, 'CodigoGrupo'),
        campo(r, 'Grupo', 'NomeGrupo', 'DescricaoGrupo'),
        campo(r, 'CodigoSubGrupo'),
        campo(r, 'SubGrupo', 'NomeSubGrupo'),
        campo(r, 'PrecoVenda', 'Preco', 'ValorVenda'),
        campo(r, 'PrecoCompra', 'Custo'),
        campo(r, 'Ativo', 'Situacao') === false ? 0 : 1,
        campo(r, 'ProdutoComposto') === true ? 1 : 0,
        campo(r, 'Processado') === true ? 1 : 0,
        campo(r, 'Pesavel') === true ? 1 : 0,
        campo(r, 'NaoExibirNoCardapio') === true ? 0 : 1,
        // Cadastro fiscal: o que o produto DEVERIA tributar
        campo(r, 'NCM'),
        campo(r, 'CFOPVenda'), campo(r, 'CSTVenda'), campo(r, 'CSOSNVenda'),
        campo(r, 'AliquotaVenda'), campo(r, 'TributoVenda'),
        campo(r, 'CSTPisCodigo', 'CSTPisTipo'), campo(r, 'CSTCofinsCodigo', 'CSTCofinsTipo'),
        JSON.stringify(r)
      );
      total += 1;
    }
    registrarSync(db, config, 'produtos', loja, null, null, lista.length);
  }
  return total;
}

async function sincronizarEstoque(db, config, lojaArg) {
  const hoje = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = { Completa: true };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarGet(config, '/api/Estoque/ListarEstoque', corpo);
    const lista = extrairLista(resposta) ?? [];
    prepDel(db, config,
      'DELETE FROM estoque_posicoes WHERE data_leitura = ?' + (loja !== null ? ' AND codigo_loja = ?' : '')
    ).run(...(loja !== null ? [hoje, loja] : [hoje]));
    const ins = prepIns(db, config,
      `INSERT INTO estoque_posicoes
       (data_leitura, codigo_loja, codigo_produto, nome_produto, unidade, quantidade, custo, json_original)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    // Payload real (validado) vem em inglês: skuId, lotId, quantity,
    // locationId, stockType, updatedAt, unit. O nome do produto sai do join
    // com a tabela produtos (skuId = codigo).
    for (const r of lista) {
      const codigoProduto = campo(r, 'skuId', 'CodigoProduto', 'Codigo');
      ins.run(
        hoje,
        campo(r, 'locationId', 'CodigoLoja', 'IdLoja') ?? loja,
        codigoProduto !== null ? Number(codigoProduto) : null,
        campo(r, 'NomeProduto', 'Nome', 'Descricao'),
        campo(r, 'unit', 'Unidade', 'UnidadeMedida'),
        campo(r, 'quantity', 'Quantidade', 'QuantidadeEstoque', 'Saldo'),
        campo(r, 'Custo', 'PrecoCusto', 'CustoMedio'),
        JSON.stringify(r)
      );
      total += 1;
    }
    registrarSync(db, config, 'estoque', loja, hoje, hoje, lista.length);
  }
  return total;
}

async function sincronizarClientes(db, config, lojaArg) {
  let total = 0;
  for (const loja of lojasAlvo(config, lojaArg)) {
    const corpo = { Completa: true };
    if (loja !== null) corpo.CodigoLoja = loja;
    const resposta = await chamarGet(config, '/api/CadastroCliente/Listar', corpo);
    const lista = extrairLista(resposta) ?? [];
    const ins = prepIns(db, config,
      `INSERT OR REPLACE INTO clientes
       (codigo, nome, tipo_pessoa, documento, email, telefone, data_nascimento, json_original)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const r of lista) {
      const codigo = campo(r, 'Codigo', 'CodigoCliente');
      if (codigo === null) continue;
      const ddd = campo(r, 'DDD', 'DDDTelefone') ?? '';
      const fone = campo(r, 'Telefone') ?? '';
      ins.run(
        codigo,
        campo(r, 'Nome'),
        campo(r, 'TipoPessoa'),
        campo(r, 'CPF', 'CNPJ', 'Documento', 'CpfCnpj'),
        campo(r, 'Email'),
        `${ddd}${fone}` || null,
        soDia(campo(r, 'DataNascimento')),
        JSON.stringify(r)
      );
      total += 1;
    }
    registrarSync(db, config, 'clientes', loja, null, null, lista.length);
  }
  return total;
}

// ---------- execução ----------

const DOMINIOS_COM_PERIODO = [
  'vendas', 'fechamentos', 'sangrias', 'provisao',
  'contas-pagar', 'livro-caixa', 'notas-venda', 'notas-entrada',
];
const DOMINIOS_SEM_PERIODO = ['produtos', 'estoque', 'clientes'];

function lerArgumentos() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = lerArgumentos();
  const dominio = args.dominio;
  const dominiosValidos = [...DOMINIOS_COM_PERIODO, ...DOMINIOS_SEM_PERIODO, 'tudo'];
  if (!dominio || !dominiosValidos.includes(dominio)) {
    console.error(`Informe --dominio com um destes valores: ${dominiosValidos.join(', ')}`);
    process.exit(1);
  }

  // Um gestor pode ter varios grupos de lojas (diretorios site diferentes).
  // Sem --grupo, sincroniza todos.
  const conexoes = selecionarConexoes(args.grupo);
  const db = abrirBanco();
  criarSchema(db);

  const alvos = dominio === 'tudo' ? [...DOMINIOS_COM_PERIODO, ...DOMINIOS_SEM_PERIODO] : [dominio];
  const precisaPeriodo = alvos.some((d) => DOMINIOS_COM_PERIODO.includes(d));
  let de = null;
  let ate = null;
  if (precisaPeriodo) {
    de = validarDia(args.de, '--de');
    ate = validarDia(args.ate, '--ate');
  }

  // A API limita consultas por período a 31 dias; períodos maiores são
  // quebrados em blocos automaticamente.
  const blocos = [];
  if (precisaPeriodo) {
    let inicio = new Date(`${de}T00:00:00Z`);
    const fim = new Date(`${ate}T00:00:00Z`);
    while (inicio <= fim) {
      const fimBloco = new Date(Math.min(inicio.getTime() + 30 * 86400_000, fim.getTime()));
      blocos.push([inicio.toISOString().slice(0, 10), fimBloco.toISOString().slice(0, 10)]);
      inicio = new Date(fimBloco.getTime() + 86400_000);
    }
  } else {
    blocos.push([null, null]);
  }

  let houveErro = false;
  for (const config of conexoes) {
  if (conexoes.length > 1) console.log(`
=== ${config.nome} ===`);
  const executores = {
    'vendas': (d, a) => sincronizarVendas(db, config, d, a, args.loja),
    'fechamentos': (d, a) => sincronizarFechamentos(db, config, d, a, args.loja),
    'sangrias': (d, a) => sincronizarSangrias(db, config, d, a, args.loja),
    'provisao': (d, a) => sincronizarProvisao(db, config, d, a, args.loja),
    'contas-pagar': (d, a) => sincronizarFinanceiro(db, config, d, a, args.loja, 'contas-pagar'),
    'livro-caixa': (d, a) => sincronizarFinanceiro(db, config, d, a, args.loja, 'livro-caixa'),
    'notas-venda': (d, a) => sincronizarNotas(db, config, d, a, args.loja, 'venda'),
    'notas-entrada': (d, a) => sincronizarNotas(db, config, d, a, args.loja, 'entrada'),
    'produtos': () => sincronizarProdutos(db, config, args.loja),
    'estoque': () => sincronizarEstoque(db, config, args.loja),
    'clientes': () => sincronizarClientes(db, config, args.loja),
  };

  for (const alvo of alvos) {
    try {
      const blocosAlvo = DOMINIOS_COM_PERIODO.includes(alvo) ? blocos : [[null, null]];
      const historicoDeDia = alvo === 'vendas' && de && periodoHistorico(de) && foraDaJanelaNoturna();
      if (historicoDeDia) {
        console.warn(
          `⚠️ ${alvo}: o período pedido tem mais de ${DIAS_HISTORICO} dias e a API da TOTVS só ` +
          'libera dados históricos entre 23h e 07h. A busca provavelmente será recusada — ' +
          'agende para a janela noturna. (Um retorno vazio aqui NÃO significa ausência de vendas.)'
        );
      }
      let qtd = 0;
      for (const [dBloco, aBloco] of blocosAlvo) {
        qtd += await executores[alvo](dBloco, aBloco);
      }
      console.log(`✅ ${alvo}: ${qtd} registro(s) sincronizado(s)${de ? ` no período ${de} a ${ate}` : ''}.`);
      if (historicoDeDia && qtd === 0) {
        console.warn(
          '⚠️ vendas: veio ZERO registro de um período histórico fora da janela noturna — ' +
          'provavelmente é a restrição de horário da API, não ausência de vendas. ' +
          'Tente novamente entre 23h e 07h antes de tirar conclusões.'
        );
      }
    } catch (erro) {
      houveErro = true;
      console.error(`❌ ${alvo}${conexoes.length > 1 ? ` (${config.nome})` : ''}: ${erro.message}`);
      if (dominio !== 'tudo') break;
    }
  }
  }
  db.close();
  // process.exitCode (e não process.exit) evita abortar conexões HTTP ainda
  // abertas, o que causava crash do Node no Windows.
  if (houveErro) process.exitCode = 1;
}

await main();
