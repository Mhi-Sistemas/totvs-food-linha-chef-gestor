---
name: dashboard
description: Gera painéis visuais (dashboards HTML com gráficos) a partir dos dados da loja - vendas, financeiro ou estoque - e abre no navegador. Use quando o gestor pedir "painel", "gráfico", "relatório visual", "dashboard" ou quando uma análise ficar melhor visualizada do que em texto.
---

# Dashboard — painéis visuais para o gestor

**Não escreva HTML de painel à mão.** Monte uma **especificação** e chame o
gerador — o padrão visual (bonito, moderno, leitura rápida), a paleta validada
para daltonismo, o formato brasileiro, as marcas de feriado e a atribuição de
autoria saem certos por construção. O arquivo gerado é 100% autossuficiente:
abre offline e pode ser enviado a qualquer pessoa.

```
node --no-warnings scripts/painel.mjs gerar --spec <arquivo.json|-> [--saida relatorios/x.html] [--abrir]
node --no-warnings scripts/painel.mjs exemplo     # especificação modelo comentável
```

## Processo

1. Garanta os dados do período no banco (skills `sincronizar`/`rotina`).
2. **Verifique `personalizados/`**: se o gestor tem um painel próprio aplicável
   (`*.painel.json`), use a especificação dele — ela prevalece. "Salve como meu
   padrão" = gravar a espec lá (com `gatilhos` num `.md` par, ou campo
   `gatilhos` no próprio JSON).
3. Monte a especificação (formato abaixo), valide campos/fórmulas no
   dicionário de dados e gere com `--abrir`. Espec pontual pode ir por stdin
   (`--spec -`); espec que o gestor vai reutilizar vai para `personalizados/`.
4. Diga onde o arquivo ficou salvo, para reabrir ou compartilhar depois.

## A especificação

```json
{
  "titulo": "Painel de Vendas — Minha Loja",
  "periodo": { "de": "2026-09-01", "ate": "2026-09-23" },
  "grupo": "principal",
  "observacao": "1 frase SUA com o principal insight do período — sempre inclua.",
  "filtro": {
    "rotulo": "Loja", "todas": "Todas as lojas", "parametro": "loja",
    "opcoes_sql": "SELECT DISTINCT codigo_loja, 'Loja '||codigo_loja FROM vendas WHERE ... ORDER BY 1"
  },
  "kpis": [
    { "rotulo": "Faturamento", "formato": "moeda", "sql": "SELECT SUM(...)", "delta_sql": "SELECT ... do período anterior" }
  ],
  "graficos": [
    { "tipo": "linha", "titulo": "Faturamento por dia", "formato": "moeda", "largura": "cheia", "sql": "SELECT dia, valor" }
  ]
}
```

Regras da especificação:

- **Colunas por convenção**: 1ª = categoria/dia, 2ª = valor, 3ª (opcional) =
  série. Datas em ISO (como o banco devolve) viram DD/MM sozinhas.
  **Sempre dê alias às colunas** (`SELECT x AS nome, y AS valor`): coluna sem
  alias cujo nome vira número (ex.: literal `SELECT 'A', 244`) é reordenada
  pelo JavaScript (chaves inteiras enumeram primeiro) e troca nome↔valor.
- **Formato pt-BR obrigatório no que o gestor vê**: dia da semana sempre
  pelo NOME — gere na consulta
  (`CASE strftime('%w', d) WHEN '0' THEN 'domingo' ... END`, ordenando por
  `MIN(strftime('%w', d))`), nunca exiba 0–6. Meses: o gerador converte
  `AAAA-MM` para "jan/26" sozinho, mas nunca escreva 2026-01 em título,
  legenda ou observação. Textos com acentuação e gramática corretas.
- **💳 Meios de pagamento: SEMPRE por categoria, nunca por forma solta.** O
  nome da forma é livre no ChefWeb e um grupo real chega a ter 45 delas
  ("PIX STONE", "MASTER VISA DEBITO INFINITY", "IFOOD ONLINE"): um gráfico por
  forma é ilegível e a maior parte do valor some numa fatia "Outros". Monte
  com `niveis` — **categoria no 1º nível, formas daquela categoria no 2º**:

  ```json
  "niveis": [
    { "sql": "SELECT COALESCE(c.categoria,'Sem categoria') AS categoria, ROUND(SUM(p.valor_efetivo),2) AS valor FROM venda_pagamentos p JOIN vendas v ON v.chave_venda=p.chave_venda AND v.conexao=p.conexao LEFT JOIN formas_pagamento_categorias c ON c.descricao=p.descricao WHERE ... GROUP BY 1 ORDER BY 2 DESC" },
    { "sql": "SELECT p.descricao AS forma, ROUND(SUM(p.valor_efetivo),2) AS valor FROM venda_pagamentos p JOIN vendas v ON ... LEFT JOIN formas_pagamento_categorias c ON c.descricao=p.descricao WHERE COALESCE(c.categoria,'Sem categoria')='{{pai}}' AND ... GROUP BY 1 ORDER BY 2 DESC" }
  ]
  ```

  **Se as categorias ainda não estiverem definidas, pare e defina antes**
  (`categorias-pagamento.mjs listar` para conferir; `sugerir` → apresente a
  proposta ao gestor → `definir`). Marketplace é categoria própria — iFood,
  AiQFome e afins **não são crédito**; "DEBITO IFOOD" é iFood, não débito.
  Mastercard e Visa são crédito; Visa Electron, Maestro e RedeShop são débito.
  O que restar ambíguo, **pergunte ao gestor** — não classifique no escuro.
- **Tipos**: `linha` (evolução no tempo; ganha marcas de feriado/evento),
  `barras` (dia da semana/hora), `barras_h` (rankings, maior no topo),
  `rosca` (composição; máx. 6 fatias, resto vira "Outros" sozinho).
- **Formatos**: `moeda`, `inteiro`, `numero`, `pct`.
- **`tabela`** (relatórios detalhados): tipo que vira **tabela interativa**
  — busca global, filtros automáticos nas colunas de texto com poucas opções,
  ordenação por clique no cabeçalho, formatos (R$, data, %) detectados por
  coluna. Use `largura: "cheia"` e liste as colunas na ordem de leitura;
  LIMITE a consulta (~2.000 linhas). **É a entrega padrão para "me dá um
  relatório de..."** — não monte tabela rica à mão.
- **`largura: "cheia"`** para a série temporal principal.
- **KPIs**: 3 a 5, os que respondem "como estou?" em 3 segundos. Use
  `delta_sql` (mesmo cálculo no período anterior) sempre que fizer sentido —
  vira a seta ▲/▼ de comparação.
- **`observacao`**: sua análise em 1 frase (o que subiu/caiu e por quê).
  Painel sem insight é só enfeite — não pule.
- **Filtro** (ex.: por loja, para redes): todas as consultas devem conter o
  marcador `{{parametro}}` no padrão
  `AND ('{{loja}}'='' OR v.codigo_loja='{{loja}}')`. Cada opção é recalculada
  por consulta — ticket médio e percentuais saem exatos por recorte.
- **Drill-down (`niveis`)**: em vez de `sql`, um array `niveis` — cada nível
  com sua consulta, usando `{{pai}}` para a categoria clicada no nível acima:

  ```json
  "niveis": [
    { "sql": "SELECT grupo, SUM(...) ... GROUP BY 1" },
    { "sql": "SELECT subgrupo, SUM(...) ... AND grupo='{{pai}}' GROUP BY 1" },
    { "sql": "SELECT nome_produto, SUM(...) ... AND subgrupo='{{pai}}' GROUP BY 1 LIMIT 15" }
  ]
  ```

  **Aplique drill-down automaticamente, sem o gestor pedir**, sempre que a
  dimensão tiver hierarquia natural: **grupo → subgrupo → produto** (mix de
  vendas — o padrão preferido ao "top produtos" plano), **categoria de
  pagamento → forma de pagamento**, **plano de contas 1 → plano 2**
  (financeiro), **rede → loja** (quando não houver filtro por loja),
  **dia → produto do dia** quando fizer sentido. Cada nível é pré-calculado na geração; limite o último nível
  (`LIMIT`) para o arquivo não inchar. O gestor navega clicando e volta pela
  trilha "Início ▸ ...".
- Regras de ouro dos dados: `cancelada = 0`, `venda_itens.status = 1`,
  excluir códigos 997/999 em análises de produto, joins por (`conexao`, código).
  Campos certos em `docs/dicionario-de-dados.md`; fórmulas em
  `docs/catalogo-metricas.md`; painéis prontos em `docs/catalogo-relatorios.md` §2.

## Conteúdo padrão do "painel de vendas" (quando o gestor não especificar)

KPIs: faturamento (com delta), cupons, ticket médio (com delta), itens por
cupom. Gráficos: linha do faturamento por dia (cheia), vendas por categoria
com mergulho grupo → subgrupo → produto (`barras_h` + `niveis`, sem 997/999),
dia da semana (`barras`), meios de pagamento (`rosca`, com mergulho
categoria → forma se o gestor já agrupou). Com mais de uma loja: filtro
por loja. Adapte para financeiro (contas a vencer, fluxo, cartões) e estoque
(críticos, valor imobilizado) conforme o pedido.

## HTML à mão — só como exceção

Apenas para pedidos que a especificação não expressa (layout muito específico).
Nesse caso mantenha: identidade ChefWeb (navy `#002233`, âmbar `#feac0e`),
paleta de séries `#2563eb #d97706 #059669 #7c3aed #dc2626 #0891b2` nesta ordem,
`<meta name="author" content="MHI Sistemas">` e o rodapé de autoria
obrigatório (a licença exige):

```
Assistente de Gestao - projeto da MHI Sistemas (revenda TOTVS Food Linha
Chef). Nao e um produto oficial TOTVS. Uso por conta e risco do usuario.
```
