# Catálogo de relatórios, análises e dashboards prontos

Estes são os entregáveis que o assistente sabe produzir **de imediato** — o
gestor só precisa pedir com as frases sugeridas (ou do jeito dele). Cada item
indica os dados necessários (domínios de sincronização), o formato da entrega e
as métricas do [catálogo](catalogo-metricas.md) que o compõem. Campos e regras
de cálculo: [dicionário de dados](dicionario-de-dados.md).

**Personalização**: o gestor pode ajustar qualquer relatório ("tira o gráfico de
pagamentos", "adiciona a loja 2") e **salvar versões próprias** — basta dizer
"salve essa análise/painel como padrão meu". As personalizações ficam na pasta
`personalizados/` e passam a valer nas próximas conversas (ver
`personalizados/README.md`).

Lembretes transversais: período padrão termina em **D-1**; sempre informar
período e base; excluir canceladas e itens 997/999 conforme o dicionário.

---

## 1. Resumos executivos (texto, direto no chat)

### 1.1 Resumo do dia (D-1)
> "Como foi ontem?" · "Me dá o resumo do dia"

Faturamento, cupons, ticket médio de ontem × mesmo dia da semana anterior;
top 3 produtos; mix de pagamentos; cancelamentos/descontos fora do padrão;
quebra de caixa se houver. **Dados**: vendas, fechamentos. **Compõe**: métricas
1.1–1.3, 1.7, 4.1, 4.3.

### 1.2 Resumo da semana
> "Como foi a semana?" · "Resumo semanal"

Semana fechada (seg–dom até D-1) × semana anterior **dia a dia equivalente**
(análise 7.1); destaque de melhor/pior dia; evolução do ticket; alertas.
**Dados**: vendas, fechamentos.

### 1.3 Fechamento do mês
> "Fecha o mês pra mim" · "Como foi setembro?"

Faturamento × mês anterior ajustado por mix de dias; ticket; mix por categoria
(subgrupo); %CMV (real se houver fotografias de estoque, senão teórico);
descontos e cancelamentos totais; contas pagas × a pagar do mês.
**Dados**: vendas, fechamentos, contas-pagar, notas-entrada, estoque, produtos.

### 1.4 Resumo curto para compartilhar
> "Faz um resumo curto de ontem pra eu mandar pro meu sócio"

Versão curtíssima (5–8 linhas, emojis moderados) de 1.1/1.2/1.3, pronta para
copiar e colar onde o gestor quiser.

## 2. Dashboards (painel HTML, identidade ChefWeb, abre no navegador)

### 2.1 Painel de vendas
> "Monte um painel das vendas do mês"

KPIs (faturamento, cupons, ticket, variação) + faturamento por dia + top 10
produtos + dia da semana + rosca de pagamentos por categoria. É o painel padrão
da skill `dashboard`. **Dados**: vendas.

### 2.2 Painel financeiro
> "Monte um painel financeiro"

Contas a vencer (7/30 dias) e vencidas; fluxo projetado dia a dia (cartões a
receber − contas a pagar); entradas × saídas do livro caixa; taxa média de
cartão por bandeira. **Dados**: contas-pagar, livro-caixa, provisao.
**Compõe**: 3.4–3.7.

### 2.3 Painel de controle/auditoria
> "Monte um painel de controle da operação"

Cancelamentos e descontos por operador e motivo; quebras de caixa por
dia/caixa; sangrias; score de anomalias (análise 7.3). **Dados**: vendas,
fechamentos, sangrias. **Compõe**: 4.1–4.3, 7.3.

### 2.4 Painel de estoque e compras
> "Monte um painel do meu estoque"

Itens críticos (cobertura × curva ABC), zerados/negativos, valor imobilizado
por categoria, variação de preço de compra por fornecedor. **Dados**: estoque,
produtos, vendas, notas-entrada. **Compõe**: 5.1–5.5.

### 2.5 Painel comparativo de lojas (redes)
> "Compare minhas lojas"

Faturamento, ticket, mix e cancelamentos lado a lado por loja; ranking e
evolução. **Dados**: vendas (todas as lojas).

## 3. Análises de cardápio e produto

### 3.1 Revisão de cardápio (curva ABC + engenharia)
> "Analisa meu cardápio" · "Quais itens devo tirar do cardápio?"

Curva ABC por receita e quantidade + matriz estrela/burro de carga/
quebra-cabeça/cão por subgrupo + recomendações item a item. **Dados**: vendas,
produtos. **Compõe**: 2.1–2.4.

### 3.2 Margem e precificação
> "Quais produtos me dão mais lucro?" · "Meus preços estão certos?"

Margem de contribuição por item, markup praticado × referência, preço médio ×
tabela (separando promoções programadas por padrão de dia/horário).
**Compõe**: 2.3, 2.6, 2.7.

### 3.3 CMV do período
> "Qual meu CMV?" 

%CMV real (com fotografias de estoque) ou teórico (avisando o método), gap
real × teórico, comparação com a faixa saudável do segmento. **Compõe**: 2.5,
3.1.

## 4. Análises operacionais

### 4.1 Auditoria de descontos e cancelamentos
> "Quem está cancelando/dando desconto?" · "Auditoria da operação"

Por operador × motivo × horário, com valores, comparação entre operadores e
sinais de alerta. **Compõe**: 4.1, 7.3.

### 4.2 Conferência de caixa
> "Teve diferença de caixa?" 

Quebras por dia/caixa/operador, série acumulada, sangrias conciliadas.
**Compõe**: 4.2, 4.3.

### 4.3 Horários e escala
> "Qual meu horário de pico?" · "Quando preciso de mais gente?"

Heatmap hora × dia da semana (cupons e faturamento), vales de movimento,
sugestões de reforço/promoção. **Compõe**: 4.4.

### 4.4 Desempenho de garçons/atendentes
> "Ranking dos meus garçons"

Venda, itens por cupom e ticket por atendente (quem lança) — nunca confundir
com o operador de caixa. **Compõe**: 4.6.

## 5. Análises financeiras

### 5.1 Agenda de pagamentos
> "O que vence esta semana?" · "Tem conta atrasada?"

Vencimentos 7/30 dias, vencidas em aberto, concentração por fornecedor.
**Compõe**: 3.7.

### 5.2 Fluxo de caixa projetado
> "Como fica meu caixa nos próximos 30 dias?"

Recebíveis de cartão (por data de depósito) − contas a pagar (por vencimento),
saldo acumulado, dias críticos. **Compõe**: 3.4.

### 5.3 Auditoria de taxas de cartão
> "Estou pagando taxa demais no cartão?"

Taxa efetiva por bandeira × referência de mercado (e × contratada, se o gestor
informar), custo total em R$, prazo médio de recebimento. **Compõe**: 3.5, 3.6, 7.6.

### 5.4 Meta diária de equilíbrio
> "Quanto preciso vender por dia para pagar as contas?"

Ponto de equilíbrio convertido em meta diária, plotado contra o realizado.
Requer custos fixos (contas/livro caixa) e, se possível, folha informada.
**Compõe**: 3.3.

## 6. Estoque e compras

### 6.1 Estoque crítico + sugestão de compra
> "O que está acabando?" · "O que preciso comprar?"

Cobertura em dias × curva ABC (itens A com cobertura baixa primeiro), zerados,
respeitando tipos (não acusa ruptura de composto). **Compõe**: 5.2, 5.3.

### 6.2 Compras e fornecedores
> "Meus fornecedores subiram preço?"

Variação de preço por insumo × fornecedor (notas de entrada), concentração de
compras, sobrecompra × consumo teórico. **Compõe**: 5.5, 7.7.

## 7. Formatos de entrega (qualquer item acima)

Todo relatório deste catálogo pode sair em quatro formatos — basta pedir:

| Formato | Peça assim | Quando serve |
|---|---|---|
| **Texto no chat** | (padrão) | Resposta rápida, conversa |
| **Painel HTML** | "monte um painel" | Ver com gráficos, explorar |
| **Planilha Excel (.xlsx)** | "manda em Excel", "gera uma planilha" | Mexer nos números, filtrar, somar |
| **PDF** | "quero em PDF", "preciso imprimir" | Imprimir, arquivar, enviar ao contador/sócio |
| **Word (.docx)** | "faz um documento" | Editar o texto, apresentação formal |

Os arquivos são gerados na pasta `relatorios/`, sem instalar nada, e funcionam
igual no Windows e no Mac (skill `exportar`).

---

## Como pedir do seu jeito

Tudo aceita variações: período ("últimos 90 dias"), loja ("só a loja 2"),
recorte ("só bebidas", "só delivery") e formato ("em painel", "em texto",
"em Excel", "em PDF", "resumo curto"). E para tornar permanente: **"salve como meu relatório
padrão"** — vira um arquivo em `personalizados/` que o assistente passa a usar.

## DRE Gerencial (dinâmica)

`node --no-warnings scripts/dre.mjs gerar [--mes AAAA-MM] [--grupo <id>] --abrir`

Demonstração do resultado com visual de app (não planilha): herói com o
resultado do mês + cascata "como o mês virou resultado"; Visão Mensal (mês
fechado vs anterior, chips de variação) e Anual (12 meses com sparklines);
Regime Competência (vendas + contas a pagar por competência + impostos por
cupom + CMV teórico) e Caixa (livro caixa por lançamento); linhas pelo plano
de contas do gestor (plano 1 → plano 2 expansível); indicador de cobertura.
HTML autossuficiente (offline, mobile). Gerencial — não substitui a peça
contábil.
