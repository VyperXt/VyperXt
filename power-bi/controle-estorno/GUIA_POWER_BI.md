# Guia de montagem — Dashboard Power BI: Controle de Estorno

Este pacote entrega tudo que é necessário para montar o `.pbix` no Power BI Desktop
(o Power BI Desktop é obrigatório para gerar o arquivo binário `.pbix` — não existe
gerador de `.pbix` fora dele, por isso o pacote traz os dados já tratados + medidas
DAX prontas + este guia de layout).

Arquivos deste pacote:
- `Controle_Estorno_PowerBI.xlsx` — base tratada (abas `Fact_Estorno`, `Dim_Data`, `Leia-me`).
- `MEDIDAS_DAX.md` — todas as medidas DAX para colar no modelo.
- Um preview navegável do resultado esperado foi publicado como artifact (link enviado na conversa).

## 1. Importar e modelar

1. Power BI Desktop → **Obter dados → Pasta de Trabalho do Excel** → `Controle_Estorno_PowerBI.xlsx`.
2. Carregue `Fact_Estorno` e `Dim_Data`.
3. Em **Modelagem**, crie a relação `Dim_Data[Data]` → `Fact_Estorno[Payment Date]` (1 para \*, ativa).
4. Marque `Dim_Data` como **Tabela de Datas** (coluna `Data`).
5. Cole as medidas de `MEDIDAS_DAX.md` na tabela `Fact_Estorno`.
6. Formate `Valor Total`, `Valor em Risco (Vencido)` etc. como moeda — **mas mantenha sempre o
   slicer de `Moeda` visível**, pois BRA (R$) e ARG (peso) não podem ser somados juntos.

## 2. Página 1 — Visão Geral / Saúde do Estorno

Cartões (linha superior):
- **Total Casos** (`[Total Casos]`)
- **% Estornado** (`[% Estornado (Casos)]`)
- **% Vencido sem Estorno** (`[% Vencido sem Estorno]`) — KPI crítico, formate com alerta visual
  (ex. cartão condicional vermelho se > 50%)
- **Valor em Risco (Vencido)** (`[Valor em Risco (Vencido)]`, filtrado por `Moeda`)

Gráfico de rosca — **Status Estorno** (`Status Estorno` na legenda, `Total Casos` no valor):
cores sugeridas — Estornado = verde, Em Dia = azul, Alerta (<=30d) = amarelo,
Vencido - Perda = vermelho.

Gráfico de colunas empilhadas — **Casos por Mês de Pagamento x Status Estorno**
(eixo X = `Ano Mes Pagamento`, legenda = `Status Estorno`).

Slicers no topo da página: `País`/`Moeda`, `Range`, `System`.

## 3. Página 2 — Financeiro (valor)

- Cartão: `Valor Total`, `Ticket Médio`, `Valor Estornado`, `Valor em Risco (Vencido)`.
- Gráfico de barras horizontais — **Valor por Destination**, ordenado decrescente.
- Gráfico de barras — **Top 10 Peças (PN + Part Description) por Valor**.
- Tabela — **Top 10 Descrições de Falha por quantidade de casos**.
- Slicer fixo: `Moeda` (obrigatório nesta página).

## 4. Página 3 — Operação / Responsáveis

- Tabela/matriz — `Analysis Responsible` x `Total Casos` x `Dias Médio Recebimento-Análise`.
- Gráfico de colunas — **Casos por Range** (Heavy/Medium/Light/Bus).
- Gráfico de colunas — **Casos por System**.
- Gráfico de colunas — **Casos por Test Type**.

## 5. Filtros globais recomendados (painel de filtros, todas as páginas)

`País`, `Range`, `System`, `Destination`, `Status Estorno`, intervalo de `Payment Date`.

## 6. Publicação

Depois de montado: **Arquivo → Publicar → Power BI Service** (ou salve o `.pbix` e envie
para quem for hospedar). Configure atualização agendada apontando para a fonte de dados
original se a base for atualizada periodicamente (ex. exportação semanal do SharePoint
"Quality Inspection Data Base").
