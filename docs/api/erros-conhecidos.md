# Catálogo de erros da API do ChefWeb — anti-falhas e autofix

Catálogo vivo dos erros observados na API do TOTVS Food Linha Chef, com a
causa, a classificação e o tratamento automático ("autofix") que o projeto
aplica. **Todo erro novo encontrado em produção deve ganhar uma entrada aqui**
— é este catálogo que alimenta a robustez do assistente e orienta relatos à
TOTVS.

Classificação usada:

- **transitório** — some sozinho; a resposta certa é retentar.
- **persistente** — não adianta retentar igual; exige contorno ou correção no servidor.
- **restrição** — comportamento por regra da API (janela, limite); a resposta é respeitar a regra.

## 1. Erro 30 — venda corrompida aborta o mês inteiro

- **Assinatura**: `CapaVenda/ListPorDataMovimento: 30: Ocorreu um erro ao
  listar os itens da(s) venda(s): <guid>[,<guid>...]. Procedimento abortado.`
- **Causa**: uma ou mais vendas com dados corrompidos no servidor da TOTVS
  fazem a listagem de itens falhar — e a API aborta **o período inteiro**, não
  só as vendas problemáticas. Observado em 24/09/2026 numa rede de 27 lojas,
  em meses variados de mais de uma loja (GUIDs sempre diferentes), o que indica
  corrupção esparsa na base, não um caso isolado.
- **Classificação**: persistente (o retry falha igual, com os mesmos GUIDs).
- **Autofix atual**: 1 retentativa automática (confirma que não é transitório);
  após 3 meses seguidos falhando na mesma loja, a coleta **pula um bloco de 6
  meses da loja e sonda de novo** — atravessa a zona ruim (na rede observada,
  o defeito se concentra num intervalo de meses) sem sacrificar os meses bons
  mais recentes; meses falhos/pulados ficam fora da cobertura e voltam à fila na
  noite seguinte.
- **Autofix implementado (25/09/2026)**: falhas persistem em `coleta_falhas`
  (banco local); com 2+ falhas o mês sai do plano mensal e entra na
  **recuperação dia a dia** (`lojas.mjs coletar --dia-a-dia`), que salva os
  dias bons e isola os dias defeituosos um a um. O gestor é avisado pelo
  sistema de alertas (`scripts/alertas.mjs`, `data/alertas.json`) na primeira
  conversa do dia, com oferta de texto pronto para o chamado no suporte da
  TOTVS (os GUIDs das vendas corrompidas ficam no campo `motivo`).

## 1b. Erro 20 — "Divide by zero error encountered" no servidor

- **Assinatura**: `CapaVenda/ListPorDataMovimento: 20: Divide by zero error
  encountered. The statement has been terminated.`
- **Causa**: erro de SQL no servidor da TOTVS ao montar a listagem do período
  — algum registro do mês provoca divisão por zero na consulta interna (ex.:
  quantidade ou total zerado onde o servidor calcula razão). Observado em
  25/09/2026 num mês específico de uma loja; o retry falha igual.
- **Classificação**: persistente (depende dos dados daquele período no servidor).
- **Autofix**: o mesmo do erro 30 — retentativa, pulo em blocos, registro em
  `coleta_falhas`, recuperação dia a dia e alerta ao gestor com texto para o
  chamado no suporte da TOTVS.

## 2. Janela noturna da CapaVenda (SÓ das vendas — testado)

- **Assinatura**: busca de vendas de período com **mais de 16 dias** fora de
  23h–07h → recusa explícita: `"Para requisições de vendas superiores a 16
  dias, por favor efetuar as chamadas entre 23:00:00 e 07:00:00."`
- **Regra exata (mapeada em 25/09/2026)**: fora da madrugada, é recusado
  (HTTP 403 + mensagem) **qualquer período que alcance mais de 16 dias
  atrás**, mesmo de 1 único dia — a régua é a PROFUNDIDADE, não o tamanho:
  período de 15 dias recentes passou (371 cupons), início há 17+ dias levou
  403. A recusa é sempre explícita, nunca vazio silencioso. Consequência: a
  recuperação dia a dia de vendas antigas também é exclusiva da madrugada.
- **Escopo (testado em 25/09/2026)**: a restrição é **por domínio** e vale
  apenas para as VENDAS. Bateria diurna contra períodos antigos com dado
  conhecido: fechamentos (29/29), livro-caixa (13/13), notas-venda (9/9),
  notas-entrada (1/1, 11 meses atrás) e contas-pagar responderam normalmente
  fora da madrugada — inclusive com faixas grandes num pedido só (livro-caixa
  18 meses, fechamentos 14 meses, notas-venda 12 meses; o cliente fatia por
  mês internamente respeitando o throttle). O flag `janelaNoturna` de cada
  domínio vive em `scripts/dominios.mjs` — domínio novo deve ser testado do
  mesmo jeito antes de assumir comportamento.
- **Autofix**: de dia, a coleta pula sozinha os domínios com janela noturna
  e segue nos livres; uma trava (`data/coleta.lock`) impede duas coletas
  simultâneas (furariam o limite de requisições) e a coleta diurna encerra
  às 22:45 para entregar a madrugada às vendas.
- **Risco grave**: vazio de período antigo durante o dia pode ser a restrição,
  **não** ausência de movimento.
- **Classificação**: restrição.
- **Autofix**: coletas históricas são agendadas para a janela noturna
  (`lojas.mjs coletar` avisa fora dela); no plano de coleta, mês que voltou
  vazio **fora da janela** não conta como coberto e é re-buscado.

## 2b. Erro 5 — intervalo máximo de 31 dias por chamada

- **Assinatura**: `5: Não é permitido um intervalo de datas maior que 31
  dias. Procedimento abortado.` (testado em 26/09/2026 no
  FechamentoCaixa com 14 meses num pedido).
- **Nota**: o `sincronizar.mjs` fatia períodos maiores em blocos de até 31
  dias automaticamente — o custo de ~1 operação por mês/loja/domínio é o
  piso físico da carga. O limite de REQUISIÇÕES é por endpoint (por isso a
  coleta roda um trabalhador por domínio em paralelo).
- **Classificação**: restrição. **Autofix**: fatiamento automático.

## 2c. Erro 20 — período anterior à implementação da funcionalidade

- **Assinatura**: `20: Período informado é anterior a implementação da
  funcionalidade(19/07/2022).` (Fiscal/ListNotasFiscais*, 26/09/2026).
- **Causa**: cada API tem uma data de nascimento — antes dela o dado não
  existe no servidor, nunca vai existir.
- **Classificação**: restrição (permanente por período).
- **Autofix**: a coleta marca o mês como indisponível (cobertura em
  `sync_log` com 0 registros) e nunca mais o tenta.

## 2d. Erro 11 — lista de lojas obrigatória (FechamentoCaixa, ProvisaoCartoes)

- **Assinatura**: `11: A(s) loja(s) desejada(s) não foi(ram) informada(s)
  corretamente. Procedimento abortado.` (testado em 28/09/2026 no
  FechamentoCaixa, chamada sem o campo `Lojas`).
- **Causa**: nesses dois endpoints o campo `Lojas` (int[]) é obrigatório,
  ao contrário dos domínios em que o código da loja é filtro opcional.
  Quando o gestor não preenche "Código das lojas" na página de configuração,
  a chamada sairia sem o campo e falharia sempre.
- **Classificação**: restrição (contrato do endpoint).
- **Autofix**: `lojasAlvo()` usa, nesta ordem, a lista configurada, as lojas
  do cadastro (`lojas.mjs definir|importar`) e só então a chamada sem filtro;
  nos dois domínios que exigem a lista, `exigirLojas()` interrompe antes com a
  orientação de cadastrar as lojas.
- **Nota**: a API aceita uma FAIXA de códigos numa só chamada e ignora os
  inexistentes. Isso chegou a virar uma descoberta automática de lojas, mas o
  método foi **descartado**: não se sustenta em rede de franquias (cada gestor
  enxerga só a própria loja) nem em cliente com mil lojas. Quem informa as
  lojas é o gestor.

## 3. Limite de requisições (bloqueio por excesso)

- **Assinatura**: bloqueio da API após chamadas em sequência rápida.
- **Classificação**: restrição.
- **Autofix**: throttle automático no cliente (`chef-api.mjs`): intervalo
  mínimo de 30s entre operações no horário comercial e 10s na janela noturna
  (23h–07h). Token + chamada contam como uma operação.

## 4. Timeout em período de movimento grande

- **Assinatura**: `tempo esgotado` / `TimeoutError` em meses com muitas vendas
  (a API demora para montar a resposta).
- **Classificação**: transitório/limite de tempo.
- **Autofix**: timeout de requisição em **5 minutos** (decisão de 24/09/2026)
  nos dois caminhos do cliente (POST via fetch e GET via node:http); na
  coleta, busca que falhar ganha 1 retentativa automática.

## 5. Token expirado

- **Assinatura**: autenticação recusada em chamada feita com token antigo (o
  token do `GerarToken` expira em ~2 minutos).
- **Classificação**: restrição.
- **Autofix**: o cliente gera um token novo imediatamente antes de **cada**
  chamada; nenhum token é reaproveitado.

## 6. "Object reference not set to an instance of an object"

- **Assinatura**: erro genérico do servidor, em duas situações distintas:
  1. **GET sem corpo** — o servidor só lê o objeto de requisição no CORPO da
     requisição GET (ao contrário do swagger, que documenta query string).
  2. **Módulo não habilitado/alimentado** no ambiente consultado.
- **Classificação**: persistente (de configuração).
- **Autofix**: o cliente envia GET com corpo via `node:http(s)` (o `fetch`
  proíbe body em GET); a mensagem de erro é anotada com a explicação provável
  (módulo não habilitado) para o diagnóstico.

## 7b. Erro 20 — usuário sem permissão para o MÓDULO

- **Assinatura**: `20: O usuário não possui permissão de acesso a essa
  solicitação.` em todas as chamadas de um domínio (observado no módulo
  Fiscal em 26/09/2026) — a permissão do ChefWeb é POR MÓDULO, além de por loja.
- **Classificação**: persistente (de configuração).
- **Autofix**: a coleta pula o domínio inteiro na primeira ocorrência (sem
  armar o freio global — é configuração, não queda) e registra alerta ao
  gestor orientando a liberar o módulo no ChefWeb.

## 7. Usuário sem permissão TOTAL (retorno vazio/erro por domínio ou por loja)

- **Assinatura**: domínios inteiros (financeiro, estoque, clientes) voltam
  vazios ou com erro de permissão em um grupo, enquanto vendas funciona; ou,
  por loja: `CapaVenda/ListPorDataMovimento: 20: O usuário não possui acesso
  a loja solicitada.` (observado em 25/09/2026 numa loja de uma rede cujas
  demais funcionavam — a permissão precisa ser replicada loja a loja).
- **Causa**: o usuário da API precisa de **permissão TOTAL** no ChefWeb —
  não basta liberar os relatórios —, **replicada em todas as lojas** da rede,
  uma a uma.
- **Classificação**: persistente (de configuração).
- ⚠️ **Efeito colateral grave (corrigido em 28/09/2026)**: como a busca percorre
  as lojas em ordem, a exceção de UMA loja abortava o domínio inteiro e todas
  as lojas seguintes ficavam sem dado, em silêncio. Caso real: num grupo de 36
  lojas, a loja 6 não tinha permissão e só as 5 primeiras tinham estoque — as
  outras 31 nunca foram sequer tentadas. **Autofix**: `registrarSemAcesso()` em
  `sincronizar.mjs` reconhece a assinatura, pula a loja, segue nas demais e
  registra alerta ao gestor com a lista das recusadas.
- **Autofix**: a coleta histórica pula a loja inteira já na primeira falha de
  acesso (permissão não muda no meio da execução) e orienta conceder a
  permissão no ChefWeb; o erro não conta para o freio global. Nos demais
  casos, nenhum autofix é possível pelo cliente — o diagnóstico de "veio zero
  registro" orienta conferir a permissão (ver onboarding).

## 8. Falha de conexão / HTTP fora de 2xx

- **Assinatura**: queda de rede, DNS, HTTP 5xx.
- **Classificação**: transitório.
- **Autofix**: mensagem traduzida em orientação prática; na coleta histórica,
  1 retentativa automática após a pausa do throttle. Falhas em **duas lojas
  diferentes sem nenhum sucesso** interrompem a execução (indicam problema
  geral: janela, credencial ou API fora do ar).

## 9. Relatório 41 (Listagem de Inventário): defeitos da exportação

Não são erros de API — são defeitos da tela do ChefWeb que afetam a importação
do inventário (`scripts/inventario.mjs`), usada para calcular CMV real de
períodos anteriores à instalação.

- **Exportação em CSV ignora as colunas arrastadas**: Loja, Data e
  Nº Inventário são *agrupadores* por padrão; mesmo depois de arrastados para
  a tabela e visíveis na tela, a exportação em CSV sai sem eles. Sem essas
  colunas todas as contagens do período saem misturadas, sem nada que
  identifique a qual inventário cada linha pertence.
  - **Classificação**: persistente (defeito do sistema).
  - **Autofix**: nenhum possível pelo cliente. A orientação é **exportar em
    Excel**, onde as colunas saem corretamente. O importador detecta a ausência
    e recusa o arquivo com a explicação, aceitando `--loja` e `--data` como
    saída manual para um arquivo de contagem única.

- **Produto sem nome desloca a linha inteira uma coluna** (vale para Excel
  **e** CSV): quando o produto não tem nome no cadastro, a Qtde Contada
  aparece na coluna *Produto* e a coluna *Qtde Contada* fica vazia. Numa
  amostra real, 106 de 697 linhas (21 produtos).
  - **Sintoma se não tratado**: esses itens entram no inventário com
    quantidade nula e o estoque sai subestimado — em silêncio, que é o pior
    tipo de erro. Na amostra, 832 unidades sumiriam.
  - **Autofix**: `inventario.mjs` detecta a linha (quantidade vazia + nome
    numérico) e recupera o valor, **mas só quando a aritmética confirma**
    (`contada − atual = diferença`), para não estragar um produto que
    legitimamente se chame "123". O comando informa quantas linhas corrigiu.

- **Rodapé de totais**: a última linha traz a contagem de registros na primeira
  coluna e a soma dos valores, sem produto. É descartada por não ter código de
  produto inteiro.

## 10. Codificação e espaços nos textos da API

A API devolve texto acentuado corretamente em UTF-8 — uma varredura de todas as
colunas de texto do banco (30/09/2026) **não encontrou nenhum mojibake**. Os
problemas são outros dois, e ambos produzem número errado com cara de certo:

- **Entidades HTML não decodificadas**, às vezes escapadas duas vezes:
  `MAT&#201;RIA PRIMA` convivendo com `MATÉRIA PRIMA`, `SA&AMP;#205;DAS` com
  `SAÍDAS`. O mesmo plano de contas vira dois nos agrupamentos da DRE, com o
  gasto dividido, e escapa dos filtros por categoria — R$ 70 mil ficavam de
  fora numa base real.
- **Espaço à direita** em descrições (`"TICKET "`, `"MAESTRO "`). Quebra em
  silêncio qualquer junção por igualdade de texto: 8 mil pagamentos ficavam sem
  categoria por causa de um espaço invisível.

- **Classificação**: persistente (característica da API).
- **Autofix**: `decodificarEntidades()` em `sincronizar.mjs` roda dentro de
  `campo()` — o **ponto único** por onde todo valor da API passa — decodificando
  (até três passadas, para o escape duplo) e removendo espaço das pontas.
  Tratar campo a campo deixava buracos, que foi como a descrição das contas a
  pagar e o fornecedor das notas escaparam na primeira tentativa. O
  `json_original` não passa por ali: continua sendo o retorno cru.
  `criar-banco.mjs` normaliza o que já estava gravado, em migração idempotente.

## 11. Tempo esgotado na CapaVenda (loja de movimento alto)

- **Assinatura**: `TimeoutError` / "tempo esgotado" na busca de vendas; o
  limite do cliente é de 300 s.
- **Causa**: volume. Uma loja com ~300 cupons/dia não cabe numa busca de mês
  inteiro.
- **Classificação**: persistente enquanto a busca for mensal.
- ⚠️ **Efeito colateral grave (corrigido em 30/09/2026)**: o tempo esgotado era
  classificado como falha GERAL e contava para o freio de cinco falhas
  seguidas. Numa loja movimentada, cinco meses seguidos derrubavam o domínio
  **inteiro** — inclusive das lojas que estavam funcionando.
- **Autofix**: passou a ser falha de DADOS (não arma o freio, fica registrada
  para recuperação). E a loja é marcada: depois de **dois** tempos esgotados,
  `lojas.coletar_dia_a_dia` liga e as vendas dela passam a ser buscadas um dia
  por vez — permanentemente, com aviso ao gestor. Manual:
  `lojas.mjs dia-a-dia --grupo <id> --loja <n> [--desligar]`.

## 12. Senha do ChefWeb expirada (autenticação recusada)

- **Assinatura**: `GerarToken` responde `Sucesso: false` / sem `Token`;
  nenhuma chamada do grupo passa.
- **Causa**: o ChefWeb faz as senhas de usuário **expirarem periodicamente**.
  É a causa mais comum de uma instalação que funcionava parar do nada — nada
  mudou do lado do gestor.
- **Classificação**: persistente (de configuração), mas com solução imediata.
- ⚠️ Como a rotina diária roda sozinha, sem tratamento a falha passa
  despercebida até alguém pedir um relatório e receber dado velho.
- **Autofix**: `gerarToken()` marca o erro com `autenticacao = true` e já
  devolve a saída prática na mensagem; `sincronizar.mjs` registra **alerta ao
  gestor** e interrompe o grupo (nenhum outro domínio passaria). O gestor
  resolve com `configurar.mjs senha --grupo <id>`, que abre a página local já
  na tela do grupo — a senha nunca passa pelo chat nem pela linha de comando.
- Se a senha estiver correta e o acesso continuar recusado, ver o item 7:
  o usuário precisa de **permissão total**, replicada loja a loja.
