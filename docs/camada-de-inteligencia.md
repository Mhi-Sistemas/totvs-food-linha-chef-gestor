# Camada de inteligência

O TOTVS já entrega painéis e relatórios. O diferencial deste projeto é
**interpretar**: dizer o que fugiu do padrão, explicar por quê, estimar o que
acontece se mudar algo e lembrar do que foi decidido. Um painel responde
"o quê"; aqui respondemos **"e daí?"** e **"o que eu faço agora?"**.

Este documento nasceu como backlog e virou a documentação da camada: as dez
capacidades abaixo estão entregues. Cada seção guarda o **problema** que
justificou a capacidade — é o que orienta quem for evoluí-la.

| # | Capacidade | Entrega | Situação |
|---|---|---|---|
| 8 | Confiabilidade dos dados | `analisar.mjs qualidade` | pronto |
| 2 | Motor de anomalias | `analisar.mjs anomalias` | pronto |
| 3 | Decomposição de variação | `analisar.mjs variacao` | pronto |
| 4 | Benchmark entre lojas | `analisar.mjs benchmark` | pronto |
| 5 | Cesta de compras | `analisar.mjs cesta` | pronto |
| 6 | Simulação de cenários | `analisar.mjs simular` | pronto |
| 9 | Calendário de contexto | `calendario.mjs` | pronto |
| 7 | Diário de decisões | `decisoes.mjs` | pronto |
| 1 | Briefing automático | skill `insights` + agendamento | pronto |
| 10 | Auditoria fiscal | `analisar.mjs fiscal` | pronto |

---

## 10. Auditoria fiscal

**Problema**: cadastro fiscal errado passa despercebido por meses no PDV e vira
risco de autuação — e o gestor não tem como perceber olhando relatório de venda.

**Entrega**: varredura do que foi efetivamente tributado em cada item vendido,
comparado com o cadastro do produto e com o próprio cálculo:
NCM genérico cobrindo categorias distintas; taxa de serviço/entrega tributada
como mercadoria; divergência entre cadastro e venda (NCM, CFOP, CSOSN);
base x alíquota que não fecha com o valor; carga tributária efetiva por
categoria; e prontidão para a reforma (IBS/CBS preenchidos e coerentes).

**Cuidado de domínio**: no Simples Nacional os tributos não vêm destacados no
cupom (vão no recolhimento unificado), então carga zerada ali é esperada. A
análise detecta o regime pelo CSOSN e avisa, em vez de apontar erro inexistente.

**Por que os dados fiscais ficam em coluna**: extraídos do payload, ocupam uma
fração do JSON bruto e — principalmente — passam a ser consultáveis. Antes
estavam presos dentro do texto e nunca eram usados.

## 8. Confiabilidade dos dados (base de tudo)

**Problema**: um painel mostra um número errado com a mesma confiança de um
certo. Se só 19% dos produtos têm custo cadastrado, todo CMV e toda margem
saem frágeis — e o gestor decide em cima disso sem saber.

**Entrega**: um diagnóstico que roda antes das análises e informa a cobertura
de cada base (custo cadastrado, estoque negativo, vendas sem cliente, produtos
sem grupo, lojas sem movimento, períodos não coletados). O assistente cita a
cobertura sempre que ela comprometer a conclusão.

## 2. Motor de anomalias

**Problema**: com 27 lojas × 30 dias × centenas de produtos, ninguém enxerga o
que está fora do padrão olhando gráfico.

**Entrega**: comparação de cada dia/loja contra o **próprio histórico do mesmo
dia da semana** (média e desvio padrão das últimas N semanas), sinalizando
desvios relevantes. Cobre faturamento, ticket, cancelamentos, descontos,
quebra de caixa e produtos que sumiram ou dispararam.

**Cuidados**: exigir amostra mínima para não gerar alarme falso; descontar
feriados (item 9); nunca apontar anomalia em período não coletado.

## 3. Decomposição de variação ("por que caiu?")

**Problema**: o painel mostra −12%. O gestor continua sem saber a causa.

**Entrega**: cascata explicativa. Faturamento = clientes × ticket, então
`ΔR = Δclientes × ticket₀ + Δticket × clientes₀ + (efeito combinado)`.
Depois abre a variação por loja, por categoria (subgrupo) e por dia da semana,
mostrando **quanto cada um contribuiu** para a diferença total.

## 4. Benchmark entre lojas

**Problema**: em rede, a melhor referência de uma loja são as irmãs.

**Entrega**: comparação de indicadores por loja (ticket, itens por cupom, mix
de categorias, taxa de anexação de bebida, cancelamentos, descontos) com
identificação do melhor praticante e **quantificação da oportunidade**: "se a
loja 12 tivesse a taxa de bebida da loja 3, seriam +R$ X/mês".

## 5. Cesta de compras

**Problema**: não se sabe o que deixa de ser vendido junto.

**Entrega**: coocorrência entre produtos/categorias no mesmo cupom, com
suporte e confiança, e o valor da oportunidade perdida. Base objetiva para
treinar venda sugestiva.

## 6. Simulação de cenários

**Problema**: painel é retrovisor; decisão é sobre o futuro.

**Entrega**: "e se eu subir 5% o preço do item X?" — projeta receita e margem
usando elasticidade estimada do próprio histórico (quando houver variação de
preço) ou cenários explícitos quando não houver. Sempre declarando a incerteza.

## 9. Calendário de contexto

**Problema**: comparar sem considerar feriado faz o assistente "descobrir"
quedas que eram só segunda de carnaval.

**Entrega**: feriados nacionais calculados (inclusive os móveis, a partir da
Páscoa) + datas comemorativas de food service (Dia das Mães, dos Pais,
Namorados) + eventos que o gestor cadastra (reforma, greve, evento na cidade).
Toda comparação e toda anomalia passam por esse filtro.

## 7. Diário de decisões

**Problema**: recomendação sem acompanhamento vira opinião solta.

**Entrega**: registro do que foi recomendado, do que o gestor decidiu fazer e
de quando; depois o assistente **volta e mede** o efeito no período seguinte.
É o que cria aprendizado acumulado e confiança.

## 1. Briefing automático

**Problema**: relatório que depende de o gestor abrir não é lido.

**Entrega**: resumo curto (diário/semanal) gerado por tarefa agendada, que fala
**só do que fugiu do padrão**, com a causa provável e a ação sugerida. Usa
todos os itens acima.

---

## Princípios da camada de inteligência

1. **Menos é mais**: falar de 3 coisas que importam, não de 40 indicadores.
2. **Sempre a causa provável**, não só o número.
3. **Declarar incerteza**: amostra pequena, dado faltando, estimativa — diga.
4. **Toda conclusão vira ação sugerida** que o gestor consiga executar.
5. **Nada de alarme falso**: é melhor calar do que apontar anomalia inexistente,
   porque o gestor abandona a ferramenta no terceiro alarme errado.
