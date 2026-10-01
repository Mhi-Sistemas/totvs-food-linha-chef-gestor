// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Rotina diaria: o que transforma o assistente em habito.
//
// Todo dia, sem o gestor pedir: busca o movimento de ontem (D-1) de todos os
// grupos, recuperando tambem os dias em que o computador ficou desligado;
// tira a fotografia do estoque (sem ela o CMV real nunca podera ser calculado
// — nao da para fotografar o passado); atualiza o catalogo uma vez por semana;
// e termina guardando a copia de seguranca do banco.
//
// Uso:
//   node --no-warnings scripts/rotina.mjs executar [--simular]
//   node --no-warnings scripts/rotina.mjs ativar --hora HH:MM
//   node --no-warnings scripts/rotina.mjs desativar
//   node --no-warnings scripts/rotina.mjs status
//
// A hora NAO tem padrao de proposito: agendar para uma hora em que o
// computador do gestor esta desligado e nunca rodar. Quem ativa precisa ter
// perguntado ao gestor a que horas a maquina costuma estar ligada (sugestao:
// inicio do expediente). Qualquer horario funciona para os dados de ontem;
// de madrugada (23h-07h) a espera entre buscas cai de 30s para 10s.

import { spawnSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { carregarConexoes } from './conexoes.mjs';
import { abrirBanco, criarSchema, CAMINHO_BANCO } from './criar-banco.mjs';
import { criarBackup, pastaDeBackup, listarCopias } from './backup.mjs';
import { aplicarAtualizacao } from './atualizar.mjs';
import { dominio as dominioInfo } from './dominios.mjs';
import { marcarParaRecoleta, diasParaRecoletar } from './completude.mjs';
import { registrarAlerta } from './alertas.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOME_AGENDAMENTO = 'rotina-diaria';

// Dominios que dependem de periodo, na ordem de importancia para o gestor.
const DOMINIOS_DIARIOS = [
  // conferencia-vendas vem logo apos as vendas de proposito: e a testemunha
  // que permite saber, no mesmo dia, se a coleta de vendas veio completa.
  'vendas', 'conferencia-vendas', 'fechamentos', 'sangrias', 'provisao',
  'contas-pagar', 'livro-caixa', 'notas-venda', 'notas-entrada',
];
// Sem periodo: estoque e diario (fotografia); catalogo e semanal (produtos
// tem cota diaria de consultas na API — nao vale gastar todo dia).
const DOMINIOS_SEMANAIS = ['produtos', 'clientes'];

const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const isoLocal = (data) => `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
const somarDias = (iso, n) => isoLocal(new Date(new Date(`${iso}T12:00:00`).getTime() + n * 86400000));

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

function rodarScript(nome, argumentos) {
  const resultado = spawnSync(
    process.execPath,
    ['--no-warnings', join(RAIZ, 'scripts', nome), ...argumentos],
    { cwd: RAIZ, stdio: 'inherit' }
  );
  return resultado.status === 0;
}

// CADASTRO DESATUALIZADO: produtos e clientes sao semanais porque a consulta
// completa tem cota diaria na API — nao vale gastar todo dia com um cadastro
// que muda pouco. So que isso deixa ate 6 dias de defasagem, e nesse intervalo
// a fotografia de estoque valoriza pelo custo velho e o cliente novo fica sem
// ficha.
//
// A saida: continuar semanal POR PADRAO e antecipar quando o proprio movimento
// denuncia que o cadastro mudou — um produto vendido que o catalogo nao
// conhece, um cliente que nunca foi baixado.
//
// So olha o movimento RECENTE: varrer a base inteira a cada rotina seria caro
// num banco de 10 GB, e cadastro novo aparece em venda nova.
const DIAS_PARA_OLHAR_CADASTRO = 45;
// Depois disso, desiste daquele codigo: produto excluido no ChefWeb nunca vai
// aparecer no catalogo, e insistir queimaria a cota diaria todo dia.
const MAX_TENTATIVAS_CADASTRO = 2;

function codigosSemCadastro(db, conexao, tipo, desde) {
  const sql = tipo === 'produtos'
    ? `SELECT DISTINCT i.codigo_produto AS codigo
         FROM venda_itens i
         JOIN vendas v ON v.conexao = i.conexao AND v.chave_venda = i.chave_venda
        WHERE i.conexao = ? AND v.data_movimento >= ?
          AND i.codigo_produto IS NOT NULL AND i.codigo_produto NOT IN (997, 999)
          AND NOT EXISTS (SELECT 1 FROM produtos p
                           WHERE p.conexao = i.conexao AND p.codigo = i.codigo_produto)`
    : `SELECT DISTINCT v.cliente_codigo AS codigo
         FROM vendas v
        WHERE v.conexao = ? AND v.data_movimento >= ? AND v.cliente_codigo > 0
          AND NOT EXISTS (SELECT 1 FROM clientes c
                           WHERE c.conexao = v.conexao AND c.codigo = v.cliente_codigo)`;
  try { return db.prepare(sql).all(conexao, desde).map((r) => r.codigo); } catch { return []; }
}

// Quantos codigos ainda valem uma tentativa.
//
// LEITURA PURA: esta funcao e chamada por `montarPlano`, que recebe o banco em
// SOMENTE LEITURA. Escrever aqui nao so falharia como — pior — o catch
// silencioso transformaria a falha em "antecipar sempre", queimando a cota
// diaria da API todo dia. Quem grava e `registrarTentativaCadastro`, no
// caminho de escrita.
function cadastroPrecisaAtualizar(db, conexao, tipo, desde) {
  const codigos = codigosSemCadastro(db, conexao, tipo, desde);
  if (codigos.length === 0) return 0;
  let esgotados;
  try {
    esgotados = new Set(db.prepare(
      'SELECT codigo FROM cadastros_ausentes WHERE conexao = ? AND tipo = ? AND tentativas >= ?'
    ).all(conexao, tipo, MAX_TENTATIVAS_CADASTRO).map((r) => r.codigo));
  } catch { esgotados = new Set(); } // banco de versao anterior
  return codigos.filter((c) => !esgotados.has(c)).length;
}

// Depois de baixar o cadastro: quem continua faltando entra no controle (ou
// ganha mais uma tentativa); quem apareceu sai da lista.
function registrarTentativaCadastro(db, conexao, tipo, desde) {
  try {
    const aindaFaltam = codigosSemCadastro(db, conexao, tipo, desde);
    const vivos = new Set(aindaFaltam);
    for (const { codigo } of db.prepare(
      'SELECT codigo FROM cadastros_ausentes WHERE conexao = ? AND tipo = ?'
    ).all(conexao, tipo)) {
      if (!vivos.has(codigo)) {
        db.prepare('DELETE FROM cadastros_ausentes WHERE conexao = ? AND tipo = ? AND codigo = ?')
          .run(conexao, tipo, codigo);
      }
    }
    const somar = db.prepare(`INSERT INTO cadastros_ausentes (conexao, tipo, codigo, tentativas)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(conexao, tipo, codigo) DO UPDATE SET tentativas = tentativas + 1`);
    for (const codigo of aindaFaltam) somar.run(conexao, tipo, codigo);
  } catch { /* melhor esforco */ }
}

// Ate onde cada dominio ja foi baixado, por grupo. Devolve Map
// "conexao|dominio" -> { fim, quando } (dominios sem periodo tem fim vazio,
// mas registram quando rodaram — e o caso de produtos e clientes).
function ultimasSincronizacoes(db) {
  const mapa = new Map();
  const linhas = db.prepare(
    'SELECT conexao, dominio, MAX(periodo_fim) AS fim, MAX(executado_em) AS quando FROM sync_log GROUP BY conexao, dominio'
  ).all();
  for (const l of linhas) mapa.set(`${l.conexao}|${l.dominio}`, { fim: l.fim, quando: l.quando });
  return mapa;
}

// Monta o plano do dia: para cada grupo e dominio, o periodo que falta baixar.
function montarPlano(db, conexoes) {
  const agora = new Date();
  const hoje = isoLocal(agora);
  const ontem = somarDias(hoje, -1);
  const hora = agora.getHours();
  const dentroDaJanela = hora >= 23 || hora < 7;
  // Dentro da janela limitamos a 31 dias por rodada para a rotina nao virar
  // madrugada inteira. Fora dela, a TOTVS bloqueia mais de 16 dias — mas so
  // nos dominios com trava de horario (as vendas). Dominio sem trava, como a
  // conferencia de vendas, pode recuperar o atraso inteiro de dia: era isso
  // que impedia a testemunha de alcancar a venda que ela deveria conferir.
  const limiteJanela = somarDias(hoje, -15);
  const limiteRodada = somarDias(ontem, -30);

  const ultimas = ultimasSincronizacoes(db);
  const plano = [];
  for (const conexao of conexoes) {
    for (const dominio of DOMINIOS_DIARIOS) {
      const fim = ultimas.get(`${conexao.id}|${dominio}`)?.fim;
      let de = fim ? somarDias(fim, 1) : somarDias(ontem, -6);
      const travado = dominioInfo(dominio)?.janelaNoturna === true;
      const maisAntigoPermitido = dentroDaJanela || !travado ? limiteRodada : limiteJanela;
      let truncado = false;
      if (de < maisAntigoPermitido) { de = maisAntigoPermitido; truncado = true; }
      if (de > ontem) {
        plano.push({ grupo: conexao.id, dominio, situacao: 'em dia', ate: fim });
        continue;
      }
      plano.push({ grupo: conexao.id, dominio, situacao: 'baixar', de, ate: ontem, truncado });
    }
    // Fotografia diaria do estoque — mas UMA por dia: a consulta completa de
    // estoque tem cota diaria na API (erro 20 "quantidade maxima liberada para
    // o dia"); se a foto de hoje ja existe, nao gasta a cota de novo.
    const fotoDeHoje = ultimas.get(`${conexao.id}|estoque`)?.fim === hoje;
    plano.push(fotoDeHoje
      ? { grupo: conexao.id, dominio: 'estoque', situacao: 'em dia', ate: hoje }
      : { grupo: conexao.id, dominio: 'estoque', situacao: 'baixar' });
    // Catalogo e clientes: as segundas, se nunca foi baixado, OU quando o
    // movimento recente traz codigo que o cadastro nao conhece.
    const segunda = agora.getDay() === 1;
    const desdeCadastro = somarDias(hoje, -DIAS_PARA_OLHAR_CADASTRO);
    for (const dominio of DOMINIOS_SEMANAIS) {
      const jaTeve = ultimas.has(`${conexao.id}|${dominio}`);
      const novos = jaTeve ? cadastroPrecisaAtualizar(db, conexao.id, dominio, desdeCadastro) : 0;
      if (segunda || !jaTeve || novos > 0) {
        plano.push({
          grupo: conexao.id,
          dominio,
          situacao: 'baixar',
          motivo: !jaTeve ? null : (novos > 0 && !segunda
            ? `${novos} ${dominio === 'produtos' ? 'produto(s)' : 'cliente(s)'} no movimento sem cadastro`
            : null),
        });
      } else plano.push({ grupo: conexao.id, dominio, situacao: 'em dia (semanal)' });
    }
  }
  return { plano, ontem, dentroDaJanela };
}

const NOME_TAREFA_NOTURNA = 'assistentechef-carga-noturna';

// Disco quase cheio derruba backup, agendamento e coleta em silencio (caso
// real de 27/09/2026) — e o gestor leigo jamais descobriria sozinho. A
// rotina vigia e avisa com folga.
function vigiarEspacoEmDisco() {
  try {
    const d = statfsSync(RAIZ);
    const livreGB = (d.bsize * d.bavail) / 1024 ** 3;
    if (livreGB < 2) {
      registrarAlerta({
        titulo: 'Espaço em disco acabando neste computador',
        detalhe: `O disco onde o assistente guarda seus dados está com apenas `
          + `${livreGB.toFixed(1).replace('.', ',')} GB livres. Sem espaço, a busca de dados, a cópia de `
          + 'segurança e até outros programas do computador começam a falhar.',
        orientacao: 'Libere espaço no computador (esvaziar a lixeira, remover '
          + 'downloads e arquivos grandes antigos). O assistente ocupa ~1 GB; o '
          + 'restante é de outros programas e arquivos seus.',
      });
      console.warn(`⚠️ disco com so ${livreGB.toFixed(1)} GB livres — alerta registrado.`);
    }
  } catch { /* melhor esforco */ }
}

function rodarLojas(argumentos) {
  return spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'lojas.mjs'), ...argumentos],
    { cwd: RAIZ, encoding: 'utf8' });
}

function garantirCargaInicial() {
  const db = abrirBanco({ somenteLeitura: true });
  let grupos;
  let semCadastro;
  try {
    const todos = carregarConexoes();
    const comLojas = (g) => db.prepare('SELECT COUNT(*) AS n FROM lojas WHERE conexao = ?')
      .get(g.id).n > 0;
    grupos = todos.filter(comLojas);
    semCadastro = todos.filter((g) => !comLojas(g));
  } finally { db.close(); }

  // Grupo configurado e sem cadastro de lojas = carga historica que nunca
  // comeca. Ficar em silencio aqui e o pior defeito possivel: o gestor
  // esperaria para sempre por um historico que ninguem esta buscando.
  for (const g of semCadastro) {
    console.log(`\n  carga inicial do grupo "${g.nome ?? g.id}": nao comecou — ainda nao sei `
      + 'quais sao as lojas nem a partir de qual data buscar.');
    registrarAlerta({
      unico: true,
      chave: `sem-cadastro-lojas:${g.id}`,
      titulo: `Falta dizer quais são as lojas do grupo "${g.nome ?? g.id}"`,
      detalhe: 'O acesso está funcionando, mas ainda não sei quais lojas existem nem desde '
        + 'quando cada uma vende — por isso a busca do histórico não começou. Enquanto isso, '
        + 'só o movimento do dia a dia está sendo atualizado.',
      orientacao: 'Perguntar ao gestor quais são as lojas (o número de cada uma) e a partir '
        + 'de qual data ele quer os dados de cada uma — a data é escolha dele, pode ser o '
        + 'início das vendas ou só os últimos anos. Gravar com '
        + `"lojas.mjs definir --grupo ${g.id} --loja <n> --inicio AAAA-MM-DD".`,
    });
  }
  if (grupos.length === 0) return;

  // 1) Dispara ja, desanexada, a coleta do que estiver pendente.
  const d = rodarLojas(['coletar', '--todos-grupos', '--com-dia-a-dia', '--desanexado']);
  const primeiraLinha = `${d.stdout ?? ''}${d.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? '';
  console.log(`\n  carga inicial: ${primeiraLinha}`);

  // 2) Vendas pendentes em algum grupo? Mantem (ou remove) o agendamento
  // noturno no sistema operacional — e ele que cobre a janela 23h-07h
  // mesmo sem nenhum ambiente de agente aberto.
  const db2 = abrirBanco({ somenteLeitura: true });
  let vendasPendentes = false;
  try {
    for (const g of grupos) {
      const falhas = db2.prepare(
        "SELECT COUNT(*) AS n FROM coleta_falhas WHERE conexao = ? AND dominio = 'vendas' AND resolvido = 0"
      ).get(g.id).n;
      const plano = rodarLojas(['plano', '--grupo', g.id, '--dominio', 'vendas', '--noite']);
      const total = Number(/TOTAL:\s*(\d+)/.exec(plano.stdout ?? '')?.[1] ?? 0);
      if (total > 0 || falhas > 0) { vendasPendentes = true; break; }
    }
  } finally { db2.close(); }

  const agendar = (argumentos) => spawnSync(process.execPath,
    ['--no-warnings', join(RAIZ, 'scripts', 'agendar.mjs'), ...argumentos], { cwd: RAIZ, encoding: 'utf8' });
  const existe = (agendar(['listar']).stdout ?? '').includes(NOME_TAREFA_NOTURNA);
  if (vendasPendentes && !existe) {
    const c = agendar(['criar', '--nome', NOME_TAREFA_NOTURNA, '--hora', '23:10', '--diario',
      '--comando', 'lojas.mjs coletar --todos-grupos --com-dia-a-dia --desanexado']);
    console.log(c.status === 0
      ? '  carga noturna de vendas agendada no sistema (23:10, diaria) — computador precisa estar ligado.'
      : `  nao consegui agendar a carga noturna: ${(c.stderr ?? '').trim().slice(-160)}`);
  } else if (!vendasPendentes && existe) {
    agendar(['cancelar', '--nome', NOME_TAREFA_NOTURNA]);
    console.log('  carga de vendas concluida: agendamento noturno do sistema removido.');
  }
}

async function executar(args) {
  vigiarEspacoEmDisco();
  const conexoes = carregarConexoes();
  if (conexoes.length === 0) {
    console.error('Nenhuma loja conectada ainda — a rotina nao tem o que buscar. Configure o acesso primeiro.');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(CAMINHO_BANCO)) {
    const db = abrirBanco();
    try { criarSchema(db); } finally { db.close(); }
  }

  const db = abrirBanco({ somenteLeitura: true });
  let plano; let ontem; let dentroDaJanela;
  try { ({ plano, ontem, dentroDaJanela } = montarPlano(db, conexoes)); } finally { db.close(); }

  const agora = new Date();
  console.log(`ROTINA DIARIA — ${dmy(isoLocal(agora))} ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`
    + ` (ate ontem, ${dmy(ontem)}${dentroDaJanela ? ', janela noturna' : ''})`);

  const aBaixar = plano.filter((p) => p.situacao === 'baixar');
  if (args.simular) {
    for (const p of plano) {
      const periodo = (p.de ? ` ${dmy(p.de)} a ${dmy(p.ate)}${p.truncado ? ' (parte antiga fica para a madrugada)' : ''}` : '')
        + (p.motivo ? ` — antecipado: ${p.motivo}` : '');
      console.log(`  [${p.grupo}] ${p.dominio}: ${p.situacao}${periodo}`);
    }
    console.log(`Simulacao: ${aBaixar.length} busca(s) seriam feitas; nada foi baixado.`);
    return;
  }

  // Cada busca roda num processo proprio, e o controle de intervalo da TOTVS
  // vive dentro do processo — entre uma busca e a seguinte quem espera e a
  // rotina, senao a primeira chamada do processo novo viola o limite.
  const resumo = [];
  for (const [indice, p] of aBaixar.entries()) {
    if (indice > 0) {
      const hora = new Date().getHours();
      const esperaMs = (hora >= 23 || hora < 7) ? 10_000 : 30_000;
      console.log(`\n⏳ aguardando ${esperaMs / 1000}s (limite de requisicoes da TOTVS)...`);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    const argumentos = ['--dominio', p.dominio, '--grupo', p.grupo];
    if (p.de) argumentos.push('--de', p.de, '--ate', p.ate);
    console.log(`\n>> [${p.grupo}] ${p.dominio}${p.de ? ` (${dmy(p.de)} a ${dmy(p.ate)})` : ''}`);
    const ok = rodarScript('sincronizar.mjs', argumentos);
    if (ok && DOMINIOS_SEMANAIS.includes(p.dominio)) {
      const dbT = abrirBanco();
      try {
        registrarTentativaCadastro(dbT, p.grupo, p.dominio,
          somarDias(isoLocal(new Date()), -DIAS_PARA_OLHAR_CADASTRO));
      } finally { dbT.close(); }
    }
    resumo.push({ ...p, ok });
  }

  // Copia de seguranca fecha a rotina — o dia so conta se estiver guardado.
  let backup = null;
  let erroBackup = null;
  try { backup = await criarBackup({ silencioso: true }); } catch (erro) { erroBackup = erro.message; }

  // Por ultimo, a verificacao silenciosa de versao nova do assistente: se
  // houver, aplica e registra em data/atualizacao.json (o assistente anuncia
  // ao gestor na proxima conversa). Sem internet ou sem acesso, fica quieto
  // e tenta amanha. Roda por ultimo de proposito: o codigo novo so passa a
  // valer na proxima execucao, nunca no meio de uma.
  // CONFERENCIA E RECOLETA DOS DIAS INCOMPLETOS.
  //
  // Roda no fim de proposito: as testemunhas do dia (fechamento de caixa e
  // conferencia de vendas) sao baixadas DEPOIS das vendas, entao antes disso
  // nao haveria com o que comparar.
  //
  // O que estiver incompleto entra na fila de recoleta e e rebuscado aqui
  // mesmo, um dia por vez. O que resistir a tres tentativas nao e mais
  // problema de coleta — e defeito do lado da TOTVS, e vira alerta com
  // proposta de chamado.
  try {
    const dbC = abrirBanco();
    try {
      const ateOntem = somarDias(isoLocal(new Date()), -1);
      const desde = somarDias(ateOntem, -35);
      for (const conexao of conexoes) {
        const { marcados } = marcarParaRecoleta(dbC, { conexao: conexao.id, de: desde, ate: ateOntem });
        if (marcados > 0) {
          console.log(`  [${conexao.id}] ${marcados} dia(s) vieram incompletos — entrando na fila de recoleta.`);
        }

        // Rebusca poucos por rodada para nao virar madrugada; o resto fica
        // para amanha, e a fila so encolhe.
        for (const d of diasParaRecoletar(dbC, conexao.id, 5)) {
          const r = spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'sincronizar.mjs'),
            '--dominio', 'vendas', '--grupo', conexao.id, '--loja', String(d.codigo_loja),
            '--de', d.dia, '--ate', d.dia], { cwd: RAIZ, encoding: 'utf8' });
          if (r.status === 0) console.log(`  [${conexao.id}] rebuscado ${dmy(d.dia)} da loja ${d.codigo_loja}.`);
        }

        // Segunda passagem: tira da fila o que a rebusca resolveu e descobre
        // quem ja resistiu a tres tentativas.
        const { persistentes } = marcarParaRecoleta(dbC, { conexao: conexao.id, de: desde, ate: ateOntem });
        if (persistentes.length > 0) {
          const total = persistentes.reduce((t, d) => t + (d.caixa - d.vendas), 0);
          registrarAlerta({
            chave: `dias-incompletos-${conexao.id}`,
            titulo: `${persistentes.length} dia(s) que o sistema da TOTVS não entrega completos`,
            detalhe: `Mesmo depois de três tentativas, ${persistentes.length} dia(s) continuam vindo `
              + 'com menos vendas do que o próprio caixa registrou — cerca de '
              + `${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} de movimento. `
              + `Exemplos: ${persistentes.slice(0, 3)
                .map((d) => `${dmy(d.dia)} loja ${d.codigo_loja}`).join('; ')}.`,
            orientacao: 'Isso é defeito do lado da TOTVS, não da sua operação. Posso montar o texto '
              + 'do chamado para o suporte deles com os dias e os valores. Enquanto isso, os '
              + 'relatórios desse período saem com a ressalva de dados incompletos.',
          });
        }
      }
    } finally { dbC.close(); }
  } catch (erro) { console.warn(`  conferência dos dados: ${erro.message}`); }

  // Relatos que o gestor enviou: descobre o que a equipe ja resolveu ou
  // respondeu e transforma em alerta, para ele saber que foi atendido sem
  // precisar voltar ao site. Silencioso quando nao ha nada.
  try {
    const r = spawnSync(process.execPath,
      ['--no-warnings', join(RAIZ, 'scripts', 'reportar.mjs'), 'verificar', '--silencioso'],
      { cwd: RAIZ, encoding: 'utf8' });
    if (r.status === 0 && r.stdout?.trim()) console.log(`  relatos: ${r.stdout.trim()}`);
  } catch { /* sem rede: fica para amanha */ }

  // Pendencia da lista de espera do benchmark (se houver, tenta reenviar).
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'benchmark.mjs'), 'enviar-pendentes'], { cwd: RAIZ, encoding: 'utf8' });
    if (r.stdout?.includes('enviada')) console.log('  lista de espera do benchmark: inscrição pendente enviada.');
  } catch { /* fica para amanha */ }

  // Estatisticas do banco em dia: o planejador de consultas depende delas
  // para manter os relatorios rapidos com o banco crescendo (10 GB+).
  try {
    const dbEstat = abrirBanco();
    dbEstat.exec('PRAGMA optimize;');
    dbEstat.close();
  } catch { /* melhor esforco */ }

  let atualizacao = null;
  try { atualizacao = await aplicarAtualizacao({ silencioso: true }); } catch { /* amanha */ }

  // CARGA INICIAL: a rotina garante a continuidade ate a conclusao (D-1)
  // SEM o gestor pedir — dispara agora a coleta desanexada do que estiver
  // pendente (se nada estiver, ela sai sozinha em segundos e a trava impede
  // duplicata) e mantem o agendamento NOTURNO do sistema enquanto houver
  // vendas pendentes (unico dominio restrito a janela 23h-07h).
  try { garantirCargaInicial(); } catch (erro) { console.warn(`  carga inicial: ${erro.message}`); }

  console.log('\nRESUMO DA ROTINA');
  for (const p of plano.filter((x) => x.situacao !== 'baixar')) {
    console.log(`  [${p.grupo}] ${p.dominio}: ${p.situacao}${p.ate ? ` (ate ${dmy(p.ate)})` : ''}`);
  }
  for (const r of resumo) {
    const periodo = r.de ? ` ${dmy(r.de)} a ${dmy(r.ate)}` : '';
    console.log(`  [${r.grupo}] ${r.dominio}:${periodo} ${r.ok ? 'ok' : 'FALHOU (veja acima)'}${r.truncado ? ' — parte antiga fica para a madrugada' : ''}`
      + `${r.motivo ? ` — antecipado: ${r.motivo}` : ''}`);
  }
  console.log(backup
    ? `  copia de seguranca: ok (${backup.caminho})`
    : `  copia de seguranca: FALHOU${erroBackup ? ` (${erroBackup})` : ''}`);
  if (atualizacao?.situacao === 'atualizado') {
    console.log(`  assistente ATUALIZADO: versao ${atualizacao.local} -> ${atualizacao.nova} (aviso em data/atualizacao.json)`);
  }

  const falhas = resumo.filter((r) => !r.ok).length;
  if (falhas > 0) {
    console.log(`Atencao: ${falhas} busca(s) falharam; a proxima rotina tenta de novo sozinha.`);
    // Alerta para o assistente dar ao gestor na primeira conversa do dia.
    const quais = resumo.filter((r) => !r.ok).map((r) => `[${r.grupo}] ${r.dominio}`).join(', ');
    registrarAlerta({
      titulo: 'Falhas na atualização diária dos dados',
      detalhe: `Na rotina de ${new Date().toLocaleDateString('pt-BR')} não consegui `
        + `baixar: ${quais}. Detalhes técnicos em data/rotina-diaria.log.`,
      orientacao: 'A próxima rotina tenta de novo sozinha. Se o mesmo dado falhar por '
        + 'vários dias seguidos, conferir as permissões do usuário da integração no '
        + 'ChefWeb ou abrir chamado no suporte da TOTVS.',
    });
  }
  if (resumo.length > 0 && falhas === resumo.length && !backup) process.exitCode = 1;
}

function ativar(args) {
  if (typeof args.hora !== 'string') {
    console.error(
      'Informe o horario: rotina.mjs ativar --hora HH:MM\n'
      + 'Nao existe horario padrao de proposito: pergunte ao gestor a que horas o\n'
      + 'computador dele costuma estar ligado (sugestao: inicio do expediente) e\n'
      + 'agende para essa hora — agendar para hora de maquina desligada e nunca rodar.'
    );
    process.exitCode = 1;
    return;
  }
  const ok = rodarScript('agendar.mjs', [
    'criar', '--nome', NOME_AGENDAMENTO, '--hora', args.hora,
    '--comando', 'rotina.mjs executar', '--diario',
  ]);
  if (!ok) { process.exitCode = 1; return; }
  console.log(
    `\nRotina diaria ativada para as ${args.hora}: busca o movimento de ontem, fotografa\n`
    + 'o estoque e guarda a copia de seguranca. IMPORTANTE: o computador precisa estar\n'
    + 'ligado e sem suspensao nesse horario; se ficar desligado, a proxima execucao\n'
    + 'recupera os dias perdidos sozinha. Para mudar o horario, rode ativar de novo.'
  );
}

function desativar() {
  if (!rodarScript('agendar.mjs', ['cancelar', '--nome', NOME_AGENDAMENTO])) process.exitCode = 1;
}

function status() {
  const conexoes = carregarConexoes();
  if (existsSync(CAMINHO_BANCO)) {
    const db = abrirBanco({ somenteLeitura: true });
    try {
      const ultimas = ultimasSincronizacoes(db);
      for (const c of conexoes) {
        console.log(`Grupo ${c.nome} (${c.id}):`);
        for (const dominio of [...DOMINIOS_DIARIOS, 'estoque', ...DOMINIOS_SEMANAIS]) {
          const u = ultimas.get(`${c.id}|${dominio}`);
          const texto = u?.fim
            ? `ate ${dmy(u.fim)}`
            : (u?.quando ? `baixado em ${dmy(u.quando.slice(0, 10))}` : 'nunca baixado');
          console.log(`  ${dominio}: ${texto}`);
        }
      }
    } finally { db.close(); }
  } else {
    console.log('Banco local ainda nao existe.');
  }
  const copias = listarCopias(pastaDeBackup());
  console.log(copias.length > 0
    ? `Ultima copia de seguranca: ${dmy(copias[0].dia)} (${copias[0].nome})`
    : 'Nenhuma copia de seguranca ainda.');
  console.log('\nAgendamentos do sistema:');
  rodarScript('agendar.mjs', ['listar']);
}

const acao = process.argv[2];
const args = lerArgs();
if (acao === 'executar') await executar(args);
else if (acao === 'ativar') ativar(args);
else if (acao === 'desativar') desativar();
else if (acao === 'status') status();
else {
  console.error('Acao invalida. Use: executar [--simular] | ativar [--hora HH:MM] | desativar | status');
  process.exitCode = 1;
}
