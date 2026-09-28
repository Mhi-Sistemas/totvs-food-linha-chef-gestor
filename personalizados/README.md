# Suas análises, métricas e dashboards personalizados

Esta pasta guarda o que **você** criou ou ajustou com o assistente. Os arquivos
daqui ficam **só no seu computador** e valem em todas as conversas futuras.

## Como criar (você não precisa mexer em arquivos!)

Basta conversar:

> "Salve essa análise como padrão meu"
> "Crie um relatório meu chamado 'abertura de sábado' com faturamento e escala"
> "No meu painel de vendas, tire o gráfico de pagamentos e adicione a loja 2"

O assistente grava aqui um arquivo descrevendo o pedido e passa a usá-lo sempre
que você pedir pelo nome (ou quando for o padrão para aquele tipo de pergunta).

## Para o assistente (regras de uso desta pasta)

1. **Antes de responder análises/relatórios/painéis, verifique esta pasta**:
   se existir personalização aplicável (pelo nome pedido ou pelo tipo de
   análise), ela **prevalece** sobre o catálogo padrão.
2. Ao salvar uma personalização, crie um arquivo `.md` com nome descritivo
   (`meu-resumo-de-sabado.md`) no formato do `exemplo-minha-analise.md`:
   frontmatter com `nome`, `tipo` (analise | metrica | dashboard), `gatilhos`
   (frases-atalho que o gestor usa) e `frequencia` (diaria | semanal | mensal
   | sob-demanda), e corpo com a especificação (períodos, filtros, SQL de
   referência, layout do painel).
3. Personalizações podem **estender ou substituir** itens dos catálogos
   oficiais — registre no arquivo qual item substituem (campo `substitui`,
   opcional).
4. Nunca salve credenciais ou dados pessoais aqui — apenas definições.
5. Métricas personalizadas: valide a fórmula com o dicionário de dados e
   registre a base de cálculo (B1/B2...) como no catálogo oficial.
6. Personalizações com `frequencia` diária/semanal/mensal são candidatas a
   **entrega agendada**: prefira o agendador do ambiente (rodando o agente
   para gerar a entrega em `relatorios/` após a rotina diária). O agendador do
   sistema não serve para análises (só executa coletas); nesse caso o
   combinado é o atalho — dados chegam pela rotina, o gestor diz a frase. A
   entrega agendada pode incluir **envio por e-mail** (`scripts/email.mjs
   enviar`), com destinatários combinados com o gestor — registre-os no
   arquivo da personalização.
