# O que mudou em cada versão

A versão mais recente vem primeiro. O assistente verifica este arquivo todos os
dias e, quando se atualiza, conta ao gestor o que mudou — por isso as entradas
são escritas em linguagem de gestor, não de programador.

> Regra para quem contribui: toda mudança publicada precisa de uma entrada aqui
> **e** do aumento da versão no `package.json` (correção = terceiro número,
> novidade = segundo número). Sem isso, a atualização automática não enxerga
> nem explica a mudança.

## [1.0.1] — 28/09/2026

### Correções

- **A página de configuração sumia no meio do caminho.** Ela era encerrada
  junto com o comando que a abriu, e quem estava preenchendo com calma — ou
  procurando a logomarca no computador — encontrava a janela sem resposta.
  Agora ela fica no ar pelo tempo que você precisar, até clicar em "Concluir".
- **A tela parecia travada ao salvar o acesso.** O sistema da TOTVS pede um
  intervalo entre as consultas, então testar usuário, senha e número de série
  leva de 1 a 2 minutos — e a página não dizia nada. Agora mostra o que está
  acontecendo, com barra de progresso e o aviso de não fechar a janela.
- **"Personalizar o assistente" não aparecia na primeira configuração**: o
  botão só existia depois de cadastrar o primeiro acesso. Agora está nas duas
  telas.
- Ao concluir, a página avisa que vai se encerrar — antes, os botões
  simplesmente paravam de responder e parecia defeito.

## [1.0.0] — 28/09/2026

**Lançamento oficial.** O assistente de gestão para o TOTVS Food Linha Chef
está disponível para qualquer gestor de food service, gratuitamente.

### Comece a usar em uma frase

Peça ao Claude Code ou ao Codex: *"instale o assistente de gestão do TOTVS
Food Linha Chef"* e ele faz o resto — baixa, prepara o computador, abre uma
página segura no navegador para você informar o acesso da TOTVS e deixa um
atalho na área de trabalho. Você não abre pasta, não edita arquivo e não
digita comando nenhum. Funciona no **Windows** e no **Mac**.

### Seus dados, no seu primeiro dia

- Assim que você conecta a loja, o assistente busca na hora tudo o que o
  sistema da TOTVS libera a qualquer momento — vendas recentes, caixa,
  financeiro, notas, catálogo e estoque — e diz o que você já pode analisar.
- **Você escolhe quanto histórico quer**: desde a primeira venda de cada loja
  ou só os últimos anos. O assistente busca sozinho, nas madrugadas, e mostra
  o progresso quando você perguntar "como está a carga?".
- Tem **mais de uma loja ou mais de um grupo**? Conecte quantos quiser e
  compare todos — e acrescente novos quando abrir uma loja.

### Ele trabalha mesmo quando você não está

- **Rotina diária**: busca o movimento de ontem, tira a fotografia do estoque
  do dia (é ela que permite calcular o CMV real) e **recupera sozinha os dias
  em que o computador ficou desligado**.
- **Cópia de segurança** automática na sua pasta Documentos, sem senhas.
- **Atualização automática**: ele confere sozinho se há versão nova e conta o
  que melhorou.
- **Avisos que importam**: se algo falhar na busca dos seus dados, você fica
  sabendo na primeira conversa do dia — com o que fazer, e com o texto do
  chamado para o suporte da TOTVS pronto quando o problema for de lá.

### Perguntas em português, respostas com contexto

Faturamento, ticket médio, produtos que mais vendem, horário de pico, mix por
categoria, curva ABC, vendas por setor (balcão, mesa, comanda, entrega),
descontos e cancelamentos por operador, contas a pagar, livro caixa, cartões a
receber, quebra de caixa, posição e cobertura de estoque, auditoria fiscal.
Os números vêm comparados com o período anterior, com as suas metas e com as
faixas de referência do mercado para o seu segmento.

### Análise que interpreta, não só mostra

Por que subiu ou caiu, o que fugiu do padrão, comparação entre lojas,
oportunidades de venda casada, simulação de cenários, feriados e eventos
explicando as variações — e um diário de decisões: o assistente registra o que
recomendou e **volta depois para medir se funcionou**.

### Entregas prontas para usar

**DRE gerencial** dinâmica (mensal/anual, competência ou caixa, com gráfico de
cascata), **painéis interativos** que abrem sem internet e funcionam no
celular, planilhas Excel formatadas, documentos Word e PDF. Enviou sua
logomarca? Os relatórios saem com a sua marca e as suas cores.

### Do seu jeito

- **Personalização por conversa**: *"crie um indicador meu"*, *"ajuste esse
  relatório e salve como meu padrão"*. Na configuração, o assistente
  entrevista você sobre o que costuma acompanhar e transforma cada hábito num
  atalho com nome.
- Dê um **nome ao assistente** e diga como prefere que ele fale com você.
- **E-mail opcional**: se quiser, ele envia seus relatórios pela sua própria
  conta, nos horários que você combinar.

### Seus dados ficam com você

Tudo é gravado **apenas no seu computador**. As senhas ficam num arquivo local
que nunca sai dele, e o assistente **só lê** o sistema da TOTVS — nunca altera
nada lá.

### Achou um problema ou tem uma ideia?

É só dizer: o assistente registra o relato para a equipe que mantém o projeto
e, se você quiser, ajuda a criar sua conta no site dos relatos para você
receber a resposta por e-mail.
