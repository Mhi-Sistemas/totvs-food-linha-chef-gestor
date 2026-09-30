---
name: sincronizar
description: Baixa/atualiza os dados da loja (vendas, caixa, financeiro, estoque, produtos) do TOTVS Food Linha Chef para o banco local. Use quando o gestor pedir para "atualizar os dados", "baixar as vendas", "puxar as informações", ou antes de qualquer análise cujo período ainda não foi baixado.
---

# Sincronizar dados da loja

Objetivo: garantir que o banco local (`data/chef.db`) tenha os dados do período que
o gestor quer analisar.

## Comando

```
node --no-warnings scripts/sincronizar.mjs --dominio <dominio> --de AAAA-MM-DD --ate AAAA-MM-DD
```

Domínios com período: `vendas`, `fechamentos`, `sangrias`, `provisao` (cartões a
receber), `contas-pagar`, `livro-caixa`, `notas-venda`, `notas-entrada`.
Domínios sem período (sempre trazem a foto atual): `produtos`, `estoque`, `clientes`.
`--dominio tudo` roda todos. Repetir um período **não duplica** dados.

**Vários grupos de lojas**: por padrão o comando sincroniza **todos** os grupos
configurados, um após o outro (o cabeçalho `=== Nome do grupo ===` separa a
saída). Use `--grupo <id>` para sincronizar um só. Cada registro é gravado com
o grupo a que pertence, então os dados nunca se misturam.

## Atalho: "atualiza meus dados" / "deixa tudo em dia"

Para o pedido genérico de atualização, **não monte comandos soltos** — rode a
rotina pronta, que calcula sozinha o que falta em cada grupo (do último dia
baixado até D-1), tira a fotografia do dia do estoque, atualiza o catálogo às
segundas e termina guardando a cópia de segurança:

```
node --no-warnings scripts/rotina.mjs executar
```

`executar --simular` mostra o plano sem baixar nada (bom para estimar o tempo
para o gestor). Se a rotina agendada estiver ativa (`rotina.mjs status`), o dia
a dia já se atualiza sozinho às 06:30 — o histórico de execuções fica em
`data/rotina-diaria.log`, primeiro lugar para olhar quando "os dados não
atualizaram". Os passos abaixo são para períodos específicos, domínios avulsos
e cargas históricas.

## Passo a passo

1. **Descubra o que já foi baixado** antes de decidir o que buscar:
   ```
   node --no-warnings scripts/consultar.mjs "SELECT conexao, dominio, MIN(periodo_inicio) AS de, MAX(periodo_fim) AS ate, MAX(executado_em) AS ultima_vez FROM sync_log GROUP BY conexao, dominio"
   ```
   Confira também o cadastro de lojas do grupo (`lojas.mjs listar --grupo <id>`):
   sem ele **nenhuma carga histórica acontece**, por mais que as credenciais
   estejam certas. Grupo sem lojas ou com "DATA A INFORMAR" → vá para a seção
   "🏪 Carga histórica" antes de qualquer outra coisa.
   Se o gestor **acabou de cadastrar um grupo novo**, ele não tem nada baixado:
   rode `carga-inicial.mjs --grupo <id>` para trazer o período recente na hora
   e depois trate o histórico pela seção "🏪 Carga histórica".

2. **Decida o período.** Se o gestor não disse, pergunte-se o que ele vai analisar:
   para "atualizar os dados" genérico, baixe do último dia sincronizado até
   **ontem (D-1)** — os dados só chegam à API após o fechamento de caixa do PDV,
   então o dia corrente vem vazio ou parcial. (Primeira vez: últimos 30 dias,
   também até D-1.)

3. **Avise em linguagem simples e ajuste a expectativa de tempo**: a TOTVS
   limita a velocidade das buscas (o script aguarda sozinho **30s entre
   buscas de dia, 10s à noite** — as mensagens "⏳ aguardando..." são normais).
   Estime para o gestor: cada mês de vendas de cada loja é uma busca; ex.:
   6 meses × 2 lojas ≈ 12 buscas ≈ 6 min de dia, 2 min à noite. Para cargas
   grandes, diga algo como "vou buscando aos poucos, o sistema da TOTVS pede
   um ritmo mais calmo — te aviso quando terminar".

4. **Execute por domínio.** Para o uso típico (análise de vendas), basta:
   - `vendas` (traz cupons, itens e pagamentos)
   - `fechamentos` (conferência de caixa)
   Sincronize os demais domínios apenas quando a análise pedir (financeiro,
   estoque etc.). Períodos longos podem ser passados de uma vez: o script quebra
   automaticamente em blocos de 31 dias (limite da API) — apenas avise o gestor
   que períodos grandes demoram mais.

4b. **Catálogo de produtos e estoque: no máximo 1× por dia cada.** A TOTVS
   limita as consultas completas de `produtos` **e de `estoque`** a uma por dia
   — se insistir, recusa com "quantidade máxima liberada para o dia" (erro 20,
   confirmado nos dois domínios). Antes de sincronizar qualquer um deles,
   confira no `sync_log` se já houve busca hoje. Se a recusa aparecer, explique
   ao gestor que o sistema da TOTVS limita essa busca a uma vez por dia e que
   os dados que já estão no computador continuam valendo (a rotina diária já
   cuida disso sozinha, na hora certa).

5. **Confira e reporte**: o script imprime quantos registros vieram. Traduza:
   "pronto! Atualizei suas vendas: 1.234 cupons de 01/09 a 22/09". Se vier zero
   registro num período em que a loja funcionou, desconfie — causas comuns:
   - o **usuário do ChefWeb não tem permissão total** (replicada em todas as lojas)
     (e, em redes, a permissão precisa estar **replicada em todas as lojas**) —
     peça ao gestor para ajustar com quem administra o ChefWeb;
   - código da loja errado no cadastro do assistente;
   - o movimento daquela loja não é integrado ao ChefWeb.

## 🏪 Carga histórica: o cadastro de lojas é que dirige a coleta

**Vale para qualquer gestor, de uma loja ou de trinta** — não é recurso de rede
grande. Cada loja custa **uma busca por mês**: sem saber quais lojas existem e
a partir de quando buscar, ou não se busca nada, ou se varrem anos vazios
(27 lojas × 4 anos = centenas de buscas desperdiçadas).

O período recente **não depende disto** — ele já veio na carga inicial
(`carga-inicial.mjs`) e a rotina diária o mantém em dia. Esta seção é só o
histórico.

```
node --no-warnings scripts/lojas.mjs definir --grupo <id> --loja <n> --inicio AAAA-MM-DD
node --no-warnings scripts/lojas.mjs listar --grupo <id>
node --no-warnings scripts/lojas.mjs plano --grupo <id> --noite
node --no-warnings scripts/lojas.mjs coletar --grupo <id>
```

- **Quem informa as lojas é o gestor.** Não existe consulta que liste as lojas
  de um grupo, e não tente adivinhar: em rede de franquias cada gestor é dono
  de uma só, e há clientes com centenas de lojas.
- `definir` grava as duas respostas dele: o **número** da loja e **a partir de
  qual data** ele quer os dados. Essa data é uma **escolha** — muita gente quer
  só os últimos dois anos, não o histórico inteiro; ofereça as duas opções,
  porque menos período significa ficar pronto mais rápido. Loja fechada:
  `--ultima-venda AAAA-MM-DD --parada`. **Sem data a loja fica fora do plano** —
  `listar` marca essas lojas com "DATA A INFORMAR".
- `importar --arquivo <tsv>` é o atalho de quem opera a revenda: o controle de
  coleta do ChefWeb exportado traz tudo de uma vez, inclusive lojas paradas.
  Numa rede grande, pergunte se existe uma relação pronta antes de listar loja
  a loja na conversa.
- `plano` mostra, loja a loja, só os meses que existem e ainda não estão no
  computador, com a estimativa de tempo. Apresente esse número ao gestor antes
  de começar ("são X buscas, cerca de Y minutos").
- `coletar` executa o plano, é **retomável** (pula o que já foi baixado) e
  respeita a pausa entre buscas. Para vendas, tem de rodar entre 23h e 7h —
  então **agende** (veja abaixo), não peça ao gestor para rodar de madrugada.
- Loja cuja data de início é posterior à última venda fica de fora e é
  reportada — avise o gestor, porque indica inconsistência no cadastro dele.
- `progresso --grupo <id> --abrir` é o que você mostra quando ele perguntar
  "como está a carga?".

## ⏳ Agende a coleta noturna (não peça ao gestor para rodar)

Cargas históricas dependem da janela 23h–07h e levam horas. O assistente
**agenda** a execução:

1. **Primeira opção — o agendador do ambiente** em que você está rodando
   (Claude Code, Codex, Orca, Paseo…). É o caminho preferido: integrado à
   ferramenta que o gestor já usa e permite reportar o resultado depois.
2. **Segunda opção — o agendador do sistema operacional**:
   ```
   node --no-warnings scripts/agendar.mjs criar --nome coleta-<grupo> --hora 23:10      --comando "lojas.mjs coletar --grupo <grupo>"
   node --no-warnings scripts/agendar.mjs listar
   node --no-warnings scripts/agendar.mjs cancelar --nome coleta-<grupo>
   ```
   Funciona no Windows (Agendador de Tarefas) e no macOS/Linux (cron), e grava
   o andamento em `data/<nome>.log`.

**Sempre avise o gestor**, em linguagem simples: a que horas vai rodar, quanto
deve levar e que **o computador precisa ficar ligado e sem suspensão** nesse
período. Como a coleta é retomável, se o computador dormir ela continua na
próxima execução.

## 📅 Backfill histórico: pergunte a data de início POR LOJA

Antes de qualquer carga histórica, **pergunte ao gestor a partir de qual data
buscar, loja por loja**. Deixe claro que é uma escolha dele: *"posso trazer
desde o início das vendas ou só os últimos anos — quanto de histórico você
usa de verdade?"* Se ele quiser desde o começo, a data da primeira venda está
no ChefWeb. Motivos: evita varrer anos vazios (cada mês vazio ainda custa
chamadas) e respeita o que ele realmente vai analisar.

- Grave cada resposta com `lojas.mjs definir` (seção acima) — é o **único**
  lugar que dirige a coleta, e serve para não perguntar de novo nunca mais.
- Daí em diante o plano sai pronto: `lojas.mjs plano` e `coletar` já buscam
  cada loja a partir da data dela.
- Combine com a janela noturna abaixo: o backfill em si deve rodar entre
  23h e 07h.

## ⏰ Janela noturna para histórico de vendas (regra da API)

A API de vendas (CapaVenda) só libera **dados com mais de 16 dias** entre
**23h e 07h** — é a regra da própria TOTVS ("Para requisições de vendas
superiores a 16 dias, efetuar as chamadas entre 23:00 e 07:00"). Vale pela
**idade** do período: até um intervalo curto, se for antigo, é recusado fora da
janela. O script avisa antes de tentar.

- Período recente (últimos 16 dias): pode sincronizar a qualquer hora.
- Período antigo durante o dia: avise o gestor em linguagem simples — "o
  sistema da TOTVS só libera dados antigos à noite (entre 23h e 7h); posso
  buscar os últimos 16 dias agora e o restante fica para a madrugada, pode ser?"
- **NUNCA conclua "não houve vendas"** a partir de retorno vazio de período
  antigo fora da janela — é quase certamente a restrição de horário.
- Backfill histórico grande: combine com o gestor para rodar **de madrugada**
  (a janela noturna também é 3× mais rápida: 10s entre buscas em vez de 30s).
- Os demais domínios (financeiro, estoque, produtos...) não têm essa restrição
  conhecida.

## Erros comuns

- **Credencial recusada** → "o sistema da TOTVS recusou o acesso; vamos conferir
  suas credenciais?" (siga a skill `configurar`).
- **Falha de conexão** → internet ou instabilidade da TOTVS; sugira tentar de novo
  em alguns minutos.
- **Timeout em período longo** → quebre em períodos menores (semana a semana).
- **"as lojas não foram informadas corretamente"** (erro 11, em fechamentos e
  cartões a receber) → esses dois exigem saber de quais lojas buscar. Rode
  cadastre as lojas (`lojas.mjs definir`) ou preencha "Código das lojas" na
  página de configuração, e repita.
- **"intervalo de datas maior que 31 dias"** (erro 5) → limite da própria
  TOTVS; o sincronizador já quebra em blocos, então isso só aparece em chamada
  montada à mão.
