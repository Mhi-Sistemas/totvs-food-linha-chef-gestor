# Banco de dados local (`data/chef.db`)

Banco SQLite criado por `scripts/criar-banco.mjs` e alimentado por
`scripts/sincronizar.mjs`. Todas as datas-dia estão como `AAAA-MM-DD`;
datas com hora como `AAAA-MM-DDTHH:MM:SS`.

> ⚠️ **Todas as tabelas de dados têm a coluna `conexao`** — o grupo de lojas
> (diretório site) de onde o registro veio. `produtos`, `clientes` e
> `fechamentos_caixa` usam chave composta `(conexao, codigo)`, porque os códigos
> do ChefWeb se repetem entre grupos. Veja a seção 0 do dicionário.
>
> ⚠️ Este arquivo descreve o schema físico. **Qual campo usar em cada cálculo**
> (e as pegadinhas entre campos parecidos) está em
> [dicionario-de-dados.md](dicionario-de-dados.md) — consulte-o antes de
> escrever consultas.

Convenção: tabelas de payload ainda não 100% mapeado guardam o registro completo
da API na coluna `json_original` — use `json_extract(json_original, '$.Campo')`
quando uma coluna estiver NULL.

## Vendas

### `vendas` — um registro por cupom/nota (capa)
| Coluna | Significado |
|---|---|
| `chave_venda` (PK) | Identificador único da venda no ChefWeb |
| `codigo_loja`, `nome_loja` | Loja |
| `data_movimento` | Dia do movimento (dia "comercial") |
| `data_hora` | Data/hora de recebimento da venda |
| `numero_cupom`, `numero_nota`, `modelo_fiscal` | Identificação fiscal (modelo 1..5: NFCe/SAT/ECF...) |
| `status_venda` | Situação (1..3, conforme ChefWeb) |
| `cancelada` | **1 = cancelada. Filtre `cancelada = 0` em análises!** |
| `data_cancelamento`, `motivo_cancelamento`, `operador_cancelamento` | Detalhe do cancelamento: quando, por quê e quem cancelou |
| `quantidade_pessoas` | Pessoas na mesa (quando registrado) |
| `cliente_codigo`, `cliente_nome`, `cliente_documento` | Cliente identificado (quando houver) |
| `numero_fechamento`, `numero_caixa` | Vínculo com o caixa |
| `operador_caixa` | Quem fechou a conta/recebeu o pagamento (≠ garçom que lançou os itens — esse é `venda_itens.atendente`) |
| `valor_subtotal` | Soma dos itens antes de descontos/acréscimos |
| `valor_desconto` | Descontos (fiscal + sistema) |
| `valor_acrescimo`, `valor_servico`, `valor_taxa_entrega` | Acréscimos, taxa de serviço, entrega |
| `valor_total` | **Valor final da venda (use este para faturamento)** |

### `venda_itens` — itens de cada venda
`chave_venda` (FK), `status` (**1 = ativo**, 2 = cancelado), `codigo_produto`,
`nome_produto`, `unidade`, `codigo_grupo`, `grupo`, `codigo_subgrupo`, `subgrupo`,
`quantidade`, `valor_unitario`, `valor_desconto`, `valor_acrescimo`,
`valor_total`, `preco_compra` (custo, quando informado), `atendente`.

### `venda_item_composicoes` — ficha técnica consumida em cada item vendido
`venda_item_id` (FK → `venda_itens.id`), `chave_venda`, `codigo_produto`
(produto composto pai), `codigo_insumo`, `nome_insumo`, `quantidade_insumo`
(por unidade vendida do pai — multiplique por `venda_itens.quantidade` para o
consumo total), `unidade`. Só produtos compostos geram linhas aqui.

### `venda_descontos` — auditoria de descontos
`chave_venda` (FK), `codigo_operador`, `operador` (quem concedeu), `motivo`.

### `venda_itens_cancelados` — auditoria de itens cancelados
`chave_venda` (FK), `data_hora`, `nome_produto`, `operador_lancamento` (quem
lançou), `operador_cancelamento` (quem cancelou), `motivo`.

### `venda_pagamentos` — pagamentos de cada venda
`chave_venda` (FK), `tipo_forma_pagamento` (1..8 conforme ChefWeb), `descricao`
(ex.: "Dinheiro", "Crédito Visa"), `valor_recebido`, `valor_efetivo` (líquido de
troco — **use este para somar recebimentos**), `tipo_transacao_cartao`
(1=crédito, 2=débito), `tipo_cartao`, `bandeira`.

## Caixa

### `fechamentos_caixa`
`id_fechamento` (PK), `codigo_loja`, `nome_loja`, `numero_caixa`,
`numero_bordero`, `data_caixa`, `data_abertura`, `data_fechamento`,
`operador_caixa`, `valor_total_sistema` (o que o sistema apurou),
`valor_total_recebido` (o que foi conferido), `valor_total_bordero`,
`valor_total_dinheiro`, `valor_total_cheque`, `valor_diferenca_dinheiro`
(sobra/falta), `json_original`.

### `fechamento_itens` — valores por forma de pagamento no fechamento
`id_fechamento` (FK), `id_forma_pagamento`, `descricao_forma_pagamento`,
`valor_bordero`, `valor_sistema`, `valor_recebido`, `observacao`.

### `sangrias`
`codigo_loja`, `data`, `valor`, `operador`, `motivo`, `json_original`.

## Financeiro

### `contas_pagar`
`codigo_loja`, `fornecedor` (credor), `descricao` (plano de contas nível 1 /
nível 2), `data_emissao`, `data_vencimento`, `data_pagamento` (**NULL = em
aberto**), `valor`, `valor_pago`, `json_original`.

### `livro_caixa`
`codigo_loja`, `data`, `descricao` (histórico), `natureza` (plano de contas),
`tipo` ('entrada'/'saida'), `valor` (sempre positivo; o sinal está em `tipo`),
`conta` (conta financeira, ex.: banco), `json_original`.

### `provisao_cartoes` — recebíveis de cartão
`codigo_loja`, `data_venda`, `data_deposito` (quando o dinheiro cai),
`bandeira`, `valor_bruto`, `valor_taxa`, `valor_liquido`, `json_original`.

## Fiscal

### `notas_fiscais`
`tipo` ('venda' | 'entrada'), `codigo_loja`, `numero_nota`, `serie`, `data`,
`fornecedor_ou_cliente`, `valor_total`, `json_original`.

## Cadastros e estoque

### `produtos` — catálogo
`codigo` (PK), `nome`, `unidade`, `codigo_grupo`, `grupo`, `codigo_subgrupo`,
`subgrupo`, `preco_venda`, `preco_compra` (custo, base para CMV), `ativo`,
`json_original`.

### `estoque_posicoes` — fotografias do estoque
`data_leitura` (dia em que a posição foi capturada), `codigo_loja`,
`codigo_produto`, `nome_produto` (frequentemente NULL — a API de estoque não
traz o nome; **faça join com `produtos`** por `codigo_produto`), `unidade`,
`quantidade`, `custo` (NULL nesta API; use `produtos.preco_compra`),
`json_original`. Posição atual = `data_leitura = (SELECT MAX(data_leitura) ...)`.

### `clientes`
`codigo` (PK), `nome`, `tipo_pessoa`, `documento`, `email`, `telefone`,
`data_nascimento`, `json_original`.

## Controle

### `lojas` — cadastro das lojas com a janela de coleta
`conexao` + `codigo_loja` (PK), `id_loja`, `serial`, `nome`, `data_inicio`
(início de operação), `ultima_venda`, `loja_parada` (1 = encerrada),
`data_loja_parada`, `ultima_coleta`, `coletar_base_historica`,
`data_coleta_concluida` e `inicio_coleta`. Duas origens: `lojas.mjs definir`
(o gestor informa o número da loja e a data) e `lojas.mjs importar` (o controle
de coleta do ChefWeb exportado, atalho de quem opera a revenda). Não há rota
pública que liste as lojas de um grupo — **quem informa é sempre o gestor**.

**Duas datas, não confundir**: `data_inicio` é quando a loja começou a operar
(fato, vem do TSV); `inicio_coleta` é **a partir de quando o gestor quer os
dados** (escolha dele — é comum querer só os últimos anos). O plano de carga
usa `COALESCE(inicio_coleta, data_inicio)`, e **loja sem nenhuma das duas fica
fora do plano**.
**Essa data até `ultima_venda` é a única faixa
em que vale buscar vendas daquela loja** — fora dela não há movimento.
Gerido por `scripts/lojas.mjs`.

### `sync_log` — o que já foi sincronizado
`dominio`, `codigo_loja`, `periodo_inicio`, `periodo_fim`, `registros`,
`executado_em`. Consulte antes de analisar para saber se o período pedido já
está no banco.

## Desempenho e escala (bancos de 10 GB+)

O projeto e dimensionado para bancos grandes (meta: 10 GB+ sem degradar):

- **Indices**: toda consulta quente tem indice com prefixo `conexao`
  (multi-grupo): vendas/notas/livro/sangrias por (conexao, loja, data),
  joins por (conexao, chave_venda), sync_log e coleta_falhas pelos filtros
  de controle. Novos dominios DEVEM nascer com seus indices no schema.
- **Estatisticas**: `ANALYZE` inicial no primeiro uso apos a carga e
  `PRAGMA optimize` ao fim de toda rotina diaria e coleta — o planejador
  nunca fica cego com o banco crescendo.
- **Conexao** (`abrirBanco`): WAL + busy_timeout 60s, cache de ~64 MB,
  mmap de 256 MB e `synchronous=NORMAL` na escrita.
- **Visoes com as regras de ouro**: `vendas_validas` (sem canceladas) e
  `itens_validos` (status ativo, sem as taxas 997/999) — prefira-as nas
  consultas de analise; alem de seguras, mantem os filtros indexaveis.
