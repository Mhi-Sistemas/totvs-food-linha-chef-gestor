// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Testa as credenciais de TODOS os grupos de lojas configurados.
// Uso: node --no-warnings scripts/testar-conexao.mjs [--grupo <id>]

import { selecionarConexoes, gerarToken } from './chef-api.mjs';

const argv = process.argv.slice(2);
const indice = argv.indexOf('--grupo');
const grupo = indice >= 0 ? argv[indice + 1] : undefined;

let falhou = false;
try {
  const conexoes = selecionarConexoes(grupo);
  for (const c of conexoes) {
    process.stdout.write(`${c.nome}: conectando... `);
    try {
      const { expiraEm } = await gerarToken(c);
      const lojas = c.lojas.length > 0 ? c.lojas.join(', ') : 'todas do grupo';
      console.log(`OK (lojas: ${lojas}; token valido ate ${expiraEm})`);
    } catch (erro) {
      falhou = true;
      console.log(`FALHOU - ${erro.message}`);
    }
  }
} catch (erro) {
  console.error(`Nao foi possivel testar: ${erro.message}`);
  process.exitCode = 1;
}
if (falhou) process.exitCode = 1;
