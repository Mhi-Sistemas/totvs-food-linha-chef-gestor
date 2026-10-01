# O que mudou em cada versão

A versão mais recente vem primeiro. O assistente verifica este arquivo todos os
dias e, quando se atualiza, conta ao gestor o que mudou — por isso as entradas
são escritas em linguagem de gestor, não de programador.

> Regra para quem contribui: toda mudança publicada precisa de uma entrada aqui
> **e** do aumento da versão no `package.json` (correção = terceiro número,
> novidade = segundo número). Sem isso, a atualização automática não enxerga
> nem explica a mudança.

## [1.0.10] — 01/10/2026

### Melhorias

- **Produto e cliente novos entram no dia, não na semana seguinte.** O catálogo
  de produtos e a lista de clientes são atualizados uma vez por semana, porque
  o sistema da TOTVS limita quantas vezes por dia essa consulta pode ser feita.
  O problema é que um produto cadastrado na terça só aparecia na segunda
  seguinte — e nesse meio-tempo o valor do seu estoque saía com o custo velho,
  e um cliente novo ficava sem ficha nas análises. Agora, quando o movimento
  traz um produto ou um cliente que o cadastro ainda não conhece, o assistente
  **antecipa a atualização para o mesmo dia**. Se o código não existir mesmo
  (um produto excluído, por exemplo), ele tenta duas vezes e desiste, para não
  gastar o limite diário à toa.

## [1.0.9] — 30/09/2026

### Correções

- **A DRE voltou a abrir.** A versão 1.0.8 trouxe a opção de escolher qual CMV
  aparece na DRE, mas, em quem ainda não tinha feito essa escolha, o relatório
  falhava com um erro de acesso ao banco de dados em vez de abrir. Corrigido:
  sem escolha feita, a DRE usa o CMV teórico, como antes, e você pode trocar
  quando quiser.

- **O assistente estava respondendo em inglês em alguns computadores.** A
  instrução de falar sempre em português passou a ser a primeira coisa que ele
  lê, e agora vale explicitamente para qualquer situação.

## [1.0.8] — 30/09/2026

### Novidades

- **Agora dá para saber o CMV real de meses que já passaram.** Até aqui, o
  custo da mercadoria vendida só podia ser calculado a partir do dia em que
  você instalou o assistente — o sistema da TOTVS informa quanto você tem em
  estoque hoje, mas nunca quanto tinha numa data anterior, e sem isso não há
  conta a fazer. A saída é o inventário que você já conta no ChefWeb: peça ao
  assistente e ele ensina a exportar a contagem do primeiro e do último dia do
  mês, importa para você e fecha o CMV do período. De quebra, o inventário
  revela o custo que cada produto tinha naquela data — informação que o
  cadastro não guarda. Pergunte "qual foi meu CMV em agosto?" que ele diz de
  onde tirou cada ponta da conta e avisa quando alguma contagem estiver
  incompleta demais para confiar.

- **Aviso de custo fora da realidade.** O assistente passou a conferir o custo
  cadastrado dos seus produtos e avisar quando algum está claramente errado —
  uma água a R$ 18,00, um pote plástico a R$ 518,00. Quase sempre a causa é a
  conversão da embalagem na entrada da mercadoria: comprou-se a caixa com mil
  potes e o sistema ficou entendendo que cada pote custa o valor da caixa
  inteira. Custo errado contamina o CMV, a margem e o valor do seu estoque, e
  esse é o tipo de erro difícil de perceber olhando relatório. Pergunte "meus
  custos estão certos?" e ele traz a lista com o que conferir no ChefWeb, item
  por item. Produtos adicionais com preço promocional de R$ 0,00 ou R$ 0,01
  ficam fora da lista: neles o custo alto é proposital, não defeito.

- **Você escolhe qual CMV aparece na sua DRE.** Existem três formas de calcular
  o custo da mercadoria vendida, e elas dão números diferentes — por isso a
  escolha passou a ser sua, não do assistente. Pode ser o **teórico** (pela
  ficha técnica, funciona desde o primeiro dia mas não enxerga desperdício), o
  **real** (estoque inicial + compras − estoque final, que é o consumo de
  verdade e revela a perda) ou o **valor das compras de mercadoria** lançadas
  no seu plano de contas (que bate com o extrato). Pergunte ao assistente
  "qual CMV a DRE está usando?" e ele explica cada um e troca para o que você
  preferir. Se num mês faltar informação para o que você escolheu, a DRE usa o
  teórico só naquele mês e avisa na nota do relatório.

- **Você fica sabendo quando resolvem o que você relatou.** Antes, ao enviar um
  problema ou uma ideia para a equipe, só dava para saber o desfecho voltando
  ao site. Agora o assistente acompanha sozinho, todo dia, e avisa na conversa
  seguinte quando alguém responde ou resolve — sem você precisar de conta em
  lugar nenhum. Pergunte "e aquele problema que eu relatei?" e ele mostra a
  situação de tudo o que você já enviou.

- **O assistente agora confere se os dados do período estão completos antes de
  responder.** O sistema da TOTVS às vezes entrega um dia pela metade dizendo
  que deu tudo certo — houve caso de um dia cujo caixa fechou em R$ 4,8 mil vir
  com uma única venda. Sem perceber isso, o assistente montava painel, DRE e
  CMV sobre dados faltando, e numa loja a receita do mês apareceu 38% menor que
  a real. Agora ele compara, dia a dia e loja a loja, as vendas com o
  fechamento de caixa, e **avisa você antes de gerar qualquer análise** quando
  falta alguma coisa: diz quantos dias faltam, de quais lojas e quanto isso
  representa em reais. Se você decidir seguir assim mesmo, a ressalva sai
  impressa no próprio painel e na própria DRE — para que ninguém que leia o
  relatório depois tome a decisão sem saber.

- **Lojas de movimento alto passam a ser buscadas dia a dia, sozinhas.** Quando
  a loja vende muito, o sistema da TOTVS não consegue entregar um mês inteiro
  de uma vez: a busca estoura o tempo e volta vazia, e o histórico daquela loja
  ficava para trás sem ninguém perceber. Agora o assistente reconhece isso
  depois da segunda vez e **muda a estratégia daquela loja para sempre**,
  buscando um dia por vez. Fica mais demorado, mas o dado vem completo — e ele
  te avisa quando faz essa troca.

- **Os dias que vieram incompletos são buscados de novo, sozinhos.** Detectar o
  buraco não bastava: agora, todo dia, o assistente confere o último mês e põe
  na fila os dias que vieram com menos vendas do que o caixa registrou,
  rebuscando alguns por noite até fecharem. O dia que resiste a três tentativas
  deixa de ser problema de coleta e vira aviso: é defeito do lado da TOTVS, e o
  assistente oferece montar o texto do chamado para o suporte deles. A lista do
  que já foi baixado passou a mostrar também quantos dias estão incompletos —
  "dias buscados" não é a mesma coisa que "dias completos".

- **A conferência dos dados agora cruza três fontes.** Além de comparar suas
  vendas com o fechamento de caixa, o assistente passou a buscar também a lista
  de cupons emitidos — uma terceira visão do mesmo movimento, que vem de outro
  lugar do sistema da TOTVS. Quando as três concordam, o número é confiável;
  quando divergem, ele te avisa antes de gerar qualquer relatório. Essa
  terceira fonte tem uma vantagem: pode ser consultada a qualquer hora do dia,
  enquanto as vendas antigas só de madrugada.

- **Trocar a senha do ChefWeb ficou simples — e o assistente avisa quando
  precisa.** A senha do ChefWeb expira de tempos em tempos, e quando isso
  acontece a busca de dados para sozinha, sem você ter mudado nada: seus
  relatórios passariam a mostrar informação velha sem aviso. Agora o assistente
  percebe na hora e te avisa na conversa seguinte, já abrindo a página segura
  para você digitar a senha nova (nunca pelo chat). Basta dizer "minha senha do
  ChefWeb mudou".

### Correções

- **A DRE deixou de contar a compra de mercadoria duas vezes.** O valor gasto
  com mercadoria aparecia na linha de CMV **e** de novo nas despesas
  operacionais, subtraindo o mesmo dinheiro duas vezes e afundando o resultado
  do mês (R$ 5.577 num único mês, no ambiente de testes). Agora a compra de
  mercadoria fica só na linha de CMV. Na visão de caixa ela continua entre as
  saídas, como deve ser: ali não existe linha de CMV, e o dinheiro saiu mesmo.

- **Nomes vindos do sistema da TOTVS deixaram de aparecer duplicados ou
  quebrados.** Alguns textos chegavam com códigos estranhos no meio
  ("MAT&#201;RIA PRIMA") ou com um espaço invisível no fim ("MAESTRO "). O
  efeito era silencioso e caro: o mesmo plano de contas virava dois na sua DRE,
  com o gasto dividido entre eles, e formas de pagamento ficavam sem categoria
  nas análises. Agora todo texto é limpo na entrada, e os dados já baixados
  foram corrigidos — na base de testes, R$ 70 mil de "Matéria Prima" voltaram
  para o lugar certo e 8 mil pagamentos voltaram a ser classificados.

- **A busca não desiste mais de todas as lojas por causa de uma.** Quando uma
  loja movimentada estourava o tempo de resposta várias vezes seguidas, o
  assistente interrompia a busca daquele tipo de dado por inteiro — inclusive
  das lojas que estavam funcionando normalmente. Agora o tempo esgotado é
  tratado como característica daquela loja, não como problema geral.

- **Lançamentos apagados no ChefWeb não entram mais nos seus relatórios.**
  Contas que você excluiu no sistema continuavam sendo somadas nas despesas da
  DRE. No ambiente de testes eram R$ 81 mil indevidos. Agora são ignoradas.

### Melhorias

- **As compras que entram no CMV passaram a vir do seu financeiro.** Antes o
  assistente somava as notas fiscais de entrada, mas uma nota costuma trazer
  equipamento, utensílio e material de limpeza junto da mercadoria — e isso
  inflava o custo da comida com coisas que não são comida (35% a mais, nos
  testes). Agora o cálculo usa as contas lançadas que você classificou como
  compra de mercadoria. Se essa classificação ainda não existir, o assistente
  pede que você confirme a lista antes de calcular, em vez de dar um número
  errado.

- **O custo passa a ser guardado junto com a fotografia do estoque.** Antes, o
  valor do seu estoque de um dia passado era calculado com o custo de hoje — e
  como o custo muda, a conta saía distorcida. Agora cada fotografia diária
  guarda o custo daquele dia, e o CMV real do mês fecha com o custo que era
  praticado no período. As fotografias já tiradas foram ajustadas com o melhor
  valor disponível.

## [1.0.7] — 28/09/2026

### Novidades

- **Suas dúvidas agora viram pergunta pública com resposta.** Quando você pede
  ao assistente para registrar uma dúvida ou uma ideia, ela vai para a área de
  discussões do projeto, em vez de virar um chamado perdido no meio dos
  problemas técnicos: a resposta fica guardada e pesquisável para quem passar
  pela mesma situação. Problemas continuam indo para a fila de correções.

## [1.0.6] — 28/09/2026

### Correções

- Em gráficos estreitos, os valores do eixo apareciam colados uns nos outros
  ("R$ 1 miR$ 2 mi"). Agora o eixo esconde o que não cabe.

## [1.0.5] — 28/09/2026

### Novidades

- **Suas metas aparecem nos painéis.** Todo indicador com meta definida passa a
  mostrar, no próprio cartão, se está dentro (verde) ou quanto estourou
  (vermelho, com a diferença exata) — e os gráficos ganham a linha da meta, o
  que mostra **em que mês** o número saiu do trilho, não só que saiu.
- Gráficos de percentual agora mostram o "%" no eixo, em vez de números soltos.

### Correções

- **Feriados escritos um por cima do outro** nos gráficos de linha viravam
  borrão ("CarnavalCarnavalCinzas"). Agora os nomes se revezam e só aparecem
  quando há espaço — a marca da data continua em todos.
- O último valor do eixo aparecia cortado ("R$ 1,8 n" em vez de "R$ 1,8 mi"),
  e o valor da maior barra também.
- Nos gráficos de barras com poucas colunas, alguns rótulos sumiam — faltavam
  segunda, quarta e sexta no gráfico por dia da semana.
- Um painel podia sair **completamente em branco, sem erro nenhum**, quando a
  receita do painel usava um filtro que não existia. Agora ele é ignorado com
  aviso, e o painel sai com todos os dados.

## [1.0.4] — 28/09/2026

### Novidades

- **Os gráficos de meios de pagamento agora mostram o tipo, não o nome solto.**
  O ChefWeb deixa você nomear as formas como quiser, e é comum ter dezenas
  ("PIX STONE", "MASTER VISA DEBITO INFINITY", "IFOOD ONLINE") — o gráfico
  virava uma lista ilegível. Agora ele mostra as categorias (Pix, Crédito,
  Débito, Dinheiro, iFood...) e **você clica em uma para ver quais formas
  estão dentro dela**.
- **O agrupamento automático ficou mais esperto**: aplicativos de delivery
  (iFood, AiQFome, Rappi...) passaram a ter categoria própria em vez de serem
  confundidos com cartão de crédito — num caso real isso colocava o maior
  recebimento da casa na categoria errada. E bandeiras sem o tipo no nome
  (Mastercard, Visa, Visa Electron, Maestro) são classificadas pela convenção
  do mercado. O que continuar ambíguo aparece marcado para **você confirmar**,
  em vez de ser adivinhado.

## [1.0.3] — 28/09/2026

### Correções

- **Uma loja sem permissão deixava as outras sem dados.** Quando o usuário do
  ChefWeb não tinha acesso a alguma loja, a busca parava ali e **nenhuma loja
  seguinte** era baixada — sem aviso. Num grupo de 36 lojas, só as 5 primeiras
  tinham estoque. Agora o assistente pula a loja recusada, continua nas demais
  e te avisa quais ficaram de fora e como liberar o acesso no ChefWeb.

### Novidades

- **Quanto entrou e saiu de cada conta**: nova análise do livro caixa por conta
  financeira (COFRE, banco, maquininha), já descontando lançamentos excluídos,
  estornos e transferências entre contas — que apareciam duas vezes e
  distorciam o número. Vale para o histórico que você já tem: o assistente
  aproveita os dados baixados, sem precisar buscar de novo.
  Uma ressalva honesta: **o sistema da TOTVS não informa o saldo das suas
  contas**, então o assistente nunca vai dizer "você tem X em caixa" — o que
  ele mostra é o movimento do período. O saldo você confere no ChefWeb ou no
  banco.

## [1.0.2] — 28/09/2026

### Novidades

- **O atalho da área de trabalho saiu.** Ele abria uma janela preta de
  terminal e não ajudava quem usa o aplicativo de computador — quem já tinha o
  atalho, ele é removido sozinho na atualização. Para voltar ao assistente,
  abra a ferramenta de IA que você usa apontando para a pasta dele; o guia de
  instalação mostra como em cada uma.

- **Escolher o jeito do assistente ficou mais simples**: em vez de descrever
  num campo em branco, agora você marca as opções que combinam com você —
  "direto ao ponto", "sem termos técnicos", "sempre comparar com antes" — e
  pode juntar quantas quiser. A tela deixa claro que **tudo ali é opcional**.
- **Histórico financeiro completo**: a busca do seu histórico passou a incluir
  os **cartões a receber**, que antes só vinham do dia a dia. Junto com contas
  a pagar, livro caixa e notas, isso é o que permite montar relatórios
  financeiros e a DRE de meses passados.
- **Você acompanha a busca enquanto ela roda**: a cada 5 minutos o assistente
  informa o progresso (quanto já veio, quanto falta e o tempo estimado), em
  vez de deixar a tela muda por longos minutos.

### Correções

- **A página de inscrição no comparativo de mercado tinha os mesmos defeitos
  da página de configuração**: era encerrada junto com o comando que a abriu e
  tinha prazo fixo de 10 minutos. Agora fica no ar enquanto você preenche, e a
  tela de confirmação chega inteira antes de ela se fechar.
- O convite para o comparativo de mercado era esquecido no fim da configuração
  — agora ele acontece uma vez, e fica registrado para nunca mais se repetir.
- Ao programar a busca da madrugada, o assistente passa a **explicar por quê**:
  é o sistema da TOTVS que só libera dados antigos entre 23h e 7h.

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
página segura no navegador para você informar o acesso da TOTVS. Você não
abre pasta, não edita arquivo e não digita comando nenhum. Funciona no **Windows** e no **Mac**.

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
