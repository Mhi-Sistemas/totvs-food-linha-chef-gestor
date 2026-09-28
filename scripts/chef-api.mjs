// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Cliente da API do TOTVS Food Linha Chef (ChefWeb).
// O token gerado por /api/Token/GerarToken expira em ~2 minutos,
// por isso cada chamada gera um token novo imediatamente antes de usar.

import { request as requestHttps } from 'node:https';
import { request as requestHttp } from 'node:http';
import { selecionarConexoes } from './conexoes.mjs';

// A configuração agora vive em data/conexoes.json (uma entrada por grupo de
// lojas / diretório site). Ver scripts/conexoes.mjs.
export { carregarConexoes, selecionarConexoes, salvarConexao, removerConexao } from './conexoes.mjs';

// Compatibilidade: devolve a PRIMEIRA conexão configurada. Prefira
// selecionarConexoes() quando o gestor puder ter mais de um grupo.
export function carregarConfig() {
  return selecionarConexoes()[0];
}

function formatarErros(erros) {
  if (!Array.isArray(erros) || erros.length === 0) return 'erro não informado pela API';
  const texto = erros
    .map((e) => `${e.CodigoErro ?? e.codigoErro ?? '?'}: ${e.DescricaoErro ?? e.descricaoErro ?? JSON.stringify(e)}`)
    .join(' | ');
  // Erro genérico do servidor ChefWeb: costuma indicar módulo não habilitado
  // ou sem dados de retaguarda no ambiente consultado.
  if (/object reference not set/i.test(texto)) {
    return `${texto} (erro interno do ChefWeb — este módulo pode não estar habilitado ou alimentado neste ambiente)`;
  }
  return texto;
}

// Algumas rotas respondem em português (Sucesso/Erros) e outras, como as
// paginadas do Fiscal, em inglês (Success/Errors). Normaliza a checagem.
function checarSucesso(dados, caminho) {
  const sucesso = dados.Sucesso ?? dados.Success ?? dados.sucesso;
  if (sucesso === false) {
    const erros = dados.Erros ?? dados.Errors ?? dados.Mensagens?.map((m) => ({ DescricaoErro: m }));
    throw new Error(`API retornou erro em ${caminho}: ${formatarErros(erros)}`);
  }
}

async function requisitar(url, opcoes) {
  let resposta;
  try {
    resposta = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(300_000) });
  } catch (erro) {
    throw new Error(
      `Falha de conexão com a API do ChefWeb (${erro.cause?.code ?? erro.name}). ` +
      'Verifique sua conexão com a internet e tente de novo em instantes.'
    );
  }
  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    throw new Error(`API do ChefWeb respondeu HTTP ${resposta.status}. ${corpo.slice(0, 300)}`);
  }
  return resposta.json();
}

// A API tem limite de requisições e BLOQUEIA quem envia chamadas demais em
// sequência. Intervalo mínimo entre operações (token + chamada contam como uma
// operação): 30s no horário comercial, 10s na janela noturna (23h–07h).
let ultimaOperacao = 0;
async function respeitarLimite() {
  const hora = new Date().getHours();
  const intervaloMs = (hora >= 23 || hora < 7) ? 10_000 : 30_000;
  const espera = ultimaOperacao + intervaloMs - Date.now();
  if (espera > 0) {
    console.log(`⏳ aguardando ${Math.ceil(espera / 1000)}s (limite de requisições da TOTVS)...`);
    await new Promise((r) => setTimeout(r, espera));
  }
  ultimaOperacao = Date.now();
}

// Gera um token novo (validade ~2 minutos). Sempre chame imediatamente antes do uso.
export async function gerarToken(config) {
  const dados = await requisitar(`${config.urlBase}/api/Token/GerarToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Usuario: config.usuario,
      Senha: config.senha,
      NumeroSerialLoja: config.serial,
      Chave: config.chave,
    }),
  });
  if (dados.Sucesso === false || !dados.Token) {
    throw new Error(`Autenticação recusada pela API: ${formatarErros(dados.Erros)}`);
  }
  return { token: dados.Token, expiraEm: dados.DataExpiracao };
}

// POST com body JSON. O campo Token é injetado automaticamente no corpo.
export async function chamarPost(config, caminho, corpo = {}) {
  await respeitarLimite();
  const { token } = await gerarToken(config);
  const dados = await requisitar(`${config.urlBase}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Token: token, ...corpo }),
  });
  checarSucesso(dados, caminho);
  return dados;
}

// GET com corpo JSON. Apesar de o swagger documentar query string, o servidor
// do ChefWeb só lê o objeto de requisição no CORPO da requisição GET (sem o
// corpo, todos esses endpoints devolvem "Object reference not set..."). O
// fetch() proíbe body em GET, por isso usamos node:http(s) diretamente.
// Parâmetros de paginação (page/pageSize) continuam na query string do caminho.
export async function chamarGet(config, caminho, corpo = {}) {
  await respeitarLimite();
  const { token } = await gerarToken(config);
  const url = new URL(`${config.urlBase}${caminho}`);
  const payload = JSON.stringify({ Token: token, ...corpo });
  const requisitarBase = url.protocol === 'http:' ? requestHttp : requestHttps;

  const dados = await new Promise((resolve, reject) => {
    const req = requisitarBase(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let texto = '';
        res.on('data', (parte) => { texto += parte; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`API do ChefWeb respondeu HTTP ${res.statusCode}. ${texto.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(texto)); } catch { reject(new Error(`Resposta inválida da API em ${caminho}.`)); }
        });
      }
    );
    req.setTimeout(300_000, () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (erro) => reject(new Error(
      `Falha de conexão com a API do ChefWeb (${erro.message}). Verifique sua conexão com a internet e tente de novo em instantes.`
    )));
    req.write(payload);
    req.end();
  });
  checarSucesso(dados, caminho);
  return dados;
}

// Converte "AAAA-MM-DD" para o formato ISO aceito pela API.
export function dataInicioISO(dia) {
  return `${dia}T00:00:00`;
}
export function dataFimISO(dia) {
  return `${dia}T23:59:59`;
}

export function validarDia(texto, nomeArgumento) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto ?? '')) {
    throw new Error(`Argumento ${nomeArgumento} deve estar no formato AAAA-MM-DD (recebido: "${texto}").`);
  }
  return texto;
}
