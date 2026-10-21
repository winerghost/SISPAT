# Dashboard — tipo de gráfico por painel

O usuário escolhe o tipo de gráfico de cada painel de `/dashboard`. A escolha é
uma preferência do próprio usuário, guardada no backend.

## Contrato (mockado nos testes; backend em paralelo)

`GET/PATCH /api/v1/me/preferences` ganha `dashboard_charts`:

| Chave | Valores | Padrão |
|-------|---------|--------|
| `units` (Bens por unidade) | `grouped`, `stacked`, `horizontal` | `grouped` |
| `status` (Bens por situação) | `pie`, `donut`, `bar` | `pie` |
| `monthly` (Aquisições mensais) | `line`, `area`, `bar` | `line` |
| `location` (Localizados × não localizados por unidade) | `stacked`, `grouped`, `horizontal` | `stacked` |
| `bond` (Bens por vínculo) | `pie`, `donut`, `bar` | `donut` |
| `rooms` (Bens por sala) | `bar`, `horizontal` | `horizontal` |

- GET devolve as 6 chaves resolvidas (backend anterior: só as 3 primeiras — as
  chaves novas ausentes viram o padrão, sem erro).
- PATCH envia só as chaves alteradas, dentro de `dashboard_charts`, mais
  `version` (ex.: `{"version": 3, "dashboard_charts": {"units": "stacked"}}`).
  `null` na chave restaura o padrão. 409 = conflito de versão.
- `src/lib/preferences-api.ts` valida a resposta por allowlist; valor fora dela
  (inclusive numa chave nova presente) ou chave original ausente invalida a
  resposta (o painel usa os padrões e não oferece o seletor nem "Personalizar
  painéis"). Chave desconhecida é ignorada. Resposta sem `dashboard_charts` é
  tratada como padrões.
- Visibilidade e ordem dos painéis (`dashboard_layout`): ver
  `docs/ux/DASHBOARD_PERSONALIZACAO.md`.

## Interface

- Gráficos em **Nivo 0.99.0** (pinado; Recharts removido em 2026-10-20):
  - `nivo-bar-charts.tsx` (`ResponsiveBar`): unidades e localização por unidade
    `grouped` | `stacked` | `horizontal`; situação e vínculo `bar`
    (`CategoryBarChart`); mensal `bar` e sala `bar` (verticais) reutilizam as
    barras agrupadas; sala `horizontal` usa as horizontais. `onMarkClick`
    (opcional) recebe as chaves originais da categoria/série da barra clicada. `borderRadius` 4; rótulos de valor fora da barra (topo/direita)
    quando legíveis (≤ 16 marcas e barra ≥ 14 px); empilhadas mostram o total da
    pilha (rótulo dentro do segmento não teria contraste garantido); largura máxima
    de barra por `padding` calculado (≈ 28 px por série, 40 px por pilha); escala
    inteira; horizontais crescem em altura (240–720 px) e listam a 1ª unidade no topo.
  - `nivo-pie-chart.tsx` (`ResponsivePie`): `pie` (innerRadius 0) e `donut`
    (innerRadius 0.58) para situação e vínculo, separação de 2 px na cor do fundo,
    sem rótulos nas fatias (a legenda traz os valores), "Outros" a partir da 5ª
    categoria (as categorias agrupadas em "Outros" não filtram; em "Barras" todas
    aparecem).
  - `nivo-line-charts.tsx` (`ResponsiveLine`): `line` e `area` (`enableArea`,
    opacidade 0.18); mês sem dado vira `y: null` (lacuna, nunca zero); tooltip por
    mês com todas as séries.
  - `chart-shell.tsx`: `figure`, contêiner `role="img"` com resumo de todos os
    números, legenda em texto e tabela alternativa `sr-only` em TODOS os tipos. O SVG
    fica em `[data-chart-surface=nivo]` (`aria-hidden`; a11y interna do Nivo
    desligada com `role="presentation"`/`isFocusable={false}`). Rótulos do eixo X
    rarefeitos e truncados conforme a largura medida (320 px sem sobreposição).
  - `chart-theme.ts`: paleta e **tema Nivo** únicos (`nivoTheme("screen"|"paper")`),
    gerados dos tokens do DESIGN.md (Geist, peso 400, eixos ash-stroke, grade
    carbon-lift, tooltip sem sombra). A paleta padrão do Nivo nunca é usada.
  - `animated-chart.tsx`: fachada compatível (`AnimatedChart` = barras ou pizza;
    nomes `Animated*` mantidos, mas **sem animação de mola**: `animate={false}` em
    todos). A troca de tipo entra por opacidade (`FadeIn`, 200 ms, desligada sob
    `prefers-reduced-motion`); números nunca são animados.
- `src/components/features/dashboard/chart-type-menu.tsx`: seletor no cabeçalho de
  cada painel (padrão "menu button" WAI-ARIA: `aria-haspopup`, `role=menu`,
  `menuitemradio`, "Restaurar padrão"). Durante um salvamento (`aria-disabled`)
  nem clique nem Enter/Espaço/Setas abrem o menu (estado aberto derivado de
  `!busy`; menu aberto fecha se o salvamento começar). Teclado: Enter/Espaço/Setas abrem;
  Setas/Home/End navegam; Esc fecha e devolve o foco; Tab fecha. Alvos de 44 px
  no celular, foco visível, entrada do menu por `FadeIn` (200 ms).
- `src/components/features/dashboard/use-dashboard-chart-prefs.ts`: leitura e
  PATCH. Estado honesto: o gráfico só muda depois da resposta do backend
  (indicador "Salvando tipo de gráfico…" enquanto isso; um salvamento por vez).
  409 recarrega as preferências e avisa; qualquer outro erro mostra mensagem
  fixa (nunca o texto do servidor). Se o GET falhar, usa os padrões e não mostra
  o seletor (sem `version` não há como salvar).
- Nivo é carregado só no cliente por `next/dynamic` (`ssr: false`), um chunk por
  módulo (barras, pizza, linhas): quem escolheu "Barras" na situação não baixa o
  módulo de pizza. First Load JS de `/dashboard`: 257 kB (Recharts) → 258 kB
  (Nivo); os chunks dinâmicos dos três módulos somam ~457 kB brutos / ~152 kB gzip
  (antes: chunk principal do Recharts ~424 kB / ~111 kB gzip).
  Enquanto o GET de preferências não responde, o painel
  mostra o esqueleto (evita desenhar o padrão e trocar logo depois).
- O relatório imprimível (`theme="paper"`) usa o tipo escolhido, sem seletor.
- Clique numa barra/fatia → filtro da URL (situação, vínculo, unidade,
  localização, sala): ver `docs/ux/DASHBOARD_PERSONALIZACAO.md`. A superfície
  clicável marca `data-chart-interactive` (cursor de ponteiro); a legenda da
  situação/vínculo vira botões "Filtrar por …:" com `aria-pressed`.
- Dependências: `@react-spring/web@10.1.2` (transitivo do Nivo) agora tem UMA
  cópia na raiz de `node_modules` (antes 8 cópias aninhadas; revisão I-4). Feito
  só no `package-lock.json` (hoist das 8 entradas idênticas, mesma versão e
  integridade); o `npm dedupe` completo foi descartado porque também trocava a
  versão de `d3-array`/`d3-format`/`d3-time` usada por `d3-scale` (v3 → v2/v1),
  de `axe-core` usada pelo `eslint-plugin-jsx-a11y` e de `ignore`. `package.json`
  inalterado; `npm install --package-lock-only` mantém o lock idêntico.
- Mudança visível: a situação passou de rosca para **pizza** por padrão.

## Testes

- `e2e/dashboard-charts-functional.spec.ts` (mocks em `e2e/support/mocks.ts`:
  `dashboard_charts` em `PreferencesMock`, PATCH com validação, `null` e 409):
  mouse, teclado, persistência após recarregar, restaurar padrão, estado honesto,
  409, 400, GET falho, valor inválido, tabela alternativa nos 9 tipos, axe com o
  menu aberto, 320/375/768/1280 px sem rolagem horizontal, alvos de 44 px, foco
  visível, reduced motion e relatório. O teste de salvamento clica no seletor
  ocupado pelas coordenadas do ponteiro (sem `force`) e por Enter/Espaço/Setas e
  verifica que o menu continua fechado (o `locator.click()` do Playwright adia o
  clique em elemento `aria-disabled` até ele habilitar — era isso que fazia o menu
  "abrir" no teste antigo, depois do salvamento). Cada tipo confere
  `[data-chart-surface=nivo] svg` e `figure[data-chart-kind]`.
  Inclui os 3 painéis novos (8 tipos a mais na tabela de casos, PATCH só com a
  chave do painel, menu da sala com 2 opções, restaurar `bond: null`, menus abertos
  sem estourar a tela em 320–1280 px).
- `e2e/security-dashboard-charts-functional.spec.ts` (revisão L-2): payload XSS em
  unidade, chave de tipo, id de situação, série mensal, unidade da localização,
  vínculo (rótulo e id) e sala, nas 3 combinações que cobrem TODOS os tipos;
  passa o ponteiro nas marcas (tooltip), abre "Filtrar pelo gráfico" e filtra pelo
  vínculo malicioso; afirma `window.__xss` indefinido, nenhum `<img src=x>` e o
  texto literal visível. Também preferência legada/inválida: valor de outro painel,
  HTML, chave nova inválida, chave obrigatória ausente, não-objeto (padrões, sem
  seletor), chave desconhecida ignorada e backend anterior (PATCH funciona).
- Telas novas em `e2e/support/screens.ts`: `dashboard-graficos-alternativos` e
  `dashboard-graficos-empilhado-barras` (agora com os 6 painéis em tipos não
  padrão; matriz responsiva 320–1920 + axe).
- `e2e/dashboard.spec.ts`: o gráfico de situação agora é "pizza".
