# Catálogo de métricas e indicadores — fórmulas oficiais do projeto

Este catálogo define **como o assistente calcula cada indicador**. As fórmulas
usam os campos corretos conforme o [dicionário de dados](dicionario-de-dados.md)
— não invente fórmula própria para indicador catalogado. Benchmarks são
**referências de mercado** (fonte/ano indicados), não normas: cada casa tem sua
realidade.

## 0. Convenções de base de cálculo

Toda análise declara sua **base** e o **período**. Bases oficiais:

| Base | Definição | SQL | Use para |
|---|---|---|---|
| **B1 — Faturamento total** | Tudo que o cliente pagou (inclui taxa de serviço e entrega, líquido de descontos) | `SUM(valor_total)` de `vendas` com `cancelada = 0` | Visão geral de receita, comparativos, ticket médio |
| **B2 — Venda de produtos** | Receita dos itens (SEM taxa de serviço/entrega) | `SUM(vi.valor_total)` de `venda_itens vi` com `vi.status = 1` **e `vi.codigo_produto NOT IN (997, 999)`** (999 = taxa de serviço, 997 = taxa de entrega, lançadas como itens), join `vendas` com `cancelada = 0` | %CMV, mix, margem, engenharia de cardápio |
| **B3 — Cupons** | Nº de vendas válidas | `COUNT(*)` de `vendas` com `cancelada = 0` | Denominadores de ticket/itens por cupom |
| **B4 — Clientes (pessoas)** | Pessoas atendidas | `SUM(quantidade_pessoas)` com `quantidade_pessoas > 0` | Per capita (mesa/à la carte) |

A taxa de serviço (10%) é repasse à equipe, não receita da casa — por isso
indicadores de custo (%CMV, margem) usam **B2**. Ao responder o gestor, diga a
base: "faturamento (com serviço)" ou "venda de produtos (sem serviço)".

**Período padrão termina em D-1 (ontem)**: os dados só chegam à API após o
fechamento de caixa do PDV, então o dia corrente é vazio/parcial. "Hoje" só
com a ressalva explícita de que depende do fechamento do caixa.

**Vários grupos de lojas**: se houver mais de uma `conexao` configurada,
declare sempre o recorte ("consolidado dos 2 grupos" ou "apenas Rede Centro") e
prefira mostrar a quebra por grupo. Junções por código de produto/cliente
precisam incluir `conexao` (dicionário §0).

**Dados que o sistema não tem** (folha de pagamento, nº de mesas/assentos,
segmento da casa, dias de funcionamento): pergunte ao gestor **uma única vez** e
grave em `data/perfil-loja.json` (fora do repositório) para reutilizar. Ex.:
`{ "segmento": "pizzaria", "mesas": 20, "assentos": 80, "folha_mensal": 25000,
"dias_funcionamento": ["ter","qua","qui","sex","sab","dom"] }`.
Indicadores que usam esses dados são **estimativas** — diga isso ao gestor.
A **data de início das vendas de cada loja** não mora aqui: ela dirige a carga
histórica e vai para o cadastro de lojas, com
`lojas.mjs definir --grupo <id> --loja <n> --inicio AAAA-MM-DD`.

---

## 1. Vendas — universais

### 1.1 Faturamento
```sql
SELECT ROUND(SUM(valor_total), 2) AS faturamento          -- B1
FROM vendas WHERE cancelada = 0 AND data_movimento BETWEEN :de AND :ate;
```
Variante "venda de produtos" (B2): some `venda_itens.valor_total` (status = 1).
⚠️ Nunca use `valor_subtotal` (ignora descontos) nem inclua canceladas.

### 1.2 Ticket médio por cupom
`faturamento (B1) ÷ cupons (B3)`. É o ticket que o gestor conhece do PDV —
padrão para balcão, fast food, lanchonete e delivery.

### 1.3 Ticket médio por pessoa (per capita)
`B1 das vendas com pessoas ÷ B4`. Padrão para mesa/à la carte. Comanda
individual já equivale a "por pessoa".
```sql
SELECT ROUND(SUM(valor_total) / SUM(quantidade_pessoas), 2) AS ticket_pessoa
FROM vendas WHERE cancelada = 0 AND quantidade_pessoas > 0
  AND data_movimento BETWEEN :de AND :ate;
```
⚠️ Exclua do denominador cupons com `quantidade_pessoas` 0/NULL (balcão registra 0).

### 1.4 Itens por cupom (IPC)
`SUM(vi.quantidade) itens ativos (excluindo 997/999) ÷ cupons (B3)`. Mede venda
sugestiva.
Complemento — **taxa de anexação** (% de cupons que contêm o grupo):
```sql
SELECT ROUND(100.0 * COUNT(DISTINCT CASE WHEN i.grupo = 'BEBIDAS' THEN v.chave_venda END)
       / COUNT(DISTINCT v.chave_venda), 1) AS pct_cupons_com_bebida
FROM vendas v LEFT JOIN venda_itens i ON i.chave_venda = v.chave_venda AND i.status = 1
WHERE v.cancelada = 0 AND v.data_movimento BETWEEN :de AND :ate;
```

### 1.5 % Descontos
`SUM(valor_desconto) ÷ (SUM(valor_total) + SUM(valor_desconto)) × 100`.
Abra por dia, operador (via json) e produto. Referência prática: acima de
3–5% da venda merece investigação.
⚠️ **Promoções parametrizadas NÃO aparecem aqui** (dicionário §9): o produto em
promoção/happy hour muda de preço sem gerar `valor_desconto`. Para o "desconto
total" real, some também a diferença preço de tabela × preço praticado (2.7).

### 1.6 Crescimento de vendas
`(atual − anterior) ÷ anterior × 100`, comparando períodos com o **mesmo mix de
dias da semana** (ver análise composta 7.1). Nunca compare um mês com 5 sábados
contra um de 4 sem ajustar.

### 1.7 Mix de meios de pagamento
Agrupe pelas **categorias definidas pelo gestor** (o cadastro tem nomes livres
como "PIX SANTANDER"/"PIX ITAU" — dicionário §3):
```sql
SELECT COALESCE(c.categoria, p.descricao) AS categoria,
       ROUND(SUM(p.valor_efetivo), 2) AS valor,
       ROUND(100.0 * SUM(p.valor_efetivo) / SUM(SUM(p.valor_efetivo)) OVER (), 1) AS pct
FROM venda_pagamentos p
JOIN vendas v ON v.chave_venda = p.chave_venda
LEFT JOIN formas_pagamento_categorias c ON c.descricao = p.descricao
WHERE v.cancelada = 0 AND v.data_movimento BETWEEN :de AND :ate
GROUP BY 1 ORDER BY valor DESC;
```
Se aparecerem formas sem categoria, rode o onboarding de agrupamento
(`scripts/categorias-pagamento.mjs sugerir` → confirme com o gestor → `definir`).
⚠️ `valor_efetivo`, nunca `valor_recebido` (troco). PIX custa ~0; cartão 1–5% —
mix importa para custo financeiro.

---

## 2. Cardápio e produto

### 2.1 Mix de vendas (participação por item/categoria)
`receita do item (B2) ÷ B2 total × 100` — calcule também em quantidade.
**Categoria padrão = `subgrupo`** (é como o PDV agrupa e como o gestor pensa o
cardápio); use `grupo` apenas para a visão macro alimentos × bebidas.
⚠️ **Adicionais e combos** (dicionário §2): sabores/tamanhos/componentes vêm
como linhas de valor 0 e o combo concentra a receita — ranking por quantidade
infla com adicionais e o mix subestima componentes de combo. Prefira receita e
avise o gestor da convenção usada.

### 2.2 Curva ABC
Ordene itens por receita (B2) desc.; acumule %: **A** até 80%, **B** 80–95%,
**C** 95–100%. Faça também por quantidade e por margem.
```sql
WITH receita AS (
  SELECT i.codigo_produto, i.nome_produto, SUM(i.valor_total) AS receita
  FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
  WHERE v.cancelada = 0 AND i.status = 1 AND i.codigo_produto NOT IN (997, 999)
    AND v.data_movimento BETWEEN :de AND :ate
  GROUP BY 1, 2),
acum AS (
  SELECT *, SUM(receita) OVER (ORDER BY receita DESC) * 100.0 / SUM(receita) OVER () AS pct_acum
  FROM receita)
SELECT nome_produto, ROUND(receita, 2) AS receita, ROUND(pct_acum, 1) AS pct_acumulado,
       CASE WHEN pct_acum <= 80 THEN 'A' WHEN pct_acum <= 95 THEN 'B' ELSE 'C' END AS classe
FROM acum ORDER BY receita DESC;
```

### 2.3 Margem de contribuição por item
`R$: preço praticado − custo` | `%: margem ÷ preço × 100`.
Custo histórico = `venda_itens.preco_compra` (da época da venda).
```sql
SELECT i.nome_produto, ROUND(SUM(i.valor_total), 2) AS receita,
       ROUND(SUM(i.quantidade * i.preco_compra), 2) AS custo,
       ROUND(SUM(i.valor_total) - SUM(i.quantidade * i.preco_compra), 2) AS margem_rs
FROM venda_itens i JOIN vendas v ON v.chave_venda = i.chave_venda
WHERE v.cancelada = 0 AND i.status = 1 AND i.preco_compra > 0
  AND i.codigo_produto NOT IN (997, 999)
  AND v.data_movimento BETWEEN :de AND :ate
GROUP BY 1 ORDER BY margem_rs DESC;
```
⚠️ `preco_compra = 0` significa "custo não cadastrado" — exclua e avise o gestor
quantos itens ficaram de fora. Para pratos compostos sem ficha técnica completa,
a margem é aproximada — diga isso.

### 2.4 Engenharia de cardápio (matriz Kasavana & Smith)
Compare cada item **dentro da sua categoria** (`subgrupo` — a categoria do PDV)
em dois eixos:
- **Popularidade**: quantidade vendida ≥ 70% da venda média esperada
  (`0,7 × total da categoria ÷ nº de itens da categoria`) → popular.
- **Margem unitária em R$** (nunca %): ≥ média ponderada da categoria → alta.

| | Margem alta | Margem baixa |
|---|---|---|
| **Popular** | ⭐ Estrela — destaque, teste leve aumento de preço | 🐴 Burro de carga — reduza custo/porção, combos |
| **Impopular** | 🧩 Quebra-cabeça — reposicione, sugestão do garçom | 🐶 Cão — remova ou reformule |

### 2.5 CMV teórico e gap
`CMV teórico % = SUM(quantidade × preco_compra) ÷ B2 × 100` (itens com custo).
Para **produto composto** sem `preco_compra` no item, calcule o custo pela
**ficha técnica consumida na própria venda** (`venda_item_composicoes`:
Σ(`quantidade_insumo` × `venda_itens.quantidade` × `preco_compra` do insumo)) ou,
na falta dela, pela ficha do cadastro (`produtos.json_original → Composicoes[]`).
Informe qual método usou. A mesma tabela dá o **consumo teórico de insumos** do
período (compare com compras/estoque).
**Gap = CMV real (3.1) − CMV teórico** → desperdício, porcionamento, desvio.
Gap acima de 2–3 p.p. é alerta clássico.

### 2.6 Markup praticado
`preço de venda ÷ custo` por item (`produtos.preco_venda ÷ preco_compra` para o
cadastro atual). Referência BR: pratos 2,5–3×; drinks até 5×.
⚠️ Markup ≠ margem (markup 100% = margem 50%).

### 2.7 Preço médio praticado
`receita do item ÷ quantidade` vs. `produtos.preco_venda` — detecta descontos
excessivos ou tabela desatualizada. Exclua linhas com `valor_total = 0`
(adicionais/sabores inclusos no preço do principal distorcem a média).
⚠️ Antes de acusar preço fora da tabela, verifique o **padrão temporal**: preço
menor recorrente em certos dias da semana/horários = **promoção programada ou
happy hour** (parametrizados no cadastro, invisíveis pela API — dicionário §9).
Agrupe por dia da semana e faixa de hora para separar promoção de desconto
indevido.

---

## 3. Financeiras

### 3.1 CMV — as três fontes, e quem escolhe

Há **três formas legítimas** de apurar o custo da mercadoria vendida, e **quem
escolhe qual vai para a DRE é o gestor** (`dre.mjs cmv-fonte`), nunca o
assistente. Explique as três antes de perguntar — roteiro em linguagem de
gestor em `docs/ajuda/como-calculamos-o-cmv.md`:

| Fonte | Como | Ponto forte | Ponto cego |
|---|---|---|---|
| **teórico** (2.5) | ficha técnica dos itens vendidos | funciona em qualquer período, sem depender de estoque | não enxerga desperdício, quebra nem desvio |
| **real** (abaixo) | estoque inicial + compras − estoque final | é o consumo verdadeiro; revela a perda | exige estoque nas duas pontas do período |
| **compras** | planos de contas marcados como `mercadoria` (`categorias-planos.mjs`) | bate com o extrato e com a contabilidade | confunde comprar com consumir (estocagem infla o mês) |

O **gap entre o teórico e o real** é o melhor detector de perda que o projeto
tem (2.5) — por isso vale migrar o gestor para o real assim que houver
histórico de estoque, mantendo o teórico como referência de comparação.

### 3.1a CMV real e %CMV
**CMV = Estoque inicial + Compras − Estoque final** | **%CMV = CMV ÷ B2 × 100**.
- Estoque inicial/final: `estoque_posicoes` valorizado por
  **`estoque_posicoes.custo`** — o custo do dia da foto, congelado na coleta —
  nas leituras (`data_leitura`) que abrem e fecham o período. **Exige fotografia
  do estoque no início e no fim.** A rotina diária tira uma foto por dia
  sozinha; o histórico de estoque **começa no dia da instalação**, porque a API
  não devolve posição retroativa (não há como calcular CMV real de um mês
  anterior à primeira foto — nesse caso, CMV teórico e diga que é aproximação).
  ⚠️ Não valorize por `produtos.preco_compra`: o catálogo é sobrescrito a cada
  sincronização, então o cadastro de hoje não é o custo de quando a foto foi
  tirada.
- **Compras: `contas_pagar` por `data_competencia`, filtrado pelos planos
  marcados como `mercadoria` e com `deletado = 0`** — não pelas notas de
  entrada, que trazem equipamento, utensílio e serviço misturados à mercadoria
  (e transferências entre lojas do mesmo grupo). Consequência: **o CMV real
  depende da categorização dos planos**, como o CMO depende da categoria
  `pessoal`. Sem ela, `analisar.mjs cmv` explica o que falta e não inventa
  número.
- **Fonte alternativa (e única para meses antigos): o INVENTÁRIO contado**,
  importado do relatório 41 do ChefWeb com `scripts/inventario.mjs`. Na mesma
  data, a contagem física prevalece sobre a fotografia. É o que permite CMV
  real de período anterior à instalação do assistente.
- **Use `analisar.mjs cmv --de --ate [--grupo] [--loja]`**: ele escolhe a melhor
  fonte para cada ponta (inventário ou fotografia, a mais próxima da data),
  informa a origem e a defasagem, e alerta quando uma das pontas é contagem
  parcial ou quando não houve nota de entrada no período.
- Sem nenhuma das duas pontas → use o CMV teórico (2.5) e diga que é aproximação.

⚠️ Antes de apresentar CMV ou margem, rode `analisar.mjs qualidade`: **custo
incoerente por fator de conversão não preenchido** (a caixa de 1.000 potes
lançada como 1 pote) infla o CMV de um jeito que parece real. O detector
compara o custo com o padrão do subgrupo e usa `unidade_compra <> unidade` como
indício, e **ignora os adicionais de preço 0/0,01**, onde o custo alto é
estratégia comercial.

⚠️ Denominador é **B2** (sem taxa de serviço) — usar B1 reduz o % artificialmente.
Benchmarks BR (F360/Unilever FS/Abrasel, 2024–2026): geral saudável **28–35%**;
cafeteria ~25 · fast food 25–30 · pizzaria 28–32 · bar 30 · à la carte 30–35 ·
lanchonete ~33 · padaria ~35 · japonês 35–40.

### 3.2 CMO — Custo de Mão de Obra
**CMO = Σ despesas dos planos de contas marcados como `pessoal`** —
competência: `contas_pagar` por `data_competencia`; caixa: `livro_caixa`
(saídas) por lançamento. **%CMO = CMO ÷ B1 × 100** (sobre o faturamento).

O mapeamento de quais planos são "pessoal" é do GESTOR: rode
`node --no-warnings scripts/categorias-planos.mjs sugerir`, apresente a
sugestão em linguagem simples e grave só o que ele confirmar
(`definir "PLANO1|PLANO2=pessoal"`). Sem mapeamento confirmado, não calcule —
ofereça fazer o mapeamento. Nota: taxa de serviço repassada à equipe é
remuneração — pergunte ao gestor se ela deve compor o CMO. Referência do
setor: ~25–35% do faturamento, variando por modelo de serviço.

### 3.2b Prime cost
`(CMV + CMO) ÷ B1 × 100` — com o CMO do mapeamento acima (não pergunte mais a
folha se houver planos marcados; `perfil-loja.json` vira fallback).
Referência internacional: ≤ 60–65% (serviço completo), 55–60% (fast food).

### 3.3 Ponto de equilíbrio e meta diária
`PE (R$) = custos fixos do período ÷ (1 − custos variáveis %)`, onde variáveis %
= %CMV + taxa média de cartão + impostos + embalagens. Custos fixos: contas a
pagar/livro caixa (aluguel, energia, sistemas, folha). Entregue como **meta
diária**: `PE ÷ dias de funcionamento` plotado contra a venda do dia.

### 3.4 Fluxo de caixa projetado
Entradas futuras (`provisao_cartoes` por `data_deposito`) − saídas futuras
(`contas_pagar` por `data_vencimento`, `data_pagamento IS NULL`), acumulado dia
a dia. Destaque dias com saldo projetado negativo e concentração de vencimentos.

### 3.4b Movimento por conta financeira (NÃO é saldo)

**Base**: `livro_caixa`, agrupando por `conta`.
**Fórmula**: entrou = SUM(valor) com `tipo='entrada'`; saiu = SUM(valor) com
`tipo='saida'`; movimento = entrou − saiu.
**Filtros obrigatórios**: `deletado = 0 AND estorno = 0 AND transferencia = 0`
— lançamento excluído e estorno não existem para efeito de movimento, e
transferência entre contas aparece nas duas pontas (entraria em dobro).
Para separar o que já caiu do que está por cair, quebre por `compensado`.

> ⚠️ **Isto não é o saldo da conta.** A API do ChefWeb não entrega saldo
> (nem inicial, nem acumulado) — ver o aviso na seção 7 do dicionário de
> dados. Apresente sempre como **"quanto entrou e saiu de cada conta no
> período analisado"**, nunca como "saldo" ou "quanto você tem em caixa".
> Se o gestor pedir o saldo, explique em uma frase: *"o sistema da TOTVS não
> me passa o saldo das suas contas; o que eu consigo mostrar é tudo o que
> entrou e saiu de cada uma no período — o saldo em si você confere no
> ChefWeb ou no banco"*.

### 3.5 Taxa média efetiva de cartões
```sql
SELECT bandeira, ROUND(SUM(valor_taxa), 2) AS taxas,
       ROUND(100.0 * SUM(valor_taxa) / SUM(valor_bruto), 2) AS taxa_media_pct
FROM provisao_cartoes WHERE data_venda BETWEEN :de AND :ate
GROUP BY 1 ORDER BY taxas DESC;
```
Referência BR (2025–2026): débito 0,8–1,5%; crédito à vista 2–4%. **Auditoria de
taxa**: compare a taxa efetiva com a contratada — acima é dinheiro vazando.

### 3.6 Prazo médio de recebimento (PMR)
`Σ(valor_liquido × dias(data_deposito − data_venda)) ÷ Σ valor_liquido` em
`provisao_cartoes`. Crédito à vista no BR liquida em ~D+30.

### 3.7 Contas vencidas e a vencer
Vencidas: `data_vencimento < date('now') AND data_pagamento IS NULL`.
Próximos 7 dias: `data_vencimento BETWEEN date('now') AND date('now','+7 day')`.
Atraso médio pago: `AVG(julianday(data_pagamento) − julianday(data_vencimento))`
quando > 0. ⚠️ Lembre: a busca na TOTVS filtra por emissão — sincronize meses
anteriores para enxergar parcelas futuras (dicionário §6).

### 3.8 Margem operacional aproximada
`(B2 − CMV − despesas do período) ÷ B2 × 100`, despesas do livro caixa
(saídas) e/ou contas a pagar — cuidado para não contar a mesma despesa duas
vezes (escolha UMA fonte e diga qual). Referência Abrasel: margem mínima 15%.

---

## 4. Operacionais e controle

### 4.1 Cancelamentos e descontos — auditoria (indicador antifraude central)
O sistema grava **operador e motivo** de cada cancelamento e desconto — sempre
analise pelos dois. Taxa geral (quantidade E valor):
```sql
SELECT ROUND(100.0 * SUM(cancelada) / COUNT(*), 1) AS pct_cupons,
       ROUND(100.0 * SUM(CASE WHEN cancelada = 1 THEN valor_total END)
             / SUM(valor_total), 1) AS pct_valor
FROM vendas WHERE data_movimento BETWEEN :de AND :ate;
```
Vendas canceladas por quem e por quê:
```sql
SELECT operador_cancelamento, motivo_cancelamento,
       COUNT(*) AS qtd, ROUND(SUM(valor_total), 2) AS valor
FROM vendas WHERE cancelada = 1 AND data_movimento BETWEEN :de AND :ate
GROUP BY 1, 2 ORDER BY valor DESC;
```
Itens cancelados dentro de vendas ativas (quem lançou × quem cancelou):
```sql
SELECT ic.operador_cancelamento, ic.motivo, COUNT(*) AS qtd
FROM venda_itens_cancelados ic
JOIN vendas v ON v.chave_venda = ic.chave_venda
WHERE v.data_movimento BETWEEN :de AND :ate
GROUP BY 1, 2 ORDER BY qtd DESC;
```
Descontos por operador e motivo: idem em `venda_descontos` (junte com `vendas`
para o período e com `valor_desconto` para o valor).
Regra prática: > 2–3% do valor, **pico concentrado num operador** ou motivos
genéricos repetidos ("teste", "erro") merecem auditoria. Cruze também com
horário e com quebra de caixa (4.3) do mesmo operador.

### 4.2 Sangrias
Total, frequência e horário por caixa/dia (`sangrias`). Sangria é
transferência, não despesa — concilie com o fechamento.

### 4.3 Quebra de caixa
`fechamentos_caixa.valor_diferenca_dinheiro` (recebido − sistema) por
dia/caixa/operador; série acumulada e % sobre venda em dinheiro. Com sangrias e
suprimentos registrados, diferença deve ser exceção.

### 4.4 Curva de movimento (heatmap hora × dia da semana)
```sql
SELECT CAST(strftime('%w', data_movimento) AS INT) AS dia_semana,
       strftime('%H', data_hora) AS hora,
       COUNT(*) AS cupons, ROUND(SUM(valor_total), 2) AS faturamento
FROM vendas WHERE cancelada = 0 AND data_movimento BETWEEN :de AND :ate
GROUP BY 1, 2;
```
⚠️ Dia = `data_movimento`; hora = `data_hora` (dicionário §1). Use para escala,
horário de funcionamento e promoções em vales de movimento.

### 4.5 Giro de mesa e RevPASH (estimativas — requerem mesas/assentos)
Giro: `cupons de mesa no turno ÷ nº de mesas`. RevPASH: `B1 ÷ (assentos × horas
de operação)`. Mesas/assentos vêm do `perfil-loja.json`.

### 4.6 Desempenho por atendente × operador de caixa
São papéis diferentes (dicionário §1–2):
- **Garçom/lançador** = `venda_itens.atendente` (quem lançou o item) → ranking
  de venda, itens por cupom, venda sugestiva, comissões.
- **Operador de caixa** = `vendas.operador_caixa` (quem fechou a conta/recebeu)
  → cancelamentos, descontos, quebra de caixa, sangrias.
Cruze os dois: venda alta + cancelamento alto no mesmo nome = atenção.

---

## 5. Estoque e compras

### 5.1 Giro de estoque
`CMV do período ÷ estoque médio a custo [(inicial + final) ÷ 2]`. Perecíveis
giram em dias, não meses.

### 5.2 Cobertura em dias
`saldo atual ÷ consumo médio diário` (consumo via vendas dos últimos 30 dias).
SQL pronta na skill `estoque`. Cruze com ABC: **item A com cobertura baixa =
compra urgente; item C com cobertura de meses = capital parado.**

### 5.3 Ruptura
% de produtos ativos com saldo ≤ 0 na última fotografia; destaque os de curva A
(perda direta de venda). Saldo negativo = erro de lançamento (alerta de
processo).
⚠️ **Tipos de produto** (dicionário §9): produto **composto** não tem estoque
próprio (olhe os insumos, que costumam ter `exibir_no_cardapio = 0`);
**processado** tem estoque próprio (é produzido). Não acuse "ruptura" de um
composto.

### 5.3b Quebra de produção (padaria/produção própria)
Para **processados**: quantidade produzida (entradas de estoque do processado)
− quantidade vendida no período. Sem o dado de produção, aproxime pela variação
de estoque entre fotografias + vendas. Perda alta = fornada errada/validade.

### 5.4 Valor imobilizado
`SUM(quantidade × produtos.preco_compra)` da última fotografia, por grupo;
destaque itens sem venda há 30+ dias (estoque morto).

### 5.5 Variação de preço de compra
Preço unitário por insumo × fornecedor × mês, das notas de entrada
(`json_original` traz os itens do XML quando disponíveis; senão use o total por
fornecedor). Variação vs. compra anterior detecta inflação de insumo e
oportunidade de troca de fornecedor.

---

## 6. Indicadores por segmento

Pergunte o segmento uma vez (grave no `perfil-loja.json`) e priorize:

| Segmento | Indicadores prioritários |
|---|---|
| **Bar** | CMV de bebidas separado (ref. internacional 18–24%); mix bebidas × comidas; venda por faixa horária/evento; consumo por comanda; gap CMV teórico × real (revela perda de bebida); % couvert artístico |
| **À la carte** | Ticket POR PESSOA; giro de mesa e permanência; RevPASH; engenharia de cardápio; anexação de entrada/sobremesa/vinho; almoço × jantar |
| **Quilo** | Preço médio efetivo do kg (venda do buffet ÷ kg — itens de produtos `pesavel = 1`, onde `quantidade` = peso); consumo médio por cliente (ref. ~350 g/visita); kg/dia; mix balança (`pesavel`) × balcão (bebida é a margem); ticket dos complementos |
| **Padaria** | Vendas por turno (madrugada/manhã/tarde/noite via `data_hora`); quebra de produção (produzido − vendido); mix produção própria × revenda; pão francês kg como termômetro; CMV ~35% |
| **Lanchonete** | Anexação de bebida (KPI nº 1); taxa de combo; curva horária; IPC; CMV ~33% |
| **Fast food** | Vendas por canal; transações/hora no pico; taxa de upsell; venda por daypart; CMV 25–30% |
| **Casa noturna** | Faturamento POR EVENTO/NOITE (madrugada pertence ao `data_movimento` da noite — é o dia comercial); entrada/couvert × consumação; consumo por comanda e % comandas no mínimo; venda por atendente por evento; público (nº comandas)/evento |
| **Pizzaria** | Mix de sabores COM margem por sabor; ticket delivery × salão; curva sex–dom; taxa de bordas/adicionais; CMV 28–32% |
| **Açaiteria** | Taxa de adicionais por copo (é a margem); venda × dia da semana/estação; preço médio por copo/kg; delivery × balcão |
| **Sorveteria** | Índice de sazonalidade mensal (mês ÷ média 12 meses) para planejar caixa do inverno; kg × bola/pote; concentração fim de semana; cobertura × validade |

**Delivery (transversal)**: identifique pela **presença do item de código 997**
(taxa de entrega) na venda — `EXISTS (SELECT 1 FROM venda_itens WHERE
chave_venda = v.chave_venda AND codigo_produto = 997)` — ou por
`valor_taxa_entrega > 0` (entrega grátis pode não ter nenhum dos dois;
`TelaVenda` no json ajuda a refinar). Ticket delivery × salão; margem por canal
(desconte comissão da plataforma — iFood 12–27%/pedido — e embalagem);
% delivery sobre a venda. **Encomendas**: exclua do ticket médio do dia
(distorcem) e acompanhe a carteira futura à parte.

---

## 7. Análises compostas

1. **Comparativo ajustado por dia da semana** — compare seg×seg…dom×dom, ou
   normalize o mês pela venda média de cada dia da semana × nº de ocorrências.
   Elimina o falso "caiu 10%" do mês com um sábado a menos.
2. **Gap CMV teórico × real** — melhor detector de desperdício/desvio (2.5 + 3.1).
3. **Score de anomalias por operador/dia** — cancelamentos + descontos + quebra
   de caixa + sangrias fora de padrão + % dinheiro anormalmente baixo.
4. **Canibalização em promoções** — promoveu X: compare venda dos substitutos da
   categoria e a margem R$ TOTAL da categoria antes/depois.
5. **Meta diária de equilíbrio** — PE ÷ dias, contra a venda dia a dia ("hoje a
   casa se pagou às 20h40").
6. **Conciliação de cartões** — `venda_pagamentos` (cartão) × `provisao_cartoes`
   por dia: encontra venda não repassada e taxa acima do contratado.
7. **Compras × consumo por insumo** — volume comprado (entradas) vs. consumo
   teórico das vendas → sobrecompra sistemática.
8. **Fiscal × gerencial** — `notas_fiscais` (venda) × `vendas` por dia: diferenças
   indicam falha de emissão.

---

## 8. Regras de apresentação ao gestor

1. Sempre diga **período** e **base** ("faturamento com serviço", "venda de
   produtos sem serviço").
2. Benchmark é referência de mercado — cite como tal ("o mercado considera
   saudável 28–35%"), nunca como veredito.
3. Indicador com dado externo (folha, mesas) = estimativa — diga.
4. Se faltar custo cadastrado (`preco_compra = 0`) em parte dos itens, informe a
   cobertura do cálculo ("calculei com 82% dos itens; 18% não têm custo
   cadastrado").
5. Um número nunca vem sozinho: compare com o período anterior equivalente e
   aponte 1–3 ações práticas.

---

## Fontes principais dos benchmarks

Abrasel-PE (seis indicadores cruciais; margem mínima 15%) · SEBRAE (Guia de
Indicadores para Varejo; engenharia de cardápio SEBRAE-RS) · F360 e Unilever
Food Solutions (%CMV por segmento, 2024–2026) · SisFood (CMV; custo iFood) ·
Restaurant365/Toast (prime cost) · Stark Bank/Transfeera (taxas de cartão MDR,
2025–2026) · iFood Parceiros (taxas por plano, 2026) · Abrahão/EPOC/Tagme
(RevPASH, giro de mesa, ponto de equilíbrio) · Kasavana & Smith (engenharia de
cardápio) · Sischef/Ivan Lima (restaurante a quilo) · Procon-SP/Agência Brasil
(preço médio do kg, 2026). Links completos no relatório de pesquisa que
originou este catálogo (histórico do projeto).

### 3.6 Taxa de ocupação / giro de mesas
Requer o **nº de mesas** da loja (pergunte uma vez; grave em
`perfil-loja.json` como `mesas` por loja). Com o setor da venda
(`tela_venda` de mesa — códigos 1 e 6):
`giro de mesas = vendas de mesa no turno ÷ nº de mesas`;
`clientes por mesa = SUM(quantidade_pessoas) ÷ vendas de mesa`
(filtre `quantidade_pessoas > 0`). Analise por turno/dia da semana para achar
horários ociosos e de fila. Sem o nº de mesas confirmado, reporte apenas
vendas/pessoas por período e ofereça cadastrar.

### 3.7 Lucro líquido gerencial
É o **Resultado Operacional da DRE** (`scripts/dre.mjs`) — competência ou
caixa, a critério do gestor. Não recalcule por fora da DRE.

## Metas do gestor (compare sempre que existir)

O gestor define metas em conversa; grave com
`node --no-warnings scripts/metas.mjs definir "indicador=valor" [--grupo <id>]
[--loja <n>] [--produto <codigo>]` (`listar`/`remover` completam). Metas são
**abertas**: qualquer indicador, em qualquer escopo — geral, por grupo, por
loja e **por produto** ("quero vender R$ 8.000/mês do produto X",
"faturamento de R$ 90 mil na loja 2"). A mais específica prevalece sobre a
geral no mesmo indicador. Convenção: `_pct` = percentual; custos são
meta de TETO, receitas/ticket de PISO. **Toda análise que toque um indicador
com meta definida compara com ela**: "CMV 32,4% — **2,4pp acima** da sua meta
de 30%". O briefing diário alerta estouros. Se o gestor mencionar um objetivo
("quero CMV abaixo de 30"), ofereça gravar como meta.

**Regra de apresentação — % é a língua do gestor**: CMV e CMO se apresentam
SEMPRE pelo percentual (%CMV, %CMO sobre B1) como manchete; o valor em reais
é apoio entre parênteses. O mesmo vale para prime cost e desconto.
