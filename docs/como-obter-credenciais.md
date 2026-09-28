# Como conseguir os dados de acesso (credenciais)

Para o assistente se conectar ao sistema da sua loja, você precisa de
**3 informações**:

| Informação | O que é |
|---|---|
| **Usuário** | O mesmo usuário que você usa para entrar no ChefWeb (retaguarda) |
| **Senha** | A senha desse usuário |
| **Número de série da loja** | A licença da sua loja no ChefWeb — se você tem **mais de uma loja**, use o da **loja central** (geralmente a loja 1) |

## Onde encontrar

- **Usuário e senha**: são os mesmos do portal ChefWeb
  (<https://chefweb.chef.totvs.com.br>). Se você não tem, peça a quem administra o
  sistema na sua empresa.

  > ⚠️ **Permissões**: esse usuário precisa ter **acesso total aos relatórios**
  > no ChefWeb — e, em redes com mais de uma loja, essa permissão deve estar
  > **replicada em todas as lojas**. Sem isso, as consultas do assistente podem
  > voltar vazias ou incompletas. Quem administra o ChefWeb na sua empresa (ou o
  > suporte TOTVS) ajusta isso no cadastro de usuários/permissões.
- **Número de série da loja**: no ChefWeb, em **Cadastros → Lojas → Número de
  Série**. Redes com várias lojas: use o número de série da **loja central**
  (geralmente a loja 1) — por ela o assistente enxerga todas as lojas. Se não
  encontrar, o suporte TOTVS informa na hora.

## Se precisar da ajuda da TOTVS

Não achou o número de série ou seu usuário não consegue acessar? Abra um chamado
no suporte da TOTVS (canal oficial de atendimento da Linha Chef) e diga:

> "Quero usar a **API do ChefWeb (ChefWebAPI)** para consultar os dados da minha
> própria loja (vendas, financeiro e estoque). Preciso confirmar o **número de
> série da loja** e que meu usuário tem acesso. Podem me orientar?"

Dicas:
- A consulta é aos **seus próprios dados** — é um recurso oficial do produto,
  usado por integrações e parceiros homologados.
- Se sua rede tem várias lojas, confirme também o **código de cada loja** — o
  assistente sabe trabalhar com várias lojas.

## Tenho mais de um grupo de lojas

Se sua empresa tem **números de série diferentes** (por exemplo, duas redes, ou
uma matriz e um quiosque contratados separadamente), você precisa de **um
conjunto de dados para cada grupo**: usuário, senha e o número de série
daquele grupo. O assistente cadastra quantos grupos você tiver, e você pode
**acrescentar outros depois**, a qualquer momento — é só dizer "quero adicionar
outra loja" que ele reabre a página de cadastro.

Se você abriu uma **filial dentro de um grupo que já existe** (mesmo número de
série), não precisa de novas credenciais: a loja nova já aparece nas consultas.

## E depois?

Com as 3 informações em mãos (de cada grupo), abra o assistente na pasta do
projeto e diga **"quero configurar minha loja"**. Ele abre uma página segura no seu navegador
onde você preenche tudo — cada campo tem um "Onde encontro?" com a explicação.
Você nunca precisa mexer em arquivos ou códigos.

> 🔒 Suas credenciais ficam gravadas **somente no seu computador**, em um arquivo
> que não sai da sua máquina. Detalhes em [seguranca.md](seguranca.md).
