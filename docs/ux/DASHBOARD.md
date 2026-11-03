# UX — Dashboard, fila de revisão e relatório imprimível

Rotas: `/dashboard`, `/dashboard/classificacao` e `/dashboard/relatorio`. Menu: só
"Dashboard" (ícone `LayoutDashboard`), logo após Home; as outras duas são
alcançadas por link dentro da própria área. Ocultar item de menu é só UX — o
escopo por perfil e por unidade é decidido pelo backend.

> **Estado atual (2026-10-29; painel `located_summary` acrescentado em
> 2026-11-01).** Desde a Onda 3 a tela `/dashboard` é governada
> **somente** pelo catálogo de painéis do backend (`GET /api/v1/dashboard/panels`).
> Os blocos antigos (KPIs de `/dashboard/resumo`, barras por unidade, pizza por
> situação, aquisições mensais, painéis de Tecnologia) e a barra de filtros com
> estado na URL **não aparecem mais em `/dashboard`**: eles sobrevivem apenas no
> relatório imprimível (`/dashboard/relatorio`), que ainda compõe o conjunto
> legado. Isso **não** quer dizer que o quantitativo de localizados × não
> localizados tenha ficado só no relatório: desde 2026-11-01 o `/dashboard` tem o
> painel de catálogo `located_summary` (rosca com o total global por situação), ao
> lado de `located_by_unit_chart` (por unidade, desde a Onda D) — são painéis
> novos, servidos por `/dashboard/panels/<id>/data`, e não o antigo bloco "Bens por
> situação". O componente `dashboard-filter-bar.tsx` foi removido do repositório;
> `use-dashboard-url-filters.ts` e `dashboard-filter-labels.ts` continuam, usados
> pelo relatório para LER e listar filtros que venham na query string.

## 1. `/dashboard` — grade do catálogo de painéis

Código: `frontend/src/app/(app)/dashboard/page.tsx` →
`features/dashboard/dashboard-view.tsx` → `features/dashboard/equipment-panels.tsx`
(+ `equipment-panel-views.tsx`, `equipment-data-matrix.tsx`, `located-chart-view.tsx`,
`located-summary-view.tsx`, `located-records-sheet.tsx`). Clientes:
`src/lib/preferences-api.ts` (catálogo e preferências) e
`src/lib/dashboard-equipment-api.ts` (dados, registros, exportação).

### Contrato (somente leitura, exceto a preferência)

| Chamada | Uso |
|---|---|
| `GET /api/v1/dashboard/panels` | `{panels, sizes, default_layout, preferences:{panels, version}}` — **só os painéis que o perfil do JWT pode ver** |
| `GET /api/v1/dashboard/panels/<id>/data?unit_id&familia&categoria` | números de um painel |
| `GET /api/v1/dashboard/panels/located_by_unit_chart/records` | bens de uma barra do painel de localização |
| `GET /api/v1/dashboard/panels/<id>/export?format=csv\|xlsx` | arquivo dos painéis marcados `exportable` |
| `PUT /api/v1/dashboard/preferences` | `{version, panels}` ou `{version, restore_default:true}` |

O frontend **não guarda lista de ids**: desenha o que vier e confere a resposta
contra o próprio catálogo recebido (`parseDashboardPanels`). `404` num painel
significa "inexistente OU proibido" (indistinguível) e o painel é simplesmente
omitido, sem alarde. Rótulo e ajuda de cada painel vêm de `panels[].label` /
`panels[].description`; os tamanhos oferecidos, de `panels[].sizes`. O mapa
`dashboard-panel-meta.ts` **não** é usado aqui: ele pertence ao contrato legado de
15 ids e só o relatório o importa (ver §3).

A rota `/records` existe **só** para `located_by_unit_chart`; o resumo global
(`located_summary`) e qualquer outro id devolvem o mesmo `404` de painel
inexistente, de propósito. `/export` só responde nos painéis marcados
`exportable` (hoje as duas tabelas por unidade).

Catálogo no backend: `backend/app/services/dashboard_panels_service.py`
(`PANEL_CATALOG`) — **14 painéis** em 2026-11-01 (`located_summary`, a rosca do
quantitativo global por situação de localização, é o mais recente), agrupados em `indicadores`,
`tabelas`, `graficos`, `operacao` e `qualidade`. Três são exclusivos de ADM
(`unclassified_review`, `classification_overrides`, `sync_status`) e dois de
ADM/USER (`notebooks_without_docking`, `workstation_ratio`); enviá-los no `PUT`
sem permissão devolve `403 panel_forbidden` e gera registro em `audit_logs`.

### Grade, filtros e estados

- Cabeçalho da página: ponto `signal-orange`, eyebrow "Painel patrimonial", h1
  "Dashboard" e as ações "Personalizar painéis" + "Imprimir relatório".
- Seção "Equipamentos e mobiliário" (`h2` em eyebrow) com a frase "Os números são
  contagens do servidor".
- **Filtros da grade** (`EquipmentFilters`, estado local da tela — não vão para a
  URL): "Família" (`TI`, `MOBILIARIO`, `OUTROS`, `NAO_CLASSIFICADO`), "Unidade"
  (`GET /units/accessible`; opção "Todas as unidades visíveis") e "Categoria"
  (lista filtrada pela família escolhida). "Limpar filtros" + resumo
  `role="status"`: "Sem filtros: todos os bens visíveis ao seu perfil." ou
  "N filtro(s) ativo(s)." Falha da lista de unidades desabilita só esse `<select>`
  e avisa; os painéis continuam.
- Cada painel é uma `section` com `aria-labelledby`, `aria-busy` enquanto carrega,
  `data-equipment-panel=<id>` e `data-panel-size=P|M|G`. Estados independentes:
  esqueleto, **vazio** ("Nenhum bem com estes filtros" / "Nenhum bem para exibir",
  sempre dizendo que nenhum gráfico de exemplo é exibido) e **erro** com
  `role="alert"`, "Não foi possível carregar este painel. Nenhum valor foi
  estimado." e "Tentar novamente" (nome acessível inclui o painel).
- Grade: 1 coluna no celular, 2 em tablet, até 3 no desktop; `P` = 1 coluna,
  `M` = 2, `G` = largura total. A ordem do DOM é a ordem escolhida (leitura e foco
  seguem a tela); `data-equipment-order` expõe a ordem para os testes.
- Catálogo indisponível: `role="alert"` com "Não foi possível carregar os painéis.
  Nenhum valor foi estimado." + "Tentar novamente". Catálogo vazio para o perfil:
  "Nenhum painel visível", orientando usar "Personalizar painéis".
- **Exportação**: só nos painéis com `exportable: true` (hoje
  `equipment_by_unit_table` e `furniture_by_unit_table`) e só quando há dados.
  Botões "Exportar CSV"/"Exportar XLSX" com `loading`, mensagem de resultado em
  `role="status"` ("Arquivo <nome> gerado.") ou `role="alert"` no erro. O download
  é autenticado (fetch → Blob); nenhum token vai na URL.
- **Painel de localização por unidade** (`located_by_unit_chart`,
  `located-chart-view.tsx`): clicar numa barra abre o painel lateral
  (`LocatedRecordsSheet`, Radix Dialog: foco preso, Esc fecha, foco devolvido) com
  os bens daquela unidade × situação, paginados pelo servidor. A tabela "Bens por
  unidade e situação" tem **linha de totais** (`[data-located-totals]`; cartão
  abaixo de `lg`): a coluna "Total" repete o `dados.total` do servidor verbatim e
  cada coluna de situação soma as linhas que o servidor mandou, **incluída a linha
  "Outras"**. Se a soma por situação não fechar com `dados.total`, os **dois**
  números aparecem num aviso `role="note"`
  (`[data-located-totals-mismatch]`) — a divergência é exibida, nunca escondida nem
  "corrigida".
- **Painel do quantitativo global por situação** (`located_summary`,
  `located-summary-view.tsx`, `data-equipment-panel="located_summary"`): rosca
  (donut Nivo) com as três séries — **verde liso** "Localizados", **laranja
  listrado** "Não localizados", **cinza pontilhado** "Não informado" (cor + textura,
  nunca só cor). Elementos, de cima para baixo:
  - legenda textual com o valor ao lado de cada série, **inclusive a série com 0**
    (a legenda e a tabela do `ChartShell` são montadas a partir dos dados do
    gráfico; fatia de ângulo zero não desenha área, então o zero não ganha marca
    visível que pudesse ser lida como "um pouco");
  - cartão "Total de bens" com o total **apurado pelo servidor** (`dados.total`;
    nada é somado no cliente);
  - tabela `Situação | Bens | % do total` com rodapé de total. O total **não tem
    percentual próprio**: a célula mostra "—", nunca 100% (o backend não envia
    percentual de total). Percentual de série vazia com acervo não vazio é `0,0%`;
    "—" também aparece quando o backend manda `percentual: null` (só acontece com
    total 0, caso em que o painel já cai no estado vazio);
  - abaixo de `lg` a tabela é substituída por **cartões** (um por situação + o de
    total), uma coluna em 320 px.
  - **Não abre lista de bens** (decisão registrada): `/patrimonios` lê da URL
    apenas `busca` e `page`, e o filtro "Localizado" daquela tela é estado local do
    React — não existe parâmetro de URL para a situação. Em vez de inventar um
    (`?localizado=` seria contrato imaginário), o painel traz o texto "Este painel
    não abre listas. Para ver os bens de uma situação, use o filtro “Localizado” em
    Patrimônios." (`[data-located-summary-hint]`) e um link simples "Abrir a lista
    de bens" para `/patrimonios`, **sem filtro aplicado**. É também
    por isso que este painel não tem `/records` nem `/export`. Melhoria futura:
    `use-asset-filters.ts` passar a ler `located` da URL.
- Rótulos vindos da planilha são sempre texto escapado pelo React e nada é
  estimado no cliente. Os gráficos Nivo rodam com `animate={false}`; o único
  número que se move é o do `StatCard` (cartões de KPI, razão e o total da rosca),
  cujo `AnimatedCounter` parte de 0 até o valor **já confirmado pelo backend** e
  fica estático sob `prefers-reduced-motion` (correção de redação: a versão
  anterior desta página dizia que nenhum número era animado na tela).

### "Personalizar painéis"

`features/dashboard/dashboard-layout-dialog.tsx` + `use-dashboard-panel-prefs.ts`.
Diálogo em superfície clara (Light Surface Card do DESIGN.md), com a lista
ordenada de painéis do catálogo. Por painel: caixa "mostrar", grupo de rádios de
tamanho (**só** os tamanhos admitidos pelo catálogo — "Pequeno", "Médio",
"Grande") e duas formas de reordenar:

- **Botões** "Mover <painel> para cima/baixo" (não depende de arrastar); ao mover,
  o foco acompanha o painel e a nova posição é anunciada por `aria-live`
  ("<painel> movido para a posição N de M.").
- **Arrastar pela alça** (ponteiro): a lista só muda ao soltar, com uma barra
  marcando o destino.

Regras: rascunho local enquanto o diálogo está aberto; "Salvar" só com mudança;
pelo menos um painel visível ("Mantenha pelo menos um painel visível." — o backend
também recusa); "Restaurar padrão" envia `{version, restore_default:true}`;
"Cancelar" descarta. A grade só muda **depois** da confirmação do servidor;
`409 version_conflict` e `403 panel_forbidden` recarregam o catálogo e redefinem o
rascunho; erro de carga mostra texto fixo ("Não foi possível carregar os painéis.
Tente novamente."). Nada em `localStorage`. Painel oculto não é montado e não
consulta o backend.

## 2. `/dashboard/classificacao` — fila de revisão (ADM)

Código: `frontend/src/app/(app)/dashboard/classificacao/page.tsx` +
`features/dashboard/classification-review.tsx`. Chegada: link "Revisar fila de
classificação" no painel "Pendentes de revisão" (`unclassified_review`); a rota não está
no menu. Quem não pode ver recebe mensagem neutra — a decisão é do backend
(`403`/`404` indistinguíveis).

- Cabeçalho: link "Voltar ao dashboard", eyebrow "Classificação patrimonial", h1
  "Fila de revisão" e o aviso de que a mudança só vale depois da confirmação do
  servidor.
- Lista `GET /api/v1/dashboard/classificacao/revisao` com filtro de unidade,
  "Ordenar por" (nº patrimonial, descrição e atualização, crescente/decrescente —
  allowlist `REVIEW_SORT_VALUES`) e a `PaginationBar` comum (50/100/200, chave
  própria `sispat-page-size-review`). Abaixo de `lg` a tabela vira cartões; a
  página nunca rola na horizontal.
- Correção: `<select>` "Corrigir para…" com as categorias **da própria resposta**
  (`categorias`), agrupadas por família (`<optgroup>`), e rótulo acessível "Nova
  categoria do bem <nº>". Escolher apenas **prepara**: nada é gravado até o
  `ConfirmActionDialog`. Confirmar envia `POST /api/v1/assets/<id>/category-override`
  com `{category, version}` e o item só sai da fila **depois** do 200 (a fila é
  recarregada do servidor; nunca atualização otimista).
- Erros com texto fixo: `409` ("Este bem foi alterado por outra pessoa. A fila foi
  recarregada; revise e tente de novo."), `400/403/404` (mensagem neutra) e
  genérico. Nunca o texto do backend.
- Exportação CSV/XLSX da fila
  (`GET /api/v1/dashboard/classificacao/revisao/export`), mesmo padrão autenticado
  dos painéis.
- A confiança da regra automática aparece como rótulo textual
  (`confidenceLabel`, `equipment-format.ts`), não como barra de cor.

## 3. `/dashboard/relatorio` — relatório imprimível (composição legada)

Código: `frontend/src/app/(app)/dashboard/relatorio/page.tsx` +
`features/dashboard/dashboard-panels.tsx` (`theme="paper"`) e
`dashboard-tech-panels.tsx`. Cliente: `src/lib/dashboard-api.ts`.

| Endpoint | Resposta |
|---|---|
| `GET /api/v1/dashboard/resumo` | contagens inteiras (`total_bens`, `localizados`, `nao_localizados`, `desconhecidos`, `movimentacoes_pendentes`, `inventarios_abertos`, `novos_30d`); `valor_total`, `em_manutencao`, `baixas_ano` **sempre `null`**; `variacao.total_bens` = variação percentual (`number\|null`), demais `null`; `filtros_aplicados` |
| `GET /api/v1/dashboard/por-unidade` | `[{unidade, total, tipos:{TIPO:int}}]` |
| `GET /api/v1/dashboard/por-situacao` | `[{id, value}]` |
| `GET /api/v1/dashboard/aquisicoes-mensais?meses=6` | `[{id, data:[{x:"YYYY-MM", y:int}]}]` |
| `GET /api/v1/dashboard/localizacao-por-unidade` | `[{unidade, sim, nao, desconhecido, total}]` (top 15 + "Outras") |
| `GET /api/v1/dashboard/por-vinculo` / `por-sala` | `[{id, label, value}]` (rótulo da planilha = texto) |
| `GET /api/v1/dashboard/pendencias-cadastro` | `{sem_responsavel, sem_sala, ociosos, nao_localizados}` |
| `GET /api/v1/dashboard/inventario` | `{conferidos, nao_conferidos, encontrados, nao_encontrados}` |
| `GET /api/v1/dashboard/tipos` | `[{value, count}]` |
| `GET /api/v1/dashboard/tecnologia/*` | painéis `tech_*` (ver `docs/architecture/dashboard-api.md`) |

Toda resposta passa por type guards com allowlist; qualquer desvio (inclusive
número em `valor_total`/`em_manutencao`/`baixas_ano`) vira estado de erro — nada
não reconhecido é renderizado. Nomes vêm como texto puro (escape do React).

Blocos: KPIs (Total de bens com `Badge` de variação, Localizados, Não localizados
com "N com localização desconhecida", Movimentações pendentes, Inventários
abertos), "Indicadores indisponíveis" (valor total, em manutenção, baixas no ano —
explica que o cadastro ainda não tem esses campos), barras por unidade/tipo
(3 maiores tipos + "Outros"), pizza por situação, aquisições mensais, Localizados ×
não localizados por unidade, Bens por vínculo, Pendências de cadastro, Bens por
sala, Inventário, os seis painéis de Tecnologia e a tabela de detalhamento com
linha de total (sempre no fim, não personalizável). Cada bloco tem esqueleto, erro
com "Tentar novamente" independente e estado vazio honesto; variação `null` = nenhum
selo; números só animam quando o backend os confirmou (`AnimatedCounter`, sem
animação sob reduced motion).

Particularidades do relatório, verificadas no código em 2026-10-29:

- **Filtros**: o relatório LÊ os filtros da query string (`parseDashboardFilters`,
  parse defensivo que descarta chave desconhecida/repetida ou valor inválido), os
  aplica a todas as consultas e os lista no cabeçalho ("Filtros aplicados", rótulos
  humanos; "Nenhum — todos os bens visíveis para o perfil." quando vazio). **Não
  existe mais interface para montar esses filtros**: o link "Imprimir relatório" do
  `/dashboard` aponta para `/dashboard/relatorio` sem query string; hoje só uma URL
  escrita à mão (ou guardada) traz filtros. "Voltar ao dashboard" preserva a query.
- **Ordem e visibilidade** dos blocos vêm da preferência **legada**
  `user_preferences.dashboard_layout` (15 ids, `order` + `hidden`,
  `use-dashboard-layout-prefs.ts`). Como "Personalizar painéis" agora grava o
  catálogo novo, essa preferência não é mais editável pela interface: o relatório
  usa o que estiver salvo ou o padrão.
- Sem clique-para-filtrar, sem legenda clicável e sem seletor de tipo de gráfico
  (ramos só do tema `screen`).
- `@media print`: sidebar, header e botões escondidos (`print:hidden`), rolagem
  interna do shell desativada, fundo branco, `break-inside: avoid` em cada bloco e
  margens de 12 mm. "Imprimir / Salvar PDF" chama `window.print()`; a data/hora de
  emissão é a do navegador (America/Araguaina). Ponto de atenção (não verificado em
  impressora real): o SVG do Nivo é dimensionado pela largura da janela ao abrir o
  relatório; o teste em mídia `print` confirma ausência de rolagem horizontal, mas a
  escala final na folha depende do navegador.

## 4. Gráficos, paleta e acessibilidade

- Gráficos em **Nivo 0.99.0** (`@nivo/core`, `@nivo/bar`, `@nivo/pie`, `@nivo/line`,
  versões pinadas; Recharts removido em 2026-10-20). Tremor descartado (exige
  React 18; o projeto é React 19.3). KPIs (`stat-card`) e tabelas não usam Nivo.
  Todos usam `animate={false}`; a única entrada é a opacidade do `FadeIn` do painel.
- `frontend/src/components/dashboard/chart-theme.ts` concentra cores, classes e o
  tema Nivo (`nivoTheme(theme)`: Geist, eixos, grade, rótulos peso 400, tooltip).
  A paleta padrão do Nivo nunca é usada. Tema `screen` (Factory dark:
  signal-orange, metric-green, bone, warm-granite) e tema `paper` do relatório
  (obsidian, signal-orange, graphite-mid, warm-granite sobre bone; o verde fica de
  fora por contraste). Para trocar a paleta, edite somente esse arquivo.
- `chart-shell.tsx`: `figure` + contêiner `role="img"` com resumo textual de todos
  os números, legenda em texto e tabela alternativa `sr-only`. O SVG fica num
  wrapper `aria-hidden` com a a11y interna do Nivo desligada
  (`role="presentation"`, `isFocusable={false}`), para não duplicar a leitura.
  Tabelas roláveis são regiões focáveis; a página não rola na horizontal de 320 a
  1920 px.
- Situação, "Localizado" e qualquer estado usam ícone + texto, nunca só cor.
  Datas/horas em America/Araguaina.
- Detalhes dos tipos de gráfico por painel: `DASHBOARD_GRAFICOS.md` (a preferência
  `dashboard_charts` descrita lá é do conjunto **legado** e hoje só alcança o
  relatório). Nos painéis do catálogo a forma do gráfico é **fixa, decidida no
  código da view**, e não é preferência do usuário: `located_by_unit_chart` é
  sempre barras agrupadas e `located_summary` é sempre rosca — não há seletor de
  tipo nem chave em `dashboard_charts` para eles. Histórico das decisões de
  personalização: `DASHBOARD_PERSONALIZACAO.md`.

## 5. Testes (não reexecutados nesta data)

- `frontend/e2e/dashboard-equipment-functional.spec.ts` — painéis do catálogo e
  fila de revisão: números do backend, perfis (a tela desenha só o que o catálogo
  devolve), `404` oculta o painel, esqueleto/vazio/erro + retry, filtros → query,
  exportação só com `exportable`, aviso de estimativa, correção com confirmação,
  `409`, `403`, paginação, axe e 320/768/1920 px sem rolagem horizontal. Suporte:
  `e2e/dashboard-equipment-support.ts`.
- `frontend/e2e/dashboard-layout-functional.spec.ts` — "Personalizar painéis" com o
  catálogo de painéis (14 em 2026-11-01): perfis ADM/USER/RH, teclado (foco + `aria-live`),
  arrastar, tamanho P/M/G, salvar/restaurar/cancelar, estado honesto, 400/403/409,
  carga/erro/resposta inválida, foco preso, Esc, axe, 320/768/1920 px.
- `frontend/e2e/dashboard-located-functional.spec.ts` e
  `dashboard-located-qa-functional.spec.ts` — painel de localização por unidade e
  painel lateral de registros.
- `frontend/e2e/dashboard-located-summary-functional.spec.ts` — rosca do
  quantitativo global: legenda com textura, série em zero visível, rodapé de total
  com "—", total do servidor, vazio honesto com `total: 0`, erro/`404`/contrato
  inválido, XSS no rótulo da série, ausência de pedido de `/records`, link para
  `/patrimonios`, a linha de totais (e o aviso de divergência) do painel por
  unidade, 320/768/1920 px, axe, reduced motion e nada em
  `localStorage`/`sessionStorage`. O painel **não** faz parte do `CATALOG` padrão de
  `e2e/dashboard-equipment-support.ts` (as contagens de painéis dos specs antigos
  são fixas): o spec o acrescenta com
  `extraCatalog: [LOCATED_SUMMARY_ENTRY]`, e por isso ele não aparece nas telas de
  `e2e/support/screens.ts`.
- `frontend/e2e/dashboard-filters-functional.spec.ts` — filtros da grade
  (família/unidade/categoria) e recusa de parâmetro fora da allowlist pelo mock.
- `frontend/e2e/dashboard.spec.ts` (projeto `dashboard`),
  `dashboard-charts-functional.spec.ts`, `dashboard-chart-click-functional.spec.ts`,
  `dashboard-tech-functional.spec.ts`, `security-dashboard-charts-functional.spec.ts`
  e `dashboard-qa-onda4-functional.spec.ts` — composição legada e relatório.
- Telas registradas em `frontend/e2e/support/screens.ts` (responsivo 320–1920 +
  axe): `dashboard`, `dashboard-painel`, `dashboard-painel-adm`,
  `dashboard-painel-vazio`, `dashboard-painel-erro`, `dashboard-personalizar`,
  `dashboard-layout-personalizado`, `dashboard-tamanhos-pequenos`,
  `dashboard-tamanhos-grandes`, `dashboard-filtros`, `dashboard-relatorio`,
  `dashboard-relatorio-filtros`, `dashboard-relatorio-personalizado`,
  `dashboard-alertas-*` e `dashboard-ia*`.

## 6. A confirmar

- O relatório imprimível ainda consome os endpoints de agregação antigos e a
  preferência legada `dashboard_layout`; migrá-lo para o contrato de painéis é
  pendência aberta (o comentário de cabeçalho de `dashboard-panels.tsx` registra
  isso).
- Sem barra de filtros, os filtros do relatório só chegam por URL. Decidir se
  volta uma interface de filtros (no `/dashboard` ou no próprio relatório).
- `chart-type-menu.tsx` e os atalhos de clique-para-filtrar continuam no
  repositório, mas sem caminho de uso pela interface (o relatório usa tema
  `paper`).
- **Deep-link do `located_summary`**: para o painel levar à lista já filtrada por
  situação, `use-asset-filters.ts` precisaria ler `located` da URL (hoje lê só
  `busca` e `page`) e `/patrimonios` precisaria refletir o filtro na query string.
  Decidir se vale, junto com o backend (`/records` deste painel hoje é 404 de
  propósito). Não implementado.
