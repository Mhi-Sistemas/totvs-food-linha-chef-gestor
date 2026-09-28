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
  // Verificacao dos dias defeituosos: quantas re-sondagens (em execucoes
  // separadas) confirmaram o defeito — so o confirmado entra no chamado.
  "ALTER TABLE coleta_falhas ADD COLUMN verificacoes INTEGER NOT NULL DEFAULT 0",
  // CNPJ da loja (vem no payload da CapaVenda; preenchido pelo sync de
  // vendas) — usado na identificacao de chamados ao suporte.
  "ALTER TABLE lojas ADD COLUMN cnpj TEXT",
];

// Tabelas que ganharam a coluna "conexao" (grupo de lojas) na versao
// multi-grupo. Bancos criados antes disso recebem a coluna por ALTER.
const TABELAS_COM_CONEXAO = [
  'vendas', 'venda_itens', 'venda_item_composicoes', 'venda_descontos',
  'venda_itens_cancelados', 'venda_pagamentos', 'fechamentos_caixa',
  'fechamento_itens', 'sangrias', 'provisao_cartoes', 'contas_pagar',
  'livro_caixa', 'notas_fiscais', 'produtos', 'estoque_posicoes',
  'clientes', 'sync_log',
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = abrirBanco();
  criarSchema(db);
  db.close();
  console.log(`Banco pronto em ${CAMINHO_BANCO}`);
}
