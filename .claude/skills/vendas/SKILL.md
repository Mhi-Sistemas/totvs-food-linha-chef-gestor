---
name: vendas
description: Análises de vendas do restaurante - faturamento, ticket médio, produtos mais vendidos, comparativos entre períodos, vendas por dia da semana/horário, descontos, cancelamentos e meios de pagamento. Use para qualquer pergunta do gestor sobre vendas, faturamento ou desempenho comercial.
---

# Análises de vendas

Antes de tudo: confira em `sync_log` se as vendas do período pedido já foram
baixadas (senão, siga a skill `sincronizar` — atenção: dados com mais de
16 dias só podem ser baixados da TOTVS entre 23h e 07h; fora disso analise o que
já está no banco e combine a busca noturna com o gestor). Consulte com:
`node --no-warnings scripts/consultar.mjs "<SQL>"` (adicione `--json` para gráficos).

Referências obrigatórias: `docs/dicionario-de-dados.md` (qual campo usar —
ex.: dia = `data_movimento`, hora = `data_hora`, faturamento = `valor_total`)
e `docs/catalogo-metricas.md` (fórmulas oficiais dos indicadores).


## Conferência obrigatória antes de responder

Rode `node --no-warnings scripts/analisar.mjs completude --de ... --ate ...`
**antes** de qualquer número de vendas. Se acusar dias faltando ou incompletos,
conte ao gestor o tamanho do buraco e ofereça buscar o que falta; só siga com a
análise se ele aceitar. Já aconteceu de um gestor decidir com a receita 38%
menor que a real — é o que esta conferência existe para evitar.

## Regras de cálculo (padrão do projeto)

- **Sempre exclua vendas canceladas**: `WHERE cancelada = 0`.
- Itens: use só os ativos — `venda_itens.status = 1` — e **exclua os itens de
  taxa**: `codigo_produto NOT IN (997, 999)` (999 = taxa de serviço/gorjeta,
  997 = taxa de entrega; são taxas lançadas como itens, não produtos). A
  presença do item 997 identifica venda de delivery.
- **Adicionais/combos**: sabores, tamanhos e componentes de combo vêm como
  linhas de item (muitas com valor 0; nomes costumam começar com "AD") — em
  rankings prefira **receita** a quantidade, e exclua `valor_total = 0` ao
  calcular preço médio. Detalhes no dicionário de dados, seção "Adicionais".
- **Faturamento** = `SUM(valor_total)` da tabela `vendas` (já inclui serviço e
  taxa de entrega, líquido de descontos).
- **Ticket médio por cupom** = faturamento ÷ nº de cupons (`COUNT(*)`).
- **Ticket médio por pessoa** = faturamento ÷ `SUM(quantidade_pessoas)` quando
  `quantidade_pessoas > 0` (salões que registram pessoas).
- Ao comparar períodos, compare dias equivalentes (mesma quantidade de dias e, se
  possível, mesmos dias da semana).
- **Período padrão termina ONTEM (D-1)**: os dados chegam à API só após o
  fechamento de caixa. Se o gestor perguntar "hoje", avise: "os números de hoje
  só aparecem depois do fechamento do caixa — posso mostrar até ontem, ou o
  parcial de hoje se algum caixa já fechou".
- Datas em `data_movimento` estão como AAAA-MM-DD; apresente como DD/MM/AAAA.

## Consultas de referência

Faturamento e ticket médio por dia:
```sql
SELECT data_movimento AS dia,
       COUNT(*)                AS cupons,
       ROUND(SUM(valor_total), 2) AS faturamento,
       ROUND(SUM(valor_total) / COUNT(*), 2) AS ticket_medio
FROM vendas
WHERE cancelada = 0 AND data_movimento BETWEEN '2026-09-01' AND '2026-09-22'
GROUP BY 1 ORDER BY 1;
```

Top produtos (quantidade e receita):
```sql
SELECT i.nome_produto,
       i.grupo,
       ROUND(SUM(i.quantidade), 1)  AS qtd,
       ROUND(SUM(i.valor_total), 2) AS receita
FROM venda_itens i
JOIN vendas v ON v.chave_venda = i.chave_venda
WHERE v.cancelada = 0 AND i.status = 1
  AND i.codigo_produto NOT IN (997, 999)   -- exclui taxas de serviço/entrega
  AND v.data_movimento BETWEEN :de AND :ate
GROUP BY 1, 2 ORDER BY receita DESC LIMIT 10;
```

Vendas por dia da semana (0=domingo ... 6=sábado):
```sql
SELECT CAST(strftime('%w', data_movimento) AS INT) AS dia_semana,
       COUNT(*) AS cupons, ROUND(SUM(valor_total), 2) AS faturamento
FROM vendas WHERE cancelada = 0 AND data_movimento BETWEEN :de AND :ate
GROUP BY 1 ORDER BY 1;
```
(Traduza: 0=domingo, 1=segunda, ... 6=sábado.)

Vendas por hora (usa a data/hora completa):
```sql
SELECT strftime('%H', data_hora) AS hora, COUNT(*) AS cupons,
       ROUND(SUM(valor_total), 2) AS faturamento
FROM vendas WHERE cancelada = 0 AND data_movimento BETWEEN :de AND :ate
GROUP BY 1 ORDER BY 1;
```

Meios de pagamento (agrupados pelas categorias definidas pelo gestor — o
cadastro tem nomes livres tipo "PIX SANTANDER"/"PIX ITAU"):
```sql
SELECT COALESCE(c.categoria, p.descricao) AS categoria,
       ROUND(SUM(p.valor_efetivo), 2) AS valor,
       COUNT(DISTINCT p.chave_venda) AS cupons
FROM venda_pagamentos p
JOIN vendas v ON v.chave_venda = p.chave_venda
LEFT JOIN formas_pagamento_categorias c ON c.descricao = p.descricao
WHERE v.cancelada = 0 AND v.data_movimento BETWEEN :de AND :ate
GROUP BY 1 ORDER BY valor DESC;
```
Se aparecer forma sem categoria: rode
`node --no-warnings scripts/categorias-pagamento.mjs sugerir`, confirme o
agrupamento com o gestor em linguagem simples e grave com
`... definir "FORMA=Categoria"`.

Cancelamentos (indicador central de erro operacional/fraude — o sistema grava
**operador e motivo**; analise sempre pelos dois):
```sql
SELECT operador_cancelamento, motivo_cancelamento, COUNT(*) AS qtd,
       ROUND(SUM(valor_total), 2) AS valor_cancelado
FROM vendas WHERE cancelada = 1 AND data_movimento BETWEEN :de AND :ate
GROUP BY 1, 2 ORDER BY valor_cancelado DESC;
```
Itens cancelados em vendas ativas: tabela `venda_itens_cancelados` (quem lançou,
quem cancelou, motivo). Descontos com operador/motivo: tabela `venda_descontos`.
Fórmulas e sinais de alerta no catálogo de métricas, §4.1.

Descontos concedidos:
```sql
SELECT ROUND(SUM(valor_desconto), 2) AS total_descontos,
       ROUND(100.0 * SUM(valor_desconto) / NULLIF(SUM(valor_total + valor_desconto), 0), 1) AS pct
FROM vendas WHERE cancelada = 0 AND data_movimento BETWEEN :de AND :ate;
```

Mix por categoria: agrupe `venda_itens` por **`subgrupo`** (é como o PDV agrupa
e como o gestor pensa o cardápio — SANDUICHES, CERVEJAS...); use `grupo` só para
a visão macro alimentos × bebidas. Para rede de lojas, agrupe `vendas` por
`codigo_loja`/`nome_loja`.

## Como apresentar

- Lidere com a resposta: "Seu faturamento de 01/09 a 22/09 foi de **R$ 87.450,32**".
- Dê contexto: compare com o período anterior equivalente quando os dados existirem.
- Aponte 1–3 destaques acionáveis (ex.: "terça é seu dia mais fraco; o grupo
  Bebidas caiu 12%").
- Ofereça um gráfico quando houver série temporal ou ranking (skill `dashboard`).

## Setor da venda (balcão, mesa, cartão, entrega)

A coluna `vendas.tela_venda` é a dimensão de canal — legenda fixa do sistema:
1/6=Mesa, 2/7=Cartão (comanda), 3=Entrega, 4/5=Balcão, A=Autopesagem, 21=NFe
(CASE pronto no dicionário de dados; agrupe sempre pelo SETOR, nunca pelo
código, e trate o valor como texto — existe código letra). Use-a por padrão quando o gestor falar de delivery,
salão, balcão ou comandas — faturamento e ticket por setor, participação do
delivery na receita, mesa × balcão por horário. Nos painéis, "faturamento por
setor" (rosca ou barras) é um bom cartão padrão quando houver mais de um setor
com movimento. Venda de entrega também carrega o item 997 (taxa) — se
`tela_venda` divergir disso, avise que o dado merece conferência.
