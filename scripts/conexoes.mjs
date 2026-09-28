// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Gerencia as CONEXÕES do assistente com o TOTVS Food Linha Chef.
//
// Uma conexão = um "diretório site" (número de série) do ChefWeb, que pode
// conter uma ou várias lojas. O gestor pode ter mais de uma conexão — por
// exemplo, dois grupos de lojas contratados separadamente, ou uma rede e um
// restaurante independente — e pode acrescentar novas a qualquer momento,
// depois da configuração inicial.
//
// Os dados ficam em data/conexoes.json (local, fora do controle de versão) e
// são escritos pela página de configuração — o gestor nunca edita arquivo.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_DADOS = join(RAIZ, 'data');
export const CAMINHO_CONEXOES = join(PASTA_DADOS, 'conexoes.json');
const URL_PADRAO = 'https://chefweb.chef.totvs.com.br/ChefWebAPI';

// Identificador estável e legível a partir do nome dado pelo gestor.
export function gerarId(nome, existentes = []) {
  const base = String(nome || 'grupo')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'grupo';
  let id = base;
  let n = 2;
  while (existentes.includes(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

function normalizar(c) {
  return {
    id: c.id,
    nome: c.nome || c.id,
    usuario: c.usuario,
    senha: c.senha,
    serial: String(c.serial ?? ''),
    chave: c.chave || 'SerialNumber',
    urlBase: (c.urlBase || c.url || URL_PADRAO).replace(/\/+$/, ''),
    lojas: Array.isArray(c.lojas) ? c.lojas.map(Number).filter((n) => !Number.isNaN(n)) : [],
    // Segmento da operacao (pizzaria, padaria, quilo...): escolhe a faixa
    // certa em docs/referencias-de-mercado.md. Geralmente todas as lojas do
    // grupo sao do mesmo segmento; excecao por loja vai na tabela lojas.
    segmento: c.segmento || null,
  };
}

// Lê todas as conexões configuradas.
export function carregarConexoes() {
  if (!existsSync(CAMINHO_CONEXOES)) return [];
  const bruto = JSON.parse(readFileSync(CAMINHO_CONEXOES, 'utf8'));
  const lista = Array.isArray(bruto) ? bruto : (bruto.conexoes ?? []);
  return lista.map(normalizar);
}

export function gravarConexoes(conexoes) {
  mkdirSync(PASTA_DADOS, { recursive: true });
  const conteudo = { conexoes: conexoes.map(normalizar) };
  writeFileSync(CAMINHO_CONEXOES, JSON.stringify(conteudo, null, 2), 'utf8');
}

// Acrescenta (ou substitui, se o id já existir) uma conexão.
export function salvarConexao(conexao) {
  const atuais = carregarConexoes();
  const id = conexao.id || gerarId(conexao.nome, atuais.map((c) => c.id));
  const nova = normalizar({ ...conexao, id });
  const indice = atuais.findIndex((c) => c.id === id);
  if (indice >= 0) atuais[indice] = nova; else atuais.push(nova);
  gravarConexoes(atuais);
  return nova;
}

export function removerConexao(id) {
  const atuais = carregarConexoes();
  const restantes = atuais.filter((c) => c.id !== id);
  gravarConexoes(restantes);
  return atuais.length !== restantes.length;
}

// Seleciona conexões por id (ou todas). Lança erro claro se não houver nenhuma.
export function selecionarConexoes(idOuNada) {
  const todas = carregarConexoes();
  if (todas.length === 0) {
    throw new Error(
      'Nenhuma loja configurada ainda. Peça ao assistente: "quero configurar minha loja" '
      + '(ele abre a página de configuração no navegador).'
    );
  }
  if (!idOuNada) return todas;
  const escolhidas = todas.filter((c) => c.id === idOuNada);
  if (escolhidas.length === 0) {
    throw new Error(`Grupo "${idOuNada}" não encontrado. Disponíveis: ${todas.map((c) => c.id).join(', ')}`);
  }
  return escolhidas;
}

export function validarConexao(c) {
  const faltando = [];
  if (!c.usuario) faltando.push('usuário');
  if (!c.senha) faltando.push('senha');
  if (!c.serial) faltando.push('número de série');
  if (!c.nome) faltando.push('nome do grupo');
  return faltando;
}
