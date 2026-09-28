// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Envio de e-mail pelo proprio computador do gestor (SMTP), sem servico
// intermediario: relatorios e resumos podem ser enviados automaticamente
// — desde que o computador esteja ligado na hora.
//
// O Node nao traz cliente SMTP e o projeto nao usa dependencias, entao o
// protocolo e falado aqui mesmo sobre node:net/node:tls (SSL direto na porta
// 465 ou STARTTLS na 587). A conta de e-mail e configurada numa pagina local
// no navegador (nunca pelo chat) e fica em data/email.json, so nesta maquina.
//
// Uso:
//   node --no-warnings scripts/email.mjs configurar        (pagina local)
//   node --no-warnings scripts/email.mjs testar [--para a@b]
//   node --no-warnings scripts/email.mjs enviar --para a@b[,c@d] \
//        --assunto "..." --texto "..." [--anexo arquivo]...

import { createServer } from 'node:http';
import { connect as conectarTcp } from 'node:net';
import { connect as conectarTls } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { abrirNoSistema } from './plataforma.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAMINHO_CONFIG = join(RAIZ, 'data', 'email.json');
const TEMPO_LIMITE_MS = 15 * 60 * 1000;
const TOKEN_FORMULARIO = randomBytes(16).toString('hex');

// Provedores comuns no Brasil — a pagina preenche os campos sozinha.
const PROVEDORES = [
  { id: 'gmail', nome: 'Gmail / Google Workspace', host: 'smtp.gmail.com', porta: 465, seguranca: 'ssl',
    dica: 'O Gmail NAO aceita a senha normal: crie uma "senha de app" em myaccount.google.com/apppasswords (exige verificacao em duas etapas ativa) e use-a aqui.' },
  { id: 'outlook', nome: 'Outlook / Hotmail / Microsoft 365', host: 'smtp-mail.outlook.com', porta: 587, seguranca: 'starttls',
    dica: 'Com verificacao em duas etapas ativa, pode ser preciso criar uma "senha de app" nas configuracoes de seguranca da conta Microsoft.' },
  { id: 'yahoo', nome: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', porta: 465, seguranca: 'ssl',
    dica: 'O Yahoo exige "senha de app", criada nas configuracoes de seguranca da conta.' },
  { id: 'outro', nome: 'Outro provedor (e-mail da empresa etc.)', host: '', porta: 465, seguranca: 'ssl',
    dica: 'Pergunte a quem cuida do seu e-mail os dados de ENVIO (SMTP): servidor, porta (465 ou 587), usuario e senha.' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function carregarConfigEmail() {
  if (!existsSync(CAMINHO_CONFIG)) return null;
  try { return JSON.parse(readFileSync(CAMINHO_CONFIG, 'utf8')); } catch { return null; }
}

function gravarConfigEmail(config) {
  mkdirSync(join(RAIZ, 'data'), { recursive: true });
  writeFileSync(CAMINHO_CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Cliente SMTP
// ---------------------------------------------------------------------------

// Leitor de respostas: uma resposta termina na linha "999 texto" (espaco apos
// o codigo); linhas "999-texto" sao continuacao.
function criarLeitor(socket) {
  let sobra = '';
  let linhas = [];
  const prontas = [];
  const esperas = [];
  const entregar = (resposta) => {
    const espera = esperas.shift();
    if (espera) espera.resolve(resposta); else prontas.push(resposta);
  };
  socket.on('data', (parte) => {
    sobra += parte.toString('utf8');
    let quebra;
    while ((quebra = sobra.indexOf('\r\n')) >= 0) {
      const linha = sobra.slice(0, quebra);
      sobra = sobra.slice(quebra + 2);
      linhas.push(linha);
      if (/^\d{3} /.test(linha)) { entregar(linhas); linhas = []; }
    }
  });
  socket.on('error', (erro) => { const e = esperas.shift(); if (e) e.reject(erro); });
  return () => new Promise((resolve, reject) => {
    if (prontas.length > 0) return resolve(prontas.shift());
    const espera = { resolve, reject };
    esperas.push(espera);
    setTimeout(() => {
      const i = esperas.indexOf(espera);
      if (i >= 0) { esperas.splice(i, 1); reject(new Error('o servidor de e-mail demorou demais para responder')); }
    }, 30_000).unref();
    return undefined;
  });
}

function traduzirErroSmtp(codigo, texto) {
  if (['535', '534', '530'].includes(codigo)) {
    return 'o servidor recusou o usuário ou a senha do e-mail. Se for Gmail/Yahoo, é preciso usar uma "senha de app", não a senha normal.';
  }
  if (codigo === '550' || codigo === '553') return `o servidor recusou o destinatário (${texto.slice(0, 120)})`;
  return `o servidor de e-mail respondeu: ${codigo} ${texto.slice(0, 160)}`;
}

async function dialogoSmtp(config, remetente, destinatarios, mensagem) {
  const alvo = { host: config.host, port: Number(config.porta) };
  let socket;
  let ler;
  const conectar = () => new Promise((resolve, reject) => {
    const s = config.seguranca === 'ssl'
      ? conectarTls({ ...alvo, servername: config.host }, () => resolve(s))
      : conectarTcp(alvo, () => resolve(s));
    s.setTimeout(30_000, () => s.destroy(new Error('tempo esgotado ao falar com o servidor de e-mail')));
    s.on('error', reject);
  });

  socket = await conectar();
  ler = criarLeitor(socket);
  const mandar = async (comando, esperado, { sigiloso = false } = {}) => {
    if (comando !== null) socket.write(`${comando}\r\n`);
    const resposta = await ler();
    const ultima = resposta[resposta.length - 1];
    const codigo = ultima.slice(0, 3);
    if (!esperado.includes(codigo)) {
      throw new Error(traduzirErroSmtp(codigo, sigiloso ? '(detalhe omitido)' : ultima.slice(4)));
    }
    return resposta;
  };

  await mandar(null, ['220']); // saudacao
  await mandar('EHLO assistente.chef.local', ['250']);
  if (config.seguranca === 'starttls') {
    await mandar('STARTTLS', ['220']);
    socket.removeAllListeners('data');
    socket = await new Promise((resolve, reject) => {
      const s = conectarTls({ socket, servername: config.host }, () => resolve(s));
      s.on('error', reject);
    });
    ler = criarLeitor(socket);
    socket.write('EHLO assistente.chef.local\r\n');
    const resposta = await ler();
    if (!/^250/.test(resposta[resposta.length - 1])) throw new Error('o servidor recusou a conexão segura');
  }
  await mandar('AUTH LOGIN', ['334']);
  await mandar(Buffer.from(config.usuario).toString('base64'), ['334'], { sigiloso: true });
  await mandar(Buffer.from(config.senha).toString('base64'), ['235'], { sigiloso: true });
  await mandar(`MAIL FROM:<${remetente}>`, ['250']);
  for (const destino of destinatarios) await mandar(`RCPT TO:<${destino}>`, ['250', '251']);
  await mandar('DATA', ['354']);
  // "Dot stuffing": linha comecando com ponto ganha um ponto a mais.
  const corpo = mensagem.replace(/\r\n\./g, '\r\n..');
  socket.write(`${corpo}\r\n.\r\n`);
  const fim = await ler();
  if (!/^250/.test(fim[fim.length - 1])) throw new Error('o servidor não confirmou o recebimento da mensagem');
  socket.write('QUIT\r\n');
  socket.end();
}

// ---------------------------------------------------------------------------
// Montagem da mensagem (MIME)
// ---------------------------------------------------------------------------

const TIPOS_ARQUIVO = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html', '.csv': 'text/csv', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

const b64Quebrado = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
const utf8Cabecalho = (texto) => `=?UTF-8?B?${Buffer.from(String(texto)).toString('base64')}?=`;
const nomeAscii = (nome) => nome.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\x20-\x7e]/g, '_');

function montarMensagem({ de, deNome, para, assunto, texto, anexos }) {
  const limite = `limite-${randomBytes(12).toString('hex')}`;
  const partes = [];
  partes.push([
    `--${limite}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Quebrado(Buffer.from(`${texto}\n\n--\nEnviado pelo Assistente de Gestao (MHI Sistemas) a pedido do gestor.`)),
  ].join('\r\n'));
  for (const caminho of anexos) {
    const nome = nomeAscii(basename(caminho));
    const tipo = TIPOS_ARQUIVO[extname(caminho).toLowerCase()] ?? 'application/octet-stream';
    partes.push([
      `--${limite}`,
      `Content-Type: ${tipo}; name="${nome}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${nome}"`,
      '',
      b64Quebrado(readFileSync(caminho)),
    ].join('\r\n'));
  }
  return [
    `From: ${utf8Cabecalho(deNome || 'Assistente de Gestao')} <${de}>`,
    `To: ${para.join(', ')}`,
    `Subject: ${utf8Cabecalho(assunto)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@assistente.chef.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${limite}"`,
    '',
    'Esta mensagem esta em formato MIME.',
    ...partes,
    `--${limite}--`,
    '',
  ].join('\r\n');
}

// Envia um e-mail com a conta configurada. Usada pelo CLI e por automacoes.
export async function enviarEmail({ para, assunto, texto, anexos = [] }, configuracao = null) {
  const config = configuracao ?? carregarConfigEmail();
  if (!config) {
    throw new Error('o envio de e-mail ainda não foi configurado. Rode: node --no-warnings scripts/email.mjs configurar');
  }
  const destinatarios = (Array.isArray(para) ? para : String(para ?? '').split(','))
    .map((d) => d.trim()).filter(Boolean);
  if (destinatarios.length === 0) throw new Error('informe ao menos um destinatário');
  for (const caminho of anexos) {
    if (!existsSync(caminho)) throw new Error(`anexo não encontrado: ${caminho}`);
  }
  const mensagem = montarMensagem({
    de: config.remetente || config.usuario,
    deNome: config.nome,
    para: destinatarios,
    assunto: assunto || 'Mensagem do Assistente de Gestao',
    texto: texto || '',
    anexos,
  });
  await dialogoSmtp(config, config.remetente || config.usuario, destinatarios, mensagem);
  return { destinatarios, anexos: anexos.length };
}

// ---------------------------------------------------------------------------
// Pagina local de configuracao
// ---------------------------------------------------------------------------

function pagina(corpo) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-mail — Assistente de Gestão TOTVS Chef</title><link rel="icon" type="image/png" href="/logo.png">
<style>
  :root{--navy:#002233;--texto:#393939;--hover:#0a425f;--ambar:#feac0e}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;margin:0;color:var(--texto)}
  .topo{background:var(--navy);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px}
  .topo img{height:42px} .topo .titulo{font-size:17px;font-weight:600}
  .topo .titulo small{display:block;font-weight:400;font-size:12px;opacity:.75}
  .conteudo{display:flex;justify-content:center;padding:28px 16px}
  .caixa{background:#fff;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 2px 8px rgba(0,34,51,.1);padding:32px;max-width:640px;width:100%}
  h1{font-size:21px;margin:0 0 6px;color:var(--navy)} .sub{color:#6b7280;margin:0 0 22px;font-size:15px}
  label{display:block;font-weight:600;margin:16px 0 6px;font-size:14px;color:var(--navy)}
  input,select{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd8dc;border-radius:6px;font-size:15px;color:var(--texto);background:#fff}
  input:focus,select:focus{outline:2px solid var(--hover);border-color:var(--hover)}
  .dica{background:#fff8e6;border-left:4px solid var(--ambar);padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;margin-top:14px}
  .linha{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}
  button{margin-top:22px;background:var(--navy);color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:var(--hover)} .ok{background:#e8f5e9;border-left:4px solid #2e7d32;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:14px}
  .erro{background:#fdecea;border-left:4px solid #c62828;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:14px}
  .rodape{text-align:center;color:#9aa0a6;font-size:12px;padding:12px}
</style></head>
<body><div class="topo"><img src="/logo.png" alt=""><div class="titulo">Assistente de Gestão<small>Envio de e-mail — fica só no seu computador</small></div></div>
<div class="conteudo"><div class="caixa">${corpo}</div></div>
<div class="rodape">Projeto da MHI Sistemas (revenda TOTVS Food Linha Chef). Não é um produto oficial TOTVS.</div>
</body></html>`;
}

function telaFormulario({ mensagemOk = null, mensagemErro = null } = {}) {
  const atual = carregarConfigEmail() ?? {};
  const opcoes = PROVEDORES.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
  return pagina(`
  ${mensagemOk ? `<div class="ok">${esc(mensagemOk)}</div>` : ''}
  ${mensagemErro ? `<div class="erro">${esc(mensagemErro)}</div>` : ''}
  <h1>Configurar envio de e-mail</h1>
  <p class="sub">Com isso o assistente pode te mandar relatórios por e-mail automaticamente.
  A senha fica gravada <b>somente neste computador</b>.</p>
  <form method="POST" action="/salvar">
    <input type="hidden" name="tf" value="${TOKEN_FORMULARIO}">
    <label>Seu provedor de e-mail</label>
    <select name="provedor" id="provedor">${opcoes}</select>
    <div class="dica" id="dica"></div>
    <div class="linha">
      <div><label>Servidor de envio (SMTP)</label><input name="host" id="host" value="${esc(atual.host ?? '')}" placeholder="smtp.exemplo.com.br"></div>
      <div><label>Porta</label><input name="porta" id="porta" value="${esc(atual.porta ?? 465)}"></div>
      <div><label>Segurança</label><select name="seguranca" id="seguranca">
        <option value="ssl">SSL (465)</option><option value="starttls">STARTTLS (587)</option></select></div>
    </div>
    <label>Seu e-mail (usuário)</label>
    <input name="usuario" value="${esc(atual.usuario ?? '')}" placeholder="voce@suaempresa.com.br">
    <label>Senha ${atual.usuario ? '(deixe em branco para manter a atual)' : ''}</label>
    <input name="senha" type="password" autocomplete="new-password">
    <label>Nome que aparece como remetente</label>
    <input name="nome" value="${esc(atual.nome ?? 'Assistente de Gestao')}">
    <label>Enviar o e-mail de teste para</label>
    <input name="teste_para" value="${esc(atual.usuario ?? '')}" placeholder="voce@suaempresa.com.br">
    <button type="submit">Testar e salvar</button>
  </form>
  ${carregarConfigEmail() ? `<form method="POST" action="/concluir"><input type="hidden" name="tf" value="${TOKEN_FORMULARIO}"><button type="submit" style="background:#2e7d32">Concluir</button></form>` : ''}
  <script>
    const PROVEDORES = ${JSON.stringify(PROVEDORES)};
    const sel = document.getElementById('provedor');
    function aplicar() {
      const p = PROVEDORES.find((x) => x.id === sel.value);
      document.getElementById('dica').textContent = p.dica;
      if (p.host) { host.value = p.host; porta.value = p.porta; seguranca.value = p.seguranca; }
    }
    sel.addEventListener('change', aplicar); aplicar();
  </script>`);
}

const telaConcluido = pagina(`<h1>Tudo certo!</h1>
  <p class="sub">O envio de e-mail está configurado. Pode fechar esta janela e voltar para a conversa com o assistente.</p>`);

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (p) => { corpo += p; if (corpo.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

function abrirPaginaConfiguracao() {
  const servidor = createServer(async (req, res) => {
    const responder = (html, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/logo.png') {
        const logo = join(RAIZ, 'assets', 'logo-totvs-chef.png');
        if (existsSync(logo)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
          return res.end(readFileSync(logo));
        }
        res.writeHead(404); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/') return responder(telaFormulario());
      if (req.method === 'POST' && url.pathname === '/salvar') {
        const dados = new URLSearchParams(await lerCorpo(req));
        if (dados.get('tf') !== TOKEN_FORMULARIO) return responder(telaFormulario({ mensagemErro: 'Sessão inválida. Recarregue a página.' }), 403);
        const atual = carregarConfigEmail() ?? {};
        const config = {
          host: dados.get('host')?.trim(),
          porta: Number(dados.get('porta')) || 465,
          seguranca: dados.get('seguranca') === 'starttls' ? 'starttls' : 'ssl',
          usuario: dados.get('usuario')?.trim(),
          senha: dados.get('senha') || atual.senha || '',
          nome: dados.get('nome')?.trim() || 'Assistente de Gestao',
          remetente: dados.get('usuario')?.trim(),
        };
        if (!config.host || !config.usuario || !config.senha) {
          return responder(telaFormulario({ mensagemErro: 'Preencha servidor, e-mail e senha.' }));
        }
        const testePara = dados.get('teste_para')?.trim() || config.usuario;
        try {
          await enviarEmail({
            para: [testePara],
            assunto: 'Teste do Assistente de Gestao',
            texto: 'Funcionou! Este e o e-mail de teste do seu Assistente de Gestao. A partir de agora ele pode te enviar relatorios automaticamente.',
          }, config);
        } catch (erro) {
          return responder(telaFormulario({ mensagemErro: `O teste falhou: ${erro.message}` }));
        }
        gravarConfigEmail(config);
        return responder(telaFormulario({ mensagemOk: `Funcionou! Um e-mail de teste foi enviado para ${testePara}. Confira a caixa de entrada e clique em Concluir.` }));
      }
      if (req.method === 'POST' && url.pathname === '/concluir') {
        const dados = new URLSearchParams(await lerCorpo(req));
        if (dados.get('tf') !== TOKEN_FORMULARIO) return responder(telaFormulario({ mensagemErro: 'Sessão inválida.' }), 403);
        responder(telaConcluido);
        console.log('✅ Envio de e-mail configurado e testado.');
        setTimeout(() => process.exit(0), 500);
        return undefined;
      }
      return responder(pagina('<h1>Página não encontrada</h1>'), 404);
    } catch (erro) {
      return responder(telaFormulario({ mensagemErro: `Algo deu errado: ${erro.message}` }), 500);
    }
  });
  servidor.listen(0, '127.0.0.1', () => {
    const endereco = `http://127.0.0.1:${servidor.address().port}/`;
    console.log(`Endereço da página de e-mail: ${endereco}`);
    console.log('Se ela não abrir sozinha, copie esse endereço e cole no navegador.');
    console.log('Aguardando o gestor concluir (limite de 15 minutos)...');
    if (!process.argv.includes('--sem-navegador')) {
      abrirNoSistema(endereco, (erro) => {
        console.warn(`Não consegui abrir o navegador automaticamente (${erro.message}).`);
        console.warn(`Peça ao gestor para abrir: ${endereco}`);
      });
    }
    setTimeout(() => {
      console.error('⏱️ Tempo esgotado: ninguém concluiu a configuração em 15 minutos.');
      process.exit(1);
    }, TEMPO_LIMITE_MS);
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function lerArgs() {
  const args = { anexos: [] };
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const nome = argv[i].slice(2);
      const proximo = argv[i + 1];
      const valor = proximo && !proximo.startsWith('--') ? (i += 1, proximo) : true;
      if (nome === 'anexo') args.anexos.push(valor); else args[nome] = valor;
    }
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  const args = lerArgs();
  try {
    if (acao === 'configurar') {
      abrirPaginaConfiguracao();
    } else if (acao === 'testar') {
      const config = carregarConfigEmail();
      if (!config) { console.error('E-mail ainda não configurado. Rode: email.mjs configurar'); process.exitCode = 1; }
      else {
        await enviarEmail({
          para: args.para ?? config.usuario,
          assunto: 'Teste do Assistente de Gestao',
          texto: 'Funcionou! Este e o e-mail de teste do seu Assistente de Gestao.',
        });
        console.log(`E-mail de teste enviado para ${args.para ?? config.usuario}.`);
      }
    } else if (acao === 'enviar') {
      if (typeof args.para !== 'string') {
        console.error('Uso: email.mjs enviar --para a@b[,c@d] --assunto "..." --texto "..." [--anexo arquivo]...');
        process.exitCode = 1;
      } else {
        const r = await enviarEmail({
          para: args.para,
          assunto: typeof args.assunto === 'string' ? args.assunto : undefined,
          texto: typeof args.texto === 'string' ? args.texto : '',
          anexos: args.anexos,
        });
        console.log(`E-mail enviado para ${r.destinatarios.join(', ')}${r.anexos ? ` com ${r.anexos} anexo(s)` : ''}.`);
      }
    } else {
      console.error('Acao invalida. Use: configurar | testar [--para a@b] | enviar --para ... --assunto ... --texto ... [--anexo f]');
      process.exitCode = 1;
    }
  } catch (erro) {
    console.error(`Não consegui enviar: ${erro.message}`);
    process.exitCode = 1;
  }
}
