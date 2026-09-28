# Dicionário de dados — qual campo usar em cada cálculo

Este documento é a **autoridade semântica** do projeto. Vários campos têm nomes
parecidos (`data_movimento` × `data_hora` × `data_caixa`; `valor_total` ×
`valor_subtotal`; `valor_recebido` × `valor_efetivo`) e usar o errado produz
números errados. **Em caso de dúvida sobre qual campo usar, consulte este
arquivo antes de escrever a consulta.** O schema físico das tabelas está em
[banco-de-dados.md](banco-de-dados.md); as fórmulas dos indicadores em
[catalogo-metricas.md](catalogo-metricas.md).

## 0. A coluna `conexao` — grupos de lojas (LEIA PRIMEIRO)

O gestor pode ter **vários grupos de lojas**: cada grupo é um "diretório site"
do ChefWeb, com seu próprio **número de série** e suas próprias credenciais.
Ele pode cadastrar novos grupos a qualquer momento, depois do onboarding.

**Toda tabela de dados tem a coluna `conexao`** (o identificador do grupo).
Isso existe porque os códigos do ChefWeb **se repetem entre grupos**: o
grupo A e o grupo B podem ter, cada um, a loja 1, o produto 10 e o
fechamento 99. As tabelas `produtos`, `clientes` e `fechamentos_caixa` têm
chave composta `(conexao, codigo)` justamente por isso.

⚠️ **Regras obrigatórias quando há mais de um grupo:**
- Em qualquer join por código (`produtos`, `clientes`, `estoque_posicoes`),
  **junte também por `conexao`** — senão o produto 10 do grupo A casa com o
  produto 10 do grupo B.
  `JOIN produtos p ON p.codigo = e.codigo_produto AND p.conexao = e.conexao`
- `codigo_loja` sozinho é **ambíguo**: identifique a loja pelo par
  (`conexao`, `codigo_loja`), ou use `nome_loja`.
- Ao apresentar números, diga de qual grupo são. Se o gestor não especificou,
  pergunte se ele quer **consolidado** (todos os grupos somados) ou
  **separado por grupo** — e mostre a quebra por grupo quando fizer sentido.
- Com um único grupo configurado, nada muda: pode ignorar a coluna.

Descobrir os grupos existentes:
`SELECT DISTINCT conexao FROM vendas` (ou a lista completa em
`data/conexoes.json`, gerida pela página de configuração).

## Convenções gerais

- Datas-dia: `AAAA-MM-DD`. Data/hora: `AAAA-MM-DDTHH:MM:SS`.
- `"0001-01-01"` na API significa **"sem data"** (os sincronizadores já gravam NULL).
- "Bruto" = antes de taxas/descontos; "líquido" = depois.

---

## 1. Vendas (`vendas`) — origem: CapaVenda

### As três datas de uma venda — a confusão mais perigosa

| Coluna | Campo API | O que é | Use para |
|---|---|---|---|
| `data_movimento` | `DataMovimento` | **Dia comercial** do movimento (dia do caixa). Vendas de madrugada contam no dia em que o caixa abriu. | **Análises diárias, semanais, mensais — é O campo padrão de período.** |
| `data_hora` | `DataRecebimento` | Data e **hora real** em que a venda aconteceu. | Curva por horário, análise de pico. Nunca para agrupar por dia (a madrugada cairia no dia "errado"). |
| — (só no json) | `DataIntegracaoChefweb` | Quando a venda subiu para a nuvem. | Nada de negócio. Ignorar em análises. |

Regra prática: **"por dia" = `data_movimento`; "por hora" = `strftime('%H', data_hora)`**.

⚠️ **Disponibilidade: os dados só chegam à API após o FECHAMENTO DE CAIXA do
PDV.** O dia corrente fica vazio ou parcial até o caixa fechar — **o período
padrão de análise e sincronização termina em D-1 (ontem)**. "Vendas de hoje"
só existem depois do fechamento (e casas que fecham de madrugada só terão o
dia completo no dia seguinte).

### Os valores de uma venda

| Coluna | Campo API (TotalizadorVenda) | O que é |
|---|---|---|
| `valor_subtotal` | `ValorSubTotal` | Soma dos itens ANTES de descontos e acréscimos. |
| `valor_desconto` | `ValorTotalDescontoFiscal + ValorTotalDescontoSistema` | Total de descontos concedidos. |
| `valor_acrescimo` | `ValorTotalAcrescimo` | Acréscimos (exceto serviço/entrega). |
| `valor_servico` | `ValorTotalServico` | Taxa de serviço (os "10%"). |
| `valor_taxa_entrega` | `ValorTotalTaxaEntrega` | Taxa de entrega (delivery). |
| `valor_total` | `ValorTotal` | **Valor final pago pelo cliente. USE ESTE para faturamento.** Já inclui serviço e entrega, já desconta os descontos. |

Decomposição (aproximada): `valor_total ≈ valor_subtotal − valor_desconto +
valor_acrescimo + valor_servico + valor_taxa_entrega`.

⚠️ Armadilhas:
- **Faturamento** = `SUM(valor_total)` com `cancelada = 0`. Nunca some
  `valor_subtotal` (ignora descontos/serviço) nem misture os dois.
- **Receita de produtos** (para mix, CMV, margem) = `SUM(venda_itens.valor_total)`
  dos itens ativos — NÃO inclui taxa de serviço nem entrega. Por isso a soma dos
  itens é menor que o faturamento quando há serviço/entrega.
- `quantidade_pessoas` pode ser 0/NULL em balcão e delivery — ao calcular ticket
  por pessoa, filtre `quantidade_pessoas > 0`.

### Setor da venda (`tela_venda`)

Indica o **setor/modo de atendimento** em que a venda aconteceu. Tabela **fixa
do sistema** (clientes não criam telas próprias), confirmada pela MHI:

| Código | Setor |
|---|---|
| 1 | Mesa |
| 2 | Cartão (comanda) |
| 3 | Entrega (delivery) |
| 4 | Balcão |
| 5 | Balcão |
| 6 | Mesa |
| 7 | Cartão (comanda) |
| A | Autopesagem (balança) |
| 21 | NFe (emissor de nota avulsa) |

Note que códigos diferentes apontam para o MESMO setor (1 e 6 = mesa; 2 e 7 =
cartão; 4 e 5 = balcão) — são telas distintas do PDV para o mesmo modo de
atendimento. **Sempre agrupe pelo setor**, não pelo código. O código `A` é
letra: trate a coluna como texto. Em SQL:

`CASE CAST(tela_venda AS TEXT) WHEN '1' THEN 'Mesa' WHEN '6' THEN 'Mesa'
WHEN '2' THEN 'Cartão' WHEN '7' THEN 'Cartão' WHEN '3' THEN 'Entrega'
WHEN '4' THEN 'Balcão' WHEN '5' THEN 'Balcão' WHEN 'A' THEN 'Autopesagem'
WHEN '21' THEN 'NFe' ELSE 'Outro ('||tela_venda||')' END`

Uso: dimensão padrão para análises por canal — faturamento e ticket por setor,
participação do delivery, mesa × balcão por horário. Checagem de sanidade:
venda com o item 997 (taxa de entrega) deve estar no setor Entrega. Não
confundir com `IDSetorVenda` do retorno bruto (outro campo; veio sempre 0).

### Status e cancelamentos

| Coluna | O que é |
|---|---|
| `cancelada` | 1 = venda cancelada. **Toda análise de vendas filtra `cancelada = 0`**, exceto a análise de cancelamentos em si. |
| `motivo_cancelamento`, `operador_cancelamento` | **Por quê e QUEM cancelou a venda** — o sistema registra ambos. Base da auditoria de cancelamentos. |
| `venda_itens.status` | 1 = item ativo, 2 = item cancelado. Use `status = 1` em análises de produto. Um item cancelado numa venda ativa NÃO entra no mix. |
| `status_venda`, `modelo_fiscal` | Situação e modelo do documento fiscal (NFCe/SAT/ECF). Irrelevantes para análise gerencial comum. |

**Tabelas de auditoria** (descontos e cancelamentos são os principais
indicadores de erro operacional ou fraude — trate como análise de primeira
classe, sempre por operador e motivo):
- `venda_descontos` (`chave_venda`, `codigo_operador`, `operador`, `motivo`) —
  quem concedeu cada desconto e por quê.
- `venda_itens_cancelados` (`chave_venda`, `data_hora`, `nome_produto`,
  `operador_lancamento`, `operador_cancelamento`, `motivo`) — item cancelado
  dentro de venda ativa: quem lançou, quem cancelou, quando e por quê.

### Os dois "atendentes" de uma venda

| Coluna | Quem é | Use para |
|---|---|---|
| `vendas.operador_caixa` | Quem **fechou a conta / recebeu o pagamento / emitiu o cupom** (operador do caixa). | Análises de caixa, cancelamentos, descontos, quebra de caixa. |
| `venda_itens.atendente` | Quem **lançou o item na conta** — geralmente o **garçom**. | Ranking de garçons, venda sugestiva, comissões. |

⚠️ Terminologia: **o caixa não é vendedor** — chame-o sempre de "operador de
caixa". Quem vende é o garçom/atendente que lança os itens. Nunca apresente um
ranking de `operador_caixa` como "quem mais vendeu".

## 2. Itens de venda (`venda_itens`)

| Coluna | Campo API | O que é |
|---|---|---|
| `quantidade` | `Quantidade` | Quantidade vendida. Em produtos por peso (quilo), é o peso na unidade do produto (ex.: KG). |
| `valor_unitario` | `ValorUnitario` | Preço unitário praticado na venda. |
| `valor_desconto` / `valor_acrescimo` | idem | Do item. |
| `valor_total` | `ValorTotal` | **Valor final do item** (qtd × unitário − desconto + acréscimo). Use para receita por produto. |
| `preco_compra` | `PrecoCompra` | **Custo do produto NA ÉPOCA da venda** — base do CMV teórico por item. Pode ser 0 quando não cadastrado (trate 0 como "sem custo", não como custo zero). |
| `grupo` / `subgrupo` | `Produto.Grupo/SubGrupo` | Classificação do cardápio. **O PDV agrupa os produtos por SUBGRUPO** — é a categoria que o gestor reconhece (SANDUICHES, CERVEJAS...); o grupo é macro (ALIMENTOS/BEBIDAS). **Use `subgrupo` como categoria padrão** em mix e engenharia de cardápio; `grupo` só para a visão macro alimentos × bebidas. |
| `atendente` | `AtendenteVenda`/`NomeAgenteVenda` | **Quem LANÇOU o item na conta — geralmente o garçom.** Use para ranking de garçons e venda sugestiva. Não confundir com `vendas.operador_caixa` (quem fechou a conta). |

### Itens especiais (validado com dados reais)

| Código | O que é |
|---|---|
| `codigo_produto = 999` | **Taxa de serviço/gorjeta** lançada como item (o valor bate com `vendas.valor_servico`). |
| `codigo_produto = 997` | **Taxa de entrega** lançada como item. A presença deste item identifica venda de **delivery**. |

⚠️ **Toda análise de produtos (mix, curva ABC, itens por cupom, margem,
engenharia de cardápio) deve excluir `codigo_produto IN (997, 999)`** — são
taxas, não produtos. Já a soma de `venda_itens.valor_total` COM esses itens se
aproxima do `vendas.valor_total`; SEM eles, é a venda de produtos.

### Adicionais e combos (validado com dados reais)

**Itens adicionais** (sabor, tamanho, complemento, componente de combo) são
vendidos como **linhas de item junto ao item principal** — são produtos normais
do catálogo (frequentemente com prefixo "AD" no nome) e **podem ter valor
zerado** (sabor escolhido, componente incluso no preço do combo). O catálogo
indica os vínculos: `produtos.json_original → Adicionais[]` lista quais
adicionais se acoplam a cada produto principal.

Implicações para análise:
- **Ranking por quantidade infla**: um combo gera várias linhas (principal +
  adicionais). Prefira ranking **por receita**; se usar quantidade, avise que
  adicionais/sabores contam como linhas.
- **Preço médio**: itens de valor 0 puxam a média para baixo — exclua
  `valor_total = 0` ao calcular preço médio praticado.
- **Combos**: a receita concentra no item do combo (adicionais zerados) — o mix
  por item SUBESTIMA os componentes. Para saber "quantas fritas saíram",
  conte também os adicionais/composições.

**Composição consumida (ficha técnica na venda)**: a sincronização pede
`Composicoes: true` e grava em `venda_item_composicoes` os insumos de cada item
composto vendido (`quantidade_insumo` é POR UNIDADE do pai — multiplique por
`venda_itens.quantidade`). Use para consumo teórico de insumos e CMV teórico de
compostos. Produtos simples não geram linhas.

## 3. Pagamentos (`venda_pagamentos`)

| Coluna | Campo API | O que é |
|---|---|---|
| `valor_recebido` | `ValorRecebido` | Quanto o cliente ENTREGOU (em dinheiro, inclui o troco). |
| `valor_efetivo` | `ValorEfetivo` | **Quanto ficou para a loja (líquido de troco). USE ESTE para somar recebimentos por meio de pagamento.** |
| `tipo_forma_pagamento` | `TipoFormaPagamento` | Código 1..8 (1 = dinheiro; 3 = cartão...). Prefira agrupar pela `descricao`, que é o nome legível ("DINHEIRO", "ELO CREDITO"). |
| `tipo_transacao_cartao` | `FormaPagamentoCartao.TipoTransacao` | ⚠️ **Código não confiável**: o swagger sugere 1=crédito/2=débito, mas nos dados reais veio invertido (DEBITO GENERICO=1, ELO CREDITO=2). **Classifique pelo texto** (`descricao`/`tipo_cartao`), nunca pelo código. |
| `bandeira` | `DadosTEF.DescricaoBandeira` | Bandeira do cartão (só em TEF; POS pode vir vazio). |

⚠️ A soma de `valor_efetivo` de uma venda = `vendas.valor_total`. Se somar
`valor_recebido`, o troco em dinheiro infla o resultado.

### Categorias de formas de pagamento (definidas pelo gestor)

O gestor cadastra formas com **nomes livres** ("PIX SANTANDER", "PIX ITAU",
"VISA CREDITO"...). A tabela `formas_pagamento_categorias` (descricao →
categoria) agrupa essas formas em categorias de análise (Dinheiro, Pix,
Crédito, Débito, Vale-refeição, Faturado...). Gerida por
`node --no-warnings scripts/categorias-pagamento.mjs sugerir|definir|listar` —
o assistente propõe as categorias por nome/tipo e o gestor confirma (onboarding
na skill `vendas`/`configurar`). Nas análises use:
`COALESCE(c.categoria, p.descricao)` com LEFT JOIN.

## 4. Fechamentos de caixa (`fechamentos_caixa` + `fechamento_itens`)

### As datas do caixa

| Coluna | O que é | Use para |
|---|---|---|
| `data_caixa` | **Dia comercial do caixa** (equivale ao `data_movimento` das vendas). | Agrupar fechamentos por dia; casar com vendas. |
| `data_abertura` / `data_fechamento` | Momento real de abertura/fechamento — um caixa aberto às 18h pode fechar às 3h do dia seguinte. | Duração do turno. Nunca para agrupar por dia. |

### Os três valores do fechamento

| Coluna | O que é |
|---|---|
| `valor_total_sistema` | O que o SISTEMA apurou que deveria ter no caixa. |
| `valor_total_recebido` | O que foi CONFERIDO/declarado no fechamento. |
| `valor_total_bordero` | O que foi declarado no borderô (envelope/malote). |
| `valor_diferenca_dinheiro` | **Sobra (+) ou falta (−) de dinheiro** (recebido − sistema). É O indicador de quebra de caixa. |

`fechamento_itens` abre esses valores por forma de pagamento
(`valor_sistema` × `valor_recebido` × `valor_bordero` por linha).

⚠️ Não compare `valor_total_sistema` do caixa com o faturamento de vendas sem
cuidado: o caixa inclui sangrias/suprimentos e pode agrupar mais de um turno.
**Vínculo (validado com dados reais):**
`vendas.numero_fechamento = fechamentos_caixa.id_fechamento`
(reforce com `numero_caixa` quando houver mais de um caixa).

## 5. Cartões a receber (`provisao_cartoes`) — origem: ProvisaoCartoes

| Coluna | Campo API | O que é |
|---|---|---|
| `data_venda` | `DataMovimento` | Dia em que a venda no cartão aconteceu. |
| `data_deposito` | `DataVencimento` | **Dia em que o dinheiro CAI NA CONTA.** Use para fluxo de caixa futuro ("quanto vou receber"). |
| `valor_bruto` | `ValorTotal` | Valor da venda no cartão. |
| `valor_taxa` | `ValorTaxa` (e `TaxaPercentual` no json) | Taxa da operadora. |
| `valor_liquido` | `ValorLiquido` | **O que efetivamente cai na conta.** |
| `bandeira` | `DescricaoFormaPagamento` | Ex.: "ELO CREDITO". |

⚠️ "Quanto vou receber esta semana?" agrupa por `data_deposito`, nunca por `data_venda`.

## 6. Contas a pagar (`contas_pagar`) — origem: Financeiro/ListContasPagar

### As quatro datas de uma conta

| Coluna | Campo API | O que é | Use para |
|---|---|---|---|
| `data_emissao` | `DataEmissao` | Quando o documento foi emitido. | — |
| — (json) | `DataCompetencia` | Mês/regime a que a despesa pertence (DRE por competência). | Análise de despesas por competência. |
| `data_vencimento` | `DataVencimento` | **Quando deve ser paga.** | Agenda de pagamentos, contas vencidas. |
| `data_pagamento` | `DataPagamento` | Quando FOI paga. **NULL = em aberto.** | Fluxo realizado; atraso = pagamento − vencimento. |

| Coluna | O que é |
|---|---|
| `fornecedor` | `Credor` — a quem se deve. |
| `descricao` | Plano de contas ("DESPESAS ADMINISTRATIVAS / TELEFONE MÓVEL") — base da análise de despesas por categoria. |
| `valor` / `valor_pago` | Valor do título / valor efetivamente pago (`ValorPagamento`). |

⚠️ **A busca na TOTVS filtra por emissão/competência, não por vencimento.** Para
enxergar os vencimentos de um mês, sincronize também os meses ANTERIORES de
emissão (parcelamentos: emitida em junho, vence em outubro).

## 7. Livro caixa (`livro_caixa`) — origem: Financeiro/ListLivroCaixa

| Coluna | Campo API | O que é |
|---|---|---|
| `data` | `DataEmissao` | Dia do lançamento (campo padrão de período). `DataLancamento` (json) = quando foi digitado — ignorar. |
| `tipo` | derivado de `Entrada`/`Saida` | 'entrada' ou 'saida'. Na API são DOIS campos de valor; aqui viram tipo + valor. |
| `valor` | `Entrada` ou `Saida` | **Sempre positivo** — o sentido está em `tipo`. Saldo = SUM(entradas) − SUM(saídas), nunca SUM(valor). |
| `conta` | `NomeConta` | Conta financeira (banco, caixa interno). |
| `natureza` | `PlanoContas1 / PlanoContas2` | Categoria do lançamento. |
| — (json) | `Compensado`, `Extorno` | Conciliação bancária e estorno. Lançamentos com `Extorno = true` merecem cautela. |

## 8. Notas fiscais (`notas_fiscais`) — origem: Fiscal/*

| Coluna | Venda (`tipo='venda'`) | Entrada (`tipo='entrada'`) |
|---|---|---|
| `data` | `DataEmissao` — dia da emissão da NFCe/NF-e. | `DtEntrada` — dia em que a mercadoria ENTROU na loja (≠ `DtLancamento`, que é a emissão pelo fornecedor; pode diferir em meses). |
| `valor_total` | `ValorNota`. | Extraído do XML (`<vNF>`). |
| `fornecedor_ou_cliente` | Geralmente vazio. | Nome do fornecedor (extraído do XML `<emit><xNome>`). |

⚠️ "Compras do período" (para CMV real) usa notas de ENTRADA agrupadas por
`data` (= data de entrada). O XML completo não é guardado no banco.

## 9. Produtos (`produtos`) — origem: produto/listarProdutos

### Tipos de cadastro (validado com dados reais)

| Tipo | Colunas/flags | O que significa | Implicação nas análises |
|---|---|---|---|
| **Simples** | `composto=0, processado=0` | Produto de revenda (cerveja, refrigerante). | Custo e estoque exatos; margem confiável. |
| **Composto** | `composto=1, processado=0` | Tem ficha técnica; **baixa o estoque dos INSUMOS na hora da venda**. Não tem estoque próprio. | Estoque/cobertura: olhe os insumos, nunca o composto. CMV via ficha. |
| **Processado** | `processado=1` (ficha + estoque próprio) | Gerado por **produção**: a produção baixa a ficha técnica e AUMENTA o estoque do processado (ex.: pão produzido na padaria). | TEM estoque próprio; quebra de produção = produzido − vendido. |
| **Pesável** | `pesavel=1` | Vendido por peso (kg), via balança ou manual (ex.: buffet self-service, tortas ao kg). | `venda_itens.quantidade` = PESO. Base das métricas de quilo (preço médio do kg, consumo per capita). |
| **Kit** | sem flag na API | Conjunto de produtos com preço fixo final. Cadastrado como composto; identificável só pelo nome ("KIT..."). | Trate como composto/combo. |
| **Não exibir no cardápio** | `exibir_no_cardapio=0` | Não aparece na tela de venda — **geralmente são os INSUMOS** e itens não vendidos. | Exclua de análises de cardápio; use como filtro de insumos em estoque/compras. |

Um produto pode combinar flags (ex.: processado E pesável: torta ao kg produzida
na casa).

| Coluna | Campo API | O que é |
|---|---|---|
| `nome` | `DescricaoProduto` | Nome do produto. |
| `preco_venda` | `PrecoVenda` | Preço de venda ATUAL do cadastro (a venda histórica usa `venda_itens.valor_unitario`). |
| `preco_compra` | `PrecoCompra` | Custo ATUAL do cadastro. Para CMV histórico use `venda_itens.preco_compra` (custo da época). |
| `unidade` | `UnidadeVenda` | UN, KG, LT... Produtos KG são os de venda por peso. |
| `composto`, `processado`, `pesavel`, `exibir_no_cardapio` | `ProdutoComposto`, `Processado`, `Pesavel`, `NaoExibirNoCardapio` | Tipo de cadastro — ver tabela acima. |
| — (json) | `Composicoes[]` | **Ficha técnica** do produto: lista de insumos `{CodigoProduto, NomeProduto, QuantidadeComposicao}`. Base do **CMV teórico**: custo = Σ(quantidade do insumo × `preco_compra` do insumo). |
| — (json) | `Adicionais[]` | Produtos adicionais vinculáveis a este principal `{CodigoProduto, QuantidadeAdicionais}` (sabores, tamanhos, componentes de combo). |
| — (json) | `PontoProducao`, `PermiteVendaFracionada`, `EstoqueOnline`, `PrecoVenda2` | Ponto de produção (cozinha/bar), venda fracionada, controle online, segundo preço (semântica não confirmada — pode servir a happy hour/segunda tabela). |

### Promoções parametrizadas (não visíveis pela API)

No ChefWeb, o cadastro do produto tem abas **Promoção** e **Happy Hour**: o
usuário parametriza data início/fim, hora início/fim, **dias da semana**, preço
promocional (valor fixo ou %), valor teto e "vender apenas em promoção" — e o
produto assume o preço promocional automaticamente nesses critérios.

⚠️ **A API de produtos NÃO expõe essa configuração** (validado: nenhum campo de
promoção no payload). Consequências para análise:
- `venda_itens.valor_unitario` abaixo de `produtos.preco_venda` em **padrão
  recorrente por dia da semana/horário** = **promoção programada**, não desconto
  manual nem tabela desatualizada. Verifique o padrão temporal antes de acusar.
- A promoção muda o preço do item SEM gerar `valor_desconto` — o % de descontos
  não captura promoções; para medi-las, compare preço praticado × preço de
  tabela por dia/hora.
| `ativo` | `Ativo` | 0 = fora de linha — exclua de análises de cardápio atual, mantenha nas históricas. |

## 10. Estoque (`estoque_posicoes`) — origem: Estoque/ListarEstoque

| Coluna | Campo API | O que é |
|---|---|---|
| `data_leitura` | — (data da sincronização) | Dia da FOTOGRAFIA. Posição atual = `MAX(data_leitura)`. Comparar duas leituras = evolução. |
| `codigo_produto` | `skuId` | ⚠️ A API de estoque responde em inglês e NÃO traz nome/custo — **join obrigatório com `produtos`**. |
| `quantidade` | `quantity` | Saldo. Negativo = erro de lançamento (alerta de processo, não número real). |
| `custo` | — | Sempre NULL nesta API; use `produtos.preco_compra`. |

## 11. Regras de ouro (resumo para consultas)

1. Período de vendas → `data_movimento`; horário → `data_hora`; caixa → `data_caixa`;
   recebimento de cartão → `data_deposito`; vencimento de conta → `data_vencimento`;
   compra/entrada → `notas_fiscais.data` (tipo='entrada').
1b. Vários grupos de lojas → filtre/agrupe por `conexao` e junte por
   (`conexao`, código) — ver seção 0.
2. Faturamento → `vendas.valor_total` (`cancelada = 0`); receita por produto →
   `venda_itens.valor_total` (`status = 1` **e `codigo_produto NOT IN (997, 999)`**
   — 999 = taxa de serviço, 997 = taxa de entrega); recebimento por meio de
   pagamento → `venda_pagamentos.valor_efetivo`.
3. Conta em aberto → `data_pagamento IS NULL`; sem data → NULL (nunca '0001-01-01').
4. Livro caixa: saldo = entradas − saídas (o campo `valor` é sempre positivo).
5. Estoque e nome de produto: sempre via join com `produtos`.
6. Custo: histórico → `venda_itens.preco_compra`; atual → `produtos.preco_compra`;
   0 = "não cadastrado".
