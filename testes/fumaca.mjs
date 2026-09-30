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

// 3. Instalacao (banco + pastas)
passo('instalar.mjs prepara o projeto', () => {
  const { codigo, saida } = rodar([join(RAIZ, 'scripts', 'instalar.mjs')]);
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

// 5d. Pagina de configuracao: precisa SOBREVIVER a quem a abriu. O assistente
// que dispara o comando costuma ter limite de poucos minutos por comando; se a
// pagina morresse junto, ela sumiria no meio da configuracao (aconteceu num
// teste real de onboarding). Por isso roda desanexada e se acompanha por
// `status`.
await passoAsync('página de configuração sobrevive a quem a abriu', async () => {
  const cfg = join(RAIZ, 'scripts', 'configurar.mjs');
  const estado = join(DADOS, 'configuracao-aberta.json');
  try {
    const abrir = rodar([cfg, '--sem-navegador']);
    espera(abrir.codigo === 0, abrir.saida.slice(0, 200));
    espera(/Página de configuração aberta: http:\/\/127\.0\.0\.1:\d+/.test(abrir.saida),
      `deveria anunciar o endereço: ${abrir.saida.slice(0, 200)}`);
    espera(existsSync(estado), 'deveria registrar o estado para o assistente acompanhar');

    // O processo que abriu ja terminou: a pagina tem de continuar respondendo.
    const { endereco } = JSON.parse(readFileSync(estado, 'utf8'));
    const r = await fetch(endereco, { signal: AbortSignal.timeout(10_000) });
    espera(r.status === 200, `a página deveria responder 200, veio ${r.status}`);
    const html = await r.text();
    espera(/Personalizar o assistente/.test(html),
      'a personalização precisa estar acessível já na primeira tela');

    // Tela de credenciais (aqui ja ha acessos, entao a raiz mostra a lista).
    const rc = await fetch(`${endereco}novo`, { signal: AbortSignal.timeout(10_000) });
    const htmlCred = await rc.text();
    espera(/Testando seu acesso no sistema da TOTVS/.test(htmlCred),
      'a tela de credenciais deveria avisar que o teste demora');
    espera(/Personalizar o assistente/.test(htmlCred),
      'a personalização precisa estar acessível também na tela de credenciais');

    espera(rodar([cfg, 'status']).saida.includes('ABERTA'), 'status deveria dizer que está aberta');
    // Chamar de novo nao pode abrir uma segunda pagina.
    espera(/já está aberta/.test(rodar([cfg, '--sem-navegador']).saida),
      'não deveria abrir uma segunda página');
  } finally {
    try {
      const { pid } = JSON.parse(readFileSync(estado, 'utf8'));
      process.kill(pid);
    } catch { /* ja encerrou */ }
    try { rmSync(estado); } catch { /* ok */ }
  }
});

// 5d2. Formulario da lista de espera: mesma exigencia da pagina de
// configuracao — sobreviver a quem o abriu e validar sem derrubar a pagina.
// NAO envia nada: o envio valido dispararia para o webhook de verdade.
await passoAsync('formulário da lista de espera se sustenta', async () => {
  const bm = join(RAIZ, 'scripts', 'benchmark.mjs');
  const estado = join(DADOS, 'lista-espera-pagina.json');
  try {
    const abrir = rodar([bm, 'lista-espera', '--sem-navegador']);
    espera(abrir.codigo === 0, abrir.saida.slice(0, 200));
    espera(existsSync(estado), 'deveria registrar onde a página está');

    const { endereco } = JSON.parse(readFileSync(estado, 'utf8'));
    const r = await fetch(endereco, { signal: AbortSignal.timeout(10_000) });
    espera(r.status === 200, `a página deveria responder 200, veio ${r.status}`);
    const html = await r.text();
    for (const campo of ['empresa', 'nome', 'telefone', 'email']) {
      espera(html.includes(`name="${campo}"`), `falta o campo ${campo}`);
    }
    const tf = /name="tf" value="([a-f0-9]+)"/.exec(html)?.[1];
    espera(Boolean(tf), 'falta o token do formulário');

    // Dado invalido volta com erro NA PROPRIA pagina, sem encerrar nada.
    const ruim = await fetch(`${endereco}entrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tf, empresa: 'X', nome: 'Y', telefone: '1', email: 'nao-e-email' }),
      signal: AbortSignal.timeout(10_000),
    });
    espera(/não parece válido/.test(await ruim.text()), 'e-mail inválido deveria ser recusado com explicação');
    const aindaNoAr = await fetch(endereco, { signal: AbortSignal.timeout(10_000) });
    espera(aindaNoAr.status === 200, 'a página não pode cair depois de um erro de preenchimento');
  } finally {
    try {
      const { pid } = JSON.parse(readFileSync(estado, 'utf8'));
      process.kill(pid);
    } catch { /* ja encerrou */ }
    try { rmSync(estado); } catch { /* ok */ }
  }
});

// 5e. ATUALIZAR NAO PODE APAGAR O QUE E DO GESTOR. A atualizacao automatica
// roda sozinha, em silencio: se um dia ela sobrescrever as personalizacoes,
// as metas, os relatorios gerados ou a memoria do assistente, o gestor perde
// o que construiu e ninguem percebe. Este teste fixa a regra.
passo('atualização preserva o que é do gestor', () => {
  const meus = [
    ['data', 'perfil-agente.json', '{"assistente_nome":"Sofia"}'],
    ['data', 'memoria/aprendizados.md', '# Preferência dele'],
    ['data', 'conexoes.json', null], // ja existe: nao pode ser tocado
    ['personalizados', 'minha-analise.md', '# Minha análise'],
    ['personalizados', 'identidade/identidade.json', '{"cabecalho":"#123456"}'],
    ['relatorios', 'paineis/meu-painel.html', '<html>meu painel</html>'],
  ];
  for (const [pasta, rel, conteudo] of meus) {
    if (conteudo === null) continue;
    const alvo = join(RAIZ, pasta, rel);
    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, conteudo, 'utf8');
  }
  const antes = new Map(meus.filter(([, , c]) => c !== null)
    .map(([p, rel]) => [join(p, rel), readFileSync(join(RAIZ, p, rel), 'utf8')]));

  // A lista de exclusao do atualizador e o que garante isso na pratica.
  const fonte = readFileSync(join(RAIZ, 'scripts', 'atualizar.mjs'), 'utf8');
  const naoCopiar = /const NAO_COPIAR = new Set\(\[([^\]]*)\]\)/.exec(fonte)?.[1] ?? '';
  for (const pasta of ['data', 'relatorios', 'personalizados']) {
    espera(naoCopiar.includes(`'${pasta}'`),
      `"${pasta}" precisa estar fora da cópia da atualização, senão o gestor perde o que é dele`);
  }

  // A preparacao que a atualizacao reexecuta (instalar + migracoes) tambem
  // nao pode encostar nesses arquivos.
  const r = rodar([join(RAIZ, 'scripts', 'instalar.mjs')]);
  espera(r.codigo === 0, r.saida.slice(0, 200));
  for (const [rel, conteudo] of antes) {
    espera(readFileSync(join(RAIZ, rel), 'utf8') === conteudo,
      `"${rel}" foi alterado pela preparação da nova versão`);
  }
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
// 7b. Inventario: o xlsx que o exportar.mjs escreve serve de cobaia para o
// leitor de planilha, entao um teste so cobre os dois lados (escrita e
// leitura) e a importacao ponta a ponta.
passo('inventário: ler planilha e importar', () => {
  const destino = join(RAIZ, 'relatorios', 'fumaca-inventario.xlsx');
  // Duas contagens: a vespera do periodo e o fechamento — as duas pontas que
  // o CMV real precisa.
  const sql = "SELECT 1 AS Loja, '2026-01-31' AS Data, 77 AS 'Nº Inventario', 1 AS 'Código',"
    + " 'PRODUTO TESTE' AS Produto, 'ALIMENTOS' AS Grupo, 'X' AS Subgrupo,"
    + " 10 AS 'Qtde Contada', 4 AS 'Qtde Atual', 6 AS 'Diferença', 'UN' AS Un,"
    + " 60 AS Valor, 'ACERTO' AS Motivo"
    + " UNION ALL SELECT 1, '2026-02-28', 78, 1, 'PRODUTO TESTE', 'ALIMENTOS', 'X',"
    + " 3, 1, 2, 'UN', 20, 'ACERTO'";
  const exp = rodar([join(RAIZ, 'scripts', 'exportar.mjs'), 'xlsx', '--saida', destino, '--aba', `Inv=${sql}`]);
  espera(exp.codigo === 0, exp.saida.slice(0, 200));

  const imp = rodar([join(RAIZ, 'scripts', 'inventario.mjs'), 'importar', '--arquivo', destino, '--grupo', 'grupo-a']);
  espera(imp.codigo === 0, imp.saida.slice(0, 300));
  espera(/2 linha\(s\) guardada/.test(imp.saida), `importação não confirmou: ${imp.saida.slice(0, 200)}`);

  // O custo da epoca sai de valor / diferenca: 60 / 6 = 10.
  const q = rodar([join(RAIZ, 'scripts', 'consultar.mjs'), '--json',
    'SELECT data, codigo_loja, numero, quantidade_contada AS q, custo_unitario AS c FROM inventarios']);
  const linhas = JSON.parse(q.saida).sort((a, b) => a.data.localeCompare(b.data));
  espera(linhas.length === 2, `esperava 2 linhas, veio ${linhas.length}`);
  espera(linhas[0].data === '2026-01-31' && linhas[0].codigo_loja === 1 && linhas[0].numero === '77',
    `identificação errada: ${JSON.stringify(linhas[0])}`);
  espera(linhas[0].q === 10 && linhas[0].c === 10, `quantidade/custo errados: ${JSON.stringify(linhas[0])}`);

  // Reimportar o mesmo arquivo nao pode duplicar.
  rodar([join(RAIZ, 'scripts', 'inventario.mjs'), 'importar', '--arquivo', destino, '--grupo', 'grupo-a']);
  const q2 = rodar([join(RAIZ, 'scripts', 'consultar.mjs'), '--json', 'SELECT COUNT(*) AS n FROM inventarios']);
  espera(JSON.parse(q2.saida)[0].n === 2, 'reimportar duplicou o inventário');

  // Sem dizer o grupo, com dois configurados, tem de recusar com orientacao.
  const semGrupo = rodar([join(RAIZ, 'scripts', 'inventario.mjs'), 'importar', '--arquivo', destino]);
  espera(semGrupo.codigo !== 0 && /grupo/i.test(semGrupo.saida), 'deveria exigir --grupo com 2 grupos');
});

passo('CMV real usa o inventário quando não há fotografia', () => {
  const cmvArgs = [join(RAIZ, 'scripts', 'analisar.mjs'), 'cmv',
    '--grupo', 'grupo-a', '--de', '2026-02-01', '--ate', '2026-02-28'];

  // Sem plano de contas marcado como mercadoria nao ha como apurar as compras:
  // o comando tem de EXPLICAR o que falta, nunca inventar um numero.
  const semPlano = rodar(cmvArgs);
  espera(semPlano.codigo === 0 && /compra de mercadoria/.test(semPlano.saida),
    `não orientou sobre o plano de contas: ${semPlano.saida.slice(0, 300)}`);
  rodar([join(RAIZ, 'scripts', 'categorias-planos.mjs'), 'definir', 'COMPRAS|*=mercadoria']);

  const { codigo, saida } = rodar(cmvArgs);
  espera(codigo === 0, saida.slice(0, 200));
  // A vespera de 01/02 e 31/01, dia do inventario importado acima.
  espera(/inventário de 31\/01\/2026/.test(saida), `não usou o inventário inicial: ${saida.slice(0, 400)}`);
  espera(/inventário de 28\/02\/2026/.test(saida), `não usou o inventário final: ${saida.slice(0, 400)}`);
  // Estoque inicial 10 x R$ 10 = 100; final 3 x R$ 10 = 30; sem compras -> CMV 70.
  espera(/R\$\s*100,00/.test(saida) && /R\$\s*70,00/.test(saida), `CMV errado: ${saida.slice(0, 500)}`);
});

await passoAsync('DRE abre em banco onde a preferência nunca foi definida', async () => {
  // Regressao da 1.0.8: ler a preferencia do CMV criava a tabela, e a DRE abre
  // o banco em SOMENTE LEITURA — em todo computador que atualizou e nunca
  // escolheu a fonte, a DRE morria com "attempt to write a readonly database".
  // O teste anterior nao pegava porque outro passo criava a tabela antes dele.
  const { abrirBanco } = await import('../scripts/criar-banco.mjs');
  const db = abrirBanco();
  try { db.exec('DROP TABLE IF EXISTS preferencias'); } finally { db.close(); }

  const saida = join(RAIZ, 'relatorios', 'dre', 'fumaca-sem-preferencia.html');
  const r = rodar([join(RAIZ, 'scripts', 'dre.mjs'), 'gerar', '--mes', '2026-01', '--saida', saida]);
  espera(r.codigo === 0, `DRE não abriu sem a preferência definida: ${r.saida.slice(0, 250)}`);
  espera(!/readonly|somente leitura/i.test(r.saida), `tentou escrever em banco só de leitura: ${r.saida.slice(0, 200)}`);
  espera(/CMV teórico/.test(readFileSync(saida, 'utf8')), 'não caiu no padrão (CMV teórico)');
});

passo('DRE: o gestor escolhe a fonte do CMV', () => {
  const dre = join(RAIZ, 'scripts', 'dre.mjs');
  // Sem argumento, lista as opcoes para o assistente apresentar ao gestor.
  const listar = rodar([dre, 'cmv-fonte']);
  espera(listar.codigo === 0 && /teorico/.test(listar.saida) && /real/.test(listar.saida)
    && /compras/.test(listar.saida), listar.saida.slice(0, 200));

  const invalida = rodar([dre, 'cmv-fonte', 'chutometro']);
  espera(invalida.codigo !== 0, 'fonte inválida deveria falhar');

  const definir = rodar([dre, 'cmv-fonte', 'real']);
  espera(definir.codigo === 0 && /CMV real/.test(definir.saida), definir.saida.slice(0, 200));
  espera(/CMV real/.test(rodar([dre, 'cmv-fonte']).saida), 'a escolha não ficou gravada');

  // A DRE tem de sair mesmo sem estoque para apurar o real: recua para o
  // teorico e AVISA na nota, em vez de zerar a linha.
  const saida = join(RAIZ, 'relatorios', 'dre', 'fumaca-cmv.html');
  const gerar = rodar([dre, 'gerar', '--mes', '2026-01', '--saida', saida]);
  espera(gerar.codigo === 0, gerar.saida.slice(0, 200));
  const html = readFileSync(saida, 'utf8');
  espera(/CMV real \(estoque \+ compras\)/.test(html), 'o rótulo do CMV não seguiu a escolha');
  espera(/usam o CMV teórico/.test(html), 'a DRE não avisou o recuo para o teórico');
  // Mes sempre por nome: nunca 2026-01 numa entrega ao gestor.
  espera(!/Em 2026-/.test(html), 'mês apareceu no formato AAAA-MM na nota');

  rodar([dre, 'cmv-fonte', 'teorico']);
});

passo('relatos: acompanhamento e situação', () => {
  const rep = join(RAIZ, 'scripts', 'reportar.mjs');
  // Sem nenhum relato enviado, os dois comandos tem de ser mansos.
  espera(/Nenhum relato/.test(rodar([rep, 'situacao']).saida), 'situacao deveria dizer que não há relatos');
  espera(rodar([rep, 'verificar']).codigo === 0, 'verificar deveria sair sem erro sem relatos');

  // Relato que o GitHub nao conhece: a consulta falha e isso NAO pode virar
  // alerta nem derrubar a rotina diaria — o gestor nao tem o que fazer com isso.
  writeFileSync(join(DADOS, 'relatos.json'), JSON.stringify([{
    tipo: 'bug', destino: 'issue', numero: 999999, titulo: 'relato de fumaça',
    url: 'https://github.com/x/y/issues/999999', criado_em: '2026-01-01',
    estado: 'aberto', respostas: 0,
  }], null, 2), 'utf8');
  const v = rodar([rep, 'verificar']);
  espera(v.codigo === 0, `verificar não pode falhar com relato inacessível: ${v.saida.slice(0, 200)}`);

  const sit = rodar([rep, 'situacao']);
  espera(/aguardando/.test(sit.saida) && /relato de fumaça/.test(sit.saida), sit.saida.slice(0, 200));
});

await passoAsync('completude: acusa dia incompleto e imprime a ressalva', async () => {
  // Cenario: um dia com caixa fechado em R$ 1.000 e so R$ 50 de venda
  // coletada. E o defeito do relato: a API respondeu "sucesso" com o dia pela
  // metade, e sem conferencia isso viraria DRE.
  const { abrirBanco } = await import('../scripts/criar-banco.mjs');
  const conn = abrirBanco();
  try {
    conn.exec("INSERT OR REPLACE INTO lojas (conexao, codigo_loja, nome) VALUES ('grupo-a', 1, 'Loja Teste')");
    conn.exec("INSERT OR REPLACE INTO fechamentos_caixa (conexao, id_fechamento, codigo_loja, data_caixa,"
      + " valor_total_sistema) VALUES ('grupo-a', 9001, 1, '2026-03-10', 1000)");
    conn.exec("INSERT INTO sync_log (conexao, dominio, codigo_loja, periodo_inicio, periodo_fim, registros)"
      + " VALUES ('grupo-a', 'vendas', 1, '2026-03-01', '2026-03-31', 1)");
    conn.exec("INSERT OR REPLACE INTO vendas (conexao, chave_venda, codigo_loja, data_movimento,"
      + " valor_total, cancelada) VALUES ('grupo-a', 'fum-inc', 1, '2026-03-10', 50, 0)");
    // Terceira testemunha: num OUTRO dia, so os cupons emitidos acusam o
    // movimento (sem fechamento de caixa). A conferencia tem de pegar isso.
    conn.exec("INSERT OR REPLACE INTO conferencia_vendas (conexao, codigo_loja, data_caixa,"
      + " numero_caixa, numero_cupom, valor_total) VALUES ('grupo-a', 1, '2026-03-11', 1, 1, 800)");
    conn.exec("INSERT OR REPLACE INTO vendas (conexao, chave_venda, codigo_loja, data_movimento,"
      + " valor_total, cancelada) VALUES ('grupo-a', 'fum-inc2', 1, '2026-03-11', 20, 0)");
  } finally { conn.close(); }

  const r = rodar([join(RAIZ, 'scripts', 'analisar.mjs'), 'completude',
    '--grupo', 'grupo-a', '--de', '2026-03-01', '--ate', '2026-03-31']);
  espera(r.codigo === 3, `deveria sair com código 3 ao achar buraco: ${r.codigo}`);
  espera(/incompletos/.test(r.saida), r.saida.slice(0, 300));
  espera(/R\$\s*50,00/.test(r.saida) && /R\$\s*1\.000,00/.test(r.saida),
    `não mostrou os valores do dia: ${r.saida.slice(0, 300)}`);
  // O dia 11 so tem a testemunha dos cupons — tem de aparecer, e dizendo a fonte.
  espera(/cupons emitidos/.test(r.saida), `não usou a conferência de vendas: ${r.saida.slice(0, 400)}`);
  espera(/R\$\s*800,00/.test(r.saida), `não acusou o dia visto só pelos cupons: ${r.saida.slice(0, 400)}`);

  // E a ressalva tem de sair IMPRESSA no painel, nao so no chat.
  const spec = join(tmpdir(), 'fumaca-completude.json');
  writeFileSync(spec, JSON.stringify({
    titulo: 'Painel com buraco', grupo: 'grupo-a',
    periodo: { de: '2026-03-01', ate: '2026-03-31' },
    kpis: [{ rotulo: 'Vendas', sql: 'SELECT SUM(valor_total) FROM vendas', formato: 'moeda' }],
  }), 'utf8');
  const saidaPainel = join(RAIZ, 'relatorios', 'paineis', 'fumaca-completude.html');
  const gp = rodar([join(RAIZ, 'scripts', 'painel.mjs'), 'gerar', '--spec', spec, '--saida', saidaPainel]);
  espera(gp.codigo === 0, gp.saida.slice(0, 200));
  espera(/class="ressalva"/.test(readFileSync(saidaPainel, 'utf8')), 'painel não imprimiu a ressalva');

  // O dia incompleto tem de virar PENDENCIA DE RECOLETA, e sair da fila
  // sozinho quando os dados chegarem — senao o buraco so seria denunciado,
  // nunca fechado.
  const { marcarParaRecoleta, diasParaRecoletar } = await import('../scripts/completude.mjs');
  const dbR = abrirBanco();
  try {
    const r1 = marcarParaRecoleta(dbR, { conexao: 'grupo-a', de: '2026-03-01', ate: '2026-03-31' });
    espera(r1.marcados === 2, `esperava 2 dias marcados, veio ${r1.marcados}`);
    espera(diasParaRecoletar(dbR, 'grupo-a', 50).length === 2, 'a fila de recoleta não encheu');

    // Simula a recoleta do dia 10 chegando completa: ele sai da fila sozinho.
    dbR.exec("UPDATE vendas SET valor_total = 1000 WHERE chave_venda = 'fum-inc'");
    const r2 = marcarParaRecoleta(dbR, { conexao: 'grupo-a', de: '2026-03-01', ate: '2026-03-31' });
    espera(r2.marcados === 1, `depois de completar o dia 10, esperava 1 marcado, veio ${r2.marcados}`);
    espera(diasParaRecoletar(dbR, 'grupo-a', 50).length === 1, 'o dia resolvido não saiu da fila');

    // Tres passagens sem melhora: o dia 11 vira defeito do lado da TOTVS.
    marcarParaRecoleta(dbR, { conexao: 'grupo-a', de: '2026-03-01', ate: '2026-03-31' });
    const r4 = marcarParaRecoleta(dbR, { conexao: 'grupo-a', de: '2026-03-01', ate: '2026-03-31' });
    espera(r4.persistentes.length === 1, 'o dia que resiste a 3 tentativas deveria virar alerta');
  } finally { dbR.close(); }

  // Devolve o banco ao estado anterior: os passos seguintes conferem totais
  // (o backup, por exemplo, conta as vendas semeadas) e nao podem herdar
  // dados deste cenario.
  const limpar = abrirBanco();
  try {
    limpar.exec("DELETE FROM vendas WHERE chave_venda IN ('fum-inc', 'fum-inc2')");
    limpar.exec("DELETE FROM conferencia_vendas WHERE conexao = 'grupo-a'");
    limpar.exec("DELETE FROM coleta_falhas WHERE conexao = 'grupo-a'");
    limpar.exec("DELETE FROM fechamentos_caixa WHERE id_fechamento = 9001");
    limpar.exec("DELETE FROM sync_log WHERE dominio = 'vendas' AND periodo_inicio = '2026-03-01'");
    limpar.exec("DELETE FROM lojas WHERE conexao = 'grupo-a' AND codigo_loja = 1");
  } finally { limpar.close(); }
});

await passoAsync('coleta adaptativa: loja pesada vira dia a dia', async () => {
  const { abrirBanco } = await import('../scripts/criar-banco.mjs');
  const db = abrirBanco();
  try {
    db.exec("INSERT OR REPLACE INTO lojas (conexao, codigo_loja, nome) VALUES ('grupo-a', 9, 'Loja Pesada')");
  } finally { db.close(); }

  const lojas = join(RAIZ, 'scripts', 'lojas.mjs');
  const liga = rodar([lojas, 'dia-a-dia', '--grupo', 'grupo-a', '--loja', '9']);
  espera(liga.codigo === 0 && /UM DIA POR VEZ/.test(liga.saida), liga.saida.slice(0, 200));

  const ver = rodar([join(RAIZ, 'scripts', 'consultar.mjs'), '--json',
    "SELECT coletar_dia_a_dia AS v FROM lojas WHERE conexao='grupo-a' AND codigo_loja=9"]);
  espera(JSON.parse(ver.saida)[0].v === 1, 'a marca não foi gravada');

  const desliga = rodar([lojas, 'dia-a-dia', '--grupo', 'grupo-a', '--loja', '9', '--desligar']);
  espera(desliga.codigo === 0 && /mês inteiro/.test(desliga.saida), desliga.saida.slice(0, 200));

  // Loja inexistente tem de avisar, nao fingir que deu certo.
  const inexistente = rodar([lojas, 'dia-a-dia', '--grupo', 'grupo-a', '--loja', '4242']);
  espera(/não encontrada/.test(inexistente.saida), inexistente.saida.slice(0, 200));

  const limpar = abrirBanco();
  try { limpar.exec("DELETE FROM lojas WHERE conexao = 'grupo-a' AND codigo_loja = 9"); }
  finally { limpar.close(); }
});

await passoAsync('texto da API: entidades e espaços são normalizados', async () => {
  // O ChefWeb devolve "MAT&#201;RIA PRIMA" (as vezes com escape duplo) e
  // descricoes com espaco a direita. Os dois produzem numero errado com cara
  // de certo: plano dividido em dois na DRE, junção por texto falhando calada.
  const { abrirBanco, criarSchema } = await import('../scripts/criar-banco.mjs');
  const db = abrirBanco();
  try {
    db.exec("INSERT INTO contas_pagar (conexao, codigo_loja, fornecedor, descricao,"
      + " plano_contas1, plano_contas2, valor, data_emissao)"
      + " VALUES ('grupo-a', 1, 'FORNECEDOR &amp; CIA', 'x', 'SA&AMP;#205;DAS',"
      + " 'MAT&#201;RIA PRIMA', 10, '2026-05-01')");
    db.exec("INSERT INTO venda_pagamentos (conexao, chave_venda, descricao, valor_efetivo)"
      + " VALUES ('grupo-a', 'fum-pg', 'MAESTRO  ', 5)");
    criarSchema(db); // a migracao normaliza o que ja esta gravado
    const c = db.prepare("SELECT fornecedor, plano_contas1 p1, plano_contas2 p2 FROM contas_pagar"
      + " WHERE conexao = 'grupo-a' AND data_emissao = '2026-05-01'").get();
    espera(c.p2 === 'MATÉRIA PRIMA', `escape simples não foi decodificado: ${c.p2}`);
    espera(c.p1 === 'SAÍDAS', `escape DUPLO não foi decodificado: ${c.p1}`);
    espera(c.fornecedor === 'FORNECEDOR & CIA', `&amp; não virou &: ${c.fornecedor}`);
    const pg = db.prepare("SELECT descricao FROM venda_pagamentos WHERE chave_venda = 'fum-pg'").get();
    espera(pg.descricao === 'MAESTRO', `espaço à direita sobreviveu: [${pg.descricao}]`);
  } finally { db.close(); }

  const limpar = abrirBanco();
  try {
    limpar.exec("DELETE FROM contas_pagar WHERE conexao = 'grupo-a' AND data_emissao = '2026-05-01'");
    limpar.exec("DELETE FROM venda_pagamentos WHERE chave_venda = 'fum-pg'");
  } finally { limpar.close(); }
});

passo('senha do ChefWeb: atalho de troca', () => {
  // A senha expira periodicamente. O atalho tem de abrir a pagina certa e,
  // acima de tudo, NUNCA aceitar a senha pela linha de comando.
  const cfg = join(RAIZ, 'scripts', 'configurar.mjs');
  const semGrupo = rodar([cfg, 'senha']);
  espera(semGrupo.codigo !== 0 && /mais de um grupo/i.test(semGrupo.saida),
    `com 2 grupos deveria pedir qual: ${semGrupo.saida.slice(0, 200)}`);
  espera(/--grupo grupo-a/.test(semGrupo.saida), 'não listou os grupos disponíveis');

  const inexistente = rodar([cfg, 'senha', '--grupo', 'nao-existe']);
  espera(inexistente.codigo !== 0 && /não encontrado/.test(inexistente.saida),
    inexistente.saida.slice(0, 200));
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
