# UX — Dashboard de indicadores e relatório imprimível

Rotas: `/dashboard` e `/dashboard/relatorio` (todos os perfis; ocultar item de menu é só UX,
o escopo por perfil/unidade é decidido pelo backend). Menu: "Dashboard" (ícone
`LayoutDashboard`) logo após Home. O painel vazio da Home linka para `/dashboard`.

## Contrato (somente leitura, `src/lib/dashboard-api.ts`)

| Endpoint | Resposta |
|---|---|
| `GET /api/v1/dashboard/resumo` | contagens inteiras (`total_bens`, `localizados`, `nao_localizados`, `desconhecidos`, `movimentacoes_pendentes`, `inventarios_abertos`, `novos_30d`); `valor_total`, `em_manutencao`, `baixas_ano` **sempre `null`**; `variacao.total_bens` = variação percentual (`number\|null`), demais `null` |
| `GET /api/v1/dashboard/por-unidade` | `[{unidade, total, tipos:{TIPO:int}}]` |
| `GET /api/v1/dashboard/por-situacao` | `[{id, value}]` |
| `GET /api/v1/dashboard/aquisicoes-mensais?meses=6` | `[{id, data:[{x:"YYYY-MM", y:int}]}]` |

Toda resposta passa por type guards com allowlist; qualquer desvio (inclusive número em
`valor_total`/`em_manutencao`/`baixas_ano`) vira estado de erro — nada não reconhecido é
renderizado. Nomes vêm como texto puro (escape do React).

## Blocos e estados

KPIs (grade de 2 colunas no celular, 4 no desktop: Total de bens com `Badge` de variação,
Localizados, Movimentações pendentes, Inventários abertos), "Indicadores indisponíveis"
(valor total, em manutenção, baixas no ano — explica que o cadastro ainda não tem esses
campos), barras por unidade/tipo (3 maiores tipos + "Outros"), pizza por situação,
linhas de aquisições mensais (tipo de cada gráfico escolhido pelo usuário — ver
`DASHBOARD_GRAFICOS.md`) (mês abreviado pt-BR, America/Araguaina) e tabela de detalhamento
com linha de total. Cada bloco tem skeleton, erro com "Tentar novamente" (independente dos
demais) e estado vazio honesto. Variação `null` = nenhum selo. Os números só animam quando
o backend os confirmou (AnimatedCounter; sem animação sob reduced motion).

Acessibilidade: gráficos em `role="img"` com resumo textual, legenda em texto, tabela
`sr-only` e (pizza/rosca/barras da situação) seleção por botões `aria-pressed`; o SVG do
Nivo fica num wrapper `aria-hidden` com a a11y interna desligada (`role="presentation"`,
`isFocusable={false}`) para não duplicar a leitura; tabela de detalhamento rolável é região
focável. WCAG 2.2 AA verificado com axe nas telas `dashboard-painel`, `-vazio`, `-erro` e
`dashboard-relatorio`; sem rolagem horizontal de 320 a 1920px.

## Biblioteca de gráficos

Gráficos em **Nivo 0.99.0** (`@nivo/core`, `@nivo/bar`, `@nivo/pie`, `@nivo/line`, versões
pinadas; Recharts removido em 2026-10-20). Tremor descartado (exige React 18; o projeto é
React 19.3). KPIs (`stat-card`) e a tabela por unidade não usam Nivo. Todos os gráficos usam
`animate={false}` (sem mola); a única entrada é a opacidade do `FadeIn` do painel. Detalhes em
`DASHBOARD_GRAFICOS.md`.

## Paleta e tema Nivo (arquivo único)

`frontend/src/components/dashboard/chart-theme.ts` concentra cores, classes e o tema Nivo
(`nivoTheme(theme)`: Geist, eixos, grade, rótulos peso 400, tooltip) dos gráficos e
cartões. A paleta padrão do Nivo nunca é usada. Tema `screen` (Factory dark: signal-orange, metric-green, bone, warm-granite) e tema
`paper` do relatório (obsidian, signal-orange, graphite-mid, warm-granite sobre bone; o verde
fica de fora por contraste). Para trocar a paleta, edite somente esse arquivo.

## Relatório imprimível

`/dashboard/relatorio`: mesma composição em folha clara. `@media print`: sidebar, header e
botões escondidos (`print:hidden`), rolagem interna do shell desativada, fundo branco,
`break-inside: avoid` em cada bloco e margens de página de 12 mm. O botão "Imprimir / Salvar
PDF" chama `window.print()`; a data/hora de emissão é a do navegador (America/Araguaina).
Ponto de atenção (não verificado em impressora real): o SVG do Nivo é dimensionado pela
largura da janela ao abrir o relatório; o teste e2e em mídia `print` confirma ausência de
rolagem horizontal, mas a escala final na folha depende do navegador.

## Testes

`e2e/dashboard.spec.ts` (projeto Playwright `dashboard`), `e2e/support/dashboard-mocks.ts` e
as telas em `e2e/support/screens.ts`.
