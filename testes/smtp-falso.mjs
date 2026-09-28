// Assistente de Gestao para TOTVS Food Linha Chef
// Copyright (c) 2026 MHI Sistemas - https://www.mhi.com.br
// Licenciado sob a Licenca MIT (veja LICENSE e NOTICE).
// Projeto independente, sem vinculo oficial com a TOTVS.
//
// Servidor SMTP de mentira (TLS) usado pelo teste de fumaca para validar o
// cliente de scripts/email.mjs sem tocar em provedor real. Captura a mensagem
// recebida para inspecao.

import { createServer } from 'node:tls';
import { readFileSync } from 'node:fs';

const CRLF = '\r\n';

export function iniciarSmtpFalso({ chave, cert, usuario, senha }) {
  let capturada = '';
  const servidor = createServer({ key: readFileSync(chave), cert: readFileSync(cert) }, (s) => {
    let emData = false;
    let acumulado = '';
    s.write(`220 falso.local pronto${CRLF}`);
    s.on('data', (dados) => {
      const texto = dados.toString('utf8');
      if (emData) {
        acumulado += texto;
        const fim = acumulado.indexOf(`${CRLF}.${CRLF}`);
        if (fim >= 0) {
          capturada = acumulado.slice(0, fim);
          emData = false;
          s.write(`250 recebido${CRLF}`);
        }
        return;
      }
      for (const linha of texto.split(CRLF).filter(Boolean)) {
        if (linha.startsWith('EHLO')) s.write(`250-falso.local${CRLF}250 AUTH LOGIN${CRLF}`);
        else if (linha === 'AUTH LOGIN') s.write(`334 VXNlcm5hbWU6${CRLF}`);
        else if (linha === Buffer.from(usuario).toString('base64')) s.write(`334 UGFzc3dvcmQ6${CRLF}`);
        else if (linha === Buffer.from(senha).toString('base64')) s.write(`235 autenticado${CRLF}`);
        else if (linha.startsWith('MAIL FROM') || linha.startsWith('RCPT TO')) s.write(`250 ok${CRLF}`);
        else if (linha === 'DATA') { emData = true; acumulado = ''; s.write(`354 manda${CRLF}`); }
        else if (linha === 'QUIT') { s.write(`221 tchau${CRLF}`); s.end(); }
        else s.write(`500 nao entendi${CRLF}`);
      }
    });
  });
  return new Promise((resolve, reject) => {
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => resolve({
      porta: servidor.address().port,
      mensagem: () => capturada,
      fechar: () => servidor.close(),
    }));
  });
}
