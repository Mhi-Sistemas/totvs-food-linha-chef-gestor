// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Cadastro das lojas de cada grupo, com a JANELA DE COLETA de cada uma.
//
// Saber quais lojas existem e a partir de quando buscar evita procurar
// períodos em que a loja nem existia ou já estava fechada — decisivo em redes,
// onde cada loja custa uma chamada por período. Sem esse cadastro a carga
// histórica simplesmente não tem o que planejar.
//
// QUEM INFORMA AS LOJAS É O GESTOR — o assistente não adivinha. Não há rota
// pública que liste as lojas de um grupo, e tentar descobri-las sondando
// códigos não se sustenta na realidade do Chef: em rede de franquias cada
// gestor é dono de UMA loja, e existem clientes com MIL lojas.
//
// Dois caminhos para preencher:
//   1. `definir` — o gestor informa o número de cada loja e a data. É o
//      caminho normal, um comando por loja;
//   2. `importar` — o TSV do controle de coleta do ChefWeb, quando quem opera
//      a revenda consegue exportá-lo (traz tudo de uma vez, inclusive lojas
//      paradas). Atalho de revenda, não caminho de gestor.
//
// DUAS DATAS DIFERENTES, não confundir:
//   - `data_inicio`   = quando a loja começou a operar (vem do TSV do ChefWeb);
//   - `inicio_coleta` = A PARTIR DE QUANDO O GESTOR QUER OS DADOS. É uma
//     ESCOLHA dele, não um fato da loja: é comum querer só os últimos dois
//     anos em vez do histórico inteiro. É o que `definir --inicio` grava, e o
//     que manda no plano de carga.
//
// Uso:
//   node --no-warnings scripts/lojas.mjs definir --grupo <id> --loja <n> [--nome "..."]
//                                        [--inicio AAAA-MM-DD] [--ultima-venda AAAA-MM-DD] [--parada]
//   node --no-warnings scripts/lojas.mjs importar --grupo <id> --arquivo <tsv>
//   node --no-warnings scripts/lojas.mjs listar [--grupo <id>]
//   node --no-warnings scripts/lojas.mjs plano --grupo <id> [--noite]
//   node --no-warnings scripts/lojas.mjs coletar --grupo <id> [--dominio <d>]  (sem --dominio: TODOS os dominios com historico)
//   node --no-warnings scripts/lojas.mjs coletar --dia-a-dia --grupo <id>   (recupera meses com falha persistente, um dia por vez)
//   node --no-warnings scripts/lojas.mjs progresso --grupo <id> [--abrir]   (relatorio HTML de progresso da carga inicial)
//
// O arquivo é o TSV/CSV copiado do controle do ChefWeb, com cabeçalho. São
// reconhecidas as colunas: IdLoja, NumeroSerialLoja, NomeLoja, CodigoLoja,
// DataInicio, ColetarBaseHistorica, UltimaColeta, LojaParada, UltimaVenda,
// DataLojaParada, DataColetaConcluida.

import { readFileSync, mkdirSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { abrirBanco, criarSchema } from './criar-banco.mjs';
import { registrarAlerta } from './alertas.mjs';
import { dominio as dominioInfo, dominiosHistoricos, dominiosCadastro } from './dominios.mjs';
import { carregarConexoes } from './conexoes.mjs';
import { gerarChamado } from './chamado-suporte.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));

// Trava de execucao unica da coleta: duas coletas simultaneas (ex.: a
// diurna ainda rodando quando a noturna dispara) furariam o limite de
// requisicoes da TOTVS — cada processo respeita o intervalo sozinho, mas a
// soma nao. Trava orfa (processo morto) e assumida sem reclamar.
const ARQUIVO_TRAVA = join(AQUI, '..', 'data', 'coleta.lock');
function adquirirTravaDeColeta() {
  try {
    const pid = Number(readFileSync(ARQUIVO_TRAVA, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // vivo?
        console.error(`Ja existe uma coleta em andamento (processo ${pid}). `
          + 'Duas ao mesmo tempo furariam o limite de requisicoes da TOTVS. Saindo.');
        process.exit(3);
      } catch { /* processo morto: trava orfa */ }
    }
  } catch { /* sem trava */ }
  mkdirSync(dirname(ARQUIVO_TRAVA), { recursive: true });
  writeFileSync(ARQUIVO_TRAVA, String(process.pid));
  process.on('exit', () => { try { unlinkSync(ARQUIVO_TRAVA); } catch { /* ja foi */ } });
}

function lerArgs() {
  const args = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const nome = argv[i].slice(2);
      const proximo = argv[i + 1];
      if (proximo && !proximo.startsWith('--')) { args[nome] = proximo; i += 1; }
      else args[nome] = true;
    }
  }
  return args;
}

const soDia = (v) => {
  if (!v || v === 'NULL') return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};
const numero = (v) => {
  if (v === undefined || v === null || v === 'NULL' || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? null : n;
};

// AAAA-MM-DD no fuso LOCAL (toISOString converteria para UTC e, dependendo
// do fuso e da hora, devolveria o dia errado).
const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
const ontem = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return diaLocal(d);
};

function importar(db, args) {
  if (!args.grupo || !args.arquivo) {
    console.error('Uso: lojas.mjs importar --grupo <id> --arquivo <arquivo.tsv>');
    process.exit(1);
  }
  const texto = readFileSync(args.arquivo, 'utf8').trim();
  const linhas = texto.split(/\r?\n/);
  const separador = linhas[0].includes('\t') ? '\t' : ';';
  const cabecalho = linhas[0].split(separador).map((c) => c.trim());
  const indice = (nome) => cabecalho.findIndex((c) => c.toLowerCase() === nome.toLowerCase());
  const col = {
    idLoja: indice('IdLoja'),
    serial: indice('NumeroSerialLoja'),
    nome: indice('NomeLoja'),
    codigo: indice('CodigoLoja'),
    inicio: indice('DataInicio'),
    historica: indice('ColetarBaseHistorica'),
    ultimaColeta: indice('UltimaColeta'),
    parada: indice('LojaParada'),
    ultimaVenda: indice('UltimaVenda'),
    dataParada: indice('DataLojaParada'),
    concluida: indice('DataColetaConcluida'),
  };
  if (col.codigo < 0) {
    console.error('O arquivo precisa ter a coluna CodigoLoja no cabeçalho.');
    process.exit(1);
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO lojas
    (conexao, codigo_loja, id_loja, serial, nome, data_inicio, ultima_venda,
     loja_parada, data_loja_parada, ultima_coleta, coletar_base_historica,
     data_coleta_concluida, atualizado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'))`);
  let n = 0;
  for (const linha of linhas.slice(1)) {
    if (!linha.trim()) continue;
    const c = linha.split(separador);
    const codigo = numero(c[col.codigo]);
    if (codigo === null) continue;
    ins.run(
      args.grupo, codigo,
      col.idLoja >= 0 ? numero(c[col.idLoja]) : null,
      col.serial >= 0 ? (c[col.serial] ?? '').trim() : null,
      col.nome >= 0 ? (c[col.nome] ?? '').trim() : null,
      col.inicio >= 0 ? soDia(c[col.inicio]) : null,
      col.ultimaVenda >= 0 ? soDia(c[col.ultimaVenda]) : null,
      col.parada >= 0 ? numero(c[col.parada]) : null,
      col.dataParada >= 0 ? soDia(c[col.dataParada]) : null,
      col.ultimaColeta >= 0 ? soDia(c[col.ultimaColeta]) : null,
      col.historica >= 0 ? numero(c[col.historica]) : null,
      col.concluida >= 0 ? soDia(c[col.concluida]) : null,
    );
    n += 1;
  }
  console.log(`${n} loja(s) importada(s) para o grupo "${args.grupo}".`);
}

// Cadastro de UMA loja, vindo da CONVERSA com o gestor: o numero da loja e a
// partir de qual data ele quer os dados dela. E o caminho normal — o TSV do
// controle de coleta do ChefWeb existe, mas so a revenda consegue exporta-lo.
// Preserva o que ja estava gravado — chamar de novo so para corrigir a data
// nao apaga o nome nem a janela.
function definir(db, args) {
  if (!args.grupo || args.loja === undefined) {
    console.error('Uso: lojas.mjs definir --grupo <id> --loja <n> [--nome "..."] '
      + '[--inicio AAAA-MM-DD] [--ultima-venda AAAA-MM-DD] [--parada]');
    process.exit(1);
  }
  const codigo = numero(args.loja);
  if (codigo === null) {
    console.error(`Código de loja inválido: "${args.loja}".`);
    process.exit(1);
  }
  const atual = db.prepare('SELECT * FROM lojas WHERE conexao = ? AND codigo_loja = ?')
    .get(args.grupo, codigo);
  // `--inicio` e A ESCOLHA DO GESTOR de onde comecar a buscar, nao a data em
  // que a loja abriu: ele pode querer so os ultimos dois anos de uma loja que
  // opera ha dez. Por isso vai para `inicio_coleta`, e nao para `data_inicio`
  // (que e fato da loja e so chega pelo TSV do ChefWeb).
  const inicio = args.inicio ? soDia(args.inicio) : (atual?.inicio_coleta ?? null);
  if (args.inicio && !inicio) {
    console.error(`Data de início inválida: "${args.inicio}" (use AAAA-MM-DD).`);
    process.exit(1);
  }
  if (inicio && inicio > ontem()) {
    console.error(`A data de início (${inicio}) está no futuro — confira.`);
    process.exit(1);
  }
  const ultimaArg = args['ultima-venda'];
  let ultima = ultimaArg ? soDia(ultimaArg) : (atual?.ultima_venda ?? null);
  if (ultimaArg && !ultima) {
    console.error(`Data de última venda inválida: "${ultimaArg}" (use AAAA-MM-DD).`);
    process.exit(1);
  }
  // Loja em operação não tem "última venda" no cadastro: a janela vai até
  // ontem (D-1), porque hoje só chega depois do fechamento de caixa.
  const parada = args.parada ? 1 : (args.ativa ? 0 : (atual?.loja_parada ?? 0));
  if (!ultima && parada !== 1) ultima = ontem();
  if (inicio && ultima && ultima < inicio) {
    console.error(`A última venda (${ultima}) é anterior ao início (${inicio}) — confira as datas.`);
    process.exit(1);
  }
  db.prepare(`INSERT INTO lojas
    (conexao, codigo_loja, nome, inicio_coleta, ultima_venda, loja_parada, atualizado_em)
    VALUES (?,?,?,?,?,?, datetime('now','localtime'))
    ON CONFLICT(conexao, codigo_loja) DO UPDATE SET
      nome = COALESCE(excluded.nome, nome),
      inicio_coleta = excluded.inicio_coleta,
      ultima_venda = excluded.ultima_venda,
      loja_parada = excluded.loja_parada,
      atualizado_em = excluded.atualizado_em`)
    .run(args.grupo, codigo, args.nome ?? atual?.nome ?? null, inicio, ultima, parada);
  console.log(`Loja ${codigo} do grupo "${args.grupo}" ${atual ? 'atualizada' : 'cadastrada'}: `
    + `${args.nome ?? atual?.nome ?? '(sem nome)'} | buscar de `
    + `${inicio ?? '(data a informar)'} a ${ultima ?? '?'} | `
    + `${parada === 1 ? 'parada' : 'ativa'}.`);
  if (!inicio) {
    console.log('Falta a data de início: sem ela a carga histórica desta loja não entra no plano. '
      + 'Pergunte ao gestor a partir de qual data ele quer os dados desta loja (pode ser o '
      + 'início das vendas dela ou só os últimos anos — a escolha é dele).');
  }
}

function listar(db, args) {
  const onde = args.grupo ? 'WHERE conexao = ?' : '';
  const params = args.grupo ? [args.grupo] : [];
  const linhas = db.prepare(`SELECT conexao, codigo_loja, nome,
    COALESCE(inicio_coleta, data_inicio) AS inicio, inicio_coleta, data_inicio, ultima_venda,
    loja_parada FROM lojas ${onde} ORDER BY conexao, codigo_loja`).all(...params);
  if (linhas.length === 0) { console.log('(nenhuma loja cadastrada)'); return; }
  let semInicio = 0;
  for (const l of linhas) {
    const situacao = l.loja_parada === 1 ? 'parada' : 'ativa';
    if (!l.inicio) semInicio += 1;
    // Quando as duas datas existem e diferem, o gestor escolheu buscar menos
    // historico do que a loja tem — mostrar as duas evita a duvida depois.
    const recorte = (l.inicio_coleta && l.data_inicio && l.inicio_coleta !== l.data_inicio)
      ? ` (loja opera desde ${l.data_inicio})` : '';
    console.log(`${l.conexao} | loja ${l.codigo_loja} | ${l.nome ?? ''} | buscar de `
      + `${l.inicio ?? '? DATA A INFORMAR'} a ${l.ultima_venda ?? '?'}${recorte} | ${situacao}`);
  }
  if (semInicio > 0) {
    console.log(`\n${semInicio} loja(s) sem data de início: ficam FORA da carga histórica. `
      + 'Pergunte ao gestor a partir de qual data ele quer os dados de cada uma '
      + 'e grave com "lojas.mjs definir".');
  }
}

// Meses (AAAA-MM) entre duas datas, inclusive.
function mesesEntre(de, ate) {
  const meses = [];
  let [ano, mes] = de.split('-').map(Number);
  const [anoFim, mesFim] = ate.split('-').map(Number);
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }
  return meses;
}

// Meses (loja|AAAA-MM) ja cobertos: com vendas gravadas OU com sincronizacao
// registrada no sync_log abrangendo o mes inteiro. Mes que voltou VAZIO nunca
// aparece em `vendas` — sem o sync_log ele seria re-buscado toda noite (loja
// parada = buscas desperdicadas para sempre). Vazio buscado FORA da janela
// noturna (23h-07h) NAO conta: pode ser a restricao da API a periodo antigo
// durante o dia, e nao ausencia de movimento.
function mesesCobertos(db, grupo, dominio = 'vendas') {
  const cobertos = new Set(dominio === 'vendas'
    ? db.prepare(
      "SELECT DISTINCT codigo_loja || '|' || strftime('%Y-%m', data_movimento) AS chave "
      + 'FROM vendas WHERE conexao = ?'
    ).all(grupo).map((r) => r.chave)
    : []);
  for (const s of db.prepare(
    "SELECT codigo_loja, periodo_inicio, periodo_fim, registros, executado_em "
    + "FROM sync_log WHERE conexao = ? AND dominio = ? AND codigo_loja IS NOT NULL "
    + 'AND periodo_inicio IS NOT NULL AND periodo_fim IS NOT NULL'
  ).all(grupo, dominio)) {
    // A restricao da janela noturna e das VENDAS; nos demais dominios um
    // resultado vazio de dia vale como cobertura normal.
    if (!s.registros && dominio === 'vendas') {
      const hora = Number(String(s.executado_em).slice(11, 13));
      if (!(hora >= 23 || hora < 7)) continue;
    }
    const inicio = String(s.periodo_inicio).slice(0, 10);
    const fim = String(s.periodo_fim).slice(0, 10);
    for (const mes of mesesEntre(inicio.slice(0, 7), fim.slice(0, 7))) {
      const [ano, m] = mes.split('-').map(Number);
      const ultimoDia = new Date(Date.UTC(ano, m, 0)).getUTCDate();
      if (inicio <= `${mes}-01` && fim >= `${mes}-${String(ultimoDia).padStart(2, '0')}`) {
        cobertos.add(`${s.codigo_loja}|${mes}`);
      }
    }
  }
  return cobertos;
}

// Meses (loja|AAAA-MM) com falha persistente registrada em coleta_falhas:
// saem do plano mensal e pertencem a recuperacao dia a dia. UMA falha
// registrada ja basta — cada registro representa duas tentativas seguidas
// com erro deterministico de dados (erros 30/20 do servidor); re-tentar o
// mes inteiro toda noite so queima a janela (aconteceu: uma madrugada
// inteira de pedagio sem nenhum mes novo).
function mesesComDefeito(db, grupo, dominio = 'vendas', minimo = 1) {
  return new Set(db.prepare(
    "SELECT codigo_loja || '|' || substr(periodo_inicio, 1, 7) AS chave FROM coleta_falhas "
    + 'WHERE conexao = ? AND dominio = ? AND resolvido = 0 '
    + 'GROUP BY chave HAVING COUNT(*) >= ?'
  ).all(grupo, dominio, minimo).map((r) => r.chave));
}

// Texto unico para o caso mais comum logo apos a configuracao: o grupo existe,
// as credenciais funcionam, mas ninguem informou ainda QUAIS sao as lojas nem
// a partir de quando buscar — sem isso a carga historica nao tem o que planejar.
const avisoSemCadastro = (grupo) => 'A carga histórica depende de duas informações que só o '
  + 'GESTOR tem (não existe consulta que liste as lojas de um grupo):\n'
  + '  - o NÚMERO de cada loja;\n'
  + '  - A PARTIR DE QUAL DATA ele quer os dados de cada uma (escolha dele: pode ser o\n'
  + '    início das vendas ou só os últimos anos).\n'
  + `  node --no-warnings scripts/lojas.mjs definir --grupo ${grupo} --loja <n> --inicio AAAA-MM-DD\n`
  + '  O dia a dia não depende disso: a rotina diária já mantém o período recente em dia.';

// Monta o plano de coleta de um dominio: por loja, só os meses entre a data
// de início e a última venda, descontando o que já está no banco.
function montarPlano(db, grupo, dominio = 'vendas') {
  const lojas = db.prepare(
    'SELECT codigo_loja, nome, COALESCE(inicio_coleta, data_inicio) AS data_inicio, '
    + 'ultima_venda, loja_parada FROM lojas WHERE conexao = ? ORDER BY codigo_loja'
  ).all(grupo);
  // Sem cadastro de lojas nao ha o que planejar — mas isso NAO derruba o
  // processo: os demais dominios (e os demais grupos) seguem, e quem chamou
  // reporta a falta de cadastro uma vez so.
  if (lojas.length === 0) {
    return { lojas: [], semCadastro: true, lojasSemJanela: 0, detalhes: [], tarefas: [] };
  }
  const jaTem = new Set([...mesesCobertos(db, grupo, dominio), ...mesesComDefeito(db, grupo, dominio)]);

  let lojasSemJanela = 0;
  const detalhes = [];
  const tarefas = [];
  for (const l of lojas) {
    if (!l.data_inicio || !l.ultima_venda || l.ultima_venda < l.data_inicio) {
      lojasSemJanela += 1;
      continue;
    }
    const meses = mesesEntre(l.data_inicio.slice(0, 7), l.ultima_venda.slice(0, 7));
    const faltando = meses.filter((m) => !jaTem.has(`${l.codigo_loja}|${m}`));
    if (faltando.length === 0) continue;
    detalhes.push({ loja: l.codigo_loja, nome: l.nome, meses: faltando.length,
      de: faltando[0], ate: faltando[faltando.length - 1] });
    for (const mes of faltando) tarefas.push({ loja: l.codigo_loja, nome: l.nome, mes });
  }
  return { lojas, lojasSemJanela, detalhes, tarefas };
}

function plano(db, args) {
  if (!args.grupo) {
    console.error('Uso: lojas.mjs plano --grupo <id> [--noite]');
    process.exit(1);
  }
  const segundos = args.noite ? 10 : 30;
  const alvos = args.dominio ? [args.dominio] : dominiosHistoricos().map((d) => d.id);
  let totalGeral = 0;
  let semJanela = 0;
  console.log(`Plano de coleta — grupo "${args.grupo}"`);
  for (const dom of alvos) {
    const plan = montarPlano(db, args.grupo, dom);
    if (plan.semCadastro) {
      console.log(`\nNenhuma loja cadastrada no grupo "${args.grupo}" — não há o que planejar.`);
      console.log(avisoSemCadastro(args.grupo));
      return;
    }
    totalGeral += plan.tarefas.length;
    semJanela = plan.lojasSemJanela;
    console.log(`\n[${dom}] ${plan.tarefas.length} busca(s)`
      + (plan.lojasSemJanela ? ` (${plan.lojasSemJanela} loja(s) sem data de início, ignoradas)` : ''));
    for (const d of plan.detalhes) {
      console.log(`  loja ${String(d.loja).padStart(2)} | ${(d.nome ?? '').padEnd(28)} | `
        + `${d.meses} mes(es): ${d.de} a ${d.ate}`);
    }
  }
  const minutos = Math.round((totalGeral * segundos) / 60);
  console.log(`\nTOTAL: ${totalGeral} buscas ≈ ${minutos} min `
    + `(${args.noite ? 'janela noturna, 10s' : 'horário comercial, 30s'} entre buscas)`);
  if (semJanela > 0) {
    console.log(`ATENÇÃO: ${semJanela} loja(s) estão fora deste plano por não terem data `
      + 'de início. Pergunte ao gestor a partir de qual data ele quer os dados e grave com '
      + `"lojas.mjs definir --grupo ${args.grupo} --loja <n> --inicio AAAA-MM-DD".`);
  }
  console.log('Comando por loja: sincronizar.mjs --dominio <d> --grupo '
    + `${args.grupo} --loja <n> --de <AAAA-MM-01> --ate <AAAA-MM-31>`);
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Assinaturas de falha de DADOS do servidor (erro 30 "listar os itens",
// erro 20 "divide by zero"): deterministicas, locais do periodo — nunca
// contam como falha geral. Ver docs/api/erros-conhecidos.md.
const ehFalhaDeDados = (texto) => /listar os itens da\(s\) venda|Divide by zero/i.test(texto);

// Versao assincrona do sincronizar: permite UM TRABALHADOR POR DOMINIO em
// paralelo (o limite de requisicoes da TOTVS e por endpoint — cada dominio
// respeita o proprio intervalo de 30s/10s, e a soma nao fura limite algum).
function rodarSincronizar(argumentos) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath,
      ['--no-warnings', join(AQUI, 'sincronizar.mjs'), ...argumentos]);
    let saida = '';
    filho.stdout.on('data', (c) => { saida += c; });
    filho.stderr.on('data', (c) => { saida += c; });
    filho.on('close', (codigo) => resolve({ codigo, saida }));
    filho.on('error', (erro) => resolve({ codigo: 1, saida: String(erro.message) }));
  });
}

// Executa o plano: uma busca por (loja, mes), na ordem, respeitando o limite
// de requisicoes da API POR DOMINIO — os dominios rodam EM PARALELO, um
// trabalhador cada. E RETOMAVEL: meses ja gravados sao pulados, entao
// pode ser interrompido e tocado de novo a qualquer momento.
async function coletar(db, args) {
  if (!args.grupo) {
    console.error('Uso: lojas.mjs coletar --grupo <id> [--dominio <d>] [--limite N]');
    process.exit(1);
  }
  if (args.dominio && !dominioInfo(args.dominio)) {
    console.error(`Dominio desconhecido: "${args.dominio}". Registro: scripts/dominios.mjs.`);
    process.exit(1);
  }
  adquirirTravaDeColeta();
  // Sem --dominio, a carga percorre TODOS os dominios com historico do
  // registro central (vendas primeiro, que e o restrito a janela noturna).
  const alvos = args.dominio ? [args.dominio] : dominiosHistoricos().map((d) => d.id);

  // Estado compartilhado entre dominios: permissao negada e por LOJA (vale
  // para todos os dominios) e os contadores alimentam um resumo/alerta so.
  const estado = {
    ok: 0, vazios: 0, erros: 0, pulados: 0,
    lojasSemAcesso: new Set(),
    dominiosSemPermissao: new Set(),
    mesesComFalha: [],
    freios: 0, // dominios freiados por falha geral
    semCadastro: false,   // grupo sem nenhuma loja cadastrada
    lojasSemJanela: 0,    // lojas cadastradas sem data de inicio
  };
  const inicio = Date.now();
  await Promise.all(alvos.map((dom) => coletarDominio(db, args, dom, estado)));
  const duracao = Math.round((Date.now() - inicio) / 60000);

  // A carga historica nao tem como comecar sem saber quais sao as lojas e
  // a partir de quando buscar. Silencio aqui seria o pior defeito: o gestor
  // ficaria esperando um historico que nunca vem.
  if (estado.semCadastro) {
    console.log(`Nenhuma loja cadastrada no grupo "${args.grupo}": a carga histórica não começou.`);
    console.log(avisoSemCadastro(args.grupo));
    registrarAlerta({
      unico: true,
      chave: `sem-cadastro-lojas:${args.grupo}`,
      titulo: `Falta dizer quais são as lojas do grupo "${args.grupo}"`,
      detalhe: 'O acesso está funcionando, mas ainda não sei quais lojas existem nem '
        + 'a partir de qual data ele quer os dados — por isso a busca do histórico não começou.',
      orientacao: 'Perguntar ao gestor, loja por loja, o número dela e a partir de qual data '
        + 'ele quer os dados (escolha dele: o início das vendas, que está no ChefWeb, ou só '
        + 'os últimos anos) e gravar com '
        + `"lojas.mjs definir --grupo ${args.grupo} --loja <n> --inicio AAAA-MM-DD". `
        + 'A data é escolha do gestor: pode ser o início das vendas ou só os últimos anos.',
    });
    return;
  }
  if (estado.lojasSemJanela > 0) {
    registrarAlerta({
      unico: true,
      chave: `lojas-sem-inicio:${args.grupo}`,
      titulo: `${estado.lojasSemJanela} loja(s) fora da busca do histórico (grupo "${args.grupo}")`,
      detalhe: 'Essas lojas estão cadastradas, mas não sei a partir de que data buscar — '
        + 'sem isso eu não tenho como saber que período pedir, então elas ficaram de fora.',
      orientacao: 'Perguntar ao gestor a partir de qual data ele quer os dados de cada uma '
        + `e gravar com "lojas.mjs definir --grupo ${args.grupo} --loja <n> --inicio AAAA-MM-DD". `
        + `A lista sai em "lojas.mjs listar --grupo ${args.grupo}".`,
    });
  }
  console.log(`Concluido em ~${duracao} min: ${estado.ok} com dados, ${estado.vazios} sem movimento, `
    + `${estado.erros} com erro${estado.pulados ? `, ${estado.pulados} pulado(s) por falha persistente` : ''}.`);

  // O gestor precisa saber das falhas na primeira conversa do dia — e o
  // alerta que permite a ele abrir chamado no suporte da TOTVS.
  if (estado.lojasSemAcesso.size > 0) {
    registrarAlerta({
      titulo: `Lojas sem permissão de acesso no grupo "${args.grupo}"`,
      detalhe: `O usuário usado na integração não tem acesso à(s) loja(s) `
        + `${[...estado.lojasSemAcesso].join(', ')} — nenhum dado delas pode ser baixado.`,
      orientacao: 'Conceder ao usuário a permissão de acesso total aos relatórios '
        + 'nessas lojas, no ChefWeb (Cadastros > Usuários), ou pedir isso ao suporte da TOTVS.',
    });
  }
  if (estado.dominiosSemPermissao.size > 0) {
    const nomes = [...estado.dominiosSemPermissao]
      .map((d) => dominioInfo(d)?.nome ?? d).join(', ');
    registrarAlerta({
      titulo: `Tipos de dado sem permissão no ChefWeb (grupo "${args.grupo}")`,
      detalhe: `O usuário usado na integração não tem permissão para: ${nomes}. `
        + 'Nenhum dado desses módulos pode ser baixado até liberar.',
      orientacao: 'Conceder ao usuário a permissão desses módulos/relatórios no '
        + 'ChefWeb (Cadastros > Usuários), replicada em todas as lojas — ou pedir '
        + 'ao suporte da TOTVS. Depois disso a busca continua sozinha.',
    });
  }
  if (estado.mesesComFalha.length > 0) {
    registrarAlerta({
      titulo: `Períodos com defeito no servidor da TOTVS (grupo "${args.grupo}")`,
      detalhe: `Não consegui baixar: ${estado.mesesComFalha.slice(0, 12).join('; ')}`
        + `${estado.mesesComFalha.length > 12 ? ` e mais ${estado.mesesComFalha.length - 12} período(s)` : ''}. `
        + 'O próprio servidor da TOTVS responde com erro nesses períodos '
        + '(detalhes técnicos em coleta_falhas, no banco local).',
      orientacao: 'Vou tentar recuperar dia a dia automaticamente. Para os dias que '
        + 'continuarem falhando, o caminho é abrir chamado no suporte da TOTVS — '
        + 'posso montar o texto do chamado com os períodos e os códigos dos registros com problema.',
    });
  }
  if (estado.freios >= 2) {
    registrarAlerta({
      titulo: `Coleta interrompida por falhas gerais (grupo "${args.grupo}")`,
      detalhe: 'A busca automática parou no meio: vários pedidos seguidos falharam em '
        + 'mais de um tipo de dado — sinal de problema geral (internet, credenciais '
        + 'ou o sistema da TOTVS fora do ar), não de um período específico.',
      orientacao: 'A próxima execução agendada tenta de novo sozinha. Se este alerta '
        + 'se repetir por dias, teste o acesso (testar-conexao) e confira as credenciais.',
    });
  }
  // Estatisticas do planejador apos a carga do dia (barato; mantem as
  // consultas rapidas com o banco crescendo).
  try { db.exec('PRAGMA optimize;'); } catch { /* melhor esforco */ }
  // Relatorio de progresso sempre atualizado ao fim de cada coleta — e o
  // feedback da carga inicial que o gestor acompanha.
  const resumo = progresso(db, { grupo: args.grupo });
  // Marcos POSITIVOS da carga: alerta bom tambem e noticia (cada um nasce
  // uma unica vez na vida, gracas ao `unico`).
  if (resumo) {
    for (const marco of [50, 75, 90]) {
      if (resumo.pctVendas >= marco && resumo.pctVendas < 100) {
        registrarAlerta({
          unico: true,
          chave: `marco-vendas-${marco}:${args.grupo}`,
          titulo: `Boa notícia: ${marco}% do histórico de vendas já carregado (grupo "${args.grupo}")`,
          detalhe: `A carga inicial passou de ${marco}% das vendas — já dá para analisar boa parte do seu histórico.`,
          orientacao: 'Nenhuma ação necessária: a busca continua sozinha. Que tal pedir um painel do período já carregado?',
        });
      }
    }
    if (resumo.pctVendas >= 100) {
      registrarAlerta({
        unico: true,
        chave: `vendas-completas:${args.grupo}`,
        titulo: `Histórico de VENDAS completo (grupo "${args.grupo}")`,
        detalhe: 'Todas as vendas previstas do seu histórico estão no computador.',
        orientacao: 'Já pode pedir qualquer análise de vendas de qualquer período.',
      });
    }
    if (resumo.pctGeral >= 100) {
      registrarAlerta({
        unico: true,
        chave: `carga-concluida:${args.grupo}`,
        titulo: `Carga inicial CONCLUÍDA (grupo "${args.grupo}")`,
        detalhe: 'Todo o histórico previsto (vendas, fechamentos, financeiro, notas...) foi carregado ou verificado.',
        orientacao: 'Daqui em diante a rotina diária mantém tudo em dia sozinha.',
      });
    }
  }
  // Arrumacao de cadastro durante a carga (roadmap): audita o que ja
  // chegou e vira checklist para o gestor corrigir no ChefWeb enquanto
  // espera — sem isso, CMV/CMO/cardapio nascem quebrados.
  try {
    const q = spawnSync(process.execPath,
      ['--no-warnings', join(AQUI, 'analisar.mjs'), 'qualidade', '--grupo', args.grupo],
      { encoding: 'utf8' });
    const achados = (q.stdout ?? '').split(/\r?\n/).filter((l) => /\[GRAVE\]|\[aten/.test(l));
    if (achados.length > 0) {
      registrarAlerta({
        chave: `arrumacao-cadastro:${args.grupo}`,
        titulo: `Cadastro precisa de arrumação no ChefWeb (grupo "${args.grupo}")`,
        detalhe: `A auditoria do que já foi carregado encontrou: `
          + `${achados.slice(0, 5).map((l) => l.trim()).join(' | ')}`
          + `${achados.length > 5 ? ` | e mais ${achados.length - 5} ponto(s)` : ''}.`,
        orientacao: 'Corrigir esses cadastros no ChefWeb agora, enquanto a carga roda, '
          + 'faz os indicadores (CMV, CMO, cardápio) nascerem confiáveis. Ofereça ao '
          + 'gestor a lista completa e o passo a passo de correção.',
      });
      console.log(`Auditoria de cadastro: ${achados.length} ponto(s) para arrumar (alerta registrado).`);
    }
  } catch { /* auditoria e melhor esforco */ }
  // --com-dia-a-dia: emenda a recuperacao e a VERIFICACAO dos dias
  // defeituosos no MESMO processo (a trava e do processo).
  if (args['com-dia-a-dia']) {
    coletarDiaADia(db, args);
    await verificarDefeitos(db, args);
  }
  if (estado.erros > 0) process.exitCode = 1;
}

// Executa a fila de UM dominio: uma busca por (loja, mes), na ordem,
// respeitando o limite de requisicoes da API. E RETOMAVEL: meses ja
// cobertos sao pulados, entao pode ser interrompido a qualquer momento.
async function coletarDominio(db, args, dominio, estado) {
  const hora = new Date().getHours();
  const noite = hora >= 23 || hora < 7;

  // Fora da madrugada a API RECUSA (HTTP 403) qualquer periodo que alcance
  // mais de 16 dias atras — mas so nos dominios com janela noturna (testado
  // em 25/09/2026: e uma restricao POR DOMINIO). De dia, esses dominios
  // ficam para a proxima madrugada e os livres seguem normalmente.
  if (dominioInfo(dominio)?.janelaNoturna && !noite) {
    console.log(`[${dominio}] fora da janela noturna (23h-07h): a API recusa periodos `
      + 'alem de 16 dias atras. Este dominio fica para a madrugada.');
    return;
  }

  const { tarefas, semCadastro, lojasSemJanela } = montarPlano(db, args.grupo, dominio);
  if (semCadastro) { estado.semCadastro = true; return; }
  if (lojasSemJanela > 0) estado.lojasSemJanela = lojasSemJanela;
  const limite = args.limite ? Number(args.limite) : tarefas.length;
  const fila = tarefas.slice(0, limite).filter((t) => !estado.lojasSemAcesso.has(t.loja));
  if (fila.length === 0) {
    console.log(`[${dominio}] nada a coletar: todos os meses previstos ja estao no computador.`);
    return;
  }
  const minutos = Math.round((fila.length * (noite ? 10_000 : 30_000)) / 60000);
  console.log(`Coletando ${dominio} do grupo "${args.grupo}": ${fila.length} busca(s), `
    + `~${minutos} min (${noite ? 'janela noturna' : 'horario comercial'}).`);

  let ok = 0;
  let vazios = 0;
  let erros = 0;
  let pulados = 0;
  // Falhas SEGUIDAS por loja: erro persistente do servidor (venda corrompida,
  // divisao por zero) costuma atingir um TRECHO do historico — numa rede real,
  // um mesmo intervalo de meses em varias lojas. Depois de 3 seguidos falhando na
  // mesma loja, pula um BLOCO de 6 meses dela e sonda de novo: atravessa a
  // zona ruim sem abandonar os meses bons mais recentes da loja.
  const falhasSeguidas = new Map();
  const pularBloco = new Map(); // loja -> meses restantes a pular
  // Falha de dados nao arma o freio global. Na retomada a fila recomeca
  // pelos meses sabidamente ruins, entao "so falhas ate agora" e o estado
  // normal do reinicio, nao problema geral.
  let falhasGerais = 0; // seguidas, de tipo geral (janela, credencial, conexao)
  const lojasSemAcesso = estado.lojasSemAcesso;
  const mesesComFalha = estado.mesesComFalha;
  let freiou = false;

  // BOLETIM DE PROGRESSO a cada 5 minutos. A coleta passa longos minutos
  // aparentemente parada (a TOTVS exige 30s entre buscas): sem um sinal
  // periodico, quem acompanha o log — gestor ou assistente — nao distingue
  // "andando devagar" de "travado".
  const inicioDominio = Date.now();
  const boletim = setInterval(() => {
    const feitas = ok + vazios + erros + pulados;
    const restantes = fila.length - feitas;
    const minCorridos = Math.max(1, Math.round((Date.now() - inicioDominio) / 60000));
    const porMinuto = feitas / minCorridos;
    const faltam = porMinuto > 0 ? Math.round(restantes / porMinuto) : null;
    console.log(`[${dominio}] progresso: ${feitas} de ${fila.length} busca(s) `
      + `(${Math.round((feitas / fila.length) * 100)}%) — ${ok} com dados, `
      + `${vazios} sem movimento${erros ? `, ${erros} com erro` : ''}`
      + `${faltam !== null ? `; faltam ~${faltam} min` : ''}.`);
  }, 5 * 60 * 1000);
  boletim.unref?.();

  try {
  for (const [i, t] of fila.entries()) {
    if (estado.pararTudo) break;
    // O intervalo do limite de requisicoes e POR DOMINIO e depende da hora
    // ATUAL (execucoes longas cruzam 07h/23h): 10s de madrugada, 30s de dia.
    const agora = new Date();
    const noiteAgora = agora.getHours() >= 23 || agora.getHours() < 7;
    const intervaloMs = noiteAgora ? 10_000 : 30_000;
    // Coleta iniciada de DIA para as 22:45: a madrugada pertence as vendas
    // e o agendamento noturno precisa encontrar a trava de coleta livre.
    if (!noite && agora.getHours() * 60 + agora.getMinutes() >= 22 * 60 + 45) {
      console.log('22:45: encerrando a coleta diurna para liberar a madrugada '
        + '(o proximo agendamento continua de onde parou).');
      estado.pararTudo = true;
      break;
    }
    const aPular = pularBloco.get(t.loja) ?? 0;
    if (aPular > 0) { pularBloco.set(t.loja, aPular - 1); pulados += 1; continue; }
    const [ano, mes] = t.mes.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const de = `${t.mes}-01`;
    const ate = `${t.mes}-${String(ultimoDia).padStart(2, '0')}`;
    const buscar = async () => {
      const r = await rodarSincronizar([
        '--dominio', dominio, '--grupo', args.grupo,
        '--loja', String(t.loja), '--de', de, '--ate', ate,
      ]);
      const achou = r.saida.match(new RegExp('([0-9]+) registro'));
      return { qtd: achou ? Number(achou[1]) : 0, falhou: r.codigo !== 0 || /❌/.test(r.saida), saida: r.saida };
    };
    let b = await buscar();
    if (b.falhou) {
      // Erros transitorios (rede, timeout, instabilidade do ChefWeb) merecem
      // UMA retentativa automatica na hora, apos a pausa do limite de
      // requisicoes — sem ela o mes so seria retentado na proxima execucao.
      console.log(`[${dominio} ${i + 1}/${fila.length}] erro  loja ${t.loja} ${t.mes} `
        + `- retentando em ${Math.round(intervaloMs / 1000)}s...`);
      await esperar(intervaloMs);
      b = await buscar();
    }
    const { qtd, falhou, saida } = b;
    if (falhou) { erros += 1; } else if (qtd > 0) { ok += 1; } else { vazios += 1; }
    const marca = falhou ? 'ERRO ' : (qtd > 0 ? 'ok   ' : 'vazio');
    console.log(`[${dominio} ${i + 1}/${fila.length}] ${marca} loja ${t.loja} ${t.mes} `
      + `- ${qtd} registro(s)`);
    if (falhou) {
      console.log(`        motivo: ${saida.trim().slice(-140)}`);
      // Usuario sem permissao para o MODULO (ex.: Fiscal): nenhum pedido
      // deste dominio vai passar — pula o dominio inteiro na primeira
      // ocorrencia, sem armar o freio (e configuracao, nao problema geral).
      if (/permissão de acesso a essa solicitação/i.test(saida)) {
        estado.dominiosSemPermissao.add(dominio);
        console.warn(`[${dominio}] usuario da API sem permissao para este modulo no ChefWeb: `
          + 'pulando este tipo de dado inteiro.');
        break;
      }
      // Periodo anterior a existencia da funcionalidade na API (a propria
      // API informa a data): o dado nunca vai existir — marca o mes como
      // verificado para nao tentar nunca mais.
      if (/anterior a implementa/i.test(saida)) {
        db.prepare(
          'INSERT INTO sync_log (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, registros) '
          + 'VALUES (?, ?, ?, ?, ?, ?)'
        ).run(args.grupo, dominio, t.loja, de, ate, 0);
        console.warn(`        periodo anterior a disponibilidade desta API: `
          + `${t.mes} marcado como indisponivel (nao sera tentado de novo).`);
        falhasGerais = 0;
        if (i < fila.length - 1) await esperar(intervaloMs);
        continue;
      }
      // Usuario da API sem permissao na loja: nenhum mes dela vai passar —
      // pula a loja inteira ja na primeira falha (nao e problema geral).
      if (/não possui acesso a loja/i.test(saida)) {
        pularBloco.set(t.loja, Infinity);
        lojasSemAcesso.add(t.loja);
        db.prepare(
          'INSERT INTO coleta_falhas (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, motivo) '
          + 'VALUES (?, ?, ?, ?, ?, ?)'
        ).run(args.grupo, dominio, t.loja, de, ate, saida.trim().slice(-300));
        console.warn(`        usuario da API sem acesso a loja ${t.loja}: pulando a loja `
          + 'inteira. Conceda a permissao de relatorios a esta loja no ChefWeb.');
        if (i < fila.length - 1) await esperar(intervaloMs);
        continue;
      }
      const deDados = ehFalhaDeDados(saida);
      falhasGerais = deDados ? 0 : falhasGerais + 1;
      // So falha de DADOS e registrada e alertada: falha geral (janela,
      // conexao) e transitoria e a proxima execucao resolve sozinha.
      if (deDados) {
        db.prepare(
          'INSERT INTO coleta_falhas (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, motivo) '
          + 'VALUES (?, ?, ?, ?, ?, ?)'
        ).run(args.grupo, dominio, t.loja, de, ate, saida.trim().slice(-300));
        mesesComFalha.push(`${dominio}: loja ${t.loja} ${t.mes}`);
      }
      const seguidas = (falhasSeguidas.get(t.loja) ?? 0) + 1;
      falhasSeguidas.set(t.loja, seguidas);
      if (seguidas >= 3) {
        pularBloco.set(t.loja, 6);
        // Deixa o contador em 2: se a sonda depois do bloco falhar, ja pula o
        // proximo bloco — atravessa rapido uma zona ruim longa.
        falhasSeguidas.set(t.loja, 2);
        console.warn(`        3 falhas seguidas na loja ${t.loja}: pulando um bloco `
          + 'de 6 meses e sondando de novo (os pulados ficam para a proxima execucao).');
      }
    } else {
      falhasSeguidas.set(t.loja, 0);
      falhasGerais = 0;
      db.prepare(
        "UPDATE coleta_falhas SET resolvido = 1 WHERE conexao = ? AND dominio = ? "
        + "AND codigo_loja = ? AND substr(periodo_inicio, 1, 7) = ?"
      ).run(args.grupo, dominio, t.loja, t.mes);
    }
    // Freio global: so falhas de tipo GERAL em sequencia indicam problema
    // geral (janela noturna, credenciais, queda da API) — falha de dados de
    // um periodo especifico nunca conta aqui.
    if (falhou && falhasGerais >= 5) {
      console.error(`[${dominio}] cinco falhas gerais seguidas: interrompendo este dominio. `
        + 'Verifique o horario (janela noturna) e as credenciais.');
      freiou = true;
      break;
    }
    if (i < fila.length - 1) {
      // pausa obrigatoria entre chamadas DO MESMO dominio (o limite e por endpoint)
      await esperar(intervaloMs);
    }
  }
  } finally { clearInterval(boletim); }
  estado.ok += ok;
  estado.vazios += vazios;
  estado.erros += erros;
  estado.pulados += pulados;
  if (freiou) {
    estado.freios += 1;
    // Dois dominios freiados por falha GERAL = problema global (credencial,
    // conexao, API fora): manda os demais trabalhadores pararem tambem.
    if (estado.freios >= 2 && !estado.pararTudo) {
      estado.pararTudo = true;
      console.error('Freio de falhas gerais em dois dominios: encerrando a execucao inteira.');
    }
  }
  console.log(`[${dominio}] parcial: ${ok} com dados, ${vazios} sem movimento, `
    + `${erros} com erro${pulados ? `, ${pulados} pulado(s)` : ''}.`);
}

// Recuperacao DIA A DIA dos meses com falha persistente (2+ tentativas):
// busca o mes um dia por vez, salvando os dias bons e isolando os dias em
// que o servidor da TOTVS responde erro (venda corrompida, divisao por
// zero). Ao final o mes e dado por tratado (nao volta ao plano mensal) e os
// dias ruins ficam registrados um a um para o chamado no suporte.
function coletarDiaADia(db, args) {
  if (!args.grupo) {
    console.error('Uso: lojas.mjs coletar --dia-a-dia --grupo <id> [--limite N]');
    process.exit(1);
  }
  adquirirTravaDeColeta();
  const hora = new Date().getHours();
  const noite = hora >= 23 || hora < 7;
  const intervaloMs = noite ? 10_000 : 30_000;
  // Sem --dominio, recupera as falhas persistentes de TODOS os dominios.
  const meses = db.prepare(
    "SELECT dominio, codigo_loja AS loja, substr(periodo_inicio, 1, 7) AS mes FROM coleta_falhas "
    + 'WHERE conexao = ? AND resolvido = 0 AND periodo_inicio <> periodo_fim '
    + (args.dominio ? 'AND dominio = ? ' : '')
    + 'GROUP BY dominio, loja, mes HAVING COUNT(*) >= 1 ORDER BY dominio, loja, mes'
  ).all(...(args.dominio ? [args.grupo, args.dominio] : [args.grupo]));
  const fila = meses.slice(0, args.limite ? Number(args.limite) : meses.length);
  if (fila.length === 0) {
    console.log('Nada a recuperar: nenhum mes com falha persistente registrada.');
    return;
  }
  console.log(`Recuperacao dia a dia do grupo "${args.grupo}": `
    + `${fila.length} mes(es) com falha persistente.`);
  const diasRuins = [];
  let diasComDados = 0;
  // Falhas GERAIS seguidas (credencial, conexao, janela): abortam a
  // recuperacao SEM marcar nada como tratado — sem este freio, uma queda de
  // credencial ja gravou dezenas de falhas-fantasma e cobertura errada.
  let falhasGerais = 0;
  let abortou = false;
  for (const m of fila) {
    if (abortou) break;
    // Recuperacao iniciada de DIA para as 22:45 (libera a madrugada).
    if (!noite) {
      const agora = new Date();
      if (agora.getHours() * 60 + agora.getMinutes() >= 22 * 60 + 45) {
        console.log('22:45: encerrando a recuperacao diurna para liberar a madrugada.');
        break;
      }
    }
    const dominio = m.dominio;
    const [ano, mesN] = m.mes.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(ano, mesN, 0)).getUTCDate();
    console.log(`[${dominio}] loja ${m.loja} ${m.mes}: ${ultimoDia} dia(s), um a um...`);
    let registrosMes = 0;
    let janelaFechou = false;
    for (let d = 1; d <= ultimoDia; d += 1) {
      // A janela noturna fechou? Para na hora: fora dela a API recusa vendas
      // antigas e cada recusa viraria uma falsa "falha do dia" registrada.
      const h = new Date().getHours();
      if (dominioInfo(dominio)?.janelaNoturna && h >= 7 && h < 23) {
        console.log('Janela noturna fechou (07h): parando a recuperacao; o resto fica para a proxima noite.');
        janelaFechou = true;
        break;
      }
      const dia = `${m.mes}-${String(d).padStart(2, '0')}`;
      const r = spawnSync(process.execPath, [
        '--no-warnings', join(AQUI, 'sincronizar.mjs'),
        '--dominio', dominio, '--grupo', args.grupo,
        '--loja', String(m.loja), '--de', dia, '--ate', dia,
      ], { encoding: 'utf8' });
      const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const achou = saida.match(new RegExp('([0-9]+) registro'));
      const qtd = achou ? Number(achou[1]) : 0;
      const falhou = r.status !== 0 || /❌/.test(saida);
      if (falhou) {
        console.log(`  ${dia} ERRO — ${saida.trim().slice(-120)}`);
        // So falha de DADOS vira registro de dia defeituoso; falha geral
        // (credencial, conexao, janela) conta para o freio e nada mais.
        if (/listar os itens da\(s\) venda|Divide by zero/i.test(saida)) {
          falhasGerais = 0;
          db.prepare(
            'INSERT INTO coleta_falhas (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, motivo) '
            + 'VALUES (?, ?, ?, ?, ?, ?)'
          ).run(args.grupo, dominio, m.loja, dia, dia, saida.trim().slice(-300));
          diasRuins.push(`${dominio}: loja ${m.loja} ${dia}`);
        } else {
          falhasGerais += 1;
          if (falhasGerais >= 5) {
            console.error('Cinco falhas gerais seguidas: interrompendo a recuperacao '
              + '(nada foi marcado como tratado). Verifique credenciais e conexao.');
            abortou = true;
            break;
          }
        }
      } else {
        falhasGerais = 0;
        registrosMes += qtd;
        if (qtd > 0) diasComDados += 1;
        console.log(`  ${dia} ${qtd > 0 ? 'ok   ' : 'vazio'} — ${qtd} registro(s)`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervaloMs);
    }
    // Recuperacao abortada por falha geral: o mes fica como estava.
    if (abortou) break;
    // Mes incompleto (janela fechou no meio): fica pendente e a proxima
    // noite recomeca este mes (repetir dia ja baixado nao duplica dados).
    // Dominios sem restricao de janela continuam normalmente.
    if (janelaFechou) continue;
    // Mes tratado: dias bons salvos, dias ruins registrados um a um. Marca a
    // falha mensal como resolvida e registra a cobertura do mes no sync_log
    // para o plano mensal nao busca-lo de novo.
    db.prepare(
      "UPDATE coleta_falhas SET resolvido = 1 WHERE conexao = ? AND dominio = ? "
      + 'AND codigo_loja = ? AND periodo_inicio <> periodo_fim AND substr(periodo_inicio, 1, 7) = ?'
    ).run(args.grupo, dominio, m.loja, m.mes);
    db.prepare(
      'INSERT INTO sync_log (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, registros) '
      + 'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(args.grupo, dominio, m.loja, `${m.mes}-01`,
      `${m.mes}-${String(ultimoDia).padStart(2, '0')}`, registrosMes);
    console.log(`  Loja ${m.loja} ${m.mes} tratado: ${registrosMes} registro(s) recuperado(s).`);
  }
  console.log(`Recuperacao concluida: ${diasComDados} dia(s) com dados salvos; `
    + `${diasRuins.length} dia(s) continuam com defeito no servidor.`);
  progresso(db, { grupo: args.grupo });
  if (diasRuins.length > 0) {
    // O CHAMADO ao suporte da TOTVS ja sai pronto (roadmap da fase de
    // carga): texto com periodos, lojas e identificadores dos registros.
    let caminhoChamado = null;
    try {
      const texto = gerarChamado(db, args.grupo);
      if (texto) {
        const pasta = join(AQUI, '..', 'relatorios', 'documentos');
        mkdirSync(pasta, { recursive: true });
        caminhoChamado = join(pasta,
          `chamado-suporte-totvs-${args.grupo}-${new Date().toISOString().slice(0, 10)}.txt`);
        writeFileSync(caminhoChamado, `${texto}\n`, 'utf8');
        console.log(`Chamado de suporte pronto: ${caminhoChamado}`);
      }
    } catch (erro) { console.warn(`nao consegui gerar o chamado: ${erro.message}`); }
    registrarAlerta({
      titulo: `Dias com defeito no servidor da TOTVS (grupo "${args.grupo}")`,
      detalhe: `Mesmo buscando dia a dia, o servidor da TOTVS respondeu erro em: `
        + `${diasRuins.slice(0, 15).join('; ')}`
        + `${diasRuins.length > 15 ? ` e mais ${diasRuins.length - 15} dia(s)` : ''}.`,
      orientacao: `${caminhoChamado ? `O texto do chamado de suporte já está pronto em ${caminhoChamado} — ` : ''}`
        + 'mostre ao gestor e, se ele aprovar, envie ao suporte da TOTVS: por '
        + 'e-mail (com SMTP configurado e o e-mail de suporte em data/suporte.json) '
        + 'ou copiando o texto no canal que ele usa.',
    });
  }
}

// VERIFICACAO dos dias defeituosos: antes de abrir chamado no suporte da
// TOTVS, cada dia marcado e RE-SONDADO em execucao separada. Se passar,
// era falso positivo (dado salvo, marca resolvida); se falhar de novo com a
// MESMA assinatura de erro de dados, ganha +1 verificacao — e so dia
// verificado entra no chamado. Exigencia do Hugo (27/09/2026).
async function verificarDefeitos(db, args) {
  const fila = db.prepare(
    'SELECT id, dominio, codigo_loja AS loja, periodo_inicio AS dia FROM coleta_falhas '
    + 'WHERE conexao = ? AND resolvido = 0 AND periodo_inicio = periodo_fim AND verificacoes = 0 '
    + 'ORDER BY dominio, loja, dia'
  ).all(args.grupo);
  if (fila.length === 0) return;
  console.log(`Verificacao dos dias defeituosos: ${fila.length} dia(s) a re-sondar.`);
  let confirmados = 0;
  let recuperados = 0;
  let adiados = 0;
  let falhasGerais = 0;
  for (const f of fila) {
    const agora = new Date();
    const h = agora.getHours();
    const noiteAgora = h >= 23 || h < 7;
    if (dominioInfo(f.dominio)?.janelaNoturna && !noiteAgora) { adiados += 1; continue; }
    if (!noiteAgora && h * 60 + agora.getMinutes() >= 22 * 60 + 45) break;
    const r = await rodarSincronizar([
      '--dominio', f.dominio, '--grupo', args.grupo,
      '--loja', String(f.loja), '--de', f.dia, '--ate', f.dia,
    ]);
    const falhou = r.codigo !== 0 || /❌/.test(r.saida);
    if (!falhou) {
      db.prepare('UPDATE coleta_falhas SET resolvido = 1 WHERE id = ?').run(f.id);
      recuperados += 1;
      console.log(`  RECUPERADO ${f.dominio} loja ${f.loja} ${f.dia} (falso positivo).`);
    } else if (ehFalhaDeDados(r.saida)) {
      db.prepare('UPDATE coleta_falhas SET verificacoes = verificacoes + 1 WHERE id = ?').run(f.id);
      confirmados += 1;
      falhasGerais = 0;
    } else {
      adiados += 1;
      falhasGerais += 1;
      if (falhasGerais >= 5) {
        console.error('Verificacao interrompida: cinco falhas gerais seguidas.');
        break;
      }
    }
    await esperar(noiteAgora ? 10_000 : 30_000);
  }
  console.log(`Verificacao concluida: ${confirmados} confirmado(s), ${recuperados} `
    + `recuperado(s) — eram falso positivo, ${adiados} adiado(s).`);
  if (confirmados > 0) {
    try {
      const texto = gerarChamado(db, args.grupo);
      if (texto) {
        const pasta = join(AQUI, '..', 'relatorios', 'documentos');
        mkdirSync(pasta, { recursive: true });
        const caminho = join(pasta,
          `chamado-suporte-totvs-${args.grupo}-${new Date().toISOString().slice(0, 10)}.txt`);
        writeFileSync(caminho, `${texto}\n`, 'utf8');
        registrarAlerta({
          titulo: `Chamado ao suporte da TOTVS verificado e pronto (grupo "${args.grupo}")`,
          detalhe: `${confirmados} dia(s) defeituosos foram RE-VERIFICADOS em execução separada `
            + `(${recuperados} se recuperaram e saíram da lista). O texto do chamado, só com o `
            + `confirmado, está em ${caminho}.`,
          orientacao: 'Leia o texto ao gestor e, com a aprovação dele, envie ao suporte da '
            + 'TOTVS (e-mail via SMTP com data/suporte.json, ou copiando o texto).',
        });
      }
    } catch (erro) { console.warn(`nao consegui gerar o chamado: ${erro.message}`); }
  }
}

// Relatorio HTML de PROGRESSO da carga inicial, para o gestor acompanhar:
// quanto do historico previsto ja esta no computador, loja a loja, o que
// esta com defeito no servidor da TOTVS e o que ainda falta. Gerado pelo
// painel.mjs (identidade visual e tabela interativa por construcao) em
// relatorios/paineis/. Regenerado automaticamente ao fim de cada coleta.
function progresso(db, args) {
  if (!args.grupo) {
    console.error('Uso: lojas.mjs progresso --grupo <id> [--abrir]');
    process.exit(1);
  }
  const grupo = args.grupo;
  const lojas = db.prepare(
    'SELECT codigo_loja, nome, COALESCE(inicio_coleta, data_inicio) AS data_inicio, '
    + 'ultima_venda FROM lojas WHERE conexao = ? ORDER BY codigo_loja'
  ).all(grupo);
  if (lojas.length === 0) {
    // Chamado tambem ao fim de cada coleta: nao pode derrubar o processo.
    console.log(`Nenhuma loja cadastrada no grupo "${grupo}" — sem cadastro não há `
      + 'progresso de carga a mostrar.');
    console.log(avisoSemCadastro(grupo));
    return null;
  }
  // Dominios do registro central (scripts/dominios.mjs): os com historico
  // por PERIODO ganham barra por mes; os de CADASTRO (fotografia) valem
  // pelo "atualizado em". API nova da TOTVS = entrada nova no registro.
  const DOMINIOS_PERIODO = dominiosHistoricos().map((d) => [d.id, d.nome]);
  const DOMINIOS_CADASTRO = dominiosCadastro().map((d) => [d.id, d.nome]);
  const cobertosPorDominio = new Map(
    DOMINIOS_PERIODO.map(([d]) => [d, mesesCobertos(db, grupo, d)])
  );
  const defeitoSet = new Set(db.prepare(
    "SELECT dominio || '|' || codigo_loja || '|' || substr(periodo_inicio, 1, 7) AS chave "
    + 'FROM coleta_falhas WHERE conexao = ? AND resolvido = 0 AND periodo_inicio <> periodo_fim'
  ).all(grupo).map((r) => r.chave));
  const diasRuinsMes = new Map(db.prepare(
    "SELECT dominio || '|' || codigo_loja || '|' || substr(periodo_inicio, 1, 7) AS chave, COUNT(*) AS n "
    + 'FROM coleta_falhas WHERE conexao = ? AND resolvido = 0 AND periodo_inicio = periodo_fim GROUP BY 1'
  ).all(grupo).map((r) => [r.chave, r.n]));
  const semAcesso = new Set(db.prepare(
    "SELECT DISTINCT codigo_loja FROM coleta_falhas WHERE conexao = ? AND resolvido = 0 "
    + "AND motivo LIKE '%acesso a loja%'"
  ).all(grupo).map((r) => r.codigo_loja));
  const ultimoCadastro = new Map(db.prepare(
    "SELECT dominio || '|' || codigo_loja AS chave, MAX(executado_em) AS quando FROM sync_log "
    + 'WHERE conexao = ? AND codigo_loja IS NOT NULL GROUP BY 1'
  ).all(grupo).map((r) => [r.chave, r.quando]));
  const vendasLoja = new Map(db.prepare(
    'SELECT codigo_loja, COUNT(*) AS cupons, ROUND(SUM(valor_total), 2) AS fat '
    + 'FROM vendas WHERE conexao = ? AND cancelada = 0 GROUP BY 1'
  ).all(grupo).map((r) => [r.codigo_loja, r]));

  const somar = (alvo, seg) => { for (const k of Object.keys(alvo)) alvo[k] += seg[k] || 0; };
  const rotuloMes = (m) => `${m.slice(5, 7)}/${m.slice(2, 4)}`;
  const geralSeg = { coletado: 0, defeito: 0, sem_acesso: 0, pendente: 0 };
  const vendasSeg = { coletado: 0, defeito: 0, sem_acesso: 0, pendente: 0 };
  const itens = [];
  for (const l of lojas) {
    if (!l.data_inicio || !l.ultima_venda || l.ultima_venda < l.data_inicio) continue;
    const meses = mesesEntre(l.data_inicio.slice(0, 7), l.ultima_venda.slice(0, 7));
    const lojaSeg = { coletado: 0, defeito: 0, sem_acesso: 0, pendente: 0 };
    const filhos = [];
    for (const [dom, nomeDom] of DOMINIOS_PERIODO) {
      const cobertos = cobertosPorDominio.get(dom);
      const seg = { coletado: 0, defeito: 0, sem_acesso: 0, pendente: 0 };
      const fichas = meses.map((m) => {
        const chaveMes = `${l.codigo_loja}|${m}`;
        const chaveDom = `${dom}|${l.codigo_loja}|${m}`;
        let estado;
        let dica;
        if (cobertos.has(chaveMes)) {
          const nRuins = diasRuinsMes.get(chaveDom);
          if (nRuins) {
            estado = 'defeito';
            dica = `Mês recuperado dia a dia; ${nRuins} dia(s) seguem com defeito no servidor da TOTVS.`;
          } else estado = 'coletado';
        } else if (defeitoSet.has(chaveDom)) {
          estado = 'defeito';
          dica = 'O servidor da TOTVS responde erro neste mês (recuperação dia a dia pendente).';
        } else if (semAcesso.has(l.codigo_loja)) {
          estado = 'sem_acesso';
          dica = 'Usuário da integração sem permissão de acesso a esta loja no ChefWeb.';
        } else estado = 'pendente';
        seg[estado] += 1;
        return { rotulo: rotuloMes(m), estado, dica };
      });
      somar(lojaSeg, seg);
      if (dom === 'vendas') somar(vendasSeg, seg);
      filhos.push({ rotulo: nomeDom, segmentos: seg, fichas });
    }
    for (const [dom, nomeDom] of DOMINIOS_CADASTRO) {
      const quando = ultimoCadastro.get(`${dom}|${l.codigo_loja}`);
      filhos.push({
        rotulo: nomeDom,
        segmentos: quando ? { coletado: 1 } : { pendente: 1 },
        extra: quando ? `atualizado em ${quando.slice(8, 10)}/${quando.slice(5, 7)}` : 'nunca baixado',
      });
    }
    somar(geralSeg, lojaSeg);
    const v = vendasLoja.get(l.codigo_loja) ?? { cupons: 0, fat: 0 };
    itens.push({
      rotulo: `${l.codigo_loja} · ${l.nome ?? ''}`,
      segmentos: lojaSeg,
      extra: v.cupons ? `${v.cupons.toLocaleString('pt-BR')} cupons` : '',
      filhos,
    });
  }
  const pctDe = (seg) => {
    const total = Object.values(seg).reduce((s, n) => s + n, 0);
    return total ? Math.round((seg.coletado * 1000) / total) / 10 : 100;
  };
  const pctGeral = pctDe(geralSeg);
  const pctVendas = pctDe(vendasSeg);
  // Estimativa (todos os dominios): 1 busca por mes pendente + ~30 por mes
  // com defeito (dia a dia), ~30s por busca, noites de ~8h.
  const buscasRestantes = geralSeg.pendente + geralSeg.defeito * 30;
  const noites = Math.max(buscasRestantes > 0 ? 1 : 0, Math.ceil((buscasRestantes * 30) / 3600 / 8));

  const asp = (s) => String(s).replace(/'/g, "''");
  const hoje = new Date().toISOString().slice(0, 10);
  const inicioGeral = lojas.map((l) => l.data_inicio).filter(Boolean).sort()[0] ?? hoje;

  const partes = [];
  if (vendasSeg.defeito > 0) {
    partes.push(`${vendasSeg.defeito} mês(es) de vendas dependem de correção no servidor da TOTVS `
      + '(recuperação dia a dia em andamento; os dias defeituosos vão para chamado no suporte)');
  }
  if (geralSeg.sem_acesso > 0) partes.push('há loja aguardando permissão de acesso no ChefWeb');
  const previsao = new Date(Date.now() + noites * 86400_000);
  const previsaoTxt = `${String(previsao.getDate()).padStart(2, '0')}/${String(previsao.getMonth() + 1).padStart(2, '0')}`;
  const spec = {
    titulo: `Progresso da carga inicial — grupo "${grupo}"`,
    periodo: { de: inicioGeral, ate: hoje },
    grupo,
    observacao: `Vendas ${String(pctVendas).replace('.', ',')}% carregadas (${vendasSeg.coletado} de `
      + `${Object.values(vendasSeg).reduce((s, n) => s + n, 0)} meses)`
      + `${buscasRestantes > 0 ? `; estimativa de ~${noites} noite(s) — previsão de conclusão: ${previsaoTxt}` : ''}. `
      + (partes.length ? `${partes.join('; ')}.` : 'Nenhuma pendência fora do normal.'),
    kpis: [
      { rotulo: 'Vendas carregadas', formato: 'pct', sql: `SELECT ${pctVendas}` },
      { rotulo: 'Todos os tipos de dado', formato: 'pct', sql: `SELECT ${pctGeral}` },
      {
        rotulo: 'Cupons já carregados',
        formato: 'inteiro',
        sql: `SELECT COUNT(*) FROM vendas WHERE conexao='${asp(grupo)}' AND cancelada=0`,
      },
      {
        rotulo: 'Faturamento já carregado',
        formato: 'moeda',
        sql: `SELECT SUM(valor_total) FROM vendas WHERE conexao='${asp(grupo)}' AND cancelada=0`,
      },
      {
        rotulo: 'Meses de vendas restantes',
        formato: 'inteiro',
        sql: `SELECT ${vendasSeg.pendente + vendasSeg.defeito + vendasSeg.sem_acesso}`,
      },
    ],
    graficos: [
      {
        tipo: 'progresso',
        titulo: 'Progresso por loja e por tipo de dado',
        largura: 'cheia',
        dados: {
          geral: { rotulo: 'Grupo inteiro', segmentos: geralSeg },
          itens,
        },
      },
      {
        tipo: 'linha',
        titulo: 'Cupons carregados por mês do histórico',
        formato: 'inteiro',
        largura: 'cheia',
        sql: "SELECT strftime('%Y-%m', data_movimento) AS mes, COUNT(*) AS cupons FROM vendas "
          + `WHERE conexao='${asp(grupo)}' AND cancelada=0 GROUP BY 1 ORDER BY 1`,
      },
    ],
  };

  const pasta = join(AQUI, '..', 'relatorios', 'paineis');
  mkdirSync(pasta, { recursive: true });
  const saida = join(pasta, `progresso-carga-${grupo}-${hoje}.html`);
  const r = spawnSync(process.execPath, [
    '--no-warnings', join(AQUI, 'painel.mjs'), 'gerar', '--spec', '-', '--saida', saida,
    ...(args.abrir ? ['--abrir'] : []),
  ], { input: JSON.stringify(spec), encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`Falha ao gerar o relatorio de progresso: ${(r.stderr ?? '').trim().slice(-300)}`);
    process.exitCode = 1;
    return null;
  }
  console.log(`Relatorio de progresso: ${saida}`);
  return { pctVendas, pctGeral };
}

const acao = process.argv[2];
const args = lerArgs();

// --desanexado: relanca a si mesmo como processo INDEPENDENTE (sobrevive ao
// termino de quem o chamou — agentes agendados tem turnos curtos e ja
// mataram tres coletas ao encerrar) e sai na hora, informando PID e log.
// A trava de coleta continua garantindo execucao unica.
if (acao === 'coletar' && args.desanexado) {
  const dia = new Date().toISOString().slice(0, 10);
  const caminhoLog = join(AQUI, '..', 'data', `coleta-${args.grupo ?? (args['todos-grupos'] ? 'todos' : 'grupo')}-${dia}.log`);
  mkdirSync(dirname(caminhoLog), { recursive: true });
  const fd = openSync(caminhoLog, 'a');
  const argumentos = process.argv.slice(2).filter((a) => a !== '--desanexado');
  const filho = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), ...argumentos], {
    detached: true, stdio: ['ignore', fd, fd],
  });
  filho.unref();
  console.log(`Coleta desanexada: processo ${filho.pid}, acompanhe em ${caminhoLog}.`);
  console.log('Pode encerrar o turno: o processo segue sozinho ate concluir.');
  process.exit(0);
}
const db = abrirBanco();
criarSchema(db);
if (acao === 'importar') importar(db, args);
else if (acao === 'definir') definir(db, args);
else if (acao === 'listar') listar(db, args);
else if (acao === 'plano') plano(db, args);
else if (acao === 'coletar' && args.verificar) await verificarDefeitos(db, args);
else if (acao === 'coletar' && args['dia-a-dia']) coletarDiaADia(db, args);
else if (acao === 'coletar' && args['todos-grupos']) {
  // Percorre todos os grupos com lojas cadastradas — e o modo dos
  // agendamentos automaticos (a carga inicial se conduz sozinha ate D-1).
  const grupos = carregarConexoes().filter((g) => (
    db.prepare('SELECT COUNT(*) AS n FROM lojas WHERE conexao = ?').get(g.id).n > 0
  ));
  if (grupos.length === 0) console.log('Nenhum grupo com lojas cadastradas para coletar.');
  for (const g of grupos) {
    console.log(`===== grupo "${g.id}" =====`);
    await coletar(db, { ...args, grupo: g.id });
  }
}
else if (acao === 'coletar') await coletar(db, args);
else if (acao === 'progresso') progresso(db, args);
else {
  console.error('Ação inválida. Use: definir | importar | listar | plano | coletar | progresso');
  process.exitCode = 1;
}
db.close();
