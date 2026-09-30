---
name: configurar
description: Configura o acesso ao TOTVS Food Linha Chef e gerencia os grupos de lojas, abrindo uma página local segura no navegador. Use quando o gestor disser "configurar", "começar", "primeira vez", "conectar minha loja", "trocar senha/credenciais", "adicionar uma loja", "abri uma loja nova", "tenho outro grupo/outra empresa", ou quando qualquer operação falhar por falta de configuração.
---

# Configurar acessos e grupos de lojas

Objetivo: deixar o assistente pronto para uso — acessos salvos e testados,
banco local criado e primeira carga feita.

**Um acesso = um grupo de lojas** (um "número de série"/diretório site do
ChefWeb, que pode conter várias lojas). O gestor pode ter **vários grupos** e
**acrescentar novos a qualquer momento** — a mesma página cadastra, altera e
remove. Use esta skill também quando ele disser "abri uma loja nova" ou "tenho
outra empresa no Chef".

**Fluxo principal: a página de configuração no navegador.** O gestor NÃO deve
digitar credenciais no chat nem ouvir falar de arquivos técnicos.


## A senha do ChefWeb expira

É a causa mais comum de "parou de funcionar do nada": o ChefWeb faz as senhas
expirarem periodicamente, a coleta para e o gestor não mudou nada. A rotina
diária registra alerta quando isso acontece.

Atalho: `node --no-warnings scripts/configurar.mjs senha [--grupo <id>]` — abre
a página local **já na tela daquele grupo**, para ele só digitar a nova.
**Nunca peça a senha pelo chat.**

Se a senha estiver certa e o acesso continuar recusado, o problema é permissão:
o usuário precisa de **permissão total** no ChefWeb, **replicada em todas as
lojas**, uma a uma — não basta liberar os relatórios.

## Passo a passo

1. **Acolha o gestor** em uma frase: "vou abrir uma página segura no seu
   navegador para você preencher os dados de acesso da TOTVS — ela explica onde
   encontrar cada informação".

2. **Abra a página de configuração**:
   ```
   node --no-warnings scripts/configurar.mjs
   ```
   O comando abre o navegador sozinho, com um formulário em português que:
   - explica onde encontrar cada credencial (usuário, senha e serial da loja;
     o campo técnico "Chave" do login é resolvido automaticamente — não é um
     segredo, a API aceita um valor padrão);
   - testa a conexão com a TOTVS antes de salvar;
   - guarda tudo localmente e cria o banco de dados.
   **O comando devolve o controle na hora**: a página roda num processo
   próprio e **fica no ar pelo tempo que o gestor precisar**, mesmo que a sua
   execução termine. Avise: *"abri a página no seu navegador; preencha com
   calma, eu espero"*.
   Para saber em que pé está, use
   `node --no-warnings scripts/configurar.mjs status` — ele diz se a página
   continua aberta e quais acessos já foram salvos. **Não fique chamando o
   comando de abrir de novo**: se a página já está no ar, ele apenas repete o
   endereço.
   **Avise o gestor que o teste das credenciais demora de 1 a 2 minutos** (a
   TOTVS exige intervalo entre as consultas). A própria página mostra o aviso
   e uma barra de progresso enquanto testa — ele não deve fechar a janela.

3. **Acompanhe pelo `status`** (a página avisa você pelo arquivo de estado):
   - `status` diz "ABERTA" → o gestor ainda está preenchendo; espere, converse,
     tire dúvidas sobre onde achar cada credencial
     (`docs/como-obter-credenciais.md`). Nunca peça a senha pelo chat.
   - `status` diz "não está aberta" **e lista acessos salvos** → ele concluiu:
     "conectei com sucesso ao sistema da sua loja!"
   - `status` diz "não está aberta" **e nenhum acesso salvo** → ele desistiu ou
     fechou a janela; pergunte se teve dificuldade e ofereça abrir de novo.
   - A página se encerra sozinha após 15 minutos **sem nenhum uso** (o relógio
     reinicia a cada clique dele).
   - Se o navegador não abrir sozinho, informe o endereço local que o comando
     imprimiu para o gestor colar no navegador.

4. **Faça a carga inicial — o que dá para buscar agora, sem esperar a
   madrugada.** Um comando só:
   ```
   node --no-warnings scripts/carga-inicial.mjs --grupo <id>
   ```
   Ele busca as **vendas dos últimos 16 dias** (o recorte que a TOTVS libera a
   qualquer hora) e **todos os outros dados que não têm trava de horário** —
   caixa, financeiro, notas, catálogo, estoque, clientes. Leva alguns minutos;
   avise o gestor: *"estou buscando seus dados, um instante"*.

4b. **Acompanhe a coleta e vá contando.** A carga inicial leva alguns minutos
   (a TOTVS pede ~30s entre buscas). **Não deixe o gestor no vazio**: a cada
   poucos minutos, diga em que pé está — *"já trouxe suas vendas e o caixa,
   estou no financeiro agora"*. Se a coleta estiver rodando em segundo plano,
   o próprio log traz um boletim de progresso a cada 5 minutos (percentual,
   quantas buscas faltam e a estimativa de tempo); use-o para informar o
   gestor no mesmo ritmo, sem que ele precise perguntar.

5. **Diga a ele o que já está disponível.** O comando termina listando isso;
   traduza em oportunidade, não em inventário: *"já tenho suas vendas dos
   últimos 16 dias, seu caixa, suas contas a pagar e seu estoque de hoje — já
   posso montar um painel ou responder sobre esse período. Quer ver?"*
   A qualquer momento, `carga-inicial.mjs situacao --grupo <id>` repete essa
   lista. **Ofereça uma entrega concreta agora** — é o que mostra ao gestor
   que a ferramenta funciona, antes de qualquer conversa sobre histórico.

5b. **Só então pergunte sobre o histórico** — e note que são duas perguntas,
   ambas só o gestor responde:
   - *"quais são as suas lojas? Preciso do número de cada uma"* (o assistente
     **não tem como descobrir sozinho** — não existe consulta que liste as
     lojas de um grupo);
   - *"a partir de qual data você quer os dados de cada loja?"* — **é uma
     escolha dele, não a data em que a loja abriu**. Muita gente quer só os
     últimos dois anos; ofereça isso explicitamente: *"posso trazer desde o
     começo ou só os últimos anos — quanto de histórico você usa de verdade?"*
     Quanto menos período, mais rápido fica pronto.

   Grave cada resposta na hora:
   ```
   node --no-warnings scripts/lojas.mjs definir --grupo <id> --loja <n> --nome "..." --inicio AAAA-MM-DD
   ```
   (loja já fechada: acrescente `--ultima-venda AAAA-MM-DD --parada`.) Confira
   com `lojas.mjs listar --grupo <id>` — loja com "DATA A INFORMAR" fica **de
   fora** da busca. Se ele não souber tudo de cabeça, registre o que souber,
   combine de perguntar o resto e anote em `data/memoria/handoff.md`.
   Se ele **não quiser histórico nenhum**, respeite: o dia a dia já está
   coberto pela rotina diária.

5c. **Monte o plano e agende**: com as datas gravadas,
   ```
   node --no-warnings scripts/lojas.mjs plano --grupo <id> --noite
   ```
   mostra quantas buscas são e quanto tempo leva. **Apresente o número ao
   gestor** ("são 240 buscas, cerca de 40 minutos por madrugada; seu histórico
   fica pronto em uns 3 dias") e **agende** — nunca peça para ele rodar de
   madrugada (veja "⏳ Agende a coleta noturna" na skill `sincronizar`).

   **Explique POR QUE precisa ser de madrugada** — sem isso, agendar uma tarefa
   noturna no computador dele parece arbitrário e invasivo:
   > *"O sistema da TOTVS só libera a busca de vendas antigas entre 23h e 7h —
   > é regra deles, para não sobrecarregar o servidor no horário em que as
   > lojas estão vendendo. Por isso eu programo a busca para a madrugada: ela
   > roda sozinha, sem atrapalhar o seu dia, e de noite ainda é 3× mais rápida.
   > O que preciso de você é só deixar o computador ligado e sem suspensão."*

   Diga também o que **não** depende da madrugada: o financeiro (contas a
   pagar, livro caixa, cartões a receber, notas) e os fechamentos de caixa não
   têm essa restrição e são buscados de dia — então os relatórios financeiros
   do histórico ficam prontos bem antes das vendas.

   A carga se conduz sozinha a partir daí: a rotina diária retoma o que faltou,
   e `lojas.mjs progresso --grupo <id> --abrir` mostra o andamento sempre que
   ele perguntar "como está a carga?".

6. **Agrupe as formas de pagamento** (após a primeira carga de vendas): o gestor
   cadastra formas com nomes livres ("PIX SANTANDER", "VISA CREDITO"...). Rode
   `node --no-warnings scripts/categorias-pagamento.mjs sugerir`, apresente as
   sugestões em linguagem simples ("vou agrupar PIX SANTANDER e PIX ITAU como
   Pix, pode ser?"), ajuste o que ele pedir e grave com
   `... categorias-pagamento.mjs definir "FORMA=Categoria" ...`.

7. **Ative a rotina diária** (não pule este passo — é o que mantém o assistente
   vivo depois que a conversa acaba). Explique em linguagem de gestor: *"posso
   deixar programado: todo dia eu busco os movimentos de ontem, tiro uma
   fotografia do estoque e guardo uma cópia de segurança dos seus dados"*.
   **Pergunte o horário — nunca assuma**: *"a que horas o seu computador
   costuma estar ligado? A tarefa só roda com ele ligado e sem suspensão"*.
   Sugira o início do expediente (ex.: quando a loja abre); qualquer horário
   funciona para os dados de ontem — de madrugada a busca é mais rápida, mas
   um horário realista vale mais que um horário rápido em que a máquina está
   desligada. Com horário combinado:
   - **1ª opção**: o agendador do ambiente em que você roda (Claude Code, Codex,
     Paseo...), executando `node --no-warnings scripts/rotina.mjs executar`
     diariamente no horário escolhido;
   - **2ª opção** (ambiente sem agendador):
     `node --no-warnings scripts/rotina.mjs ativar --hora HH:MM`.
   Se um dia o computador ficar desligado, a execução seguinte recupera os
   dias perdidos sozinha — diga isso ao gestor. A fotografia diária do estoque
   é o que permitirá calcular o CMV real no futuro — dias sem rotina são dados
   perdidos para sempre. Se o gestor recusar, respeite, mas avise dessa
   consequência.

7b. **Confirme o segmento e a persona**. Na página de configuração o gestor
   escolhe o **segmento** de cada grupo (pizzaria, padaria, quilo... —
   geralmente todas as lojas do grupo são do mesmo segmento; exceção por
   loja, anote em `data/memoria/aprendizados.md`) e, na tela "Personalizar o
   assistente", o **nome do assistente**, o **jeito de se comunicar** e a
   **logomarca** dele. Se ele não preencheu, pergunte na conversa e ofereça
   reabrir a página. Enviou logomarca? **Olhe a imagem, extraia as cores e
   grave `personalizados/identidade/identidade.json`** (formato em
   `scripts/identidade.mjs`) — os painéis e a DRE passam a sair com a marca
   dele; mostre um painel de exemplo para ele ver a mágica.

8. **Entreviste para personalizar** (o gestor precisa descobrir que tudo aqui
   pode ser do jeito dele — e ninguém descobre sozinho). Não anuncie apenas:
   **pergunte**: *"que análises ou números você costuma acompanhar — e com que
   frequência? Todo dia de manhã? Toda segunda? No fechamento do mês?"* Com as
   respostas, produza na hora:
   - **Um atalho para cada hábito**: arquivo em `personalizados/` (formato do
     README, com `gatilhos` e `frequencia`), validando fórmulas novas no
     dicionário de dados e no catálogo de métricas. Ensine a frase ao gestor:
     *"é só me dizer 'fechamento da semana' que eu entrego pronto"*.
   - **Agendamento para as recorrentes**: prefira o agendador do ambiente
     (Claude Code, Codex, Paseo...) rodando você mesmo para gerar a entrega em
     `relatorios/` no horário combinado — **depois da rotina diária**, para os
     dados estarem frescos. Se o ambiente não agendar conversas, seja honesto:
     o agendador do sistema só roda coletas, não análises — o combinado então
     é *"seus dados chegam sozinhos às [hora da rotina]; quando você abrir,
     diga a frase do atalho que sai na hora"*.
   A meta é o gestor sair da configuração com **2 ou 3 atalhos do jeito dele
   já funcionando** — nada fixa a capacidade como vê-la pronta no primeiro dia.

9. **Convide para a lista de espera do benchmark — UMA ÚNICA VEZ, e não deixe
   de fazer**: este é o passo que mais se esquece, e é o último do onboarding.
   Confira antes com `node --no-warnings scripts/benchmark.mjs situacao`:
   - `não convidado ainda` → faça o convite agora (fala pronta abaixo);
   - qualquer outra resposta → **não toque no assunto**.
   Com o **sim**, ABRA a página (não basta mencionar):
   `node --no-warnings scripts/benchmark.mjs lista-espera`.
   Logo depois — tanto faz se ele aceitou ou recusou — registre para nunca
   mais convidar: `node --no-warnings scripts/benchmark.mjs convite-feito`
   (acrescente `--aceitou` quando ele entrar).
   Fala pronta: *"já pensou comparar seu CMV e seu ticket médio com empresas
   parecidas com a sua — da sua cidade ou de outros estados? Estamos
   construindo esse benchmark, colaborativo e gratuito: quando chegarmos a
   500 inscritos, o projeto começa, e quem está na lista participa primeiro.
   Quer entrar? Abro uma página aqui para você preencher."* Com o sim:
   `node --no-warnings scripts/benchmark.mjs lista-espera`
   — abre a página local (empresa, nome, telefone, e-mail), que explica o que
   é enviado; o gestor preenche e confirma lá. Sem internet na hora, o pedido
   fica guardado e a rotina reenvia sozinha. Antes de convidar, confira
   `benchmark.mjs situacao`; se recusar, não repita o convite.

10. **Encerre ensinando**: dê 3 exemplos de perguntas que ele já pode fazer, ex.:
   "qual foi meu faturamento este mês?", "quais os 10 produtos que mais vendem?",
   "monte um painel das minhas vendas".

## Situações especiais

- **Adicionar um grupo de lojas novo** ("abri outra empresa", "tenho outro
  número de série"): rode o mesmo comando e diga "clique em *Adicionar grupo de
  lojas*". Depois de salvar, o grupo nasce sem dados — **refaça por ele os
  passos 4 a 5c** (carga inicial, mostrar o que já tem, perguntar as lojas e as
  datas, planejar e agendar), sempre com `--grupo <id>`.
- **Adicionar uma loja a um grupo existente** ("abri uma filial"): se a loja
  pertence ao mesmo número de série, cadastre a janela dela —
  `lojas.mjs definir --grupo <id> --loja <n> --nome "..." --inicio AAAA-MM-DD`
  (aqui a data de abertura é o início natural) — e sincronize. Vale acrescentar o código no campo
  "Código das lojas" (botão *Alterar*), mas o cadastro acima é o que dirige a
  busca. Se a filial tiver série própria, é um grupo novo (caso acima).
- **Gestor de uma loja só** (o caso da maioria, inclusive em rede de
  franquias, onde cada franqueado é dono da sua): os passos valem igual, com
  uma loja — são 30 segundos de conversa.
- **Rede com dezenas ou centenas de lojas**: não tente listar tudo numa
  conversa só. Pergunte se existe uma relação pronta (planilha, o controle de
  coleta do ChefWeb) — com ela, `lojas.mjs importar --arquivo <tsv>` resolve de
  uma vez. Sem ela, comece pelas lojas que ele mais acompanha e vá somando: a
  carga é retomável e cada loja nova entra no plano seguinte.
- **Trocar credenciais/senha**: *Alterar* no grupo desejado. Deixar a senha em
  branco mantém a atual.
- **Remover um grupo**: botão *Remover*. Os dados já baixados continuam no banco
  local — avise o gestor disso.
- **Ambiente sem navegador** (raro, ex.: servidor remoto): só neste caso use o
  fluxo alternativo — peça as credenciais no chat, uma por vez, e grave em
  `data/conexoes.json` (formato em `scripts/conexoes.mjs`); depois rode
  `node --no-warnings scripts/testar-conexao.mjs` e
  `node --no-warnings scripts/criar-banco.mjs`. Nunca repita a senha de volta.
- **Gestor colou credenciais no chat espontaneamente**: use-as (grave e teste),
  não as repita, e sugira que da próxima vez use a página segura.
