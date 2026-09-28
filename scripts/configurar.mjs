// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Página local de configuração do assistente.
//
// Sobe um pequeno servidor APENAS em 127.0.0.1 e abre no navegador uma página
// onde o gestor cadastra e gerencia seus acessos ao TOTVS Food Linha Chef.
//
// Um acesso = um "diretório site" (número de série) do ChefWeb, que pode
// conter uma ou várias lojas. O gestor pode ter vários — por exemplo, dois
// grupos de lojas contratados separadamente — e pode acrescentar novos a
// qualquer momento, muito depois da configuração inicial.
//
// Uso: node --no-warnings scripts/configurar.mjs
// Encerra com código 0 quando o gestor clica em "Concluir", ou 1 se ninguém
// concluir em 15 minutos.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { abrirNoSistema } from './plataforma.mjs';
import { gerarToken, chamarPost } from './chef-api.mjs';
import { carregarConexoes, salvarConexao, removerConexao, gerarId, validarConexao } from './conexoes.mjs';
import { abrirBanco, criarSchema } from './criar-banco.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FORMULARIO = randomBytes(16).toString('hex'); // impede envios vindos de outros sites
const TEMPO_LIMITE_MS = 15 * 60 * 1000;
const URL_PADRAO = 'https://chefweb.chef.totvs.com.br/ChefWebAPI';
const CAMINHO_PERFIL = join(RAIZ, 'data', 'perfil-agente.json');
const PASTA_IDENTIDADE = join(RAIZ, 'personalizados', 'identidade');

// Segmentos atendidos pelo TOTVS Food Linha Chef — escolhem a faixa certa
// em docs/referencias-de-mercado.md. Geralmente todas as lojas de um grupo
// sao do mesmo segmento.
const SEGMENTOS = [
  'restaurante à la carte', 'restaurante a quilo (self-service)', 'bar',
  'pizzaria', 'hamburgueria', 'lanchonete', 'fast food', 'padaria',
  'cafeteria', 'japonês/sushi', 'açaiteria', 'sorveteria', 'casa noturna',
  'delivery (sem salão)', 'outro',
];

function carregarPerfil() {
  try { return JSON.parse(readFileSync(CAMINHO_PERFIL, 'utf8')); } catch { return {}; }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Identidade visual do ChefWeb: navy #002233, texto #393939, hover #0a425f, âmbar #feac0e.
function pagina(corpo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuração — Assistente de Gestão TOTVS Chef</title>
<link rel="icon" type="image/png" href="/logo.png">
<style>
  :root{--navy:#002233;--texto:#393939;--hover:#0a425f;--ambar:#feac0e}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;margin:0;color:var(--texto)}
  .topo{background:var(--navy);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px}
  .topo img{height:42px} .topo .titulo{font-size:17px;font-weight:600}
  .topo .titulo small{display:block;font-weight:400;font-size:12px;opacity:.75}
  .conteudo{display:flex;justify-content:center;padding:28px 16px}
  .caixa{background:#fff;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 2px 8px rgba(0,34,51,.1);padding:32px;max-width:680px;width:100%}
  h1{font-size:21px;margin:0 0 6px;color:var(--navy)} .sub{color:#6b7280;margin:0 0 24px;font-size:15px}
  label{display:block;font-weight:600;margin:18px 0 6px;font-size:14px;color:var(--navy)}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd8dc;border-radius:6px;font-size:15px;color:var(--texto)}
  input:focus{outline:2px solid var(--hover);border-color:var(--hover)}
  details{margin-top:6px;font-size:13px;color:#555}
  summary{cursor:pointer;color:var(--hover);font-weight:600}
  details p{margin:8px 0 0}
  .aviso{background:#fff8e6;border:1px solid var(--ambar);border-radius:6px;padding:12px;font-size:13px;margin-top:20px}
  .erro{background:#fdecea;border:1px solid #e57373;border-radius:6px;padding:12px;font-size:14px;margin-bottom:16px}
  .ok{background:#edf7ed;border:1px solid #4caf50;border-radius:6px;padding:14px;font-size:15px;margin-bottom:16px}
  button,.botao{margin-top:22px;width:100%;padding:13px;background:var(--ambar);color:var(--navy);border:0;border-radius:6px;font-size:16px;font-weight:700;cursor:pointer;display:block;text-align:center;text-decoration:none;box-sizing:border-box}
  button:hover,.botao:hover{background:#e09b00}
  .botao.secundario{background:#fff;border:1px solid var(--navy);color:var(--navy)}
  .botao.secundario:hover{background:#eef3f5}
  .lista{margin:0 0 8px;padding:0;list-style:none}
  .item{border:1px solid #e0e6e9;border-radius:8px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
  .item .info{flex:1}
  .item .nome{font-weight:700;color:var(--navy);font-size:15px}
  .item .det{font-size:13px;color:#6b7280;margin-top:3px}
  .acoes{display:flex;gap:8px}
  .acoes button{margin:0;width:auto;padding:7px 12px;font-size:13px;font-weight:600}
  .acoes .remover{background:#fff;border:1px solid #e57373;color:#c62828}
  .acoes .remover:hover{background:#fdecea}
  .vazio{color:#6b7280;font-size:15px;padding:16px;border:1px dashed #cfd8dc;border-radius:8px;text-align:center}
  .rodape{margin-top:20px;font-size:12px;color:#9aa5ab;text-align:center}
</style>
</head>
<body>
  <div class="topo">
    <img src="/logo.png" alt="TOTVS Chef">
    <div class="titulo">TOTVS Chef<small>Assistente de Gestão — configuração</small></div>
  </div>
  <div class="conteudo"><div class="caixa">${corpo}</div></div>
</body>
</html>`;
}

const RODAPE = `<div class="rodape">Assistente de Gestão — projeto da MHI Sistemas (revenda TOTVS Food Linha Chef).
  Não é um produto oficial TOTVS. Uso por conta e risco do usuário.</div>`;

// ---------- tela 1: lista de acessos ----------

function telaLista({ mensagemOk = null, mensagemErro = null } = {}) {
  const conexoes = carregarConexoes();
  const itens = conexoes.map((c) => `
    <li class="item">
      <div class="info">
        <div class="nome">${esc(c.nome)}</div>
        <div class="det">Série ${esc(c.serial)} · usuário ${esc(c.usuario)} ·
        ${c.lojas.length > 0 ? `lojas ${c.lojas.join(', ')}` : 'todas as lojas do grupo'}${c.segmento ? ` · ${esc(c.segmento)}` : ''}</div>
      </div>
      <div class="acoes">
        <form method="GET" action="/editar"><input type="hidden" name="id" value="${esc(c.id)}">
          <button type="submit" class="botao secundario" style="margin:0;padding:7px 12px;font-size:13px">Alterar</button></form>
        <form method="POST" action="/remover" onsubmit="return confirm('Remover o acesso &quot;${esc(c.nome)}&quot;? Os dados já baixados continuam no seu computador.')">
          <input type="hidden" name="tf" value="${TOKEN_FORMULARIO}">
          <input type="hidden" name="id" value="${esc(c.id)}">
          <button type="submit" class="remover">Remover</button></form>
      </div>
    </li>`).join('');

  return pagina(`
  ${mensagemOk ? `<div class="ok">✅ ${esc(mensagemOk)}</div>` : ''}
  ${mensagemErro ? `<div class="erro">⚠️ ${esc(mensagemErro)}</div>` : ''}
  <h1>🍽️ Suas lojas conectadas</h1>
  <p class="sub">Cada acesso corresponde a um grupo de lojas no sistema da TOTVS
  (o que o sistema chama de <em>número de série</em>). Se você tem grupos
  diferentes, cadastre um acesso para cada um — pode acrescentar novos quando quiser.</p>
  ${conexoes.length > 0 ? `<ul class="lista">${itens}</ul>`
    : '<div class="vazio">Nenhuma loja conectada ainda. Comece cadastrando a primeira.</div>'}
  <a class="botao secundario" href="/novo">➕ Adicionar grupo de lojas</a>
  <a class="botao secundario" href="/personalizar">🎨 Personalizar o assistente (nome, jeito de falar, sua marca)</a>
  ${conexoes.length > 0 ? '<form method="POST" action="/concluir"><input type="hidden" name="tf" value="'
    + TOKEN_FORMULARIO + '"><button type="submit">Concluir e voltar ao assistente</button></form>' : ''}
  ${RODAPE}`);
}

// ---------- tela: personalizacao do assistente ----------

function telaPersonalizar({ mensagemOk = null, mensagemErro = null } = {}) {
  const p = carregarPerfil();
  const temLogo = existsSync(join(PASTA_IDENTIDADE, 'logo.png')) || existsSync(join(PASTA_IDENTIDADE, 'logo.jpg'));
  return pagina(`
  ${mensagemOk ? `<div class="ok">✅ ${esc(mensagemOk)}</div>` : ''}
  ${mensagemErro ? `<div class="erro">⚠️ ${esc(mensagemErro)}</div>` : ''}
  <h1>🎨 Personalizar o assistente</h1>
  <p class="sub">Deixe o assistente com a cara da sua empresa — tudo opcional.</p>
  <form method="POST" action="/salvar-personalizacao" enctype="multipart/form-data">
    <input type="hidden" name="tf" value="${TOKEN_FORMULARIO}">

    <label for="assistente_nome">Como você quer chamar o assistente?</label>
    <input id="assistente_nome" name="assistente_nome" value="${esc(p.assistente_nome ?? '')}"
      placeholder="ex.: Chef, Sofia, Assistente da Rede Centro">

    <label for="comunicacao">Como prefere que ele se comunique?</label>
    <input id="comunicacao" name="comunicacao" value="${esc(p.comunicacao ?? '')}"
      placeholder="ex.: direto ao ponto, sem formalidade; ou detalhado, me explicando os porquês">
    <details><summary>Exemplos</summary>
      <p>"Direto ao ponto, só os números que importam" · "Me explique como se eu
      não soubesse nada de finanças" · "Pode usar emoji" · "Me trate por você".</p></details>

    <label for="logo">Logomarca da sua empresa <span style="font-weight:400;color:#6b7280">(PNG ou JPG${temLogo ? ' — já existe uma; enviar outra substitui' : ''})</span></label>
    <input id="logo" name="logo" type="file" accept="image/png,image/jpeg">
    <details><summary>O que acontece com ela?</summary>
      <p>Seus relatórios e painéis passam a sair com a SUA marca. O assistente
      olha a logomarca, identifica as cores dela e monta a melhor combinação
      possível para os painéis — você não precisa escolher cor nenhuma.</p></details>

    <button type="submit">Salvar personalização</button>
  </form>
  <a class="botao secundario" href="/">Voltar</a>
  ${RODAPE}`);
}

// ---------- tela 2: formulário de um acesso ----------

function telaFormulario({ valores = {}, mensagemErro = null, editando = false } = {}) {
  const v = {
    id: valores.id ?? '',
    nome: valores.nome ?? '',
    usuario: valores.usuario ?? '',
    serial: valores.serial ?? '',
    lojas: Array.isArray(valores.lojas) ? valores.lojas.join(', ') : (valores.lojas ?? ''),
    url: valores.urlBase ?? valores.url ?? URL_PADRAO,
  };
  return pagina(`
  <h1>${editando ? '✏️ Alterar acesso' : '➕ Novo grupo de lojas'}</h1>
  <p class="sub">Preencha os dados de acesso ao sistema TOTVS Food Linha Chef.
  Eles ficam guardados <strong>somente neste computador</strong>.</p>
  ${mensagemErro ? `<div class="erro">⚠️ ${esc(mensagemErro)}</div>` : ''}
  <form method="POST" action="/salvar">
    <input type="hidden" name="tf" value="${TOKEN_FORMULARIO}">
    <input type="hidden" name="id" value="${esc(v.id)}">

    <label for="nome">Como você chama este grupo de lojas?</label>
    <input id="nome" name="nome" required value="${esc(v.nome)}" placeholder="ex.: Matriz, Rede Centro, Quiosques">
    <details><summary>Para que serve?</summary>
      <p>É só um apelido para você se organizar — aparece nos relatórios quando
      você tem mais de um grupo. Escolha algo que faça sentido para você.</p></details>

    <label for="usuario">Usuário do ChefWeb</label>
    <input id="usuario" name="usuario" required value="${esc(v.usuario)}" autocomplete="username">
    <details><summary>Onde encontro?</summary>
      <p>É o mesmo usuário que você usa para entrar no portal ChefWeb
      (chefweb.chef.totvs.com.br). Se não tiver, peça a quem administra o sistema
      na sua empresa.</p>
      <p><strong>Importante:</strong> esse usuário precisa ter <strong>permissão de
      acesso total aos relatórios</strong> no ChefWeb — e, se o grupo tem mais de uma
      loja, essa permissão deve estar <strong>replicada em todas as lojas</strong>.
      Sem isso, as consultas podem voltar vazias ou incompletas.</p></details>

    <label for="senha">Senha${editando ? ' <span style="font-weight:400;color:#6b7280">(deixe em branco para manter a atual)</span>' : ''}</label>
    <input id="senha" name="senha" type="password" ${editando ? '' : 'required'} autocomplete="current-password">

    <label for="serial">Número de série</label>
    <input id="serial" name="serial" required value="${esc(v.serial)}">
    <details><summary>Onde encontro?</summary>
      <p>No ChefWeb, acesse <strong>Cadastros → Lojas → Número de Série</strong>.
      <strong>Se este grupo tem mais de uma loja</strong>, use o número de série da
      <strong>loja central</strong> (geralmente a loja 1) — por ela o assistente
      enxerga todas as lojas do grupo.</p>
      <p>Grupos diferentes têm números de série diferentes: cadastre um acesso
      para cada um.</p></details>

    <label for="segmento">Qual o segmento deste grupo?</label>
    <select id="segmento" name="segmento" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd8dc;border-radius:6px;font-size:15px;color:var(--texto);background:#fff">
      <option value="">— escolha o que mais se aproxima —</option>
      ${SEGMENTOS.map((s) => `<option value="${esc(s)}"${(valores.segmento === s) ? ' selected' : ''}>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</option>`).join('')}
    </select>
    <details><summary>Para que serve?</summary>
      <p>Cada segmento tem números de referência diferentes (custo de insumos,
      margens...). Sabendo o seu, o assistente compara seus resultados com o
      que é saudável <strong>para o seu tipo de casa</strong>. Se as lojas deste
      grupo forem de segmentos diferentes, escolha o principal e avise o
      assistente na conversa.</p></details>

    <label for="lojas">Código das lojas deste grupo <span style="font-weight:400;color:#6b7280">(opcional)</span></label>
    <input id="lojas" name="lojas" value="${esc(v.lojas)}" placeholder="ex.: 1  —  ou  1, 2, 5">
    <details><summary>O que é isso?</summary>
      <p>Os números das lojas dentro deste grupo. Se não souber, deixe em branco —
      o assistente descobre depois e preenche para você. Abriu uma loja nova?
      Volte aqui e acrescente o código dela.</p></details>

    <label for="url">Endereço do sistema <span style="font-weight:400;color:#6b7280">(não mexa, salvo orientação da TOTVS)</span></label>
    <input id="url" name="url" value="${esc(v.url)}">

    <button type="submit">Testar e salvar</button>
  </form>
  <a class="botao secundario" href="/">Voltar sem salvar</a>
  <a class="botao secundario" href="/personalizar">🎨 Personalizar o assistente (nome, jeito de falar, sua marca)</a>
  <div class="aviso">🔒 Esta página funciona apenas dentro do seu computador
  (endereço local). Suas senhas não são enviadas para a internet — apenas para o
  sistema da TOTVS, na hora de validar o acesso.</div>
  ${RODAPE}`);
}

const telaConcluido = pagina(`
  <h1>✅ Tudo certo!</h1>
  <div class="ok">Seus acessos foram testados e guardados com segurança neste computador.</div>
  <p style="margin-top:20px;font-size:15px">Pode <strong>fechar esta janela</strong> e
  voltar para a conversa com o assistente — ele já vai continuar de onde parou. 👋</p>
  <p style="font-size:14px;color:#6b7280">Esta página se encerra agora, então os
  botões dela param de responder — é normal. Para mexer em qualquer coisa depois
  (dar um nome ao assistente, enviar sua logomarca, acrescentar uma loja), é só
  pedir na conversa que ele abre a página de novo.</p>
  ${RODAPE}`);

// ---------- validação de credenciais ----------

// O campo "Chave" do GerarToken é o MODO de autenticação: "SerialNumber"
// (loja única) ou "CentralNumber" (grupo de lojas, serial da central). O modo
// errado ainda gera token, mas módulos como Fiscal/Estado recusam — por isso
// validamos cada modo com uma chamada real e gravamos o que funcionar.
async function descobrirModo(base) {
  let ultimoErro = null;
  let autenticou = false;
  for (const candidata of ['SerialNumber', 'CentralNumber']) {
    const cfg = { ...base, chave: candidata };
    try {
      await gerarToken(cfg);
      autenticou = true;
    } catch (erro) {
      ultimoErro = erro;
      continue;
    }
    try {
      const estados = await chamarPost(cfg, '/api/Estado/ObterEstados', {});
      if (estados.Sucesso !== false) return { modo: candidata };
    } catch { /* token ok, mas o modo não valida o serial: tenta o próximo */ }
  }
  if (!autenticou) return { erro: ultimoErro?.message ?? 'não foi possível autenticar' };
  return { modo: 'SerialNumber' }; // autenticou, mas nenhum modo validou 100%
}

// ---------- servidor ----------

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (c) => {
      corpo += c;
      if (corpo.length > 100_000) reject(new Error('corpo grande demais'));
    });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

function lerCorpoBinario(req, limite = 3_000_000) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) reject(new Error('arquivo grande demais (limite 3 MB)'));
      else pedacos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

// Parser minimo de multipart/form-data (upload da logomarca), em Node puro.
// Devolve { campos: {nome: texto}, arquivos: [{nome, arquivo, tipo, dados}] }.
function extrairMultipart(corpo, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) throw new Error('formulário inválido (sem boundary)');
  const delim = Buffer.from(`--${m[1] ?? m[2]}`);
  const campos = {};
  const arquivos = [];
  let pos = corpo.indexOf(delim);
  while (pos !== -1) {
    const proximo = corpo.indexOf(delim, pos + delim.length);
    if (proximo === -1) break;
    // parte = [\r\n]cabecalhos\r\n\r\ncorpo\r\n
    let parte = corpo.subarray(pos + delim.length, proximo);
    if (parte[0] === 0x0d && parte[1] === 0x0a) parte = parte.subarray(2);
    const fim = parte.indexOf('\r\n\r\n');
    if (fim !== -1) {
      const cabecalho = parte.subarray(0, fim).toString('utf8');
      const dados = parte.subarray(fim + 4, parte.length - 2); // tira o \r\n final
      const nome = /name="([^"]*)"/i.exec(cabecalho)?.[1];
      const arquivo = /filename="([^"]*)"/i.exec(cabecalho)?.[1];
      const tipo = /content-type:\s*([^\r\n]+)/i.exec(cabecalho)?.[1]?.trim();
      if (nome && arquivo !== undefined) {
        if (arquivo) arquivos.push({ nome, arquivo, tipo, dados });
      } else if (nome) {
        campos[nome] = dados.toString('utf8');
      }
    }
    pos = proximo;
  }
  return { campos, arquivos };
}

// Relogio de INATIVIDADE: cada requisicao do gestor o reinicia.
let relogioInatividade = null;
function agendarEncerramentoPorInatividade() {
  if (relogioInatividade) clearTimeout(relogioInatividade);
  relogioInatividade = setTimeout(() => {
    console.error('⏱️ Tempo esgotado: a página ficou 15 minutos sem uso e foi encerrada. '
      + 'Rode o comando de novo para continuar de onde parou (o que já foi salvo continua salvo).');
    process.exit(1);
  }, TEMPO_LIMITE_MS);
  relogioInatividade.unref?.();
}

const servidor = createServer(async (req, res) => {
  agendarEncerramentoPorInatividade();
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
      res.writeHead(404);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/') {
      // Primeira vez (nenhum acesso): vai direto para o cadastro.
      if (carregarConexoes().length === 0) return responder(telaFormulario({}));
      return responder(telaLista());
    }

    if (req.method === 'GET' && url.pathname === '/novo') {
      return responder(telaFormulario({}));
    }

    if (req.method === 'GET' && url.pathname === '/personalizar') {
      return responder(telaPersonalizar());
    }

    if (req.method === 'POST' && url.pathname === '/salvar-personalizacao') {
      const corpo = await lerCorpoBinario(req);
      const { campos, arquivos } = extrairMultipart(corpo, req.headers['content-type']);
      if (campos.tf !== TOKEN_FORMULARIO) {
        return responder(telaPersonalizar({ mensagemErro: 'Sessão inválida. Recarregue a página.' }), 403);
      }
      const perfil = {
        ...carregarPerfil(),
        assistente_nome: (campos.assistente_nome ?? '').trim() || null,
        comunicacao: (campos.comunicacao ?? '').trim() || null,
        atualizado_em: new Date().toISOString(),
      };
      mkdirSync(join(RAIZ, 'data'), { recursive: true });
      writeFileSync(CAMINHO_PERFIL, `${JSON.stringify(perfil, null, 2)}\n`, 'utf8');

      let avisoLogo = '';
      const logo = arquivos.find((a) => a.nome === 'logo' && a.dados.length > 0);
      if (logo) {
        const ehPng = logo.dados[0] === 0x89 && logo.dados[1] === 0x50;
        const ehJpg = logo.dados[0] === 0xff && logo.dados[1] === 0xd8;
        if (!ehPng && !ehJpg) {
          return responder(telaPersonalizar({
            mensagemErro: 'A logomarca precisa ser um arquivo PNG ou JPG.',
          }));
        }
        mkdirSync(PASTA_IDENTIDADE, { recursive: true });
        // Uma logo por vez: remove a anterior e o arquivo de cores (o
        // assistente extrai as cores da logo nova na proxima conversa).
        for (const antiga of ['logo.png', 'logo.jpg', 'identidade.json']) {
          try { rmSync(join(PASTA_IDENTIDADE, antiga)); } catch { /* nao existia */ }
        }
        writeFileSync(join(PASTA_IDENTIDADE, ehPng ? 'logo.png' : 'logo.jpg'), logo.dados);
        avisoLogo = ' Logomarca recebida: na próxima conversa o assistente identifica as cores dela e aplica nos seus relatórios.';
      }
      return responder(telaPersonalizar({ mensagemOk: `Personalização salva.${avisoLogo}` }));
    }

    if (req.method === 'GET' && url.pathname === '/editar') {
      const id = url.searchParams.get('id');
      const atual = carregarConexoes().find((c) => c.id === id);
      if (!atual) return responder(telaLista({ mensagemErro: 'Acesso não encontrado.' }));
      return responder(telaFormulario({ valores: atual, editando: true }));
    }

    if (req.method === 'POST' && url.pathname === '/salvar') {
      const dados = new URLSearchParams(await lerCorpo(req));
      if (dados.get('tf') !== TOKEN_FORMULARIO) {
        return responder(telaLista({ mensagemErro: 'Sessão inválida. Recarregue a página.' }), 403);
      }
      const id = (dados.get('id') ?? '').trim();
      const existentes = carregarConexoes();
      const anterior = existentes.find((c) => c.id === id);
      const v = {
        id: id || undefined,
        nome: (dados.get('nome') ?? '').trim(),
        usuario: (dados.get('usuario') ?? '').trim(),
        senha: (dados.get('senha') ?? '').trim() || anterior?.senha || '',
        serial: (dados.get('serial') ?? '').trim(),
        lojas: (dados.get('lojas') ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number),
        urlBase: ((dados.get('url') ?? '').trim() || URL_PADRAO).replace(/\/+$/, ''),
        segmento: (dados.get('segmento') ?? '').trim() || null,
      };
      const faltando = validarConexao(v);
      if (faltando.length > 0) {
        return responder(telaFormulario({
          valores: v, editando: Boolean(anterior),
          mensagemErro: `Preencha: ${faltando.join(', ')}.`,
        }));
      }
      const resultado = await descobrirModo(v);
      if (resultado.erro) {
        return responder(telaFormulario({
          valores: v, editando: Boolean(anterior),
          mensagemErro: `O sistema da TOTVS não aceitou esses dados. Confira e tente de novo. (Detalhe: ${resultado.erro})`,
        }));
      }
      // Serial duplicado: dois acessos ao mesmo ambiente confundem os relatórios.
      const duplicado = existentes.find((c) => c.serial === v.serial && c.id !== id);
      if (duplicado) {
        return responder(telaFormulario({
          valores: v, editando: Boolean(anterior),
          mensagemErro: `Este número de série já está cadastrado como "${duplicado.nome}". `
            + 'Se quiser mudar algo, altere aquele acesso em vez de criar outro.',
        }));
      }
      v.chave = resultado.modo;
      if (!v.id) v.id = gerarId(v.nome, existentes.map((c) => c.id));
      const salva = salvarConexao(v);
      const db = abrirBanco();
      criarSchema(db);
      db.close();
      return responder(telaLista({
        mensagemOk: `Conexão com "${salva.nome}" testada e salva com sucesso.`,
      }));
    }

    if (req.method === 'POST' && url.pathname === '/remover') {
      const dados = new URLSearchParams(await lerCorpo(req));
      if (dados.get('tf') !== TOKEN_FORMULARIO) {
        return responder(telaLista({ mensagemErro: 'Sessão inválida. Recarregue a página.' }), 403);
      }
      const id = dados.get('id');
      const removida = removerConexao(id);
      return responder(telaLista({
        mensagemOk: removida ? 'Acesso removido. Os dados já baixados continuam no seu computador.' : null,
        mensagemErro: removida ? null : 'Acesso não encontrado.',
      }));
    }

    if (req.method === 'POST' && url.pathname === '/concluir') {
      const dados = new URLSearchParams(await lerCorpo(req));
      if (dados.get('tf') !== TOKEN_FORMULARIO) {
        return responder(telaLista({ mensagemErro: 'Sessão inválida. Recarregue a página.' }), 403);
      }
      responder(telaConcluido);
      const total = carregarConexoes().length;
      console.log(`✅ Configuração concluída: ${total} grupo(s) de lojas conectado(s); banco local pronto.`);
      setTimeout(() => process.exit(0), 500);
      return undefined;
    }

    return responder(pagina('<h1>Página não encontrada</h1>'), 404);
  } catch (erro) {
    return responder(telaLista({ mensagemErro: `Algo deu errado: ${erro.message}` }), 500);
  }
});

servidor.listen(0, '127.0.0.1', () => {
  const endereco = `http://127.0.0.1:${servidor.address().port}/`;
  console.log(`Endereço da página de configuração: ${endereco}`);
  console.log('Se ela não abrir sozinha, copie esse endereço e cole no navegador.');
  console.log('Aguardando o gestor concluir (limite de 15 minutos)...');
  if (!process.argv.includes('--sem-navegador')) {
    abrirNoSistema(endereco, (erro) => {
      console.warn(`Não consegui abrir o navegador automaticamente (${erro.message}).`);
      console.warn(`Peça ao gestor para abrir: ${endereco}`);
    });
  }
  // O limite e de INATIVIDADE, nao de duracao total: cada interacao do gestor
  // renova o relogio. Um gestor leigo passa dos 15 minutos com facilidade na
  // primeira configuracao — procurar o numero de serie no ChefWeb, escolher o
  // arquivo da logomarca — e o servidor morrer no meio faz a pagina parar de
  // responder sem explicacao nenhuma.
  agendarEncerramentoPorInatividade();
});
