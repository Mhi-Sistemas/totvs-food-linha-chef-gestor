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

## 7. Usuário sem permissão de relatórios (retorno vazio/erro por domínio ou por loja)

- **Assinatura**: domínios inteiros (financeiro, estoque, clientes) voltam
  vazios ou com erro de permissão em um grupo, enquanto vendas funciona; ou,
  por loja: `CapaVenda/ListPorDataMovimento: 20: O usuário não possui acesso
  a loja solicitada.` (observado em 25/09/2026 numa loja de uma rede cujas
  demais funcionavam — a permissão precisa ser replicada loja a loja).
- **Causa**: o usuário da API precisa de **permissão de acesso total aos
  relatórios** no ChefWeb, **replicada em todas as lojas** da rede.
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
