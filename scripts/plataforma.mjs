// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Helpers de sistema operacional - o projeto precisa funcionar igual no
// Windows e no macOS (e, por tabela, no Linux).

import { existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EH_WINDOWS = process.platform === 'win32';
export const EH_MAC = process.platform === 'darwin';

// Abre um arquivo ou URL no aplicativo padrao do sistema.
// Chame com aoFalhar para avisar o usuario quando nao der (alguns terminais
// nao tem o cmd no PATH, e ambientes sem interface grafica nunca abrem nada).
export function abrirNoSistema(alvo, aoFalhar) {
  // No Windows usamos o caminho real do interpretador: em alguns terminais
  // (Git Bash, shells embarcados) o nome 'cmd' nao esta no PATH e o spawn
  // falha com ENOENT.
  const interpretador = process.env.ComSpec || process.env.COMSPEC || 'C:/Windows/System32/cmd.exe';
  const [comando, argumentos] = EH_WINDOWS
    ? [interpretador, ['/c', 'start', '', alvo]]
    : EH_MAC
      ? ['open', [alvo]]
      : ['xdg-open', [alvo]];
  execFile(comando, argumentos, (erro) => {
    if (erro && typeof aoFalhar === 'function') aoFalhar(erro);
  });
}

// Localiza um navegador baseado em Chromium (Edge, Chrome, Brave...), usado
// para gerar PDF via impressao headless. Retorna null se nao houver nenhum.
export function acharNavegadorChromium() {
  const programas = process.env.ProgramFiles || 'C:/Program Files';
  const programasX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const candidatos = EH_WINDOWS
    ? [
      join(programasX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programas, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programas, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programasX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programas, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    : EH_MAC
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      ]
      : [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
      ];
  return candidatos.find((c) => existsSync(c)) ?? null;
}

// Caminho completo de um utilitario do Windows (schtasks, tasklist...).
// Em alguns terminais (Git Bash, shells embarcados) o System32 nao esta no
// PATH e o spawn falha com ENOENT; resolver pelo diretorio real evita isso.
export function comandoDoSistema(nome) {
  if (!EH_WINDOWS) return nome;
  const raizWindows = process.env.SystemRoot || process.env.windir || 'C:/Windows';
  const candidato = join(raizWindows, 'System32', `${nome}.exe`);
  return existsSync(candidato) ? candidato : nome;
}

// Converte um caminho local em URL file:// valida nos dois sistemas.
export function urlDeArquivo(caminho) {
  return pathToFileURL(caminho).href;
}

// --- Pastas do usuario (Area de Trabalho, Documentos) -----------------------
//
// Essas pastas dao MUITO trabalho para achar: no Windows em portugues elas se
// chamam "Area de Trabalho" e "Documentos" (com acento), e o OneDrive costuma
// redireciona-las para dentro de uma das suas pastas — que por sua vez pode
// ter o nome da empresa. Por isso nao adianta montar o caminho: e preciso
// procurar, comparando os nomes sem acento, nas bases onde elas podem estar.

export const semAcento = (texto) => texto
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function subpastaChamada(base, nomes) {
  try {
    for (const item of readdirSync(base, { withFileTypes: true })) {
      if (item.isDirectory() && nomes.includes(semAcento(item.name))) return join(base, item.name);
    }
  } catch { /* pasta inacessivel: segue para a proxima */ }
  return null;
}

// Bases onde as pastas do usuario podem morar: as pastas do OneDrive (variavel
// de ambiente e as OneDrive* dentro da home) e a propria home, nessa ordem.
function basesDoUsuario() {
  const bases = [];
  if (EH_WINDOWS) {
    for (const variavel of [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]) {
      if (variavel && existsSync(variavel)) bases.push(variavel);
    }
    try {
      for (const item of readdirSync(homedir(), { withFileTypes: true })) {
        if (item.isDirectory() && item.name.toLowerCase().startsWith('onedrive')) {
          bases.push(join(homedir(), item.name));
        }
      }
    } catch { /* home inacessivel */ }
  }
  bases.push(homedir());
  return bases;
}

function acharPastaDoUsuario(nomes) {
  for (const base of basesDoUsuario()) {
    const achada = subpastaChamada(base, nomes);
    if (achada) return achada;
  }
  return null;
}

export function pastaAreaDeTrabalho() {
  return acharPastaDoUsuario(['desktop', 'area de trabalho']);
}

// Documentos do usuario; se nao achar, cai na propria home (sempre existe).
export function pastaDocumentos() {
  // ("Meus Documentos" fica de fora: no Windows e um atalho antigo, sem acesso)
  return acharPastaDoUsuario(['documents', 'documentos']) ?? homedir();
}

// Instrucao de impressao manual, no idioma do gestor, por sistema.
export const DICA_IMPRIMIR_PDF = EH_MAC
  ? 'abra o arquivo no navegador e use Arquivo > Imprimir > Salvar como PDF (Cmd+P)'
  : 'abra o arquivo no navegador e use Imprimir > Salvar como PDF (Ctrl+P)';
