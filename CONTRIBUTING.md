# Como contribuir

Contribuições são bem-vindas — pode escrever em português, do seu jeito.

## Achou um problema ou tem uma ideia?

Abra uma [issue](../../issues) descrevendo o que aconteceu (ou o que você
gostaria que acontecesse). Se for um erro, ajuda muito informar: o que você
pediu ao assistente, o que ele respondeu e qual sistema você usa (Windows ou
Mac). **Nunca cole senhas, número de série ou dados de clientes na issue.**

## Vai enviar código?

1. Abra uma issue antes, para combinarmos a abordagem — evita trabalho jogado fora.
2. Siga o estilo do projeto: código e comentários **em português**, sem
   dependências externas (o projeto roda só com o Node, de propósito) e
   compatível com **Windows e macOS**.
3. Teste com dados reais quando possível, e nunca versione dados de cliente —
   as pastas `data/`, `relatorios/` e `personalizados/` ficam fora do Git.
4. **Nunca mexa no que é do gestor.** A atualização é automática e silenciosa:
   uma versão nova NÃO pode apagar nem alterar o que ele já configurou —
   `data/` (credenciais, banco, metas, memória do assistente, perfil),
   `personalizados/` (análises, painéis e indicadores dele, identidade visual)
   e `relatorios/` (o que já foi gerado). Essas pastas ficam fora da cópia da
   atualização e fora do Git. Mudança de formato nesses arquivos precisa ser
   **retrocompatível** ou vir com migração que preserve o conteúdo; mudança de
   schema do banco entra como migração idempotente em `criar-banco.mjs`, nunca
   recriando tabela. O teste de fumaça cobre essa regra.
5. **Changelog e versão são obrigatórios**: toda mudança publicada precisa de
   uma entrada no `CHANGELOG.md` (escrita em linguagem de gestor) e do aumento
   da versão no `package.json` (correção = terceiro número, novidade =
   segundo). É isso que alimenta a atualização automática dos assistentes já
   instalados — sem changelog e sem versão nova, sua melhoria não chega a
   ninguém.

## Certificado de origem (DCO)

Para proteger o projeto e quem contribui, exigimos que cada commit seja
assinado com o *Developer Certificate of Origin*. Na prática, basta usar:

```
git commit -s -m "sua mensagem"
```

Isso acrescenta uma linha `Signed-off-by: Seu Nome <seu@email>` ao commit,
pela qual você declara que:

- o código é seu, ou você tem o direito de submetê-lo sob a licença deste
  projeto (MIT); e
- você concorda que sua contribuição seja distribuída sob essa licença.

O texto integral do DCO está em <https://developercertificate.org/>.

Contribuições **sem** o sign-off não serão incorporadas — não por burocracia,
mas porque sem essa declaração não há como garantir que o projeto pode seguir
sendo distribuído livremente.

## Autoria

O projeto é de autoria da **MHI Sistemas** (veja `NOTICE` e `LICENSE`).
Contribuições aceitas passam a integrar o projeto sob a mesma licença,
preservando o crédito de cada autor no histórico do Git. A atribuição de
autoria presente no código, na documentação, nas telas e nos arquivos gerados
deve ser mantida — removê-la viola os termos da licença.
