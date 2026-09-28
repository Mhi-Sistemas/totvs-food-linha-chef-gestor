// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// CARGA INICIAL — o que o assistente busca sozinho assim que o acesso e
// configurado, para o gestor ter dados NA PRIMEIRA CONVERSA em vez de esperar
// madrugadas de coleta.
//
// A ordem importa e e deliberada:
//   1. VENDAS dos ultimos 16 dias — a API libera esse recorte a qualquer hora
//      (alem de 16 dias so entre 23h e 07h), entao sai na hora;
//   2. TODOS OS DEMAIS DOMINIOS que nao tem trava de horario nem janela —
//      fechamentos, sangrias, financeiro, notas, catalogo, estoque, clientes;
//   3. SITUACAO: o que ficou disponivel, em linguagem de gestor, para ele ja
//      poder pedir relatorio ou analise;
//   4. (conversa, nao comando) perguntar se ele quer o historico e A PARTIR DE
//      QUAL DATA, loja por loja — ver a skill `configurar`. A resposta vai
//      para `lojas.mjs definir --inicio`, e so entao a carga historica comeca.
//
// Uso:
//   node --no-warnings scripts/carga-inicial.mjs [--grupo <id>] [--dias N]
//   node --no-warnings scripts/carga-inicial.mjs situacao [--grupo <id>]

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { abrirBanco, criarSchema } from './criar-banco.mjs';
import { carregarConexoes } from './conexoes.mjs';
import { DOMINIOS, dominio as dominioInfo } from './dominios.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// A CapaVenda libera periodos que alcancam ate 16 dias atras a qualquer hora;
// alem disso, so na janela 23h-07h. Este e o recorte que sempre cabe de dia.
const DIAS_LIVRES_DE_VENDAS = 16;

function lerArgs(inicio) {
  const args = {};
  const argv = process.argv.slice(inicio);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const nome = argv[i].slice(2);
    const proximo = argv[i + 1];
    if (proximo && !proximo.startsWith('--')) { args[nome] = proximo; i += 1; }
    else args[nome] = true;
  }
  return args;
}

const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;
function somarDias(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return diaLocal(d);
}
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

function sincronizar(argumentos) {
  const r = spawnSync(process.execPath,
    ['--no-warnings', join(RAIZ, 'scripts', 'sincronizar.mjs'), ...argumentos],
    { cwd: RAIZ, encoding: 'utf8' });
  return { ok: r.status === 0, saida: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

// Nem toda falha e problema: catalogo e estoque tem COTA DIARIA na API (uma
// consulta completa por dia). Quem ja rodou hoje nao precisa de novo — chamar
// isso de "falhou" assustaria o gestor a toa.
function resultado(r) {
  if (r.ok) return 'ok';
  const ultima = r.saida.split('\n').pop() ?? '';
  if (/quantidade máxima liberada para o dia|quantidade maxima liberada/i.test(r.saida)) {
    return 'já baixado hoje (a TOTVS libera uma vez por dia)';
  }
  return `falhou (${ultima.slice(0, 120)})`;
}

// ---------- passo 3: o que ja esta disponivel ----------
// Le o sync_log e traduz para o que o gestor pode pedir hoje. Nao e relatorio
// tecnico: e a lista do que ja da para analisar.
function situacao(grupos) {
  const db = abrirBanco({ somenteLeitura: true });
  try {
    for (const g of grupos) {
      console.log(`\n=== ${g.nome ?? g.id} ===`);
      const linhas = db.prepare(
        'SELECT dominio, MIN(periodo_inicio) AS de, MAX(periodo_fim) AS ate, '
        + 'SUM(registros) AS registros, MAX(executado_em) AS quando '
        + 'FROM sync_log WHERE conexao = ? GROUP BY dominio'
      ).all(g.id);
      const porDominio = new Map(linhas.map((l) => [l.dominio, l]));
      let algum = false;
      for (const d of DOMINIOS) {
        const l = porDominio.get(d.id);
        if (!l || !l.registros) { console.log(`  ${d.nome.padEnd(22)} —`); continue; }
        algum = true;
        console.log(`  ${d.nome.padEnd(22)} ${d.tipo === 'periodo'
          ? `${dmy(l.de)} a ${dmy(l.ate)}`
          : `atualizado em ${dmy(String(l.quando).slice(0, 10))}`}`
          + ` (${Number(l.registros).toLocaleString('pt-BR')} registro(s))`);
      }
      if (!algum) console.log('  (nada baixado ainda)');
      // O estado do historico sai SEMPRE, inclusive com o banco vazio: e a
      // deixa da conversa do passo 4, e e justamente no grupo recem-criado
      // que o gestor precisa ouvir a pergunta.
      const lojas = db.prepare(
        'SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(inicio_coleta, data_inicio) IS NULL '
        + 'THEN 1 ELSE 0 END) AS sem_data FROM lojas WHERE conexao = ?'
      ).get(g.id);
      if (!lojas || lojas.n === 0) {
        console.log('\n  Histórico: nenhuma loja informada ainda — PERGUNTE ao gestor quais são '
          + 'as lojas (o número de cada uma) e a partir de qual data ele quer os dados, '
          + `depois grave com "lojas.mjs definir --grupo ${g.id} --loja <n> --inicio AAAA-MM-DD".`);
      } else if (lojas.sem_data > 0) {
        console.log(`\n  Histórico: ${lojas.sem_data} de ${lojas.n} loja(s) ainda sem data de `
          + 'início — pergunte ao gestor a partir de quando ele quer os dados de cada uma.');
      } else {
        console.log(`\n  Histórico: ${lojas.n} loja(s) com data definida — `
          + `veja o plano com "lojas.mjs plano --grupo ${g.id} --noite".`);
      }
    }
  } finally { db.close(); }
}

// ---------- passos 1 e 2 ----------
async function executar(args) {
  const todos = carregarConexoes();
  if (todos.length === 0) {
    console.error('Nenhum acesso configurado ainda. Rode scripts/configurar.mjs primeiro.');
    process.exit(1);
  }
  const grupos = args.grupo ? todos.filter((g) => g.id === args.grupo) : todos;
  if (grupos.length === 0) {
    console.error(`Grupo "${args.grupo}" não está configurado.`);
    process.exit(1);
  }

  const dias = Number(args.dias ?? DIAS_LIVRES_DE_VENDAS);
  const ate = somarDias(-1); // D-1: hoje so chega depois do fechamento de caixa
  const de = somarDias(-dias);

  // Passo 2 lista tudo o que nao depende da janela noturna. Vendas ficam de
  // fora daqui porque tem recorte proprio (passo 1).
  const livres = DOMINIOS.filter((d) => d.id !== 'vendas' && !d.janelaNoturna);
  const comPeriodo = livres.filter((d) => d.tipo === 'periodo');
  const cadastros = livres.filter((d) => d.tipo === 'cadastro');

  console.log('CARGA INICIAL — o que dá para buscar agora, sem esperar a madrugada');
  console.log(`Período: ${dmy(de)} a ${dmy(ate)} | grupos: ${grupos.map((g) => g.nome ?? g.id).join(', ')}`);
  console.log(`Buscas previstas por grupo: ${1 + comPeriodo.length + cadastros.length} `
    + '(a TOTVS pede ~30s entre buscas, então leve alguns minutos).\n');

  for (const g of grupos) {
    console.log(`=== ${g.nome ?? g.id} ===`);

    // 1) Vendas dos ultimos 16 dias — o unico recorte de vendas liberado de dia.
    process.stdout.write(`  ${dominioInfo('vendas').nome}... `);
    const vendas = sincronizar(['--dominio', 'vendas', '--grupo', g.id, '--de', de, '--ate', ate]);
    console.log(resultado(vendas));

    // 2) Tudo o que nao tem trava de horario.
    for (const d of comPeriodo) {
      process.stdout.write(`  ${d.nome}... `);
      const r = sincronizar(['--dominio', d.id, '--grupo', g.id, '--de', de, '--ate', ate]);
      console.log(resultado(r));
    }
    for (const d of cadastros) {
      process.stdout.write(`  ${d.nome}... `);
      const r = sincronizar(['--dominio', d.id, '--grupo', g.id]);
      console.log(resultado(r));
    }
  }

  // 3) O que o gestor ja pode pedir.
  console.log('\n\nO QUE VOCÊ JÁ TEM');
  situacao(grupos);

  // 4) A conversa que falta.
  console.log('\n\nPRÓXIMO PASSO (converse com o gestor, não rode nada ainda)');
  console.log('  Pergunte se ele quer o histórico e, LOJA POR LOJA, o número dela e a partir');
  console.log('  de qual data ele quer os dados — pode ser desde o início das vendas ou só os');
  console.log('  últimos anos; a escolha é dele. Depois grave cada resposta com:');
  console.log('    lojas.mjs definir --grupo <id> --loja <n> --nome "..." --inicio AAAA-MM-DD');
  console.log('  e monte o plano com "lojas.mjs plano --grupo <id> --noite".');
}

const acao = process.argv[2];
if (acao === 'situacao') {
  const args = lerArgs(3);
  const db = abrirBanco(); criarSchema(db); db.close();
  const todos = carregarConexoes();
  const grupos = args.grupo ? todos.filter((g) => g.id === args.grupo) : todos;
  if (grupos.length === 0) {
    console.error('Nenhum grupo configurado (ou o id informado não existe).');
    process.exit(1);
  }
  situacao(grupos);
} else if (!acao || acao.startsWith('--')) {
  const db = abrirBanco(); criarSchema(db); db.close();
  await executar(lerArgs(2));
} else {
  console.error('Ação inválida. Use: (sem ação) para executar a carga inicial, ou "situacao".');
  process.exit(1);
}
