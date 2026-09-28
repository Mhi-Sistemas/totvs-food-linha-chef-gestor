// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Agrupamento das formas de pagamento em categorias definidas pelo gestor.
//
// Uso:
//   node scripts/categorias-pagamento.mjs sugerir
//       Lista as formas encontradas nas vendas com uma categoria SUGERIDA
//       (por nome/tipo). Não grava nada.
//   node scripts/categorias-pagamento.mjs definir "PIX SANTANDER=Pix" "VISA CREDITO=Crédito" ...
//       Grava/atualiza o agrupamento (aceita vários pares por chamada).
//   node scripts/categorias-pagamento.mjs listar
//       Mostra o agrupamento atual e as formas ainda sem categoria.
//
// As análises usam: COALESCE(categoria, descricao) como rótulo do meio de pagamento.

import { abrirBanco, criarSchema } from './criar-banco.mjs';

// Sugestão por texto — o código tipo_transacao_cartao não é confiável
// (veio invertido vs. a documentação nos dados reais); o texto é.
export function sugerirCategoria(descricao, tipoCartao) {
  const d = `${descricao ?? ''} ${tipoCartao ?? ''}`.toUpperCase();
  if (/DINHEIRO|ESPECIE/.test(d)) return 'Dinheiro';
  if (/PIX/.test(d)) return 'Pix';
  if (/CR[ÉE]D/.test(d)) return 'Crédito';
  if (/D[ÉE]B/.test(d)) return 'Débito';
  if (/VALE|VR |VA |ALELO|SODEXO|TICKET|PLURXX|BEN VIS|REFEI[ÇC]/.test(d)) return 'Vale-refeição';
  if (/FATUR|PRAZO|CONV[ÊE]NIO|BOLETO|NOTA|ASSINAD/.test(d)) return 'Faturado';
  if (/CHEQUE/.test(d)) return 'Cheque';
  if (/CART[ÃA]O|VISA|MASTER|ELO|AMEX|HIPER/.test(d)) return 'Cartão (verificar créd/déb)';
  return 'Outros';
}

const acao = process.argv[2];
const db = abrirBanco();
criarSchema(db);

if (acao === 'sugerir') {
  const formas = db.prepare(`
    SELECT p.descricao, MAX(p.tipo_cartao) AS tipo_cartao,
           COUNT(*) AS usos, ROUND(SUM(p.valor_efetivo), 2) AS valor,
           c.categoria AS categoria_atual
    FROM venda_pagamentos p
    LEFT JOIN formas_pagamento_categorias c ON c.descricao = p.descricao
    GROUP BY p.descricao ORDER BY valor DESC`).all();
  if (formas.length === 0) {
    console.log('Nenhum pagamento sincronizado ainda. Sincronize vendas primeiro.');
  }
  for (const f of formas) {
    const sugestao = f.categoria_atual ?? sugerirCategoria(f.descricao, f.tipo_cartao);
    const marca = f.categoria_atual ? '(já definida)' : '(sugestão)';
    console.log(`${f.descricao} | ${sugestao} ${marca} | ${f.usos} uso(s), R$ ${f.valor}`);
  }
} else if (acao === 'definir') {
  const pares = process.argv.slice(3);
  if (pares.length === 0) {
    console.error('Informe pares "FORMA=Categoria". Ex.: definir "PIX ITAU=Pix"');
    process.exit(1);
  }
  const upsert = db.prepare(
    'INSERT INTO formas_pagamento_categorias (descricao, categoria) VALUES (?, ?) ' +
    'ON CONFLICT(descricao) DO UPDATE SET categoria = excluded.categoria'
  );
  for (const par of pares) {
    const posicao = par.indexOf('=');
    if (posicao < 1) {
      console.error(`Par inválido (esperado FORMA=Categoria): "${par}"`);
      continue;
    }
    const descricao = par.slice(0, posicao).trim();
    const categoria = par.slice(posicao + 1).trim();
    upsert.run(descricao, categoria);
    console.log(`✅ ${descricao} → ${categoria}`);
  }
} else if (acao === 'listar') {
  const definidas = db.prepare(
    'SELECT descricao, categoria FROM formas_pagamento_categorias ORDER BY categoria, descricao'
  ).all();
  console.log(definidas.length === 0 ? '(nenhuma categoria definida ainda)' : 'Definidas:');
  for (const d of definidas) console.log(`  ${d.descricao} → ${d.categoria}`);
  const pendentes = db.prepare(`
    SELECT DISTINCT p.descricao FROM venda_pagamentos p
    LEFT JOIN formas_pagamento_categorias c ON c.descricao = p.descricao
    WHERE c.descricao IS NULL`).all();
  if (pendentes.length > 0) {
    console.log('Sem categoria (use "sugerir" e depois "definir"):');
    for (const p of pendentes) console.log(`  ${p.descricao}`);
  }
} else {
  console.error('Ação inválida. Use: sugerir | definir | listar');
  process.exit(1);
}
db.close();
