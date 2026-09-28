---
name: email
description: Configura e usa o envio de relatorios por e-mail (SMTP do proprio gestor) - recurso OPCIONAL. Use quando o gestor pedir "me manda por e-mail", "envie toda segunda para...", ou quiser automatizar entregas por e-mail. A maioria dos gestores usa Gmail pessoal - esta skill tem o roteiro guiado da "senha de app".
---

# E-mail — envio de relatórios (opcional)

**Este recurso é opcional.** Só ofereça quando o gestor pedir envio por
e-mail ou combinar uma automação que o inclua. Nunca trave outra entrega por
causa dele — sem e-mail configurado, o relatório abre no computador
normalmente (`abrir.mjs`).

Comandos:

```
node --no-warnings scripts/email.mjs configurar    # página local (senha NUNCA no chat)
node --no-warnings scripts/email.mjs testar [--para a@b]
node --no-warnings scripts/email.mjs enviar --para a@b[,c@d] --assunto "..." --texto "..." [--anexo arquivo]...
```

Está configurado? `data/email.json` existe. Regras de sempre: enviar só a
pedido ou em automação combinada; confirmar destinatários na primeira vez;
**nunca anexar o banco de dados nem cópias de segurança** (contêm dados
pessoais de clientes); envio agendado exige o computador ligado — avise.

## O caso típico: gestor com Gmail pessoal

Muitos gestores não têm e-mail corporativo. O Gmail funciona bem, mas **não
aceita a senha normal da conta** — precisa de uma "senha de app", e o gestor
não vai conseguir sozinho. Conduza você, um passo por vez, esperando ele
confirmar cada um:

1. **Explique o porquê em uma frase**: *"o Google pede uma senha especial
   para programas enviarem e-mail por você — vou te ajudar a criar, leva uns
   3 minutos e é uma vez só"*.
2. **Verificação em duas etapas** (pré-requisito do Google): abra no navegador
   dele `https://myaccount.google.com/signinoptions/twosv`. Se já estiver
   ativa, siga ao passo 3. Se não: oriente a clicar em ativar e confirmar com
   o celular (ele vai precisar do telefone na mão — avise antes).
3. **Criar a senha de app**: abra `https://myaccount.google.com/apppasswords`.
   Peça para digitar o nome **Assistente de Gestao** e clicar em criar. O
   Google mostra **16 letras em blocos de 4**.
4. **Colar na página local**: rode `node --no-warnings scripts/email.mjs
   configurar`, peça para escolher **Gmail** na lista (servidor e porta se
   preenchem sozinhos) e **colar as 16 letras no campo de senha da página**
   — pode colar com ou sem espaços. ⚠️ Oriente explicitamente: *"cole na
   janela que abriu, não aqui na conversa"*. Se ele colar a senha no chat,
   não a repita, peça para usar a página e siga em frente.
5. **Testar**: o botão "Testar e salvar" envia um e-mail de teste. Peça para
   conferir a caixa de entrada e clicar em **Concluir**.

Outros provedores:

- **Outlook/Hotmail**: escolher na lista da página; com verificação em duas
  etapas ativa, também pode exigir senha de app (configurações de segurança
  da conta Microsoft).
- **E-mail da empresa** (provedor próprio): a página tem a opção "Outro" —
  o gestor pergunta a quem cuida do e-mail dele os dados de envio (SMTP):
  servidor, porta (465 ou 587), usuário e senha.
- **Gestor sem nenhum e-mail?** Criar uma conta Gmail gratuita resolve — e
  o roteiro acima se aplica na sequência.

## Automação combinada ("toda segunda me manda...")

Registre a entrega na personalização (skill `configurar` passo 8 /
`personalizados/README.md`, campos `frequencia` e destinatários) e agende
pelo agendador do ambiente: gerar o arquivo em `relatorios/` **depois da
rotina diária** e enviar com `email.mjs enviar --anexo ...`. Lembre o gestor:
o computador precisa estar ligado no horário.
