// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Cria (ou atualiza) o banco local data/chef.db com o schema do assistente.
// Idempotente: pode rodar quantas vezes quiser sem perder dados.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CAMINHO_BANCO = join(RAIZ, 'data', 'chef.db');

export function abrirBanco({ somenteLeitura = false } = {}) {
  mkdirSync(join(RAIZ, 'data'), { recursive: true });
  const db = new DatabaseSync(CAMINHO_BANCO, { readOnly: somenteLeitura });
  // Dois processos podem usar o banco ao mesmo tempo (ex.: rotina diaria das
  // 06:30 durante uma coleta historica). Sem busy_timeout, o segundo escritor
  // falha na hora com "database is locked"; com ele, espera a vez.
  db.exec('PRAGMA busy_timeout = 60000;');
  // Escala (bancos de 10 GB+): cache de paginas generoso e mmap para
  // leituras grandes; com WAL, synchronous NORMAL e seguro e bem mais
  // rapido nas cargas.
  db.exec('PRAGMA cache_size = -64000;'); // ~64 MB
  db.exec('PRAGMA mmap_size = 268435456;'); // 256 MB
  if (!somenteLeitura) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  return db;
}

const SCHEMA = `
-- Vendas (capa): um registro por cupom/nota
CREATE TABLE IF NOT EXISTS vendas (
  chave_venda TEXT PRIMARY KEY,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site)

  codigo_loja INTEGER,
  nome_loja TEXT,
  data_movimento TEXT,          -- dia do movimento (AAAA-MM-DD)
  data_hora TEXT,               -- data/hora completa do recebimento
  numero_cupom INTEGER,
  numero_nota INTEGER,
  modelo_fiscal INTEGER,        -- 1..5 (NFCe, SAT, ECF...)
  status_venda INTEGER,         -- 1..3
  cancelada INTEGER DEFAULT 0,  -- 1 = venda cancelada
  data_cancelamento TEXT,
  motivo_cancelamento TEXT,
  operador_cancelamento TEXT,   -- quem cancelou a venda
  quantidade_pessoas INTEGER,
  tela_venda TEXT,                -- setor da venda (1/6=mesa, 2/7=cartao, 3=entrega, 4/5=balcao, A=autopesagem, 21=NFe)
  cliente_codigo INTEGER,
  cliente_nome TEXT,
  cliente_documento TEXT,
  numero_fechamento INTEGER,
  numero_caixa INTEGER,
  operador_caixa TEXT,
  valor_subtotal REAL,
  valor_desconto REAL,          -- descontos fiscal + sistema
  valor_acrescimo REAL,
  valor_servico REAL,           -- taxa de serviço (10%)
  valor_taxa_entrega REAL,
  valor_total REAL,
  json_original TEXT
);
CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas (data_movimento);
CREATE INDEX IF NOT EXISTS idx_vendas_loja_data ON vendas (codigo_loja, data_movimento);
CREATE INDEX IF NOT EXISTS idx_vendas_conexao ON vendas (conexao, data_movimento);

-- Itens vendidos em cada venda
CREATE TABLE IF NOT EXISTS venda_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  chave_venda TEXT NOT NULL,
  status INTEGER,               -- 1 = ativo, 2 = cancelado
  codigo_produto INTEGER,
  nome_produto TEXT,
  unidade TEXT,
  codigo_grupo INTEGER,
  grupo TEXT,
  codigo_subgrupo INTEGER,
  subgrupo TEXT,
  quantidade REAL,
  valor_unitario REAL,
  valor_desconto REAL,
  valor_acrescimo REAL,
  valor_total REAL,
  preco_compra REAL,
  atendente TEXT,
  -- Fiscal: extraido do payload para coluna, em vez de ficar preso no JSON.
  -- Permite auditar cadastro x tributacao praticada, conferir calculo e
  -- acompanhar a transicao IBS/CBS da reforma tributaria.
  ncm TEXT,
  cfop TEXT,
  cst TEXT,
  csosn TEXT,
  cest TEXT,
  tributo TEXT,
  pis_cst TEXT, pis_aliquota REAL, pis_base REAL, pis_valor REAL,
  cofins_cst TEXT, cofins_aliquota REAL, cofins_base REAL, cofins_valor REAL,
  icms_aliquota REAL, icms_base REAL, icms_valor REAL,
  ibscbs_cst TEXT, ibscbs_classtrib TEXT, ibscbs_base REAL,
  ibs_uf_aliquota REAL, ibs_uf_valor REAL,
  ibs_mun_aliquota REAL, ibs_mun_valor REAL,
  cbs_aliquota REAL, cbs_valor REAL
);
CREATE INDEX IF NOT EXISTS idx_itens_chave ON venda_itens (chave_venda);
CREATE INDEX IF NOT EXISTS idx_itens_produto ON venda_itens (codigo_produto);

-- Ficha técnica consumida em cada item vendido (Composicoes da API)
CREATE TABLE IF NOT EXISTS venda_item_composicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  venda_item_id INTEGER NOT NULL,   -- venda_itens.id
  chave_venda TEXT NOT NULL,
  codigo_produto INTEGER,           -- produto composto (pai)
  codigo_insumo INTEGER,
  nome_insumo TEXT,
  quantidade_insumo REAL,           -- por unidade vendida do produto pai
  unidade TEXT
);
CREATE INDEX IF NOT EXISTS idx_composicoes_item ON venda_item_composicoes (venda_item_id);
CREATE INDEX IF NOT EXISTS idx_composicoes_insumo ON venda_item_composicoes (codigo_insumo);

-- Descontos concedidos (quem deu e por quê) — auditoria
CREATE TABLE IF NOT EXISTS venda_descontos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  chave_venda TEXT NOT NULL,
  codigo_operador INTEGER,
  operador TEXT,
  motivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_descontos_chave ON venda_descontos (chave_venda);

-- Itens cancelados (quem lançou, quem cancelou e por quê) — auditoria
CREATE TABLE IF NOT EXISTS venda_itens_cancelados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  chave_venda TEXT NOT NULL,
  data_hora TEXT,
  nome_produto TEXT,
  operador_lancamento TEXT,     -- quem lançou o item
  operador_cancelamento TEXT,   -- quem cancelou
  motivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_itens_cancel_chave ON venda_itens_cancelados (chave_venda);

-- Pagamentos de cada venda
CREATE TABLE IF NOT EXISTS venda_pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  chave_venda TEXT NOT NULL,
  tipo_forma_pagamento INTEGER, -- 1..8
  descricao TEXT,
  valor_recebido REAL,
  valor_efetivo REAL,
  tipo_transacao_cartao INTEGER, -- 1 = crédito, 2 = débito (quando cartão)
  tipo_cartao TEXT,
  bandeira TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_chave ON venda_pagamentos (chave_venda);

-- Fechamentos de caixa
CREATE TABLE IF NOT EXISTS fechamentos_caixa (
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site)
  id_fechamento INTEGER NOT NULL,
  codigo_loja INTEGER,
  nome_loja TEXT,
  numero_caixa INTEGER,
  numero_bordero INTEGER,
  data_caixa TEXT,
  data_abertura TEXT,
  data_fechamento TEXT,
  operador_caixa TEXT,
  valor_total_sistema REAL,
  valor_total_recebido REAL,
  valor_total_bordero REAL,
  valor_total_dinheiro REAL,
  valor_total_cheque REAL,
  valor_diferenca_dinheiro REAL, -- diferença dinheiro (recebido x sistema)
  json_original TEXT,
  PRIMARY KEY (conexao, id_fechamento)
);
CREATE INDEX IF NOT EXISTS idx_fechamentos_data ON fechamentos_caixa (data_caixa);

-- Valores por forma de pagamento dentro de cada fechamento
CREATE TABLE IF NOT EXISTS fechamento_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  id_fechamento INTEGER NOT NULL,
  id_forma_pagamento INTEGER,
  descricao_forma_pagamento TEXT,
  valor_bordero REAL,
  valor_sistema REAL,
  valor_recebido REAL,
  observacao TEXT
);
CREATE INDEX IF NOT EXISTS idx_fech_itens ON fechamento_itens (id_fechamento);

-- Sangrias (retiradas de dinheiro do caixa)
CREATE TABLE IF NOT EXISTS sangrias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  codigo_loja INTEGER,
  data TEXT,
  valor REAL,
  operador TEXT,
  motivo TEXT,
  json_original TEXT
);

-- Provisão de recebíveis de cartão
CREATE TABLE IF NOT EXISTS provisao_cartoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  codigo_loja INTEGER,
  data_venda TEXT,
  data_deposito TEXT,
  bandeira TEXT,
  valor_bruto REAL,
  valor_taxa REAL,
  valor_liquido REAL,
  json_original TEXT
);

-- Contas a pagar
CREATE TABLE IF NOT EXISTS contas_pagar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  codigo_loja INTEGER,
  fornecedor TEXT,
  descricao TEXT,
  data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  valor REAL,
  valor_pago REAL,
  json_original TEXT
);
CREATE INDEX IF NOT EXISTS idx_contas_venc ON contas_pagar (data_vencimento);

-- Livro caixa (entradas e saídas)
CREATE TABLE IF NOT EXISTS livro_caixa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  codigo_loja INTEGER,
  data TEXT,
  descricao TEXT,
  natureza TEXT,
  tipo TEXT,                    -- entrada / saida
  valor REAL,
  conta TEXT,                   -- conta financeira (banco/caixa)
  json_original TEXT
);

-- Notas fiscais (venda e entrada)
CREATE TABLE IF NOT EXISTS notas_fiscais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  tipo TEXT NOT NULL,           -- 'venda' ou 'entrada'
  codigo_loja INTEGER,
  numero_nota INTEGER,
  serie TEXT,
  data TEXT,
  fornecedor_ou_cliente TEXT,
  valor_total REAL,
  json_original TEXT
);

-- Catálogo de produtos
CREATE TABLE IF NOT EXISTS produtos (
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site)
  codigo INTEGER NOT NULL,
  nome TEXT,
  unidade TEXT,
  codigo_grupo INTEGER,
  grupo TEXT,
  codigo_subgrupo INTEGER,
  subgrupo TEXT,
  preco_venda REAL,
  preco_compra REAL,            -- custo de compra (base para CMV)
  ativo INTEGER,
  composto INTEGER,             -- 1 = tem ficha técnica; baixa estoque dos insumos na venda
  processado INTEGER,           -- 1 = produzido (ficha técnica + estoque próprio)
  pesavel INTEGER,              -- 1 = vendido por peso (kg)
  exibir_no_cardapio INTEGER,   -- 0 = nao aparece na tela de venda (geralmente insumo)
  -- Conversao da embalagem de COMPRA para a unidade de consumo. Quando a
  -- unidade de compra difere da de venda e o fator nao esta configurado, o
  -- custo cadastrado acaba sendo o da embalagem inteira — a caixa de 1.000
  -- potes lancada como se fosse 1 pote. E a principal causa de custo
  -- incoerente, e o que analisar.mjs qualidade denuncia.
  unidade_compra TEXT,
  fator_compra REAL,            -- unidades de consumo por embalagem comprada
  -- 1 = o produto aparece na lista de Adicionais de algum outro (item filho).
  -- Adicional com preco de venda 0 ou 0,01 e estrategia comercial: o custo
  -- alto em relacao ao preco e ESPERADO e nao deve virar alerta.
  eh_adicional INTEGER,
  -- Cadastro fiscal: o que o produto DEVERIA tributar (compara-se com o que
  -- a venda de fato tributou, em venda_itens).
  ncm TEXT,
  cfop_venda TEXT,
  cst_venda TEXT,
  csosn_venda TEXT,
  aliquota_venda REAL,
  tributo_venda TEXT,
  cst_pis TEXT,
  cst_cofins TEXT,
  json_original TEXT,
  PRIMARY KEY (conexao, codigo)
);

-- Posições de estoque (fotografia por data de leitura)
CREATE TABLE IF NOT EXISTS estoque_posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  data_leitura TEXT NOT NULL,   -- quando a foto do estoque foi tirada
  codigo_loja INTEGER,
  codigo_produto INTEGER,
  nome_produto TEXT,
  unidade TEXT,
  quantidade REAL,
  custo REAL,
  json_original TEXT
);
CREATE INDEX IF NOT EXISTS idx_estoque_data ON estoque_posicoes (data_leitura);
CREATE INDEX IF NOT EXISTS idx_estoque_cx_data_prod ON estoque_posicoes (conexao, data_leitura, codigo_produto);

-- Conferencia de vendas: um registro por CUPOM emitido, direto do endpoint
-- ConferenciaVendas. E a TERCEIRA testemunha do movimento de um dia (as outras
-- sao a venda em si e o fechamento de caixa) — quando as tres concordam, o
-- dado e confiavel; quando divergem, ha buraco de coleta.
CREATE TABLE IF NOT EXISTS conferencia_vendas (
  conexao TEXT NOT NULL DEFAULT 'principal',
  codigo_loja INTEGER NOT NULL,
  data_caixa TEXT NOT NULL,        -- dia da operacao (AAAA-MM-DD)
  numero_caixa INTEGER NOT NULL,
  numero_cupom INTEGER NOT NULL,
  periodo INTEGER,
  valor_total REAL,                -- veio como texto "$39.80" na API
  cpf_cnpj TEXT,
  chave TEXT,
  numero_nfce TEXT,
  status_nfce TEXT,                -- "EMISSAO NORMAL AUTORIZADA", rejeicoes...
  motivo_rejeicao TEXT,
  modelo_fiscal INTEGER,
  json_original TEXT,
  PRIMARY KEY (conexao, codigo_loja, data_caixa, numero_caixa, numero_cupom)
);
CREATE INDEX IF NOT EXISTS idx_conf_cx_dia ON conferencia_vendas (conexao, data_caixa, codigo_loja);

-- Codigos que aparecem no movimento mas nao estao no cadastro (produto
-- vendido que o catalogo ainda nao conhece, cliente novo). Existem para a
-- rotina diaria saber que vale ANTECIPAR a atualizacao do cadastro, em vez de
-- esperar a segunda-feira.
--
-- A coluna tentativas evita o oposto: produto excluido no ChefWeb nunca vai
-- aparecer no catalogo, e sem esse contador a rotina gastaria a cota da API
-- todo dia atras de um codigo que nao existe mais.
CREATE TABLE IF NOT EXISTS cadastros_ausentes (
  conexao TEXT NOT NULL DEFAULT 'principal',
  tipo TEXT NOT NULL,              -- 'produtos' | 'clientes'
  codigo INTEGER NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  visto_em TEXT NOT NULL DEFAULT (date('now','localtime')),
  PRIMARY KEY (conexao, tipo, codigo)
);

-- Preferencias do gestor (ex.: qual CMV aparece na DRE). Vive no schema
-- principal porque e LIDA por scripts que abrem o banco em somente leitura —
-- criar a tabela na hora da leitura quebrava a DRE em todo computador onde a
-- preferencia ainda nao tinha sido definida.
CREATE TABLE IF NOT EXISTS preferencias (
  chave TEXT NOT NULL,
  conexao TEXT NOT NULL DEFAULT '*',
  valor TEXT NOT NULL,
  definida_em TEXT NOT NULL DEFAULT (date('now','localtime')),
  PRIMARY KEY (chave, conexao)
);

-- Categorias dos planos de contas do gestor: quais sao gastos com PESSOAL
-- (base do CMO) e quais sao COMPRA DE MERCADORIA (base das compras do CMV).
-- Vive no schema principal — e nao mais criada sob demanda — porque virou
-- dependencia de varios calculos, e a ausencia dela quebrava a DRE.
CREATE TABLE IF NOT EXISTS plano_categorias (
  plano1 TEXT NOT NULL,
  plano2 TEXT NOT NULL DEFAULT '*',
  categoria TEXT NOT NULL,
  PRIMARY KEY (plano1, plano2)
);

-- Inventarios contados no ChefWeb, importados do relatorio 41 (Listagem de
-- Inventario). Existem porque a API de estoque NAO devolve posicao retroativa:
-- quem instala o assistente hoje nao tem como calcular o CMV real de um mes
-- passado. O inventario do primeiro e do ultimo dia do mes fecham essa conta.
CREATE TABLE IF NOT EXISTS inventarios (
  conexao TEXT NOT NULL DEFAULT 'principal',
  data TEXT NOT NULL,              -- dia da contagem (AAAA-MM-DD)
  codigo_loja INTEGER NOT NULL,
  numero TEXT NOT NULL DEFAULT '', -- numero do inventario no ChefWeb ('' se o export nao trouxe)
  codigo_produto INTEGER NOT NULL,
  nome_produto TEXT,
  unidade TEXT,
  quantidade_contada REAL,         -- coluna "Inventario": a contagem FISICA (e esta que vale)
  quantidade_sistema REAL,         -- coluna "Estoque": o saldo que o sistema tinha
  diferenca REAL,
  valor_diferenca REAL,            -- coluna "Valor": valor da DIFERENCA, nao do estoque contado
  -- valor_diferenca / diferenca = custo unitario praticado NA DATA da contagem.
  -- Vale ouro: o catalogo da API e sobrescrito a cada sincronizacao, entao esta
  -- e a unica fonte de custo historico que o ChefWeb entrega.
  custo_unitario REAL,
  motivo TEXT,
  arquivo TEXT,                    -- de qual arquivo veio (rastreabilidade)
  importado_em TEXT,
  PRIMARY KEY (conexao, data, codigo_loja, numero, codigo_produto)
);
CREATE INDEX IF NOT EXISTS idx_inv_cx_data ON inventarios (conexao, data, codigo_loja);
CREATE INDEX IF NOT EXISTS idx_inv_cx_prod ON inventarios (conexao, codigo_produto, data);

-- Clientes cadastrados
CREATE TABLE IF NOT EXISTS clientes (
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site)
  codigo INTEGER NOT NULL,
  nome TEXT,
  tipo_pessoa INTEGER,
  documento TEXT,
  email TEXT,
  telefone TEXT,
  data_nascimento TEXT,
  json_original TEXT,
  PRIMARY KEY (conexao, codigo)
);

-- Cadastro das lojas de cada grupo, com a JANELA DE COLETA de cada uma.
-- Vem do controle de coleta do ChefWeb (o gestor informa; nao ha rota publica).
-- data_inicio..ultima_venda define exatamente o periodo que faz sentido buscar:
-- fora dele nao existe movimento, entao nao vale gastar chamadas.
CREATE TABLE IF NOT EXISTS lojas (
  conexao TEXT NOT NULL DEFAULT 'principal',
  codigo_loja INTEGER NOT NULL,
  id_loja INTEGER,
  serial TEXT,
  nome TEXT,
  data_inicio TEXT,             -- inicio de operacao da loja (fato, vem do TSV)
  inicio_coleta TEXT,           -- a partir de quando o GESTOR quer os dados (escolha dele)
  ultima_venda TEXT,            -- data da ultima venda registrada
  loja_parada INTEGER,          -- 1 = loja encerrada (janela fechada e definitiva)
  data_loja_parada TEXT,
  ultima_coleta TEXT,           -- ultima coleta feita pelo ChefWeb
  coletar_base_historica INTEGER,
  data_coleta_concluida TEXT,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (conexao, codigo_loja)
);

-- Diario de decisoes: o que foi recomendado, o que o gestor fez e qual foi o
-- efeito medido depois. E a memoria que transforma recomendacao em aprendizado.
CREATE TABLE IF NOT EXISTS decisoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT,
  categoria TEXT,               -- preco | cardapio | operacao | compras | financeiro
  recomendacao TEXT NOT NULL,
  codigo_produto INTEGER,       -- quando a decisao e sobre um item especifico
  prazo TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente | feita | descartada
  data_execucao TEXT,
  observacao TEXT,
  verificado_em TEXT,
  resultado TEXT,               -- efeito medido (JSON)
  registrado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_decisoes_status ON decisoes (status);

-- Eventos que explicam variacao de movimento (reforma, greve, evento na
-- cidade). Feriados nacionais sao calculados em calendario.mjs; aqui ficam
-- so os eventos que o gestor informa.
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT,                 -- NULL = vale para todos os grupos
  codigo_loja INTEGER,          -- NULL = vale para todas as lojas
  data_inicio TEXT NOT NULL,
  data_fim TEXT,
  evento TEXT NOT NULL,
  impacto TEXT,                 -- positivo | negativo | neutro
  registrado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_eventos_data ON eventos (data_inicio, data_fim);

-- Índices da era multi-grupo e de escala (bancos de 10 GB+): as consultas
-- do assistente filtram por (conexao, loja, data) e fazem joins por
-- (conexao, chave); os domínios novos precisam dos seus.
CREATE INDEX IF NOT EXISTS idx_vendas_cx_loja_data ON vendas (conexao, codigo_loja, data_movimento);
CREATE INDEX IF NOT EXISTS idx_itens_cx_chave ON venda_itens (conexao, chave_venda);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cx_chave ON venda_pagamentos (conexao, chave_venda);
CREATE INDEX IF NOT EXISTS idx_notas_cx_tipo_data ON notas_fiscais (conexao, tipo, data);
CREATE INDEX IF NOT EXISTS idx_notas_cx_loja_data ON notas_fiscais (conexao, codigo_loja, data);
CREATE INDEX IF NOT EXISTS idx_livro_cx_loja_data ON livro_caixa (conexao, codigo_loja, data);
CREATE INDEX IF NOT EXISTS idx_sangrias_cx_loja_data ON sangrias (conexao, codigo_loja, data);
-- Os indices de sync_log e coleta_falhas ficam la embaixo, junto das tabelas:
-- indice criado ANTES da tabela aborta o schema inteiro em banco NOVO (so nao
-- aparecia em banco ja existente, onde as tabelas vinham de versoes anteriores).

-- Visões que embutem as regras de ouro (cancelada = 0; item ativo sem as
-- taxas 997/999): mais seguras para consultas do agente e do gestor.
CREATE VIEW IF NOT EXISTS vendas_validas AS
  SELECT * FROM vendas WHERE cancelada = 0;
CREATE VIEW IF NOT EXISTS itens_validos AS
  SELECT * FROM venda_itens WHERE status = 1 AND codigo_produto NOT IN (997, 999);

-- Agrupamento das formas de pagamento em categorias definidas pelo gestor
-- (ex.: "PIX SANTANDER" e "PIX ITAU" -> "Pix"). Gerido por
-- scripts/categorias-pagamento.mjs.
CREATE TABLE IF NOT EXISTS formas_pagamento_categorias (
  descricao TEXT PRIMARY KEY,   -- nome exato da forma em venda_pagamentos.descricao
  categoria TEXT NOT NULL       -- Dinheiro, Pix, Crédito, Débito, Vale-refeição, Faturado, Outros...
);

-- Falhas de coleta que persistiram apos as retentativas (ex.: mes com venda
-- corrompida no servidor da TOTVS). Alimentam a coleta dia a dia e os
-- alertas ao gestor; resolvido=1 quando o periodo foi tratado.
CREATE TABLE IF NOT EXISTS coleta_falhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',
  dominio TEXT NOT NULL,
  codigo_loja INTEGER,
  periodo_inicio TEXT NOT NULL,        -- dia (AAAA-MM-DD); mes inteiro = dia 01 ao ultimo
  periodo_fim TEXT NOT NULL,
  motivo TEXT,
  resolvido INTEGER NOT NULL DEFAULT 0,
  executado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Registro do que já foi sincronizado (controle incremental)
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conexao TEXT NOT NULL DEFAULT 'principal',   -- grupo de lojas (diretorio site),
  dominio TEXT NOT NULL,
  codigo_loja INTEGER,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  registros INTEGER,
  executado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sync_cx_dom_loja ON sync_log (conexao, dominio, codigo_loja, periodo_inicio);
CREATE INDEX IF NOT EXISTS idx_falhas_cx_dom_res ON coleta_falhas (conexao, dominio, resolvido);
`;

// Colunas adicionadas após a primeira versão do schema (migrações leves).
const MIGRACOES = [
  // A partir de quando o GESTOR quer os dados desta loja — escolha dele, nao
  // um fato da loja (e comum querer so os ultimos anos). Manda no plano de
  // carga; `data_inicio` (inicio de operacao, vindo do TSV) e so o piso.
  "ALTER TABLE lojas ADD COLUMN inicio_coleta TEXT",
  "ALTER TABLE livro_caixa ADD COLUMN conta TEXT",
  "ALTER TABLE produtos ADD COLUMN preco_compra REAL",
  "ALTER TABLE produtos ADD COLUMN composto INTEGER",
  "ALTER TABLE produtos ADD COLUMN processado INTEGER",
  "ALTER TABLE produtos ADD COLUMN pesavel INTEGER",
  "ALTER TABLE produtos ADD COLUMN exibir_no_cardapio INTEGER",
  "ALTER TABLE vendas ADD COLUMN operador_cancelamento TEXT",
  "ALTER TABLE vendas ADD COLUMN tela_venda TEXT",
  "ALTER TABLE contas_pagar ADD COLUMN plano_contas1 TEXT",
  "ALTER TABLE contas_pagar ADD COLUMN plano_contas2 TEXT",
  "ALTER TABLE contas_pagar ADD COLUMN data_competencia TEXT",
  "ALTER TABLE contas_pagar ADD COLUMN pago INTEGER",
  // Marcas que vem no payload e mudam o que pode ser somado: Deletado (o
  // lancamento foi apagado no ChefWeb e NAO pode entrar em conta nenhuma),
  // Compra e Investimento (separam mercadoria de imobilizado), e a data em
  // que o lancamento foi registrado no sistema.
  "ALTER TABLE contas_pagar ADD COLUMN deletado INTEGER",
  "ALTER TABLE contas_pagar ADD COLUMN compra INTEGER",
  "ALTER TABLE contas_pagar ADD COLUMN investimento INTEGER",
  "ALTER TABLE contas_pagar ADD COLUMN data_registro TEXT",
  "ALTER TABLE livro_caixa ADD COLUMN plano_contas1 TEXT",
  "ALTER TABLE livro_caixa ADD COLUMN plano_contas2 TEXT",
  "ALTER TABLE livro_caixa ADD COLUMN data_lancamento TEXT",
  // Marcas que decidem se o lancamento CONTA no movimento da conta. Sem elas,
  // lancamento excluido, estorno e transferencia entre contas entram na soma
  // e o numero fica errado — ver docs/dicionario-de-dados.md.
  "ALTER TABLE livro_caixa ADD COLUMN deletado INTEGER",
  "ALTER TABLE livro_caixa ADD COLUMN estorno INTEGER",
  "ALTER TABLE livro_caixa ADD COLUMN transferencia INTEGER",
  "ALTER TABLE livro_caixa ADD COLUMN compensado INTEGER",
  "ALTER TABLE venda_itens ADD COLUMN ncm TEXT",
  "ALTER TABLE venda_itens ADD COLUMN cfop TEXT",
  "ALTER TABLE venda_itens ADD COLUMN cst TEXT",
  "ALTER TABLE venda_itens ADD COLUMN csosn TEXT",
  "ALTER TABLE venda_itens ADD COLUMN cest TEXT",
  "ALTER TABLE venda_itens ADD COLUMN tributo TEXT",
  "ALTER TABLE venda_itens ADD COLUMN pis_cst TEXT",
  "ALTER TABLE venda_itens ADD COLUMN pis_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN pis_base REAL",
  "ALTER TABLE venda_itens ADD COLUMN pis_valor REAL",
  "ALTER TABLE venda_itens ADD COLUMN cofins_cst TEXT",
  "ALTER TABLE venda_itens ADD COLUMN cofins_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN cofins_base REAL",
  "ALTER TABLE venda_itens ADD COLUMN cofins_valor REAL",
  "ALTER TABLE venda_itens ADD COLUMN icms_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN icms_base REAL",
  "ALTER TABLE venda_itens ADD COLUMN icms_valor REAL",
  "ALTER TABLE venda_itens ADD COLUMN ibscbs_cst TEXT",
  "ALTER TABLE venda_itens ADD COLUMN ibscbs_classtrib TEXT",
  "ALTER TABLE venda_itens ADD COLUMN ibscbs_base REAL",
  "ALTER TABLE venda_itens ADD COLUMN ibs_uf_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN ibs_uf_valor REAL",
  "ALTER TABLE venda_itens ADD COLUMN ibs_mun_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN ibs_mun_valor REAL",
  "ALTER TABLE venda_itens ADD COLUMN cbs_aliquota REAL",
  "ALTER TABLE venda_itens ADD COLUMN cbs_valor REAL",
  "ALTER TABLE produtos ADD COLUMN ncm TEXT",
  "ALTER TABLE produtos ADD COLUMN cfop_venda TEXT",
  "ALTER TABLE produtos ADD COLUMN cst_venda TEXT",
  "ALTER TABLE produtos ADD COLUMN csosn_venda TEXT",
  "ALTER TABLE produtos ADD COLUMN aliquota_venda REAL",
  "ALTER TABLE produtos ADD COLUMN tributo_venda TEXT",
  "ALTER TABLE produtos ADD COLUMN cst_pis TEXT",
  "ALTER TABLE produtos ADD COLUMN cst_cofins TEXT",
  "ALTER TABLE produtos ADD COLUMN unidade_compra TEXT",
  "ALTER TABLE produtos ADD COLUMN fator_compra REAL",
  "ALTER TABLE produtos ADD COLUMN eh_adicional INTEGER",
  // Verificacao dos dias defeituosos: quantas re-sondagens (em execucoes
  // separadas) confirmaram o defeito — so o confirmado entra no chamado.
  "ALTER TABLE coleta_falhas ADD COLUMN verificacoes INTEGER NOT NULL DEFAULT 0",
  // CNPJ da loja (vem no payload da CapaVenda; preenchido pelo sync de
  // vendas) — usado na identificacao de chamados ao suporte.
  "ALTER TABLE lojas ADD COLUMN cnpj TEXT",
  // Loja com muito movimento estoura o tempo limite quando a busca cobre o mes
  // inteiro. Quando isso se repete, a loja passa a ser coletada UM DIA POR VEZ
  // — e esse modo vira o padrao dela, em vez de o sistema insistir na busca
  // mensal, falhar de novo e desistir do dominio.
  "ALTER TABLE lojas ADD COLUMN coletar_dia_a_dia INTEGER",
  "ALTER TABLE lojas ADD COLUMN timeouts_vendas INTEGER NOT NULL DEFAULT 0",
];

// Tabelas que ganharam a coluna "conexao" (grupo de lojas) na versao
// multi-grupo. Bancos criados antes disso recebem a coluna por ALTER.
const TABELAS_COM_CONEXAO = [
  'vendas', 'venda_itens', 'venda_item_composicoes', 'venda_descontos',
  'venda_itens_cancelados', 'venda_pagamentos', 'fechamentos_caixa',
  'fechamento_itens', 'sangrias', 'provisao_cartoes', 'contas_pagar',
  'livro_caixa', 'notas_fiscais', 'produtos', 'estoque_posicoes',
  'clientes', 'sync_log', 'inventarios', 'conferencia_vendas',
];

// Tabelas cuja chave primaria era um inteiro do ChefWeb (codigo/id) e que
// passam a ter chave composta (conexao, codigo) — dois grupos podem ter a
// loja 1, o produto 10 ou o fechamento 99 ao mesmo tempo.
const CHAVES_COMPOSTAS = {
  produtos: 'codigo',
  clientes: 'codigo',
  fechamentos_caixa: 'id_fechamento',
};

function colunas(db, tabela) {
  try {
    return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

// Extrai do SCHEMA o CREATE TABLE de uma tabela especifica.
function sqlDaTabela(tabela) {
  const marca = `CREATE TABLE IF NOT EXISTS ${tabela} (`;
  const inicio = SCHEMA.indexOf(marca);
  if (inicio < 0) return null;
  const fim = SCHEMA.indexOf(');', inicio);
  return SCHEMA.slice(inicio, fim + 2);
}

// Recria uma tabela com chave composta (conexao, codigo), preservando os dados.
function recriarComChaveComposta(db, tabela) {
  const info = db.prepare(`PRAGMA table_info(${tabela})`).all();
  if (info.length === 0) return false;
  if (info.some((c) => c.name === 'conexao')) return false; // ja migrada
  const antigas = info.map((c) => c.name);
  const lista = antigas.join(', ');
  const criar = sqlDaTabela(tabela);
  if (!criar) return false;
  db.exec(`ALTER TABLE ${tabela} RENAME TO ${tabela}_antiga`);
  db.exec(criar);
  db.exec(
    `INSERT OR REPLACE INTO ${tabela} (conexao, ${lista}) `
    + `SELECT 'principal', ${lista} FROM ${tabela}_antiga`
  );
  db.exec(`DROP TABLE ${tabela}_antiga`);
  return true;
}

export function criarSchema(db) {
  // 1) colunas novas em tabelas que ja existem (bancos de versoes anteriores)
  for (const migracao of MIGRACOES) {
    try { db.exec(migracao); } catch { /* coluna ja existe ou tabela nova */ }
  }
  // 2) chaves compostas por conexao (recriam a tabela preservando os dados)
  for (const tabela of Object.keys(CHAVES_COMPOSTAS)) {
    try {
      if (recriarComChaveComposta(db, tabela)) {
        console.log(`Banco atualizado: ${tabela} agora separa os dados por grupo de lojas.`);
      }
    } catch (erro) {
      console.error(`Nao consegui migrar a tabela ${tabela}: ${erro.message}`);
    }
  }
  // 3) coluna conexao nas demais tabelas ja existentes
  for (const tabela of TABELAS_COM_CONEXAO) {
    const cols = colunas(db, tabela);
    if (cols.length === 0 || cols.includes('conexao')) continue;
    try {
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN conexao TEXT NOT NULL DEFAULT 'principal'`);
    } catch { /* ok */ }
  }
  // 4) cria o que faltar (tabelas novas) e todos os indices
  db.exec(SCHEMA);

  // 5) preenchimento retroativo de colunas novas a partir do payload que ja
  // esta guardado. Evita pedir ao gestor uma nova carga so por causa de um
  // campo que sempre esteve no json_original. So toca linhas ainda nulas,
  // entao roda rapido depois da primeira vez.
  try {
    if (colunas(db, 'livro_caixa').includes('deletado')) {
      db.exec(`UPDATE livro_caixa SET
          deletado = CASE WHEN json_extract(json_original, '$.Deletado') IN (1, 'true') THEN 1 ELSE 0 END,
          estorno = CASE WHEN json_extract(json_original, '$.Extorno') IN (1, 'true') THEN 1 ELSE 0 END,
          transferencia = CASE WHEN json_extract(json_original, '$.Transfere') IN (1, 'true')
                            OR json_extract(json_original, '$.Transferido') IN (1, 'true') THEN 1 ELSE 0 END,
          compensado = CASE WHEN json_extract(json_original, '$.Compensado') IN (1, 'true') THEN 1 ELSE 0 END
        WHERE deletado IS NULL AND json_original IS NOT NULL`);
    }
  } catch { /* melhor esforco: sem isso, so os registros novos trazem as marcas */ }

  // Unidade e fator de compra, e a marca de adicional: tudo ja estava no
  // json_original guardado, entao nao ha motivo para pedir nova carga.
  try {
    if (colunas(db, 'produtos').includes('unidade_compra')) {
      db.exec(`UPDATE produtos SET
          unidade_compra = json_extract(json_original, '$.UnidadeCompra'),
          fator_compra = json_extract(json_original, '$.FatorCompra')
        WHERE unidade_compra IS NULL AND json_original IS NOT NULL`);
      db.exec("UPDATE produtos SET eh_adicional = 0 WHERE eh_adicional IS NULL");
      // Quem e adicional nao se sabe pelo proprio cadastro: descobre-se por
      // aparecer na lista Adicionais de OUTRO produto. A CTE monta o conjunto
      // uma vez; comparar produto a produto seria quadratico.
      db.exec(`WITH adicionais AS (
            SELECT DISTINCT p.conexao AS cx, json_extract(j.value, '$.CodigoProduto') AS cod
              FROM produtos p, json_each(p.json_original, '$.Adicionais') j)
          UPDATE produtos SET eh_adicional = 1
           WHERE EXISTS (SELECT 1 FROM adicionais WHERE cx = produtos.conexao AND cod = produtos.codigo)`);
    }
  } catch { /* melhor esforco */ }

  // Marcas do contas a pagar: estavam no json_original desde sempre, entao nao
  // ha motivo para pedir nova carga. `deletado` e o mais importante — sem ele,
  // lancamentos apagados no ChefWeb continuam somando na DRE.
  try {
    if (colunas(db, 'contas_pagar').includes('deletado')) {
      db.exec(`UPDATE contas_pagar SET
          deletado = CASE WHEN json_extract(json_original, '$.Deletado') IN (1, 'true') THEN 1 ELSE 0 END,
          compra = CASE WHEN json_extract(json_original, '$.Compra') IN (1, 'true') THEN 1 ELSE 0 END,
          investimento = CASE WHEN json_extract(json_original, '$.Investimento') IN (1, 'true') THEN 1 ELSE 0 END,
          data_registro = substr(json_extract(json_original, '$.DataRegistro'), 1, 10)
        WHERE deletado IS NULL AND json_original IS NOT NULL`);
    }
  } catch { /* melhor esforco */ }

  // Planos de contas gravados com entidade HTML ("MAT&#201;RIA PRIMA"): o
  // mesmo plano virava dois nos agrupamentos da DRE e escapava dos filtros por
  // categoria. Normaliza o que ja esta no banco — a sincronizacao passou a
  // decodificar na entrada.
  try {
    const decodificar = (t) => {
      if (typeof t !== 'string' || !t.includes('&')) return t;
      let v = t;
      for (let i = 0; i < 3 && v.includes('&'); i += 1) {
        const antes = v;
        v = v.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
          .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
        if (v === antes) break;
      }
      return v;
    };
    // Todo campo de texto que veio da API pode ter entidade: a lista cobre o
    // que o gestor ve em relatorio e o que serve de chave em agrupamento.
    const TEXTOS = {
      contas_pagar: ['fornecedor', 'descricao', 'plano_contas1', 'plano_contas2'],
      livro_caixa: ['descricao', 'natureza', 'conta', 'plano_contas1', 'plano_contas2'],
      produtos: ['nome', 'grupo', 'subgrupo'],
      venda_itens: ['nome_produto', 'grupo', 'subgrupo', 'atendente'],
      venda_pagamentos: ['descricao'],
      notas_fiscais: ['fornecedor_ou_cliente'],
      clientes: ['nome'],
      lojas: ['nome'],
      fechamentos_caixa: ['nome_loja', 'operador_caixa'],
    };
    // Espaco nas pontas quebra juncao por texto em silencio — mesma familia de
    // problema das entidades, mesmo remedio: normalizar o que ja esta gravado.
    for (const [tabela, cols] of Object.entries(TEXTOS)) {
      if (colunas(db, tabela).length === 0) continue;
      for (const coluna of cols) {
        try {
          db.exec(`UPDATE ${tabela} SET ${coluna} = TRIM(${coluna})
                    WHERE ${coluna} IS NOT NULL AND ${coluna} <> TRIM(${coluna})`);
        } catch { /* coluna ausente nesta versao */ }
      }
    }
    for (const [tabela, cols] of Object.entries(TEXTOS)) {
      if (colunas(db, tabela).length === 0) continue;
      for (const coluna of cols) {
        if (!colunas(db, tabela).includes(coluna)) continue;
        const sujos = db.prepare(
          `SELECT DISTINCT ${coluna} AS v FROM ${tabela}
            WHERE ${coluna} LIKE '%&#%' OR ${coluna} LIKE '%&amp;%' OR ${coluna} LIKE '%&lt;%'
               OR ${coluna} LIKE '%&gt;%' OR ${coluna} LIKE '%&quot;%' OR ${coluna} LIKE '%&nbsp;%'`
        ).all();
        const upd = db.prepare(`UPDATE ${tabela} SET ${coluna} = ? WHERE ${coluna} = ?`);
        for (const { v } of sujos) {
          const limpo = decodificar(v);
          if (limpo !== v) upd.run(limpo, v);
        }
      }
    }
  } catch { /* melhor esforco */ }

  // Custo das fotografias de estoque tiradas antes de o custo passar a ser
  // congelado na coleta. Usa o custo ATUAL do cadastro — e o melhor
  // disponivel para elas, ja que a API nao devolve custo no estoque e o
  // catalogo sobrescreve o preco de compra a cada sincronizacao. As fotos
  // novas nascem com o custo do proprio dia (ver sincronizar.mjs).
  try {
    if (colunas(db, 'estoque_posicoes').includes('custo')) {
      db.exec(`UPDATE estoque_posicoes SET custo = (
            SELECT p.preco_compra FROM produtos p
             WHERE p.conexao = estoque_posicoes.conexao
               AND p.codigo = estoque_posicoes.codigo_produto)
          WHERE custo IS NULL`);
    }
  } catch { /* melhor esforco */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = abrirBanco();
  criarSchema(db);
  db.close();
  console.log(`Banco pronto em ${CAMINHO_BANCO}`);
}
