// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Benchmark do setor — FASE 1: lista de espera.
//
// O comparativo com o mercado ("seu %CMV vs a mediana do seu segmento") sera
// lancado quando houver massa de participantes. Ate la, o gestor pode entrar
// na LISTA DE ESPERA: informa empresa, nome, telefone e e-mail — o assistente
// MOSTRA exatamente o que sera enviado e, com o "sim" dele, dispara para o
// webhook do projeto. A lista mede o interesse no benchmark e conecta o
// gestor a MHI Sistemas, que mantem o assistente.
//
// Resiliencia: sem internet (ou webhook fora do ar), o pedido fica guardado
// em data/lista-espera-pendente.json e a rotina diaria reenvia sozinha.
//
// O formulario e LOCAL (mesmo padrao da pagina de configuracao): o comando
// abre uma pagina no navegador do gestor com os 4 campos e a explicacao do
// que sera enviado; ele preenche e clica — nada de ditar dados no chat.
//
// Uso:
//   node --no-warnings scripts/benchmark.mjs lista-espera            (abre a pagina)
//   node --no-warnings scripts/benchmark.mjs lista-espera --empresa .. --nome ..
//        --telefone .. --email ..                                    (envio direto)
//   node --no-warnings scripts/benchmark.mjs enviar-pendentes        (usado pela rotina)
//   node --no-warnings scripts/benchmark.mjs situacao

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { abrirNoSistema } from './plataforma.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_DADOS = join(RAIZ, 'data');
const CAMINHO_PENDENTES = join(PASTA_DADOS, 'lista-espera-pendente.json');
const CAMINHO_ENVIADO = join(PASTA_DADOS, 'lista-espera-enviado.json');

// URL do webhook da lista de espera (definida pela mantenedora do projeto).
const WEBHOOK_LISTA_ESPERA = 'https://flowhook.oruzz.com.br/webhook/b49c1b43-6321-48b7-a366-fb8f1e2bb320';

function versaoDoAssistente() {
  try { return JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).version; } catch { return '?'; }
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

function montarInscricao(args) {
  const obrigatorios = ['empresa', 'nome', 'telefone', 'email'];
  const faltando = obrigatorios.filter((c) => typeof args[c] !== 'string' || !args[c].trim());
  if (faltando.length > 0) throw new Error(`faltam campos: ${faltando.join(', ')}`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email.trim())) throw new Error('o e-mail informado não parece válido');
  return {
    empresa: args.empresa.trim(),
    nome: args.nome.trim(),
    telefone: args.telefone.trim(),
    email: args.email.trim().toLowerCase(),
    origem: 'assistente-chef',
    versao: versaoDoAssistente(),
    enviado_em: new Date().toISOString(),
  };
}

async function postar(inscricao) {
  const resposta = await fetch(WEBHOOK_LISTA_ESPERA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inscricao),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resposta.ok) throw new Error(`o serviço da lista respondeu ${resposta.status}`);
}

function guardarPendente(inscricao) {
  mkdirSync(PASTA_DADOS, { recursive: true });
  writeFileSync(CAMINHO_PENDENTES, JSON.stringify(inscricao, null, 2), 'utf8');
}

function marcarEnviado(inscricao) {
  mkdirSync(PASTA_DADOS, { recursive: true });
  writeFileSync(CAMINHO_ENVIADO, JSON.stringify({ email: inscricao.email, enviado_em: new Date().toISOString() }, null, 2), 'utf8');
  try { rmSync(CAMINHO_PENDENTES); } catch { /* nao existia */ }
}

// ---------------------------------------------------------------------------
// Pagina local do formulario (mesmo padrao da pagina de configuracao)
// ---------------------------------------------------------------------------

const TOKEN_FORMULARIO = randomBytes(16).toString('hex');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function pagina(corpo) {
  let logo = '';
  try { logo = `data:image/png;base64,${readFileSync(join(RAIZ, 'assets', 'logo-totvs-chef.png')).toString('base64')}`; } catch { /* sem logo */ }
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark do Setor — lista de espera</title>
<style>
  :root{--navy:#002233;--ambar:#feac0e;--tinta:#393939}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;margin:0;color:var(--tinta)}
  .topo{background:var(--navy);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px}
  .topo img{height:42px}.topo .titulo{font-size:17px;font-weight:600}
  .topo .titulo small{display:block;font-weight:400;font-size:12px;opacity:.75}
  .conteudo{display:flex;justify-content:center;padding:28px 16px}
  .caixa{background:#fff;border:1px solid #e5e5e5;border-radius:10px;box-shadow:0 2px 8px rgba(0,34,51,.1);padding:32px;max-width:560px;width:100%}
  h1{font-size:21px;margin:0 0 6px;color:var(--navy)}.sub{color:#6b7280;margin:0 0 20px;font-size:15px;line-height:1.5}
  label{display:block;font-weight:600;margin:16px 0 6px;font-size:14px;color:var(--navy)}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd8dc;border-radius:6px;font-size:15px}
  input:focus{outline:2px solid #0a425f;border-color:#0a425f}
  .aviso{background:#fff8e6;border-left:4px solid var(--ambar);padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;margin-top:18px;line-height:1.5}
  .erro{background:#fdecea;border-left:4px solid #c62828;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:14px}
  button{margin-top:22px;background:var(--navy);color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#0a425f}
  .rodape{text-align:center;color:#9aa0a6;font-size:12px;padding:12px}
</style></head>
<body><div class="topo">${logo ? `<img src="${logo}" alt="">` : ''}<div class="titulo">Benchmark do Setor<small>Lista de espera — comparativo de mercado</small></div></div>
<div class="conteudo"><div class="caixa">${corpo}</div></div>
<div class="rodape">Assistente de Gestão — projeto da MHI Sistemas (revenda TOTVS Food Linha Chef). Não é um produto oficial TOTVS.</div>
</body></html>`;
}

function telaFormulario(mensagemErro = null) {
  return pagina(`
  ${mensagemErro ? `<div class="erro">${esc(mensagemErro)}</div>` : ''}
  <h1>Já pensou comparar seus números com quem é do ramo?</h1>
  <p class="sub">Seu CMV, seu ticket médio, seu custo de equipe — lado a lado
  com <b>empresas parecidas com a sua</b>, da sua cidade ou de outros estados,
  de forma anônima e <b>gratuita</b>. Estamos construindo esse <b>benchmark
  colaborativo</b> e queremos medir o interesse real:
  <b>ao atingirmos 500 inscritos, o projeto começa</b> — e quem está na lista
  participa primeiro.</p>
  <form method="POST" action="/entrar">
    <input type="hidden" name="tf" value="${TOKEN_FORMULARIO}">
    <label>Nome da empresa</label><input name="empresa" required placeholder="Ex.: Açaí do Vale">
    <label>Seu nome</label><input name="nome" required>
    <label>Telefone</label><input name="telefone" required placeholder="(11) 99999-9999">
    <label>E-mail</label><input name="email" type="email" required>
    <button type="submit">Quero participar — me avisem!</button>
  </form>
  <div class="aviso">Estes quatro dados são enviados à equipe que mantém o
  assistente (MHI Sistemas) apenas para avisar do lançamento e falar sobre o
  comparativo. Nenhum dado das suas vendas é enviado.</div>`);
}

const telaOk = pagina(`<h1>Você está na lista! 🎉</h1>
  <p class="sub">Cada inscrição nos aproxima dos <b>500 participantes</b> que
  dão a largada no benchmark — e você entra primeiro. Assim que começar, você
  será avisado. Pode fechar esta janela e voltar para a conversa.</p>`);
const telaPendente = pagina(`<h1>Pedido guardado</h1>
  <p class="sub">Não consegui falar com o serviço da lista agora (talvez sem
  internet). Seu pedido ficou guardado <b>neste computador</b> e será enviado
  automaticamente na próxima atualização diária. Pode fechar esta janela.</p>`);

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (p) => { corpo += p; if (corpo.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

function abrirPaginaListaEspera() {
  const servidor = createServer(async (req, res) => {
    const responder = (html, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    try {
      if (req.method === 'GET') return responder(telaFormulario());
      if (req.method === 'POST' && req.url === '/entrar') {
        const dados = new URLSearchParams(await lerCorpo(req));
        if (dados.get('tf') !== TOKEN_FORMULARIO) return responder(telaFormulario('Sessão inválida — recarregue a página.'), 403);
        let inscricao;
        try {
          inscricao = montarInscricao({
            empresa: dados.get('empresa'), nome: dados.get('nome'),
            telefone: dados.get('telefone'), email: dados.get('email'),
          });
        } catch (erro) { return responder(telaFormulario(erro.message)); }
        try {
          await postar(inscricao);
          marcarEnviado(inscricao);
          responder(telaOk);
          console.log('✅ Gestor entrou na lista de espera do benchmark.');
        } catch {
          guardarPendente(inscricao);
          responder(telaPendente);
          console.log('Pedido guardado localmente (webhook indisponível); a rotina reenvia.');
        }
        setTimeout(() => process.exit(0), 800);
        return undefined;
      }
      return responder(telaFormulario(), 404);
    } catch (erro) {
      return responder(telaFormulario(`Algo deu errado: ${erro.message}`), 500);
    }
  });
  servidor.listen(0, '127.0.0.1', () => {
    const endereco = `http://127.0.0.1:${servidor.address().port}/`;
    console.log(`Página da lista de espera: ${endereco}`);
    console.log('Se não abrir sozinha, copie esse endereço e cole no navegador.');
    if (!process.argv.includes('--sem-navegador')) {
      abrirNoSistema(endereco, () => console.warn(`Peça ao gestor para abrir: ${endereco}`));
    }
    setTimeout(() => { console.error('⏱️ Tempo esgotado (10 min) sem envio.'); process.exit(1); }, 10 * 60 * 1000);
  });
}

const acao = process.argv[2];
const args = lerArgs();
try {
  if (acao === 'lista-espera') {
    if (existsSync(CAMINHO_ENVIADO)) {
      const j = JSON.parse(readFileSync(CAMINHO_ENVIADO, 'utf8'));
      console.log(`Este computador já está na lista de espera (${j.email}, em ${j.enviado_em.slice(0, 10)}). Nada a fazer.`);
    } else if (typeof args.empresa === 'string' || typeof args.nome === 'string') {
      // Envio direto por argumentos (uso avançado)
      const inscricao = montarInscricao(args);
      try {
        await postar(inscricao);
        marcarEnviado(inscricao);
        console.log('✅ Entrou na lista de espera do benchmark! A equipe do projeto avisa quando o comparativo de mercado for liberado.');
      } catch (erro) {
        guardarPendente(inscricao);
        console.log(`Não consegui enviar agora (${erro.message}). Guardei o pedido — a rotina diária tenta de novo sozinha.`);
      }
    } else {
      abrirPaginaListaEspera();
    }
  } else if (acao === 'enviar-pendentes') {
    if (!existsSync(CAMINHO_PENDENTES)) {
      console.log('(sem pendências)');
    } else {
      const inscricao = JSON.parse(readFileSync(CAMINHO_PENDENTES, 'utf8'));
      try {
        await postar(inscricao);
        marcarEnviado(inscricao);
        console.log('✅ Inscrição pendente na lista de espera enviada.');
      } catch (erro) {
        console.log(`Lista de espera ainda pendente (${erro.message}); tento na próxima rotina.`);
      }
    }
  } else if (acao === 'situacao') {
    if (existsSync(CAMINHO_ENVIADO)) console.log('inscrito');
    else if (existsSync(CAMINHO_PENDENTES)) console.log('pendente de envio');
    else console.log('não inscrito');
  } else {
    console.error('Uso: lista-espera --empresa "..." --nome "..." --telefone "..." --email "..." | enviar-pendentes | situacao');
    process.exitCode = 1;
  }
} catch (erro) {
  console.error(`Não consegui concluir: ${erro.message}`);
  process.exitCode = 1;
}
