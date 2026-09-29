# Dashboard Power BI — Controle de Estorno

Pacote gerado a partir de `Controle_de_Estorno.xlsx` (base de garantia/estorno da
Iveco Group, abas `query`/`BasePA`) para montar um dashboard Power BI com os
principais parâmetros de controle.

## Preview interativo

Um preview navegável, já com os KPIs calculados a partir da base real, está publicado aqui:
https://claude.ai/artifact/SDXMvxBWhZJuWWQa91QgT5

(O `.pbix` em si só pode ser gerado dentro do Power BI Desktop — não existe um formato
de exportação para esse binário fora da ferramenta. Este pacote traz tudo pronto para
montá-lo em poucos minutos.)

## Conteúdo

| Arquivo | Para quê |
|---|---|
| `Controle_Estorno_PowerBI.xlsx` | Base tratada (`Fact_Estorno` + `Dim_Data` + `Leia-me` com premissas) pronta para importar no Power BI. |
| `MEDIDAS_DAX.md` | Medidas DAX prontas para colar no modelo. |
| `GUIA_POWER_BI.md` | Passo a passo de modelagem e layout das páginas do dashboard. |

## Principais parâmetros do dashboard

- **Saúde do estorno**: % de casos já estornados ao fornecedor vs. % que perderam o
  prazo de 180 dias (regra: vencimento = data de pagamento + 180 dias) sem recuperação.
- **Financeiro por moeda**: valor total, valor estornado e valor em risco — sempre
  segmentado por `Moeda` (BRL/ARS), pois a base mistura Real e Peso Argentino sem
  conversão.
- **Operacional**: casos por linha de veículo (Range), sistema, tipo de teste, destino
  da peça, principais descrições de falha e carga de trabalho por responsável de análise.

Veja `Leia-me` dentro do Excel e `GUIA_POWER_BI.md` para as regras de negócio e os
pontos de atenção de qualidade de dados identificados na base original.
