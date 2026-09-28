---
name: estoque
description: Análises de estoque - posição atual, itens zerados ou críticos, valor imobilizado e cobertura (para quantos dias o estoque dá, cruzando com as vendas). Use para perguntas sobre estoque, insumos, falta de produto ou compras.
---

# Análises de estoque

O estoque é uma **fotografia**: cada sincronização grava a posição do dia em
`estoque_posicoes` com `data_leitura`. Para posição atual, sincronize o domínio
`estoque` primeiro (skill `sincronizar`) — assim a foto é de hoje.

Referências obrigatórias: `docs/dicionario-de-dados.md` (campos e joins) e
`docs/catalogo-metricas.md` (fórmulas de giro, cobertura, CMV).

> Nota técnica (validada): a API de estoque não traz nome nem custo do produto —
> **sempre faça join com `produtos`** (`codigo_produto = produtos.codigo`) para
> nome, grupo e custo (`preco_compra`). Sincronize `produtos` junto com `estoque`.
>
> Tipos de produto (dicionário §9): **composto** não tem estoque próprio (o
> estoque está nos INSUMOS, geralmente `exibir_no_cardapio = 0`); **processado**
> tem estoque próprio (é produzido); **pesável** tem saldo em kg. Nunca acuse
> falta de estoque de um produto composto.

## Consultas de referência

Posição mais recente:
```sql
SELECT p.nome, p.grupo, e.unidade, ROUND(e.quantidade, 2) AS qtd
FROM estoque_posicoes e
JOIN produtos p ON p.codigo = e.codigo_produto
WHERE e.data_leitura = (SELECT MAX(data_leitura) FROM estoque_posicoes)
ORDER BY p.nome;
```

Itens zerados ou negativos (ruptura / erro de lançamento):
```sql
SELECT p.nome, e.quantidade
FROM estoque_posicoes e
JOIN produtos p ON p.codigo = e.codigo_produto
WHERE e.data_leitura = (SELECT MAX(data_leitura) FROM estoque_posicoes)
  AND e.quantidade <= 0
ORDER BY e.quantidade;
```

Valor imobilizado em estoque (custo vem do cadastro de produtos):
```sql
SELECT ROUND(SUM(e.quantidade * p.preco_compra), 2) AS valor_estoque
FROM estoque_posicoes e
JOIN produtos p ON p.codigo = e.codigo_produto
WHERE e.data_leitura = (SELECT MAX(data_leitura) FROM estoque_posicoes)
  AND e.quantidade > 0 AND p.preco_compra > 0;
```

Cobertura em dias (estoque ÷ venda média diária dos últimos 30 dias — só faz
sentido para produtos vendidos por unidade de estoque, não para pratos compostos):
```sql
WITH venda_media AS (
  SELECT i.codigo_produto, SUM(i.quantidade) / 30.0 AS media_dia
  FROM venda_itens i
  JOIN vendas v ON v.chave_venda = i.chave_venda
  WHERE v.cancelada = 0 AND i.status = 1
    AND v.data_movimento >= date('now', '-30 day')
  GROUP BY 1
)
SELECT p.nome, ROUND(e.quantidade, 1) AS estoque,
       ROUND(m.media_dia, 2) AS venda_dia,
       ROUND(e.quantidade / m.media_dia, 1) AS dias_cobertura
FROM estoque_posicoes e
JOIN produtos p ON p.codigo = e.codigo_produto
JOIN venda_media m ON m.codigo_produto = e.codigo_produto
WHERE e.data_leitura = (SELECT MAX(data_leitura) FROM estoque_posicoes)
  AND m.media_dia > 0
ORDER BY dias_cobertura ASC LIMIT 20;
```

## Cuidados

- Em restaurantes, o item vendido (prato) difere do insumo estocado; a cobertura
  acima vale para itens de revenda (bebidas, sobremesas prontas). Deixe isso claro.
- Estoque negativo geralmente é falha de lançamento — trate como alerta de
  processo, não como número real.
- Se `custo` vier vazio, diga que o valor imobilizado não pôde ser calculado por
  falta de custo cadastrado no sistema.

## Como apresentar

- Comece pelos alertas (itens zerados/críticos), depois a visão geral.
- Sugira ação: "estes 5 itens acabam em menos de 3 dias — vale programar compra".
