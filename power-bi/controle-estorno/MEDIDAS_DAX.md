# Medidas DAX — Controle de Estorno

Cole estas medidas na tabela `Fact_Estorno` depois de importar `Controle_Estorno_PowerBI.xlsx`
no Power BI Desktop (Home > New Measure).

> **Importante:** `Spending` mistura Real (BRA) e Peso Argentino (ARG) sem conversão de câmbio.
> Todas as medidas de valor abaixo respeitam o slicer de `Moeda` — nunca crie um cartão que some
> `Spending` sem o filtro de Moeda visível na mesma página, ou o resultado mistura duas moedas.

## Básicas

```DAX
Total Casos = COUNTROWS('Fact_Estorno')

Valor Total = SUM('Fact_Estorno'[Spending])

Ticket Médio = AVERAGE('Fact_Estorno'[Spending])

Dias Médio Recebimento-Análise = AVERAGE('Fact_Estorno'[Dias Recebimento-Analise])
```

## Estorno / prazo de 180 dias

```DAX
Casos Estornados =
CALCULATE([Total Casos], 'Fact_Estorno'[Status Estorno] = "Estornado")

Valor Estornado =
CALCULATE([Valor Total], 'Fact_Estorno'[Status Estorno] = "Estornado")

% Estornado (Casos) =
DIVIDE([Casos Estornados], [Total Casos])

Casos Vencidos (Perda) =
CALCULATE([Total Casos], 'Fact_Estorno'[Status Estorno] = "Vencido - Perda")

Valor em Risco (Vencido) =
CALCULATE([Valor Total], 'Fact_Estorno'[Status Estorno] = "Vencido - Perda")

% Vencido sem Estorno =
DIVIDE([Casos Vencidos (Perda)], [Total Casos])

Casos em Alerta (<=30d) =
CALCULATE([Total Casos], 'Fact_Estorno'[Status Estorno] = "Alerta (<=30d)")

Valor em Alerta (<=30d) =
CALCULATE([Valor Total], 'Fact_Estorno'[Status Estorno] = "Alerta (<=30d)")
```

## Auxiliares de formatação (para os cartões de KPI)

```DAX
Valor Total (Texto) =
VAR pais = SELECTEDVALUE('Fact_Estorno'[País])
VAR simbolo = SWITCH(TRUE(), pais = "BRA", "R$ ", pais = "ARG", "AR$ ", "")
RETURN simbolo & FORMAT([Valor Total], "#,##0")
```

## Como aplicar

1. Abra o Power BI Desktop → **Obter Dados → Excel** → selecione `Controle_Estorno_PowerBI.xlsx`.
2. Marque as duas tabelas: `Fact_Estorno` e `Dim_Data`.
3. No Model view, crie a relação `Dim_Data[Data]` (lado 1) → `Fact_Estorno[Payment Date]` (lado \*), ativa.
4. Cole as medidas acima na tabela `Fact_Estorno`.
5. Adicione um slicer de `Moeda` (ou `País`) fixo em todas as páginas que exibem valores monetários.

Veja `GUIA_POWER_BI.md` para o layout de páginas e visuais sugeridos.
