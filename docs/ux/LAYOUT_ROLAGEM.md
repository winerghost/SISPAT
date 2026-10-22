# Layout: rolagem única da página

## Modelo
O app é uma "tela de aplicativo": `AppShell` (`frontend/src/components/layout/app-shell.tsx`)
ocupa a altura do viewport (`.h-app` = `100vh` com fallback e `100dvh`), a Sidebar tem a
mesma altura e **só o `<main id="conteudo">` rola** (`overflow-y-auto`). A janela
(`documentElement`) nunca rola.

## Regra
O shell, o wrapper e o `<main>` são `relative`. Eles são o containing block de qualquer
`position:absolute` do conteúdo (ex.: `sr-only` da `PaginationBar`, do `ChartShell`, de
tabelas). Não remova o `relative` desses três elementos; mantenha as regras `print:*`.

## Causa raiz do bug "scroll duplo" (2026-10-22)
Sem `relative`, um `sr-only` (`position:absolute` sem offsets) usava o bloco inicial como
referência e, vindo de dentro do `<main>` rolado, estendia o `scrollHeight` do documento.
Resultado: segunda barra de rolagem, desproporcional, na janela (mais visível com paginação
de 100/200 itens, que alonga a página). Medido antes da correção em 1366x768: `/administracao/auditoria`
com `docScrollHeight` 2269 (innerHeight 768) e `scrollY` 1501 após `scrollTo(0, 9999)`;
`/` e `dashboard-painel` idem. Secundário: `h-screen` (100vh) ignora a barra de endereço
móvel; trocado por `100dvh` (com fallback 100vh).

## Teste de regressão
`frontend/e2e/page-scroll.spec.ts` (projeto Playwright `scroll`):
`npx playwright test --project=scroll`. Em 320, 768, 1024, 1366 e 1920 de largura, nas
rotas principais (dashboard, painel, patrimônios, patrimônios com 100/200 por página,
unidades, salas, responsáveis, usuários, auditoria, cadastros, relatórios, perfil,
aparência, movimentações, inventários, importação):

- `documentElement.scrollHeight <= innerHeight + 1`;
- `window.scrollTo(0, 9999)` não altera `scrollY`;
- `<main>` sem rolagem fantasma (> 2 px além do último conteúdo visível);
- sem rolagem horizontal;
- `span.sr-only` injetado ao fim do `<main>` não rola a janela;
- axe WCAG 2.x A/AA na mesma passada.

Medidas em `e2e/support/layout-checks.ts` (`collectScrollReport`). O mock `assetsBulk`
(`e2e/support/mocks.ts`) gera N bens sintéticos para os casos de 100/200 por página.
