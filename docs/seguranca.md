# Segurança e privacidade dos seus dados

Resumo em uma frase: **os dados da sua loja e suas senhas ficam no seu
computador, e o assistente só lê informações do sistema da TOTVS — nunca altera
nada lá.**

## A página de configuração

Quando você diz "quero configurar minha loja", o assistente abre uma página no
seu navegador. Essa página **existe apenas dentro do seu computador** (endereço
local, tipo `127.0.0.1`) — ela não está na internet e ninguém de fora consegue
acessá-la. Ao salvar, ela valida seus dados diretamente com o sistema da TOTVS e
os grava localmente.

## Onde ficam suas senhas

Na configuração, suas credenciais (usuário, senha e número de série) são
gravadas em um arquivo dentro da pasta `data/`, **no seu computador**. Se você
tem mais de um grupo de lojas, cada um fica guardado separadamente ali.

- Esse arquivo **nunca** é enviado ao GitHub, à TOTVS (além do login normal) ou a
  qualquer outro site.
- O projeto é configurado para que esse arquivo seja ignorado por qualquer
  publicação (está no `.gitignore`).
- O assistente é instruído a **nunca repetir sua senha** em conversas ou relatórios.

## Onde ficam os dados da loja

As vendas, contas e estoques baixados ficam no arquivo `data/chef.db` — um banco
de dados local, também só no seu computador. Os painéis gerados ficam na pasta
`relatorios/`. Nada disso é publicado em lugar nenhum.

> ⚠️ **Atenção**: como qualquer conversa com uma IA, o conteúdo que você digita e
> os resultados das análises passam pelos servidores do fornecedor do assistente
> (Anthropic, no caso do Claude; OpenAI, no caso do Codex), conforme os termos e
> políticas de privacidade deles. Suas **senhas** ficam no arquivo local e o
> assistente é orientado a não expô-las.

## A memória do assistente

O assistente guarda em `data/memoria/` (só no seu computador) o que aprende
com você — suas preferências, combinados e fatos da operação — para não
recomeçar do zero a cada conversa. Ele é instruído a **nunca** anotar ali
senhas ou dados pessoais de clientes. Você pode pedir "o que você sabe sobre
mim?" ou mandar esquecer algo a qualquer momento.

## A cópia de segurança

Todo dia, ao fim da rotina automática, o assistente guarda uma **cópia de
segurança** dos dados baixados na pasta **Documentos** do seu computador
(subpasta "Assistente TOTVS Chef - Backups"). As 14 cópias mais recentes são
mantidas; as antigas são apagadas sozinhas.

- A cópia contém **apenas os dados da loja** (vendas, contas, estoque...).
  **Sua senha nunca entra na cópia.**
- Ela fica **no seu computador** — nada é enviado para a internet. Se você
  quiser guardar também em outro lugar (um pen drive, uma pasta que sincroniza
  com sua nuvem pessoal), peça ao assistente para mudar a pasta das cópias.

**Troquei de computador (ou formatei):** instale o assistente no computador
novo, copie a cópia de segurança mais recente para lá (pen drive serve) e peça:
*"restaure minha cópia de segurança"*. Depois, reconfigure o acesso ("quero
configurar minha loja") — a senha não vem na cópia, de propósito. Todo o
histórico volta sem precisar baixar tudo de novo.

## O envio de e-mail (se você ativar)

Se você configurar o envio de relatórios por e-mail, a senha da sua conta de
e-mail também fica **apenas no seu computador** (pasta `data/`), preenchida em
uma página local — nunca pela conversa. Os e-mails saem direto do seu
computador para o seu provedor, sem passar por nenhum serviço da MHI. O
assistente é instruído a **nunca** enviar por e-mail o banco de dados ou as
cópias de segurança — apenas relatórios e planilhas que você pedir.

## O assistente pode estragar algo no meu sistema?

Não. Este projeto usa **apenas funções de consulta** da API do ChefWeb — só
leitura. O assistente é explicitamente proibido (nas instruções do projeto) de
usar qualquer função que grave, altere ou exclua dados no sistema da TOTVS.

## Boas práticas

- Use o assistente no **seu** computador, não em máquinas compartilhadas.
- Não envie a pasta do projeto (principalmente a subpasta `data/`, onde ficam
  suas senhas e seus dados) por e-mail nem por aplicativos de mensagem.
- Se trocar a senha do ChefWeb, diga ao assistente "quero atualizar minhas
  credenciais".
- Para "desinstalar", basta apagar a pasta do projeto — tudo some junto.
