// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Executa uma consulta SOMENTE LEITURA no banco local data/chef.db.
//
// Uso:
//   node scripts/consultar.mjs "SELECT data_movimento, SUM(valor_total) FROM vendas GROUP BY 1"
//   node scripts/consultar.mjs --json "SELECT ..."      (saída em JSON, útil p/ gráficos)
//
// Qualquer comando que não seja consulta (INSERT, UPDATE, DELETE...) é recusado.

import { existsSync } from 'node:fs';
import { abrirBanco, CAMINHO_BANCO } from './criar-banco.mjs';

const argv = process.argv.slice(2);
const comoJson = argv.includes('--json');
const sql = argv.filter((a) => a !== '--json').join(' ').trim();

if (!sql) {
  console.error('Informe a consulta SQL entre aspas. Ex.: node scripts/consultar.mjs "SELECT COUNT(*) FROM vendas"');
  process.exit(1);
}
if (!/^\s*(select|with|pragma table_info|explain)\b/i.test(sql)) {
  console.error('Apenas consultas de leitura (SELECT/WITH) são permitidas por este script.');
  process.exit(1);
}
if (!existsSync(CAMINHO_BANCO)) {
  console.error('Os dados locais ainda não foram preparados. Peça ao assistente: '
    + '"prepare meu computador e conecte minha loja".');
  process.exit(1);
}

const db = abrirBanco({ somenteLeitura: true });
try {
  const linhas = db.prepare(sql).all();
  if (comoJson) {
    console.log(JSON.stringify(linhas, null, 2));
  } else if (linhas.length === 0) {
    console.log('(nenhum resultado)');
  } else {
    // Tabela simples em texto
    const colunas = Object.keys(linhas[0]);
    const larguras = colunas.map((c) =>
      Math.max(c.length, ...linhas.map((l) => String(l[c] ?? '').length))
    );
    const linhaTexto = (valores) =>
      valores.map((v, i) => String(v ?? '').padEnd(larguras[i])).join('  ');
    console.log(linhaTexto(colunas));
    console.log(larguras.map((w) => '-'.repeat(w)).join('  '));
    for (const l of linhas) console.log(linhaTexto(colunas.map((c) => l[c])));
    console.log(`\n${linhas.length} linha(s).`);
  }
} catch (erro) {
  console.error(`Erro na consulta: ${erro.message}`);
  process.exit(1);
} finally {
  db.close();
}
