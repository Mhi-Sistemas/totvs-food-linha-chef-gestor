// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Identidade visual dos relatorios/paineis. Padrao = ChefWeb/TOTVS Chef;
// se o gestor enviou a logomarca dele na pagina de configuracao
// (personalizados/identidade/), ela prevalece. As CORES da identidade
// propria sao extraidas da logomarca PELO ASSISTENTE (ele olha a imagem,
// monta a melhor combinacao com contraste valido e grava identidade.json —
// formato abaixo); enquanto identidade.json nao existir, as cores padrao
// continuam valendo mesmo com logo propria.
//
// personalizados/identidade/identidade.json:
//   { "cabecalho": "#0b3d2e",       // fundo do cabecalho (escuro)
//     "texto_cabecalho": "#ffffff", // texto sobre o cabecalho
//     "destaque": "#e8a13d",        // botoes/realce (contrasta com cabecalho)
//     "origem": "extraida da logomarca em AAAA-MM-DD" }

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_IDENTIDADE = join(RAIZ, 'personalizados', 'identidade');

const PADRAO = {
  cabecalho: '#002233',
  texto_cabecalho: '#ffffff',
  destaque: '#feac0e',
  logo: join(RAIZ, 'assets', 'logo-totvs-chef.png'),
  propria: false,
};

// Devolve { cabecalho, texto_cabecalho, destaque, logo (caminho|null),
// logoDataUri (string|null), propria }.
export function carregarIdentidade() {
  const png = join(PASTA_IDENTIDADE, 'logo.png');
  const jpg = join(PASTA_IDENTIDADE, 'logo.jpg');
  const logoPropria = existsSync(png) ? png : (existsSync(jpg) ? jpg : null);
  let cores = {};
  if (logoPropria) {
    try { cores = JSON.parse(readFileSync(join(PASTA_IDENTIDADE, 'identidade.json'), 'utf8')); } catch { /* ainda sem cores extraidas */ }
  }
  const id = {
    cabecalho: cores.cabecalho || PADRAO.cabecalho,
    texto_cabecalho: cores.texto_cabecalho || PADRAO.texto_cabecalho,
    destaque: cores.destaque || PADRAO.destaque,
    logo: logoPropria ?? PADRAO.logo,
    propria: Boolean(logoPropria),
  };
  id.logoDataUri = null;
  try {
    const tipo = id.logo.endsWith('.jpg') ? 'jpeg' : 'png';
    id.logoDataUri = `data:image/${tipo};base64,${readFileSync(id.logo).toString('base64')}`;
  } catch { /* sem logo alguma */ }
  return id;
}
