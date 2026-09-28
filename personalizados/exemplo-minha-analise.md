---
nome: exemplo-abertura-de-sabado
tipo: analise            # analise | metrica | dashboard
gatilhos: ["abertura de sábado", "relatório de sábado"]
frequencia: semanal      # diaria | semanal | mensal | sob-demanda
substitui:               # opcional: item do catálogo oficial que substitui
---

# Exemplo — apague ou use como modelo

**O que entrega**: faturamento e cupons dos últimos 4 sábados, comparados entre
si, com o horário de pico de cada um e os 5 produtos mais vendidos no período
da noite (18h–23h).

**Período/filtros**: apenas sábados (`strftime('%w', data_movimento) = '6'`),
últimos 28 dias, todas as lojas.

**Consulta de referência**:
```sql
SELECT data_movimento, COUNT(*) AS cupons, ROUND(SUM(valor_total), 2) AS faturamento
FROM vendas
WHERE cancelada = 0
  AND strftime('%w', data_movimento) = '6'
  AND data_movimento >= date('now', '-28 day')
GROUP BY 1 ORDER BY 1;
```

**Formato**: texto no chat, com oferta de virar painel.
