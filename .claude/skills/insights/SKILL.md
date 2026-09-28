---
name: insights
description: Análise profunda que interpreta em vez de só mostrar números - detecta o que fugiu do padrão, explica por que subiu ou caiu, compara lojas, encontra oportunidades de venda, simula cenários e acompanha decisões anteriores. Use quando o gestor perguntar "por que caiu?", "tem algo errado?", "o que eu deveria olhar hoje?", "como estou indo?", "o que fazer para melhorar?", ou para montar o resumo diário/semanal.
---

# Insights — interpretar, não só mostrar

O TOTVS já entrega painel e relatório. **Nosso valor é a interpretação.** Toda
resposta desta skill precisa ir além do número: dizer o que fugiu do padrão,
**por quê**, e **o que fazer**.

Ferramentas (saída legível por padrão, `--json` quando for raciocinar em cima):

```
node --no-warnings scripts/analisar.mjs qualidade  [--grupo X]
node --no-warnings scripts/analisar.mjs anomalias  --grupo X [--data AAAA-MM-DD] [--semanas 8]
node --no-warnings scripts/analisar.mjs variacao   --grupo X --de A --ate B --contra-de C --contra-ate D
node --no-warnings scripts/analisar.mjs benchmark  --grupo X --de A --ate B
node --no-warnings scripts/analisar.mjs cesta      --grupo X --de A --ate B
node --no-warnings scripts/analisar.mjs simular    --grupo X [--produto N] --variacao 5
node --no-warnings scripts/analisar.mjs fiscal     --grupo X --de A --ate B
node --no-warnings scripts/calendario.mjs consultar AAAA-MM-DD
node --no-warnings scripts/decisoes.mjs registrar|executar|listar|verificar
```

## Regras de ouro (o que separa insight de relatório)

1. **Máximo 3 assuntos por resposta.** Um painel mostra 40 indicadores; você
   escolhe os 3 que mudam a decisão de hoje. O resto é ruído.
2. **Nunca entregue número sem causa provável.** "Caiu 12%" é relatório.
   "Caiu 12% porque vieram 30 clientes a menos nas terças, e isso começou na
   semana em que a loja ao lado reabriu" é insight.
3. **Toda conclusão termina em ação executável** pelo gestor amanhã de manhã.
4. **Declare a incerteza.** Amostra pequena, custo não cadastrado, período não
   coletado, estimativa — diga na hora, não em nota de rodapé.
5. **Silêncio é melhor que alarme falso.** No terceiro alerta errado o gestor
   abandona a ferramenta. Se a amostra não sustenta, diga que não sustenta.
6. **Sempre cheque o calendário** antes de explicar variação: feriado, Dia das
   Mães e evento local explicam a maior parte dos "sustos".

## Roteiro para "por que caiu/subiu?"

1. `variacao` entre os dois períodos → separa **menos clientes** de
   **ticket menor** (são problemas diferentes: o primeiro é atração, o segundo
   é mix/preço).
2. Veja quem puxou: qual **loja** e qual **categoria** (subgrupo) respondem
   pela maior parte da diferença. Normalmente 1 ou 2 explicam quase tudo.
3. `calendario consultar` nos dias extremos → havia feriado ou evento?
4. Se a causa foi ticket: olhe mix por categoria e a `cesta` (deixou de vender
   bebida/sobremesa junto?). Se foi volume: olhe dias da semana e horários.
5. Feche com a ação: o que dá para fazer sobre a causa encontrada.

## Roteiro para "tem algo errado?" (rotina de vigilância)

1. `anomalias` do último dia com movimento.
2. Cruze com `calendario` (feriado explica desvio sem ser problema).
3. Cancelamentos e descontos concentrados num operador → auditoria (skill
   `financeiro`/`vendas`), não acusação: apresente como "vale conferir".
4. Quebra de caixa recorrente no mesmo caixa/operador → processo.

## Roteiro para rede (dois ou mais grupos, ou várias lojas)

1. `benchmark` do período → quem é o melhor praticante de cada indicador.
2. Traduza a diferença em dinheiro: "se a loja 12 tivesse a anexação de bebida
   da loja 3, seriam +R$ X no mês".
3. Cuidado: compare lojas comparáveis (porte, praça). Se os perfis forem muito
   diferentes, diga isso em vez de ranquear cegamente.

## Roteiro fiscal (diferencial de quem entende do sistema)

`fiscal` audita o que foi tributado em cada item contra o cadastro do produto e
contra o próprio cálculo. O gestor não enxerga isso em relatório de vendas, e
erro fiscal acumula silenciosamente até virar autuação.

- **NCM genérico**: um mesmo código cobrindo categorias muito diferentes é
  cadastro feito no atacado — aponte os casos e sugira revisão com o contador.
- **Taxa tributada como mercadoria**: serviço (999) e entrega (997) saindo com
  NCM e CFOP de produto é erro claro.
- **Divergência cadastro × venda**: o produto está cadastrado de um jeito e sai
  tributado de outro.
- **Cálculo que não fecha**: base × alíquota diferente do valor indica
  configuração errada no PDV; cada cupom emitido assim acumula o problema.
- **Reforma (IBS/CBS)**: confira se os campos vêm preenchidos em todas as lojas
  e produtos — quem estiver emitindo errado agora vai descobrir tarde.
- ⚠️ **Simples Nacional**: o tributo não vem destacado no cupom (vai no
  recolhimento unificado). Carga zerada ali é esperada — a análise já detecta o
  regime pelo CSOSN e avisa. Nunca apresente isso como erro.

Ao relatar, fale como consultor, não como fiscal: "vale revisar isso com seu
contador", nunca "você está sonegando". E lembre que a responsabilidade
tributária é do contador do cliente — você aponta indícios, não dá parecer.

## Briefing (resumo automático)

Formato: **5 a 8 linhas**, sem tabela, sem jargão. Estrutura:

- uma frase com o resultado do período (faturamento e comparação);
- o que fugiu do padrão (ou "nada fora do normal", se for o caso);
- a causa provável;
- **uma** ação sugerida;
- se houver decisão anterior já medida, o resultado dela.

Para agendar o briefing recorrente, siga a regra de agendamento (skill
`sincronizar`): use o agendador do ambiente e avise que o computador precisa
ficar ligado. Sugestão: diário às 9h, e um resumo semanal na segunda.

## Fechando o ciclo: registre as decisões

Sempre que o gestor decidir algo a partir de uma análise sua:

```
node --no-warnings scripts/decisoes.mjs registrar --grupo X --categoria preco \
  --produto 1301 --texto "Subir 8% o preço do Baby Beef"
node --no-warnings scripts/decisoes.mjs executar --id N --data AAAA-MM-DD
```

Depois de ~30 dias, `verificar` mede o efeito comparando janelas equivalentes
antes e depois. **Traga esse resultado de volta ao gestor** — é o que prova que
a análise vale, e o que faz ele confiar na próxima recomendação.

## Metas no briefing

Consulte `scripts/metas.mjs listar` (tabela `metas`): indicador com meta
estourada entra nos 3 assuntos do briefing com prioridade ("CMO 31,2% — 3,2pp
acima da meta"). Sem meta definida, sugira uma vez ao gestor definir as
principais (%CMV, %CMO, faturamento do mês).

## "Como estou em relação ao mercado?"

O comparativo setorial (benchmark) ainda não foi liberado. Responda com as
referências do catálogo (ex.: CMV ideal 28–31%) e convide para a lista de
espera (`scripts/benchmark.mjs lista-espera`, roteiro na skill `configurar`,
passo 9) — quem entra é avisado primeiro. Confira antes com `situacao` se já
está inscrito, para não repetir o convite.
