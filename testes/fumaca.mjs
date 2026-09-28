// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Teste de fumaca multiplataforma: exercita os fluxos que nao dependem de
// credenciais reais nem de interface grafica. Roda em macOS, Windows e Linux
// no GitHub Actions (.github/workflows/testes.yml) — e localmente, DESDE QUE
// em um clone limpo: para nao tocar dados reais, ele se recusa a rodar onde
// exista data/conexoes.json.
//
// Uso: node --no-warnings testes/fumaca.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DADOS = join(RAIZ, 'data');
const EH_WINDOWS = process.platform === 'win32';

if (existsSync(join(DADOS, 'conexoes.json'))) {
  console.error('Este teste cria e apaga dados locais — rode-o num CLONE LIMPO, nunca onde há configuração real (data/conexoes.json existe aqui).');
  process.exit(1);
}

let falhas = 0;
let avisos = 0;
const ok = (nome) => console.log(`  ✅ ${nome}`);
const falhou = (nome, detalhe) => { falhas += 1; console.error(`  ❌ ${nome} — ${detalhe}`); };
const aviso = (nome, detalhe) => { avisos += 1; console.warn(`  ⚠️ ${nome} — ${detalhe}`); };

function rodar(argumentos, { entrada = null } = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', ...argumentos], {
    cwd: RAIZ, encoding: 'utf8', input: entrada ?? undefined, timeout: 120_000,
  });
  return { codigo: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function passo(nome, fn) {
  try { fn(); ok(nome); } catch (erro) { falhou(nome, erro.message); }
}
async function passoAsync(nome, fn) {
  try { await fn(); ok(nome); } catch (erro) { falhou(nome, erro.message); }
}
function espera(cond, detalhe) { if (!cond) throw new Error(detalhe); }

console.log(`FUMACA — ${process.platform} ${process.arch}, Node ${process.versions.node}\n`);

// 1. Sintaxe de todos os scripts
passo('sintaxe de todos os scripts', () => {
  for (const nome of readdirSync(join(RAIZ, 'scripts')).filter((n) => n.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath, ['--check', join(RAIZ, 'scripts', nome)], { encoding: 'utf8' });
    espera(r.status === 0, `${nome}: ${r.stderr}`);
  }
});

// 2. Configuracao ficticia (dois grupos; a simulacao da rotina nao chama a API)
passo('configuração fictícia gravada', () => {
  mkdirSync(DADOS, { recursive: true });
  // Backups do teste vao para dentro do proprio clone — sem isso, o passo de
  // backup escreveria na pasta Documentos REAL da maquina (e, por o nome ser
  // por dia, poderia sobrescrever uma copia verdadeira).
  writeFileSync(join(DADOS, 'backup.json'), JSON.stringify({ pasta: join(DADOS, 'copias-fumaca') }), 'utf8');
  writeFileSync(join(DADOS, 'conexoes.json'), JSON.stringify({
    conexoes: [
      { id: 'grupo-a', nome: 'Grupo A', usuario: 'teste', senha: 'x'.repeat(8), serial: '000000', chave: 'SerialNumber', urlBase: 'http://127.0.0.1:9', lojas: [1] },
      { id: 'grupo-b', nome: 'Grupo B', usuario: 'teste', senha: 'y'.repeat(8), serial: '111111', chave: 'SerialNumber', urlBase: 'http://127.0.0.1:9', lojas: [1, 2] },
    ],
  }, null, 2), 'utf8');
});

// 3. Instalacao (banco + pastas; sem atalho para nao tocar a area de trabalho)
passo('instalar.mjs prepara o projeto', () => {
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'instalar.mjs'), '--sem-atalho']);
  espera(codigo === 0, saida.slice(0, 200));
  espera(existsSync(join(DADOS, 'chef.db')), 'banco não foi criado');
  espera(existsSync(join(DADOS, 'memoria', 'aprendizados.md')) && existsSync(join(DADOS, 'memoria', 'handoff.md')), 'memória do gestor não foi criada');
});

// 4. Rotina: simulacao calcula o plano por grupo sem chamar a API
passo('rotina --simular monta o plano', () => {
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'rotina.mjs'), 'executar', '--simular']);
  espera(codigo === 0, saida.slice(0, 200));
  espera(saida.includes('[grupo-a] vendas') && saida.includes('[grupo-b] estoque'), 'plano incompleto');
  espera(saida.includes('nada foi baixado'), 'simulação deveria avisar que nada foi baixado');
});
passo('rotina ativar exige --hora', () => {
  const { codigo } = rodar([join(RAIZ, 'scripts', 'rotina.mjs'), 'ativar']);
  espera(codigo === 1, 'deveria recusar sem --hora');
});

// 5. Agendador do sistema (schtasks/cron) — ciclo completo
passo('agendar criar/listar/cancelar', () => {
  const nome = 'fumaca-ci';
  try {
    const criar = rodar([join(RAIZ, 'scripts', 'agendar.mjs'), 'criar', '--nome', nome, '--hora', '23:59', '--comando', 'rotina.mjs executar', '--diario']);
    if (criar.codigo !== 0 && !EH_WINDOWS) { aviso('agendar (cron)', `indisponível neste ambiente: ${criar.saida.slice(0, 120)}`); return; }
    espera(criar.codigo === 0, criar.saida.slice(0, 200));
    const listar = rodar([join(RAIZ, 'scripts', 'agendar.mjs'), 'listar']);
    espera(listar.saida.includes(nome), 'tarefa criada não aparece na listagem');
  } finally {
    rodar([join(RAIZ, 'scripts', 'agendar.mjs'), 'cancelar', '--nome', nome]);
  }
});

// 5b. Cadastro de lojas — e ele que dirige a carga historica. Sem cadastro,
// nada de historico; loja sem data de inicio fica fora do plano. Os comandos
// tem de dizer isso em voz alta, nunca falhar em silencio nem derrubar o
// processo (regressao real: `plano` saia com exit(1) e matava a coleta toda).
passo('cadastro de lojas dirige a carga', () => {
  const lojas = (...args) => rodar([join(RAIZ, 'scripts', 'lojas.mjs'), ...args]);

  const semCadastro = lojas('plano', '--grupo', 'grupo-a');
  espera(semCadastro.codigo === 0, 'plano sem cadastro não pode derrubar o processo');
  espera(/Nenhuma loja cadastrada/.test(semCadastro.saida)
    && /definir/.test(semCadastro.saida), 'plano sem cadastro deveria orientar o caminho');

  const definir = lojas('definir', '--grupo', 'grupo-a', '--loja', '1',
    '--nome', 'Loja Fumaça', '--inicio', '2026-01-01');
  espera(definir.codigo === 0, definir.saida.slice(0, 200));

  // Sem data de inicio a loja existe, mas fica FORA do plano — e o comando avisa.
  const semInicio = lojas('definir', '--grupo', 'grupo-a', '--loja', '2', '--nome', 'Sem Início');
  espera(semInicio.codigo === 0 && /Falta a data de início/.test(semInicio.saida),
    'definir sem --inicio deveria avisar que a loja fica fora da carga');

  const listar = lojas('listar', '--grupo', 'grupo-a');
  espera(/Loja Fumaça/.test(listar.saida) && /DATA A INFORMAR/.test(listar.saida),
    'listar deveria mostrar a loja cadastrada e marcar a que falta data');

  const plano = lojas('plano', '--grupo', 'grupo-a', '--dominio', 'vendas');
  espera(/1 loja\(s\) sem data de início/.test(plano.saida),
    'plano deveria contar a loja sem data de início fora do plano');
  espera(/TOTAL: \d+ buscas/.test(plano.saida), 'plano deveria estimar o total de buscas');

  // Datas invalidas nao entram no cadastro (senao a carga varre periodo errado).
  espera(lojas('definir', '--grupo', 'grupo-a', '--loja', '3', '--inicio', 'ontem').codigo === 1,
    'definir deveria recusar data de início inválida');
  espera(lojas('definir', '--grupo', 'grupo-a', '--loja', '1',
    '--inicio', '2026-05-01', '--ultima-venda', '2026-02-01').codigo === 1,
    'definir deveria recusar última venda anterior ao início');
  espera(lojas('definir', '--grupo', 'grupo-a', '--loja', '4', '--inicio', '2099-01-01').codigo === 1,
    'definir deveria recusar data de início no futuro');
});

// 5c. Carga inicial — o que o gestor recebe no primeiro dia. O passo 3 (dizer
// o que ja esta disponivel) nao pode depender de API: le so o banco local.
passo('carga inicial mostra o que já está disponível', () => {
  const r = rodar([join(RAIZ, 'scripts', 'carga-inicial.mjs'), 'situacao', '--grupo', 'grupo-a']);
  espera(r.codigo === 0, r.saida.slice(0, 200));
  espera(/Grupo A/.test(r.saida), 'situação deveria identificar o grupo');
  // Com loja cadastrada e sem data em uma delas, precisa cobrar a data que falta.
  espera(/sem data de início|Histórico/.test(r.saida),
    'situação deveria dizer em que pé está o histórico');
  espera(rodar([join(RAIZ, 'scripts', 'carga-inicial.mjs'), 'coisa-errada']).codigo === 1,
    'ação inválida deveria sair com erro');
});

// 6. Dados de exemplo direto no banco (para consultar/exportar/backup)
await passoAsync('semear vendas de exemplo', async () => {
  const { abrirBanco, criarSchema } = await import('../scripts/criar-banco.mjs');
  const db = abrirBanco();
  try {
    criarSchema(db);
    const ins = db.prepare('INSERT OR REPLACE INTO vendas (chave_venda, conexao, codigo_loja, data_movimento, valor_total, cancelada) VALUES (?,?,?,?,?,0)');
    ins.run('t-1', 'grupo-a', 1, '2026-09-20', 100.5);
    ins.run('t-2', 'grupo-a', 1, '2026-09-21', 200.25);
    ins.run('t-3', 'grupo-b', 1, '2026-09-21', 50);
  } finally { db.close(); }
});
passo('consultar.mjs lê e soma', () => {
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'consultar.mjs'), '--json', 'SELECT COUNT(*) AS n, ROUND(SUM(valor_total),2) AS total FROM vendas WHERE cancelada = 0']);
  espera(codigo === 0 && JSON.parse(saida)[0].n === 3 && JSON.parse(saida)[0].total === 350.75, saida.slice(0, 200));
});

// 7. Exportacoes (xlsx do SQL; docx de markdown; pdf se houver Chrome/Edge)
passo('exportar xlsx', () => {
  const destino = join(RAIZ, 'relatorios', 'fumaca.xlsx');
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'exportar.mjs'), 'xlsx', '--saida', destino, '--aba', 'Vendas=SELECT data_movimento, valor_total FROM vendas ORDER BY 1']);
  espera(codigo === 0, saida.slice(0, 200));
  espera(readFileSync(destino).subarray(0, 2).toString() === 'PK', 'xlsx não é um zip válido');
});
passo('exportar docx', () => {
  const md = join(tmpdir(), 'fumaca.md');
  writeFileSync(md, '# Título\n\nParágrafo com **negrito**.\n\n- item 1\n- item 2\n', 'utf8');
  const destino = join(RAIZ, 'relatorios', 'fumaca.docx');
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'exportar.mjs'), 'docx', '--entrada', md, '--saida', destino]);
  espera(codigo === 0, saida.slice(0, 200));
  espera(readFileSync(destino).subarray(0, 2).toString() === 'PK', 'docx não é um zip válido');
});
await passoAsync('exportar pdf (se houver navegador)', async () => {
  const { acharNavegadorChromium } = await import('../scripts/plataforma.mjs');
  if (!acharNavegadorChromium()) { aviso('exportar pdf', 'nenhum Chrome/Edge neste ambiente'); return; }
  const html = join(RAIZ, 'relatorios', 'fumaca.html');
  writeFileSync(html, '<!DOCTYPE html><html><body><h1>Fumaça</h1></body></html>', 'utf8');
  const destino = join(RAIZ, 'relatorios', 'fumaca.pdf');
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'exportar.mjs'), 'pdf', '--entrada', html, '--saida', destino]);
  espera(codigo === 0, saida.slice(0, 200));
  espera(readFileSync(destino).subarray(0, 4).toString() === '%PDF', 'saída não é PDF');
});

// 7b. Gerador de paineis: espec com filtro -> HTML autossuficiente
passo('painel gerar (com filtro e KPIs)', () => {
  const spec = JSON.stringify({
    titulo: 'Painel de fumaça',
    periodo: { de: '2026-09-01', ate: '2026-09-30' },
    observacao: 'gerado pelo teste',
    filtro: { rotulo: 'Grupo', todas: 'Todos', parametro: 'g',
      opcoes_sql: "SELECT DISTINCT conexao, conexao FROM vendas ORDER BY 1" },
    kpis: [{ rotulo: 'Faturamento', formato: 'moeda',
      sql: "SELECT SUM(valor_total) FROM vendas WHERE cancelada=0 AND ('{{g}}'='' OR conexao='{{g}}')" }],
    graficos: [
      { tipo: 'linha', titulo: 'Por dia', formato: 'moeda', largura: 'cheia',
        sql: "SELECT data_movimento, SUM(valor_total) FROM vendas WHERE cancelada=0 AND ('{{g}}'='' OR conexao='{{g}}') GROUP BY 1 ORDER BY 1" },
      { tipo: 'barras_h', titulo: 'Drill grupo -> loja', formato: 'moeda', niveis: [
        { sql: "SELECT conexao, SUM(valor_total) FROM vendas WHERE cancelada=0 GROUP BY 1 ORDER BY 2 DESC" },
        { sql: "SELECT 'Loja '||codigo_loja, SUM(valor_total) FROM vendas WHERE cancelada=0 AND conexao='{{pai}}' GROUP BY 1" },
      ] },
    ],
  });
  const destino = join(RAIZ, 'relatorios', 'fumaca-painel.html');
  const r = rodar([join(RAIZ, 'scripts', 'painel.mjs'), 'gerar', '--spec', '-', '--saida', destino], { entrada: spec });
  espera(r.codigo === 0, r.saida.slice(0, 200));
  espera(r.saida.includes('3 recorte(s)'), 'filtro deveria criar 3 recortes (Todos + 2 grupos): ' + r.saida.slice(0, 120));
  const html = readFileSync(destino, 'utf8');
  espera(html.includes('id="filtro"'), 'seletor de filtro ausente');
  espera(html.includes('R$'), 'KPI inicial deveria vir renderizado do servidor');
  espera(html.includes('echarts'), 'biblioteca de graficos nao foi embutida');
  espera(html.includes('MHI Sistemas'), 'atribuicao de autoria ausente');
  espera(html.includes('"filhos"') && html.includes('Loja 1'), 'drill-down nao pre-calculou os filhos');
});
passo('painel tipo tabela (busca/ordenacao)', () => {
  const spec = JSON.stringify({
    titulo: 'Relatorio de fumaça',
    graficos: [{ tipo: 'tabela', titulo: 'Vendas', largura: 'cheia',
      sql: "SELECT data_movimento, conexao, valor_total FROM vendas WHERE cancelada=0 ORDER BY 1" }],
  });
  const destino = join(RAIZ, 'relatorios', 'paineis', 'fumaca-tabela.html');
  const r = rodar([join(RAIZ, 'scripts', 'painel.mjs'), 'gerar', '--spec', '-', '--saida', destino], { entrada: spec });
  espera(r.codigo === 0, r.saida.slice(0, 200));
  const html = readFileSync(destino, 'utf8');
  espera(html.includes('renderTabela') && html.includes('Buscar em tudo'), 'tabela interativa ausente');
  espera(html.includes('"colunas"') && html.includes('moeda'), 'metadados de coluna ausentes');
});

// 7c. DRE gerencial: duas visoes x dois regimes num HTML autossuficiente
passo('dre gerar (visões e regimes)', () => {
  const destino = join(RAIZ, 'relatorios', 'fumaca-dre.html');
  const r = rodar([join(RAIZ, 'scripts', 'dre.mjs'), 'gerar', '--mes', '2026-09', '--saida', destino]);
  espera(r.codigo === 0, r.saida.slice(0, 200));
  const html = readFileSync(destino, 'utf8');
  espera(html.includes('Mensal (set/26)') && html.includes('Anual ('), 'visões ausentes');
  espera(html.includes('Competência') && html.includes('Caixa'), 'regimes ausentes');
  espera(html.includes('RECEITA BRUTA') && html.includes('GERAÇÃO DE CAIXA'), 'linhas dos dois regimes ausentes');
  espera(html.includes('echarts') && html.includes('MHI Sistemas'), 'cascata/autoria ausentes');
});

// 8. Backup: criar, listar, recusar sem confirmação, restaurar e conferir
passo('backup criar/listar/restaurar', () => {
  const criar = rodar([join(RAIZ, 'scripts', 'backup.mjs'), 'criar']);
  espera(criar.codigo === 0, criar.saida.slice(0, 200));
  const nome = criar.saida.match(/chef-backup-[\d-]+\.db\.gz/)?.[0];
  espera(nome, 'não achei o nome da cópia na saída');
  const semConfirmar = rodar([join(RAIZ, 'scripts', 'backup.mjs'), 'restaurar', '--arquivo', nome]);
  espera(semConfirmar.codigo === 1, 'restaurar sem --confirmar deveria recusar');
  const restaurar = rodar([join(RAIZ, 'scripts', 'backup.mjs'), 'restaurar', '--arquivo', nome, '--confirmar']);
  espera(restaurar.codigo === 0 && restaurar.saida.includes('3 vendas'), restaurar.saida.slice(0, 200));
});

// 9. E-mail: protocolo SMTP completo contra um servidor falso em TLS local
await passoAsync('smtp de ponta a ponta (servidor falso)', async () => {
  const certos = join(tmpdir(), `fumaca-cert-${Date.now()}`);
  mkdirSync(certos, { recursive: true });
  const chave = join(certos, 'k.pem');
  const cert = join(certos, 'c.pem');
  const gerar = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', chave, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  if (gerar.status !== 0) { aviso('smtp', 'openssl indisponível neste ambiente'); rmSync(certos, { recursive: true, force: true }); return; }
  const { iniciarSmtpFalso } = await import('./smtp-falso.mjs');
  const servico = await iniciarSmtpFalso({ chave, cert, usuario: 'u@t.com', senha: 'segredo1' });
  const anterior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const { enviarEmail } = await import('../scripts/email.mjs');
    await enviarEmail(
      { para: 'a@b.com,c@d.com', assunto: 'Fumaça — açaí & pão', texto: 'corpo', anexos: [join(RAIZ, 'CHANGELOG.md')] },
      { host: '127.0.0.1', porta: servico.porta, seguranca: 'ssl', usuario: 'u@t.com', senha: 'segredo1', nome: 'Fumaça', remetente: 'u@t.com' },
    );
    const capturada = servico.mensagem();
    espera(capturada.includes('To: a@b.com, c@d.com'), 'destinatários ausentes');
    const parte = capturada.split('attachment')[1] ?? '';
    const b64 = parte.split('\r\n\r\n')[1]?.split('\r\n--')[0] ?? '';
    const bytes = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    espera(bytes.equals(readFileSync(join(RAIZ, 'CHANGELOG.md'))), 'anexo corrompido');
  } finally {
    if (anterior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = anterior;
    servico.fechar();
    rmSync(certos, { recursive: true, force: true });
  }
});

// 10. Caminhos de erro falam lingua de gestor e saem com codigo certo
passo('erros amigáveis e códigos de saída', () => {
  espera(rodar([join(RAIZ, 'scripts', 'email.mjs'), 'testar']).codigo === 1, 'email sem config deveria falhar');
  espera(rodar([join(RAIZ, 'scripts', 'analisar.mjs')]).codigo === 1, 'analisar sem ação deveria falhar');
  const consulta = rodar([join(RAIZ, 'scripts', 'consultar.mjs'), 'DELETE FROM vendas']);
  espera(consulta.codigo === 1 && consulta.saida.includes('leitura'), 'consultar deveria recusar escrita');
});

// 11. Verificacao de atualizacao nao explode (em dia, nova ou indisponivel)
passo('atualizar verificar', () => {
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'atualizar.mjs'), 'verificar']);
  espera(codigo === 0, saida.slice(0, 200));
});

console.log(`\nRESULTADO: ${falhas === 0 ? 'APROVADO' : 'REPROVADO'} — ${falhas} falha(s), ${avisos} aviso(s).`);
process.exitCode = falhas === 0 ? 0 : 1;
