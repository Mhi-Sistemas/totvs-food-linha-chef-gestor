// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// CHAMADO AO SUPORTE DA TOTVS: monta, a partir das falhas persistentes
// registradas em coleta_falhas (dias/meses que o proprio servidor se recusa
// a entregar, com os codigos das vendas corrompidas), o texto pronto do
// ticket de suporte — o gestor so copia (ou, com SMTP configurado e e-mail
// de suporte informado em data/suporte.json, o assistente envia por e-mail
// APOS aprovacao explicita do gestor; ver CLAUDE.md).
//
// Uso: node --no-warnings scripts/chamado-suporte.mjs gerar [--grupo <id>]

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { abrirBanco } from './criar-banco.mjs';
import { dominio as dominioInfo } from './dominios.mjs';
import { carregarConexoes } from './conexoes.mjs';

// Como reproduzir cada dominio: metodo, caminho e o corpo EXATO que o
// assistente envia (espelho do sincronizar.mjs; token omitido). O exemplo
// de requisicao do chamado nasce daqui.
const REQUISICOES = {
  vendas: {
    metodo: 'POST', caminho: '/api/CapaVenda/ListPorDataMovimento',
    corpo: (loja, dia) => ({
      DataMovimentoInicial: `${dia}T00:00:00`, DataMovimentoFinal: `${dia}T23:59:59`,
      Composicoes: true, CodigoLoja: loja,
    }),
  },
  fechamentos: {
    metodo: 'POST', caminho: '/api/FechamentoCaixa/ObterFechamentoCaixa',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, Lojas: [loja] }),
  },
  sangrias: {
    metodo: 'POST', caminho: '/api/sangria/Listar',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, CodigoLoja: loja }),
  },
  'contas-pagar': {
    metodo: 'GET (objeto no corpo)', caminho: '/api/Financeiro/ListContasPagar',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, CodigoLoja: loja }),
  },
  'livro-caixa': {
    metodo: 'GET (objeto no corpo)', caminho: '/api/Financeiro/ListLivroCaixa',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, CodigoLoja: loja }),
  },
  'notas-venda': {
    metodo: 'GET (objeto no corpo)', caminho: '/api/Fiscal/ListNotasFiscaisVenda?page=1&pageSize=500',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, CodigoLoja: loja }),
  },
  'notas-entrada': {
    metodo: 'GET (objeto no corpo)', caminho: '/api/Fiscal/ListNotasFiscaisEntrada',
    corpo: (loja, dia) => ({ DataInicial: `${dia}T00:00:00`, DataFinal: `${dia}T23:59:59`, TipoData: 0, CodigoLoja: loja }),
  },
};

const REGEX_GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Dias com o MESMO erro se agrupam: a assinatura normaliza a mensagem
// (identificadores variaveis viram "<identificadores>").
function assinaturaDoErro(motivo) {
  const m = String(motivo ?? '');
  if (/listar os itens/i.test(m)) {
    return {
      chave: 'erro-30-itens',
      titulo: 'ERRO 30 — "Ocorreu um erro ao listar os itens da(s) venda(s): '
        + '<identificadores>. Procedimento abortado."',
    };
  }
  if (/Divide by zero/i.test(m)) {
    return {
      chave: 'erro-20-div0',
      titulo: 'ERRO 20 — "Divide by zero error encountered. The statement has been terminated."',
    };
  }
  const texto = m.replace(REGEX_GUID, '<id>').replace(/\s+/g, ' ').trim().slice(-140);
  return { chave: `outro-${texto}`, titulo: `ERRO — "${texto}"` };
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

function lerArgs() {
  const args = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const proximo = argv[i + 1];
      if (proximo && !proximo.startsWith('--')) { args[argv[i].slice(2)] = proximo; i += 1; }
      else args[argv[i].slice(2)] = true;
    }
  }
  return args;
}

const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

// Comprime dias ORDENADOS em intervalos contiguos: "28/04/2022 a 07/06/2022"
// em vez de dezenas de datas soltas — o suporte agradece.
function comprimirDias(dias) {
  const trechos = [];
  let inicio = null;
  let fim = null;
  const diaSeguinte = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400_000)
    .toISOString().slice(0, 10);
  for (const dia of dias) {
    if (fim !== null && dia === diaSeguinte(fim)) { fim = dia; continue; }
    if (inicio !== null) trechos.push(inicio === fim ? dmy(inicio) : `${dmy(inicio)} a ${dmy(fim)}`);
    inicio = dia;
    fim = dia;
  }
  if (inicio !== null) trechos.push(inicio === fim ? dmy(inicio) : `${dmy(inicio)} a ${dmy(fim)}`);
  return trechos;
}

export function gerarChamado(db, grupo) {
  // So entra no chamado o dia RE-VERIFICADO (verificacoes >= 1): cada um
  // acumulou pelo menos 3 tentativas com a mesma assinatura de erro, em
  // execucoes separadas. Meses ainda nao esmiucados dia a dia ficam fora.
  const falhas = db.prepare(
    'SELECT dominio, codigo_loja, periodo_inicio, motivo FROM coleta_falhas '
    + 'WHERE conexao = ? AND resolvido = 0 AND periodo_inicio = periodo_fim '
    + 'AND verificacoes >= 1 ORDER BY dominio, codigo_loja, periodo_inicio'
  ).all(grupo);
  if (falhas.length === 0) return null;

  // dominio -> assinatura -> { titulo, porLoja: loja -> Set dias, guids }
  const blocos = new Map();
  const lojasAfetadas = new Set();
  for (const f of falhas) {
    if (!blocos.has(f.dominio)) blocos.set(f.dominio, new Map());
    const porErro = blocos.get(f.dominio);
    const assinatura = assinaturaDoErro(f.motivo);
    if (!porErro.has(assinatura.chave)) {
      porErro.set(assinatura.chave, { titulo: assinatura.titulo, porLoja: new Map(), guids: new Set() });
    }
    const g = porErro.get(assinatura.chave);
    if (!g.porLoja.has(f.codigo_loja)) g.porLoja.set(f.codigo_loja, new Set());
    g.porLoja.get(f.codigo_loja).add(f.periodo_inicio);
    lojasAfetadas.add(f.codigo_loja);
    for (const id of String(f.motivo ?? '').match(REGEX_GUID) ?? []) g.guids.add(id.toLowerCase());
  }

  // Identificacao do ambiente e das lojas (diretorio site + CNPJ).
  const conexao = carregarConexoes().find((c) => c.id === grupo);
  const infoLoja = new Map();
  for (const loja of lojasAfetadas) {
    const l = db.prepare(
      'SELECT nome, cnpj FROM lojas WHERE conexao = ? AND codigo_loja = ?'
    ).get(grupo, loja) ?? {};
    infoLoja.set(loja, { nome: l.nome ?? null, cnpj: l.cnpj ?? null });
  }
  const rotuloLoja = (loja) => {
    const i = infoLoja.get(loja) ?? {};
    return `Loja ${loja}${i.nome ? ` (${i.nome})` : ''} — CNPJ ${i.cnpj ?? '(informar)'}`;
  };

  const linhas = [];
  linhas.push('CHAMADO — Falha na API do ChefWeb ao listar períodos históricos');
  linhas.push('');
  linhas.push('Prezado suporte TOTVS Food Linha Chef,');
  linhas.push('');
  linhas.push('Identificação do ambiente:');
  linhas.push(`- Diretório site (número de série da loja central): ${conexao?.serial ?? '(informar)'}`);
  linhas.push(`- Usuário de integração próprio, somente leitura.`);
  linhas.push('- Lojas afetadas:');
  for (const loja of [...lojasAfetadas].sort((a, b) => a - b)) linhas.push(`    ${rotuloLoja(loja)}`);
  linhas.push('');
  linhas.push('Ao consultar dados históricos pela API do ChefWeb (dentro das janelas');
  linhas.push('e limites documentados), o servidor responde erro e aborta a listagem');
  linhas.push('dos dias abaixo. Cada dia foi consultado individualmente em pelo menos');
  linhas.push('TRÊS tentativas, em execuções e horários distintos, sempre com o mesmo');
  linhas.push('erro — falha determinística. Agrupamos os dias por erro e anexamos um');
  linhas.push('exemplo real de requisição de cada grupo (token omitido):');
  linhas.push('');
  for (const [dom, porErro] of blocos) {
    const req = REQUISICOES[dom];
    linhas.push(`— ${dominioInfo(dom)?.nome ?? dom} — ${req ? `${req.metodo} ${req.caminho}` : dom}`);
    linhas.push('');
    for (const g of porErro.values()) {
      linhas.push(`  ${g.titulo}`);
      let exemplo = null;
      for (const [loja, diasSet] of [...g.porLoja.entries()].sort((a, b) => a[0] - b[0])) {
        const dias = [...diasSet].sort();
        linhas.push(`    ${rotuloLoja(loja)} — ${dias.length} dia(s): ${comprimirDias(dias).join('; ')}`);
        if (!exemplo) exemplo = { loja, dia: dias[0] };
      }
      if (req && exemplo) {
        linhas.push(`    Exemplo de requisição (loja ${exemplo.loja}, dia ${dmy(exemplo.dia)}) — corpo enviado:`);
        linhas.push(`      ${JSON.stringify(req.corpo(exemplo.loja, exemplo.dia))}`);
      }
      if (g.guids.size > 0) {
        linhas.push(`    Identificadores citados nas mensagens de erro (${g.guids.size}):`);
        for (const id of g.guids) linhas.push(`      ${id}`);
      }
      linhas.push('');
    }
  }
  linhas.push('Solicitamos a verificação/correção desses registros no ambiente, ou');
  linhas.push('orientação de como obter os períodos afetados.');
  linhas.push('');
  linhas.push('Obrigado.');
  return linhas.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  if (acao !== 'gerar') {
    console.error('Uso: chamado-suporte.mjs gerar [--grupo <id>]');
    process.exit(1);
  }
  const args = lerArgs();
  const grupo = args.grupo ?? 'principal';
  const db = abrirBanco({ somenteLeitura: true });
  const texto = gerarChamado(db, grupo);
  db.close();
  if (!texto) {
    console.log('Nenhuma falha persistente registrada: nao ha chamado a abrir.');
    process.exit(0);
  }
  const pasta = join(RAIZ, 'relatorios', 'documentos');
  mkdirSync(pasta, { recursive: true });
  const caminho = join(pasta, `chamado-suporte-totvs-${grupo}-${new Date().toISOString().slice(0, 10)}.txt`);
  writeFileSync(caminho, `${texto}\n`, 'utf8');
  console.log(`Chamado pronto: ${caminho}\n`);
  console.log(texto);
}
