---
name: financeiro
description: Análises financeiras - contas a pagar (vencimentos, atrasos), livro caixa (entradas e saídas), valores a receber de cartões, sangrias e conferência de fechamento de caixa. Use para perguntas sobre contas, pagamentos, recebimentos, caixa e diferenças de caixa.
---

# Análises financeiras

Domínios de dados: `contas-pagar`, `livro-caixa`, `provisao` (cartões a receber),
`sangrias`, `fechamentos`. Confira em `sync_log` se o período está baixado; senão,
sincronize (skill `sincronizar`). Consulte via
`node --no-warnings scripts/consultar.mjs "<SQL>"`.

Referências obrigatórias: `docs/dicionario-de-dados.md` (qual data/valor usar —
ex.: recebimento de cartão = `data_deposito`; conta aberta = `data_pagamento IS NULL`)
e `docs/catalogo-metricas.md` (fórmulas oficiais dos indicadores).

> Notas técnicas (validadas em ambiente real):
> - `contas_pagar.data_pagamento` NULL = conta **em aberto**; `descricao` traz o
>   plano de contas ("DESPESAS ADMINISTRATIVAS / TELEFONE MÓVEL").
> - `livro_caixa.valor` é sempre positivo — o sentido está em `tipo`
>   ('entrada'/'saida'); `conta` identifica a conta financeira (banco/caixa).
> - A consulta de contas a pagar na TOTVS filtra por **emissão/competência**;
>   para ver vencimentos futuros, sincronize os meses de emissão correspondentes.
> - O registro completo da API fica em `json_original` (`json_extract` se precisar).

## Contas a pagar

Vencimentos dos próximos 7 dias:
```sql
SELECT data_vencimento, fornecedor, descricao, ROUND(valor, 2) AS valor
FROM contas_pagar
WHERE data_vencimento BETWEEN date('now') AND date('now', '+7 day')
  AND data_pagamento IS NULL
ORDER BY data_vencimento;
```

Contas vencidas e não pagas (atenção do gestor):
```sql
SELECT data_vencimento, fornecedor, ROUND(valor, 2) AS valor
FROM contas_pagar
WHERE data_vencimento < date('now') AND data_pagamento IS NULL
ORDER BY data_vencimento;
```

Total por fornecedor no período: agrupe por `fornecedor`.

## Livro caixa

Entradas x saídas por dia:
```sql
SELECT data, tipo, ROUND(SUM(valor), 2) AS total
FROM livro_caixa
WHERE data BETWEEN :de AND :ate AND deletado = 0 AND estorno = 0
GROUP BY 1, 2 ORDER BY 1;
```

### Movimento por conta — e por que NÃO é o saldo

```sql
SELECT conta,
       ROUND(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 2) AS entrou,
       ROUND(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 2) AS saiu,
       ROUND(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END), 2) AS movimento
FROM livro_caixa
WHERE data BETWEEN :de AND :ate
  AND deletado = 0 AND estorno = 0 AND transferencia = 0
GROUP BY conta ORDER BY ABS(movimento) DESC;
```

Os três filtros são obrigatórios: lançamento excluído e estorno não existem
para efeito de movimento, e **transferência entre contas aparece nas duas
pontas** (sem excluí-la, o mesmo dinheiro é contado duas vezes).

⚠️ **"Quanto eu tenho em caixa?" é a pergunta que este número NÃO responde.**
O sistema da TOTVS não entrega saldo de conta — nem o inicial, nem o
acumulado. O que existe é o movimento do período que já foi baixado; o saldo
real exigiria saber quanto havia em cada conta antes do primeiro lançamento.
Nunca chame isso de "saldo". Resposta pronta:

> *"O sistema da TOTVS não me passa o saldo das suas contas — isso você
> confere no ChefWeb ou no banco. O que eu consigo te mostrar é tudo o que
> entrou e saiu de cada conta no período: [tabela]. Quer que eu detalhe alguma
> delas por categoria ou por dia?"*

Para separar o que já caiu do que ainda está por compensar, quebre por
`compensado`.

## Cartões a receber (provisão)

Quanto vai cair na conta por dia:
```sql
SELECT data_deposito, bandeira,
       ROUND(SUM(COALESCE(valor_liquido, valor_bruto)), 2) AS valor
FROM provisao_cartoes
WHERE data_deposito >= date('now')
GROUP BY 1, 2 ORDER BY 1;
```

## Fechamento de caixa e diferenças

Diferenças de caixa (sobra/falta de dinheiro) — indicador de controle:
```sql
SELECT data_caixa, nome_loja, numero_caixa, operador_caixa,
       ROUND(valor_total_sistema, 2)  AS sistema,
       ROUND(valor_total_recebido, 2) AS recebido,
       ROUND(valor_diferenca_dinheiro, 2) AS diferenca_dinheiro
FROM fechamentos_caixa
WHERE data_caixa BETWEEN :de AND :ate
ORDER BY ABS(COALESCE(valor_diferenca_dinheiro, 0)) DESC;
```

Recebimentos por forma de pagamento no fechamento: use `fechamento_itens`
(junte por `id_fechamento`).

## Sangrias

```sql
SELECT data, ROUND(SUM(valor), 2) AS total, COUNT(*) AS qtd
FROM sangrias WHERE data BETWEEN :de AND :ate GROUP BY 1 ORDER BY 1;
```

## Como apresentar

- Priorize o que exige ação: contas vencidas, diferenças de caixa relevantes.
- Fluxo prático: "esta semana você tem R$ X a pagar e R$ Y a receber de cartões".
- Valores em R$ com formato brasileiro; período sempre explícito.

## DRE gerencial ("como foi o resultado do mês?")

Pedidos como "me mostra a DRE", "qual foi meu resultado", "fechamento do mês":

```
node --no-warnings scripts/dre.mjs gerar [--mes AAAA-MM] [--grupo <id>] --abrir
```

Sem `--mes`, assume o **mês anterior** (o fechado) — não pergunte a data para
o pedido genérico. O HTML traz Visão (Mensal com variação | Anual com
sparklines) e Regime (Competência | Caixa) trocáveis na tela, cascata do
resultado, hierarquia do plano de contas e **cobertura dos lançamentos**.

Ao entregar, INTERPRETE (não só abra o arquivo): diga o resultado e a margem,
os 2 maiores movimentos vs o mês anterior, e o que a cascata mostra. Se a
cobertura estiver baixa (<80%), avise que parte das despesas está sem
classificação no Chef — a DRE melhora se ele classificar os lançamentos.
Regime: competência é o padrão de análise de resultado; caixa responde "sobrou
dinheiro?". Sempre lembre: gerencial, não substitui a contabilidade.

## CMO — Custo de Mão de Obra

Fórmula oficial no catálogo de métricas (3.2). Antes de calcular, confira o
mapeamento: `node --no-warnings scripts/categorias-planos.mjs listar`. Se
vazio, rode `sugerir`, apresente ao gestor em linguagem simples ("esses planos
parecem ser gastos com equipe: ... confirma?") e grave com `definir` **só o
que ele confirmar** — nunca assuma. Pergunte também se a taxa de serviço
repassada à equipe deve compor o CMO.

## Metas

`node --no-warnings scripts/metas.mjs listar|definir|remover` — sempre que
apresentar %CMV, %CMO, prime cost ou faturamento, compare com a meta se
houver ("2,4pp acima da sua meta de 30%"). Gestor citou objetivo? Ofereça
gravar. Apresentação: **percentual como manchete**, reais como apoio.
