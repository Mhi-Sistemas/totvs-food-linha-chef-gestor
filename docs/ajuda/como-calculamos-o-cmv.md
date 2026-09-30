# Como o CMV é calculado — e por que você precisa escolher

O CMV é o **custo da mercadoria vendida**: quanto de comida e bebida saiu do seu
estoque para gerar o faturamento do período. É o indicador que mais pesa no
resultado de um restaurante, e a pergunta "qual foi meu CMV?" tem **três
respostas possíveis**, todas legítimas e todas diferentes.

Este documento serve ao assistente para explicar a diferença ao gestor em
linguagem simples e ajudá-lo a escolher. **A escolha é sempre dele.**

---

## As três formas de calcular

### 1. CMV teórico — o que *deveria* ter sido consumido

Soma o custo da ficha técnica de tudo o que foi vendido. Se você vendeu 100
hambúrgueres e a ficha diz que cada um leva R$ 4,20 de insumo, o CMV teórico é
R$ 420,00.

- **A favor**: funciona para **qualquer período**, inclusive anos atrás, porque
  não depende de contagem de estoque nenhuma. É o cálculo mais fácil de ter.
- **Contra**: descreve o mundo ideal. Não enxerga desperdício, quebra, porção
  passada do ponto, produto vencido nem desvio. Se um funcionário leva
  mercadoria para casa, o CMV teórico continua igualzinho.
- **Depende de**: ficha técnica cadastrada e custo dos insumos em dia.

### 2. CMV real — o que de fato saiu do estoque

```
Estoque no início do mês  +  Compras do mês  −  Estoque no fim do mês
```

Se você tinha R$ 30.000 em estoque no dia 1º, comprou R$ 50.000 no mês e
terminou com R$ 25.000, consumiu R$ 55.000. Simples assim — e implacável:
**esse número inclui tudo o que sumiu**, tenha sido vendido ou não.

> **De onde saem as "compras"**: das contas lançadas no seu financeiro que
> estão classificadas como compra de mercadoria, pela data de competência. Não
> usamos a nota fiscal de entrada, porque uma nota costuma trazer equipamento,
> utensílio e material de limpeza junto da mercadoria — e isso jogaria custo
> que não é de comida dentro do seu CMV. Por isso o assistente precisa que
> você confirme, uma vez só, **quais contas do seu plano são compra de
> mercadoria**; ele sugere a lista e você aprova.

- **A favor**: é o consumo verdadeiro. Comparado com o teórico, revela quanto
  você está perdendo — a diferença entre os dois é a sua perda.
- **Contra**: exige saber quanto havia em estoque **nas duas pontas** do
  período. E aqui está a restrição que explicamos a seguir.

### 3. Compra de mercadorias — o que saiu do caixa

Soma o que foi lançado nas contas classificadas como compra de mercadoria no
seu plano de contas.

- **A favor**: bate com o extrato e com o que o contador costuma usar. Fácil de
  conferir.
- **Contra**: confunde **comprar** com **consumir**. Um mês em que você
  aproveitou uma promoção e encheu o estoque aparece com CMV altíssimo, mesmo
  sem ter vendido nada a mais. No mês seguinte, o CMV parece ótimo porque você
  está consumindo o que já tinha comprado.
- **Depende de**: você indicar quais contas do seu plano são compra de
  mercadoria (o assistente sugere e você confirma).

---

## A restrição importante: estoque de datas passadas

O sistema da TOTVS informa **quanto você tem em estoque agora**. Ele **não
informa quanto você tinha numa data passada** — essa consulta simplesmente não
existe.

A consequência é direta: no dia em que o assistente é instalado, ele passa a
tirar uma fotografia do seu estoque **todo dia**, automaticamente. A partir daí
o CMV real fica disponível. Mas **de todos os meses anteriores à instalação,
não há fotografia** — e não existe forma de recuperá-la depois.

É por isso que a fotografia diária é tão importante e que a rotina automática
nunca deve ser desligada: cada dia sem fotografia é um dia que não volta.

## A alternativa: o inventário que você já conta

Se você quer o CMV real de meses anteriores à instalação, existe uma saída: o
**inventário contado no ChefWeb**. Toda contagem física que você já fez está
guardada lá, e ela vale como fotografia daquele dia.

O ideal é o inventário do **primeiro e do último dia do mês**. Com essas duas
contagens, mais as compras de mercadoria lançadas no período, o CMV real do mês
fecha normalmente.

O passo a passo para exportar está em
[exportar-inventario.md](exportar-inventario.md) — peça ao assistente e ele
conduz. Depois de importado, o inventário é usado automaticamente: quando
existe contagem e fotografia na mesma data, **a contagem física vale mais**,
porque ela é a realidade e a fotografia é o que o sistema achava que tinha.

> Uma contagem **parcial** não serve. Se você contou só as bebidas, aquele
> inventário não representa o estoque inteiro e não pode fechar a conta. O
> assistente avisa quando percebe que as duas pontas do período cobrem
> quantidades de itens muito diferentes.

---

## Qual escolher para a sua DRE

Não existe resposta certa — existe a que responde à **sua** pergunta:

| Se você quer... | Escolha |
|---|---|
| Um número confiável para todo o histórico, desde já | **Teórico** |
| Descobrir quanto está perdendo com desperdício e desvio | **Real** |
| Que a DRE bata com o extrato e com a contabilidade | **Compra de mercadorias** |

O caminho mais comum é começar pelo **teórico** (funciona no primeiro dia),
ativar a fotografia diária e migrar para o **real** quando houver alguns meses
de histórico — passando a acompanhar a diferença entre os dois, que é o melhor
detector de perda que existe num restaurante.

**Como definir** (o assistente faz por você):

```
node --no-warnings scripts/dre.mjs cmv-fonte teorico|real|compras
```

Sem argumento, o comando mostra a escolha atual e as opções. Se em algum mês
não houver como apurar o CMV escolhido, a DRE usa o teórico naquele mês e
**avisa isso na própria nota do relatório** — nunca deixa a linha zerada sem
explicação, porque isso inflaria o lucro bruto sem você perceber.
