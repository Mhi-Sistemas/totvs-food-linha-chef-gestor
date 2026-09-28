---
name: exportar
description: Gera arquivos para o gestor baixar, imprimir ou enviar - planilhas Excel (.xlsx), documentos Word (.docx) e PDF. Use quando ele pedir "me manda em Excel", "gera uma planilha", "quero em PDF", "faz um documento", "preciso imprimir" ou quiser levar a analise para fora do chat.
---

# Exportar para Excel, Word e PDF

Tudo é gerado na pasta `relatorios/`, sem instalar nada. Funciona igual no
Windows e no Mac. Depois de gerar, **sempre diga onde o arquivo ficou** e
ofereça abrir (`node --no-warnings scripts/abrir.mjs <arquivo>`).

## Planilha Excel (.xlsx)

Cada aba é uma consulta. Nomes de aba em linguagem do gestor (máx. 31 letras):

```
node --no-warnings scripts/exportar.mjs xlsx --saida "relatorios/vendas-setembro.xlsx"   --aba "Vendas por dia=SELECT data_movimento AS Dia, COUNT(*) AS Cupons, ROUND(SUM(valor_total),2) AS Faturamento FROM vendas WHERE cancelada=0 AND data_movimento BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY 1 ORDER BY 1"   --aba "Top produtos=SELECT nome_produto AS Produto, ROUND(SUM(valor_total),2) AS Receita FROM venda_itens ..."
```

Boas práticas:
- **Renomeie as colunas em português** com `AS` ("Faturamento", não "valor_total").
- Arredonde valores (`ROUND(...,2)`) — o Excel mostra o número cru.
- Datas: envie `data_movimento` como está (AAAA-MM-DD) ou formate com
  `strftime('%d/%m/%Y', data_movimento) AS Dia`.
- Uma aba por assunto; a primeira deve ser a visão principal.

## Documento Word (.docx)

Escreva o relatório em markdown (título `#`, seções `##`, listas `-`, tabelas
com `|`, **negrito**), salve num arquivo temporário e converta:

```
node --no-warnings scripts/exportar.mjs docx --entrada "relatorios/_rascunho.md" --saida "relatorios/relatorio-mensal.docx"
```

O documento sai com a identidade do projeto (títulos azul-marinho, tabelas com
cabeçalho escuro). Escreva para o gestor: sem jargão, com período e base
declarados, e conclusões antes das tabelas.

## PDF

Gere primeiro um HTML (use a skill `dashboard` para painéis com gráficos, ou um
HTML simples para texto) e converta:

```
node --no-warnings scripts/exportar.mjs pdf --entrada "relatorios/painel-vendas.html" --saida "relatorios/painel-vendas.pdf"
```

Usa o Chrome/Edge/Brave instalado. Se não houver nenhum (Mac só com Safari), o
script abre o arquivo e orienta o gestor a usar Imprimir → Salvar como PDF
(Cmd+P no Mac, Ctrl+P no Windows) — repasse essa instrução em linguagem simples.

## Escolha do formato

| O gestor quer... | Entregue |
|---|---|
| Mexer nos números, filtrar, somar | **Excel** |
| Ler, imprimir, arquivar, enviar para contador/sócio | **PDF** |
| Editar o texto, apresentar formalmente | **Word** |
| Ver rápido com gráficos | Painel HTML (skill `dashboard`) |

Na dúvida, pergunte: "prefere em planilha (para mexer nos números) ou em PDF
(para imprimir e enviar)?". Se ele pedir "os dois", gere os dois.

## Enviar por e-mail

Se o envio de e-mail estiver configurado (`data/email.json` existe), ofereça:
"quer que eu envie por e-mail?" — e mande com
`node --no-warnings scripts/email.mjs enviar --para <destino> --assunto "..."
--texto "..." --anexo <arquivo>`. Confirme o destinatário na primeira vez.
Se não estiver configurado e o gestor quiser, rode
`node --no-warnings scripts/email.mjs configurar` (página local; nunca peça a
senha do e-mail no chat). Nunca anexe o banco de dados nem cópias de segurança.

## Formatação automática das planilhas

As colunas ganham formato sozinhas ao gerar o xlsx: datas do banco viram
DD/MM/AAAA (com hora, se houver); colunas cujo nome indica dinheiro (valor,
faturamento, receita, preço, custo, ticket, margem, saldo, total...) saem como
R$; nomes com `pct`/`percent`/`%` saem como percentual — tanto faz vir 87,5 ou
0,875, a exibição fica certa. Para a detecção funcionar bem, **nomeie os
apelidos das consultas com intenção**: percentuais terminando em `_pct`
(ex.: `margem_pct`), e contagens como `cupons`/`qtd` — nunca `total`, que é
tratado como dinheiro.

## HTML rico é o padrão de "relatório" — e organização das pastas

Pedido genérico de **"relatório"** = página HTML rica via gerador de painéis
(`painel.mjs`, skill `dashboard`) — KPIs, gráficos e o tipo `tabela` com
busca, filtros de coluna e ordenação. Excel/Word/PDF entram quando o gestor
pedir o FORMATO ("manda em Excel", "quero imprimir").

Organização obrigatória de `relatorios/` (nome `assunto-AAAA-MM-DD.ext`):
- `relatorios/paineis/` — painéis e relatórios HTML (padrão do gerador)
- `relatorios/dre/` — DREs (padrão do gerador)
- `relatorios/planilhas/` — .xlsx
- `relatorios/documentos/` — .docx e .pdf
Nunca despeje arquivo solto na raiz de `relatorios/`.
