// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// REGISTRO CENTRAL DE DOMINIOS de dados do ChefWeb — o conceito de dominio
// e um pilar do projeto: A MEDIDA QUE A TOTVS LIBERAR NOVAS APIS, ELAS
// ENTRAM AQUI como um dominio novo, e a carga historica, o relatorio de
// progresso e a recuperacao dia a dia passam a enxerga-las sozinhos.
//
// Campos:
// - id:       o mesmo usado em `sincronizar.mjs --dominio <id>` e no sync_log
// - nome:     como o gestor ve o dominio (relatorios, alertas)
// - tipo:     'periodo'  = tem historico por data (busca por mes/dia)
//             'cadastro' = fotografia do estado atual (vale o "atualizado em")
// - historico: entra na CARGA HISTORICA (`lojas.mjs coletar`)? Dominios de
//             periodo sem historico (ex.: provisao, que a API entrega por
//             grupo e sem recorte por loja) ficam so na rotina diaria.
// - janelaNoturna: a API so libera periodos antigos entre 23h e 07h
//             (hoje, restricao conhecida apenas das vendas).

export const DOMINIOS = [
  { id: 'vendas', nome: 'Vendas', tipo: 'periodo', historico: true, janelaNoturna: true },
  { id: 'fechamentos', nome: 'Fechamentos de caixa', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'sangrias', nome: 'Sangrias', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'provisao', nome: 'Cartões a receber', tipo: 'periodo', historico: false, janelaNoturna: false },
  { id: 'contas-pagar', nome: 'Contas a pagar', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'livro-caixa', nome: 'Livro caixa', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'notas-venda', nome: 'Notas de venda', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'notas-entrada', nome: 'Notas de entrada', tipo: 'periodo', historico: true, janelaNoturna: false },
  { id: 'produtos', nome: 'Catálogo de produtos', tipo: 'cadastro' },
  { id: 'estoque', nome: 'Fotografia de estoque', tipo: 'cadastro' },
  { id: 'clientes', nome: 'Clientes', tipo: 'cadastro' },
];

export const dominio = (id) => DOMINIOS.find((d) => d.id === id);
export const dominiosHistoricos = () => DOMINIOS.filter((d) => d.tipo === 'periodo' && d.historico);
export const dominiosCadastro = () => DOMINIOS.filter((d) => d.tipo === 'cadastro');
