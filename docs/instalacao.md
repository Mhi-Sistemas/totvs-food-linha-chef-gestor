# Guia de instalação (para quem nunca mexeu com isso)

Leva uns 10 minutos e você faz **uma vez só**.

A ideia é simples: você instala o assistente de IA, e **é ele quem instala o
resto** para você. Você não vai precisar baixar arquivos, descompactar pastas
nem entender onde as coisas ficam.

> 💡 **O que é "terminal"?** É a tela preta onde se digitam comandos. Parece
> coisa de filme de hacker, mas você só vai colar 1 ou 2 comandos deste guia.
> - **Windows**: aperte a tecla Windows, digite `powershell` e aperte Enter.
> - **Mac**: aperte Cmd + espaço, digite `terminal` e aperte Enter.

---

## Passo 1 — Instalar o Node.js

É um programa de apoio, de graça, que o assistente usa para funcionar.

1. Acesse <https://nodejs.org/pt>
2. Clique no botão de download da versão **LTS** (a recomendada).
3. Abra o arquivo baixado e vá clicando em **Avançar/Next** até concluir
   (não precisa mudar nenhuma opção).
4. Para conferir: feche e abra o terminal de novo, digite `node --version` e
   aperte Enter. Deve aparecer `v22` ou um número maior. Apareceu? Deu certo.

## Passo 2 — Instalar o assistente de IA

Escolha **um** dos dois. Os dois funcionam igual com este projeto.

### Opção A: Claude Code (Anthropic)

1. Você precisa de uma conta em <https://claude.ai> com um plano que inclua o
   Claude Code (confira os planos atuais no site).
2. No terminal, cole e aperte Enter:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
3. Digite `claude` e aperte Enter. Na primeira vez ele abre o navegador para
   você entrar com sua conta. Siga as instruções na tela.

### Opção B: Codex (OpenAI)

1. Você precisa de uma conta ChatGPT com plano que inclua o Codex
   (confira em <https://openai.com/codex>).
2. No terminal, cole e aperte Enter:
   ```
   npm install -g @openai/codex
   ```
3. Digite `codex`, aperte Enter e siga as instruções para entrar com sua conta.

## Passo 3 — Pedir a instalação do assistente de gestão

Com o Claude Code (ou o Codex) aberto — **em qualquer pasta, não importa
qual** — escreva esta frase e aperte Enter:

> **Instale o assistente de gestão do TOTVS Food Linha Chef:**
> **https://github.com/mhi-sistemas/totvs-food-linha-chef-gestor**

Ele vai baixar o projeto e preparar seu computador. Pode levar um ou dois
minutos. Se ele pedir permissão para executar alguma coisa, pode autorizar.
Ao terminar, **peça para ele te dizer em que pasta o assistente ficou** — é
por ela que você volta nas próximas vezes.

## Passo 4 — Conectar sua loja

Na sequência, o assistente abre uma **página segura no seu navegador** para
você informar os dados de acesso da TOTVS. Tenha em mãos:

- **usuário** e **senha** do ChefWeb;
- **número de série da loja** (o da loja central, se você tem mais de uma).

Não sabe onde encontrar? Veja
[como-obter-credenciais.md](como-obter-credenciais.md) — a própria página de
configuração também explica.

> 🔒 Digite a senha **só naquela página**, nunca na conversa. Ela fica gravada
> apenas no seu computador.

Ao salvar, o assistente testa a conexão e busca seus primeiros dados. A partir
daí é só perguntar: *"como foram minhas vendas na semana passada?"*

---

## Nas próximas vezes

Abra a mesma ferramenta de IA que você usa, **apontando para a pasta do
assistente** — é só isso. Ele lembra de tudo: seus acessos, suas preferências
e todo o histórico que já baixou.

- **Claude Desktop**: abra o app e escolha a pasta do assistente.
- **Claude Code ou Codex (no terminal)**: abra o terminal na pasta do
  assistente e digite `claude` (ou `codex`).

Não lembra onde ficou a pasta? Ela se chama **`assistente-totvs-chef`** e está
dentro da sua pasta de usuário. Você também pode abrir a ferramenta de IA em
qualquer lugar e pedir: *"abra o assistente de gestão do TOTVS Food"*.

---

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `node não é reconhecido...` | Feche e abra o terminal de novo. Se persistir, reinstale o Node.js. |
| `npm não é reconhecido...` | Mesmo caso acima — o npm vem junto com o Node.js. |
| O assistente diz que a versão do Node é antiga | Instale a versão **LTS** em <https://nodejs.org/pt> por cima da atual. |
| Erro de permissão no Mac ao instalar | Tente `sudo npm install -g ...` e digite a senha do computador. |
| As consultas voltam vazias ou incompletas | Seu usuário do ChefWeb precisa de **acesso total aos relatórios**, replicado **em todas as lojas**. Fale com seu contato TOTVS. |

Travou em alguma coisa? Abra o assistente, cole a mensagem que apareceu e peça
ajuda — ele mesmo te orienta, em português.

---

## Prefere instalar à mão?

Não é necessário, mas é possível — útil em computadores de empresa com
restrição de instalação.

1. Na página do projeto no GitHub, clique no botão verde **Code** →
   **Download ZIP** e descompacte a pasta em um lugar fácil (ex.: Documentos).
2. Abra o terminal **dentro dessa pasta**:
   - **Windows**: abra a pasta no Explorador, clique na barra de endereço,
     digite `powershell` e aperte Enter.
   - **Mac**: no Terminal, digite `cd ` (com espaço), arraste a pasta para
     dentro da janela e aperte Enter.
3. Cole e aperte Enter:
   ```
   node --no-warnings scripts/instalar.mjs
   ```
4. Digite `claude` (ou `codex`), aperte Enter e diga
   **"quero configurar minha loja"**.
