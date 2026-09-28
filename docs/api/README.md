# Referência técnica — API do ChefWeb (ChefWebAPI)

> Documentação técnica para manutenção do projeto. O gestor não precisa ler isto.

- **Endereço base**: `https://chefweb.chef.totvs.com.br/ChefWebAPI`
  (instalações on-premise podem ter outro endereço — configurável via `CHEF_API_URL`).
- **Swagger oficial**: `https://chefweb.chef.totvs.com.br/ChefWebAPI/swagger/ui/index`
  (especificação JSON em `/swagger/docs/v1`).
- **TDN (documentação TOTVS)**: buscar por "API ChefWeb" em <https://tdn.totvs.com>
  (ex.: "Como autenticar via API ChefWeb", "API - Capa Venda",
  "API - Obter Fechamento de Caixa").

## Autenticação

`POST /api/Token/GerarToken` com body JSON:

```json
{
  "Usuario": "...",
  "Senha": "...",
  "NumeroSerialLoja": "...",
  "Chave": "..."
}
```

Resposta: `{ "Token": "...", "DataExpiracao": "...", "Sucesso": true, "Erros": [] }`

Sobre o campo **`Chave`** (validado em ambiente real): não é um segredo — é o
**modo de autenticação**, conforme a TDN ("API - Capa Venda"):
- `"SerialNumber"` → loja única (o serial informado é o da própria loja);
- `"CentralNumber"` → grupo de lojas (o serial informado é o da **loja central**).

⚠️ Pegadinha: com o modo errado o `GerarToken` **ainda gera token** e as rotas de
vendas funcionam, mas os módulos que derivam o serial do token (Fiscal, Estado…)
falham com "O token não retornou um número de série válido". A página de
configuração descobre o modo certo validando cada um com `POST /api/Estado/ObterEstados`
e grava em `CHEF_CHAVE_INTEGRACAO`.

⚠️ **O token expira em ~2 minutos.** Estratégia deste projeto: gerar um token novo
imediatamente antes de cada chamada (ver `scripts/chef-api.mjs`). Não há refresh.

## Convenções (validadas contra o servidor real)

- **POST**: token vai no body JSON, campo `Token`.
- **GET**: ⚠️ **o swagger mente** — ele documenta query string (`requisicao.*`),
  mas o servidor só lê o objeto de requisição no **CORPO da requisição GET**
  (JSON, mesmos nomes PascalCase do POST: `Token`, `CodigoLoja`, `DataInicial`…).
  Sem corpo, todos os GET devolvem `"Object reference not set to an instance of
  an object"`. O `fetch()` proíbe body em GET — o projeto usa `node:http(s)`
  direto (ver `chamarGet` em `scripts/chef-api.mjs`). `page`/`pageSize`
  (paginação do Fiscal) vão na query string normalmente.
- Datas em ISO 8601: `2026-09-22T00:00:00`. `"0001-01-01T00:00:00"` significa
  "sem data" (ex.: conta ainda não paga).
- Resposta padrão: `{ Sucesso: bool, Erros: [{ CodigoErro, DescricaoErro }], ...dados }`.
  `Sucesso: false` pode vir com HTTP 200 — sempre checar o campo. As rotas
  paginadas do Fiscal respondem em **inglês**: `{ Success, Errors, Data,
  Page, PageSize, TotalRecords, TotalPages, HasNextPage }`.
- Os endpoints do Fiscal rejeitam intervalos de data muito longos ("Intervalo de
  data maior que o permitido") — use blocos de até ~31 dias. Atenção: essa
  validação roda ANTES da validação do token. A CapaVenda também limita a 31
  dias por chamada (HTTP 403).
- **Janela noturna da CapaVenda** (regra confirmada pela mensagem do servidor):
  *"Para requisições de vendas superiores a 16 dias, por favor efetuar as
  chamadas entre 23:00:00 e 07:00:00."* Vale pela **idade** do período pedido,
  não pela largura: um intervalo de 5 dias em janeiro é recusado fora da janela
  do mesmo jeito que um mês inteiro. A recusa vem como **HTTP 403** com essa
  mensagem. `sincronizar.mjs` avisa antes de tentar e alerta se vier vazio.
- **Cota diária na listagem completa de produtos** (descoberto em testes): a
  rota `/api/produto/listarProdutos` com `Completa: true` responde
  *"A consulta completa não pode ser realizada pois já atingiu a quantidade
  máxima liberada para o dia!"* depois de algumas chamadas no mesmo dia.
  Sincronize o catálogo **no máximo uma vez por dia** (ele muda pouco); se
  precisar repetir, aguarde o dia seguinte.
- **Rate limit com bloqueio**: a API limita requisições em sequência e pode
  BLOQUEAR o acesso. Intervalo mínimo entre operações: **30s no horário
  comercial** e **10s na janela noturna (23h–07h)** (o par GerarToken + chamada conta
  como uma operação). O throttle é automático em `chef-api.mjs`
  (`respeitarLimite()`), com aviso "⏳ aguardando Ns..." no console.

## Endpoints de leitura usados pelo projeto

| Domínio (sincronizador) | Endpoint | Método | Parâmetros principais |
|---|---|---|---|
| vendas | `/api/CapaVenda/ListPorDataMovimento` | POST | `CodigoLoja` (int64), `DataMovimentoInicial`, `DataMovimentoFinal`, `Composicoes` (bool) |
| fechamentos | `/api/FechamentoCaixa/ObterFechamentoCaixa` | POST | `Lojas` (int[]), `DataInicial`, `DataFinal` |
| sangrias | `/api/sangria/Listar` | POST | `CodigoLoja`, `DataInicial`, `DataFinal` |
| provisao | `/api/ProvisaoCartoes/ObterProvisaoCartoes` | POST | `Lojas` (int[]), `DataInicial`, `DataFinal` |
| contas-pagar | `/api/Financeiro/ListContasPagar` | GET | `requisicao.codigoLoja`, `requisicao.dataInicial`, `requisicao.dataFinal` |
| livro-caixa | `/api/Financeiro/ListLivroCaixa` | GET | idem |
| notas-venda | `/api/Fiscal/ListNotasFiscaisVenda` | GET | idem + `page`, `pageSize` (**paginado**; resposta traz `hasNextPage`) |
| notas-entrada | `/api/Fiscal/ListNotasFiscaisEntrada` | GET | idem + `requisicao.tipoData` (0/1) |
| produtos | `/api/produto/listarProdutos` | GET | `request.codigoLoja`, `request.completa` (prefixo `request.`!) |
| estoque | `/api/Estoque/ListarEstoque` | GET | `requisicao.codigoLoja`, `requisicao.completa`, `requisicao.produtos` (multi) |
| clientes | `/api/CadastroCliente/Listar` | GET | `requisicao.codigoLoja` (OBRIGATÓRIO — sem ele: erro 20 de acesso), `requisicao.completa`. **Sem filtro de data** (DataInicial/DataFinal/DataAtualizacao são ignorados — testado em 28/09/2026): é sempre fotografia completa. O cadastro é ~99% central (uma loja devolve quase tudo; fichas residuais variam por loja) — por isso a varredura semanal por loja. |
| — | `/api/ConferenciaVendas/ListConferenciaVenda` | GET | `requisicao.codigoLoja`, datas (disponível, ainda não sincronizado) |

Outras variantes de vendas existem (`/api/CapaVenda/ListPorNumeroFechamento`,
`ListPorDataIntegracaoChefweb`, `/api/Vendas/ObterVendasNFCe|SAT|ECF` e
canceladas) — úteis para integrações; este projeto usa `ListPorDataMovimento`
por ser a visão gerencial por dia de movimento.

## Estrutura da resposta de CapaVenda (resumo)

`{ Vendas: [CapaVenda], NotasInutilizadas: [], NotasCanceladas: [], Sucesso, Erros }`

CapaVenda: `ChaveVenda`, `DataMovimento`, `DataRecebimento`, `NumeroCupom`,
`NumeroNota`, `ModeloFiscal` (1-5), `StatusVenda` (1-3), `QuantidadePessoas`,
`Loja{Codigo,Nome,CNPJ}`, `Cliente{Codigo,Nome,Documento,...}`,
`Caixa{Data,Numero,NumeroFechamento,Operador}`, `DadosCancelamento{Data,Motivo,...}`,
`Itens[]{Status(1 ativo/2 cancelado), Produto{Codigo,Nome,Grupo,SubGrupo,...},
Quantidade, ValorUnitario, ValorDesconto, ValorTotal, PrecoCompra, impostos...}`,
`Pagamentos[]{TipoFormaPagamento(1-8), Descricao, ValorRecebido, ValorEfetivo,
FormaPagamentoCartao{TipoTransacao, DadosTEF{DescricaoBandeira,...}}}`,
`TotalizadorVenda{ValorSubTotal, ValorTotalDescontoFiscal, ValorTotalDescontoSistema,
ValorTotalAcrescimo, ValorTotalServico, ValorTotalTaxaEntrega, ValorTotal, ...}`,
`Descontos[]`, `ItemCancelado[]`, `Comissoes[]`.

## Estrutura da resposta de FechamentoCaixa (resumo)

`{ Fechamentos: [...], Sucesso, Erros }` — cada fechamento:
`IdFechamento`, `IdLoja`, `DescricaoLoja`, `Caixa`, `NrFechamentoBordero`,
`DataAbertura`, `DataFechamento`, `DataCaixa`, `OperadorCaixa`,
`ValorTotalSistema`, `ValorTotalRecebido`, `ValorTotalBordero`,
`ValorTotalDinheiro`, `ValorTotalCheque`, `ValorDiferencaDinheiroRecebido`, ...,
`Itens[]{IdFormaPagamento, DescricaoFormaPagamento, ValorBordero, ValorSistema,
ValorRecebido, Observacao}`.

## Endpoints de escrita (FORA DO ESCOPO — nunca usar)

A API também expõe rotas que alteram dados (`produto/salvar*`,
`CadastroCliente/Gravar*`, `Fornecedor/Salvar`, `*/AtualizarProcessamento`,
`RegraFiscal/EnviarRegrasEmLote`, etc.). **Este projeto é somente leitura** — as
instruções do agente (CLAUDE.md/AGENTS.md) proíbem seu uso. Atenção especial a
`AtualizarProcessamento`: marca registros como processados no ChefWeb e afeta
outras integrações.

## Payloads reais validados (ambiente de homologação, set/2026)

- **Contas a pagar** (`ContasPagar[]`): `NumeroControle`, `Credor`, `Valor`,
  `PlanoContas1/2`, `Pago` (bool), `DataPagamento`, `ValorPagamento`,
  `DataVencimento`, `DataEmissao`, `DataCompetencia`, `Loja`, `Operador`.
  O filtro de datas da consulta é por **emissão/competência**, não vencimento.
- **Livro caixa** (`LivroCaixa[]`): `Controle`, `DataEmissao`, `DataLancamento`,
  `Entrada`/`Saida` (valores separados), `NomeConta`, `Historico1..3`,
  `PlanoContas1/2`, `Loja`, `Compensado`, `Extorno`.
- **Produtos** (`Dados[]`): `CodigoProduto`, `DescricaoProduto`, `UnidadeVenda`,
  `UnidadeCompra`, `Grupo`, `SubGrupo`, `PrecoVenda`, `PrecoCompra`,
  `ProdutoComposto`, `Composicoes[]`, `Adicionais[]`.
- **Estoque** (em inglês!): `skuId`, `lotId`, `quantity`, `locationId`,
  `stockType`, `updatedAt`, `unit`. Nome do produto via join com produtos.
- **Clientes** (`Cliente[]`): `Codigo`, `Nome`, `CPF`/`CNPJ`, `Email`, `DDD` +
  `Telefone`, endereço completo.
- **Notas fiscais de venda** (`Data[]`, paginado): `DataEmissao`, `ChaveSefaz`,
  `NumeroCaixa`, `SerieNota`, `NumeroNota`, `ValorNota`, `CodigoLoja`, `XML`
  (NF-e completa).
- **Notas fiscais de entrada**: `NumeroNota`, `Serie`, `ChaveDeAcesso`,
  `DtLancamento` (emissão), `DtEntrada`, `XMLNota` — fornecedor e valor total só
  existem dentro do XML (`<emit><xNome>` e `<vNF>`).
- **Provisão de cartões**: `IdLoja`, `DataMovimento`, `DataVencimento`,
  `NrControle`, `ValorTotal`, `ValorLiquido`, `TaxaPercentual`, `ValorTaxa`,
  `IdFormaPagamento`, `DescricaoFormaPagamento`, `NomeOperador`.

## Legendas dos campos enumerados (TDN "API - Capa Venda")

Colhidas do Dicionário de Retorno oficial:

- **ModeloFiscal**: 1=SAT, 2=NFCe, 3=BNF, 4=ECF, 5=NFe.
- **ModuloVenda**: 1=PDV, 2=PED, 3=Recebimento automático, 4=Contingência,
  5=Emissor de NFe, 6=Pedido de Venda, 7=Comanda Mobile, 8=ATM (autoatendimento).
- **StatusVenda**: 1=Aberto, 2=Finalizado, 3=Cancelado, 4=Erro.
- **StatusItemVenda**: 1=Finalizado, 2=Cancelado.
- **StatusNotaNFCe**: 1=Emissão normal autorizada, 2=Contingência pendente,
  3=Contingência autorizada, 4=Contingência rejeitada.
- **TipoPessoa**: 0=Não informado, 1=Física, 2=Jurídica.
- **TipoFormaPagamento**: 1=Dinheiro, 2=Cheque, 3=Cartão, 4=Ticket,
  5=Contra vale, 6=Assinada, 7=Cortesia, 8=Boleto.
- **TipoCartao** (texto): DÉBITO, CRÉDITO, VOUCHER, PIX — classifique SEMPRE
  pelo texto: o código numérico veio invertido nos dados reais.
- **TipoTransacao**: 1=TEF, 2=POS.
- **TelaVenda** (setor da venda — NÃO consta no dicionário oficial; tabela
  fixa do sistema, confirmada pela MHI): 1=Mesa, 2=Cartão, 3=Entrega,
  4=Balcão, 5=Balcão, 6=Mesa, 7=Cartão, A=Autopesagem, 21=NFe (emissor de
  nota avulsa). Códigos diferentes = mesma finalidade em telas distintas do
  PDV; agrupe sempre pelo setor. O valor pode ser LETRA ("A") — campo texto.

## Observações de implementação

- Payloads reais podem variar por versão do ChefWeb; os sincronizadores gravam o
  registro bruto em `json_original` para permitir remapeamento sem nova coleta.
- Períodos longos: a API pode demorar; o projeto usa timeout de 120 s e recomenda
  sincronizar em blocos de até 31 dias.
- `Sucesso: false` com `Erros` de credencial → orientar reconfiguração
  (skill `configurar`).
