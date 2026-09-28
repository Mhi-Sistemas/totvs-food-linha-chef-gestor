// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Abre um arquivo (relatorio, planilha, PDF) no aplicativo padrao do sistema.
// Funciona igual no Windows, no macOS e no Linux.
//
// Uso: node --no-warnings scripts/abrir.mjs relatorios/painel-vendas.html

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { abrirNoSistema } from './plataforma.mjs';

const alvo = process.argv[2];
if (!alvo) {
  console.error('Informe o arquivo a abrir. Ex.: node scripts/abrir.mjs relatorios/painel.html');
  process.exit(1);
}
const caminho = resolve(alvo);
if (!existsSync(caminho)) {
  console.error(`Arquivo nao encontrado: ${caminho}`);
  process.exit(1);
}
abrirNoSistema(caminho, (erro) => {
  console.warn(`Nao consegui abrir automaticamente (${erro.message}).`);
  console.warn(`Peca ao gestor para abrir este arquivo: ${caminho}`);
});
console.log(`Abrindo ${caminho}`);
