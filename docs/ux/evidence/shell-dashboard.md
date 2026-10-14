# Shell (navegação) e dashboard — evidência (2026-10-13)

Papel: Desenvolvedor Frontend de Navegação e Dashboard. Base: `docs/ux/evidence/fundacao.md`
(primitivas `@/components/animations`, `m.*`, tokens `@/lib/motion/tokens`). Nenhum arquivo da fundação,
de `src/lib` ou do backend foi alterado.

## Arquivos

Editados
- `frontend/src/components/layout/nav-items.ts` — `adminOnly` no grupo "Administração", `ADMIN_ROLE`,
  `filterNavItems(items, roles)` (perfil desconhecido = nega). Comentário: ocultar é só UX.
- `frontend/src/components/layout/sidebar.tsx` — sidebar recolhível, indicador ativo, tooltip, setas,
  submenu com `aria-controls`, filtro por perfil via `useMe()` (hook existente de `src/lib/session.ts`).
- `frontend/src/components/layout/mobile-nav.tsx` — gaveta com slide + fade (Motion + Radix `forceMount`).
- `frontend/src/components/layout/header.tsx` — `transition-factory` nos breadcrumbs; "Sair" usa
  `Button loading` + ícone desliza 2px no hover. Lógica de logout intocada.
- `frontend/src/app/page.tsx` — introdução com `StaggerContainer` + `DashboardOverview status="unavailable"`.

Criados
- `frontend/src/components/dashboard/{types.ts, stat-card.tsx, animated-chart.tsx,
  dashboard-empty-state.tsx, dashboard-overview.tsx, index.ts}`.
- `frontend/e2e/motion-shell.spec.ts` (13 testes) e `frontend/e2e/motion-dashboard.spec.ts` (6 testes).

## O que foi feito

**Sidebar desktop (≥ 1024px)**
- Botão "Recolher/Expandir menu lateral" com `aria-expanded` + `aria-controls` (id da `<nav>`).
- Largura 256 ↔ 64px por transição de `width` 200ms `ease-factory`. Estado em **sessionStorage**
  (`sispat-sidebar-collapsed`, try/catch) — nunca localStorage. O SSR sai sempre expandido; o estado salvo é
  aplicado após montar e só então a transição é ligada (sem animação/mismatch na carga).
- Recolhida: só ícones; o rótulo permanece como `sr-only` (nome acessível). Tooltip visual (bone sobre
  obsidian, Geist Mono 12px, `position: fixed` para não ser cortado pelo scroll) no hover/foco, `aria-hidden`
  (o nome já está no item), fecha com Esc (WCAG 1.4.13). Clique num grupo com a sidebar recolhida expande a
  sidebar e abre o grupo.
- Indicador da página ativa: uma barra 2×16px `signal-orange` (Status Pulse — "você está aqui") que desliza
  por `transform` (tween 200ms `TRANSITION_BASE`) até o link ativo, ou até o botão do grupo se o submenu estiver
  fechado. Substitui o ponto laranja estático anterior.
- Cores de itens/ícones com `transition-factory` (150ms, cor+fundo+borda juntos). Foco visível (ring bone).
- Teclado: Tab normal + ↑/↓/Home/End entre itens visíveis da navegação.
- Submenu: `<ul>` sempre no DOM (`aria-controls` válido), `hidden` quando fechado, fade 200ms ao abrir
  (opacity — sem animar altura); chevron gira em 150ms.

**Menu móvel (< 1024px)** — Radix Dialog preservado (foco preso, Esc, retorno de foco, overlay fecha).
Overlay fade 200/150ms; gaveta desliza da esquerda 200ms (entrada) / 150ms (saída) com `AnimatePresence` +
`forceMount`. Anima a propriedade `transform` inteira (não `x`) para o Motion usar WAAPI → a animação aparece
em `document.getAnimations()` e o `waitForAnimations` dos testes a espera antes de medir layout/axe. Sob reduced
motion: sem deslocamento.

**Permissões (UX)** — a navegação **não** filtrava (havia um TODO). Agora "Administração" só aparece quando
`GET /api/v1/me` traz o papel `ADM`; USER/RH não veem; enquanto o perfil carrega/falha, fica oculto (negar por
padrão). Documentado em `nav-items.ts` e `sidebar.tsx` que isso é só UX: o Flask continua autorizando (403) e as
páginas administrativas tratam a negação. Os breadcrumbs do header não foram filtrados (refletem a URL atual).

**Dashboard (`/`)** — não há endpoint de indicadores, então:
- `DashboardOverview` ("Dashboard Frame" do DESIGN.md: painel #0d0d0d, raio 10px, barra de título Geist Mono
  com chrome neutro e ponto de status) recebe `status` + `data` por props. A página passa
  `status="unavailable"` → estado vazio honesto ("Indicadores ainda indisponíveis… quando o módulo patrimonial
  estiver ativo no backend… não usa dados de demonstração"). Ponto de status em warm-granite ("Aguardando
  dados"); signal-orange só quando houver dado vivo.
- Skeleton (`LoadingSkeleton`) só com `status="loading"` (consulta real). Filtro de período só é renderizado com
  dados **e** `periodOptions` reais — hoje nada é renderizado.
- `animate-dashboard-frame-in` (sfDashboardFrameIn) aplicada **uma vez**, no frame. A introdução (eyebrow, h1,
  aviso de Fase 1) entra com `StaggerContainer` (só em navegação client-side; na 1ª carga SSR aparece pronta,
  política da fundação).
- `StatCard` (Metric Tile): `AnimatedCounter` com o valor REAL da prop (`live="off"` em grade); `value: null`
  mostra "—" + "Sem dado" (sr-only).
- `AnimatedChart` (Recharts 2.15): `bar` | `donut`, `ResponsiveContainer`, entrada 320ms (`DURATION_MS.slow`,
  `animationEasing="ease-out"` — Recharts não aceita cubic-bezier), tooltip 150ms com fade, `isAnimationActive`
  desligado sob reduced motion, destaque de categoria selecionada (demais em fill-opacity .35, transição 150ms),
  seleção por legenda com botões `aria-pressed`, SVG `aria-hidden` + `<figure>/<figcaption>` + legenda textual
  com valores + `<table class="sr-only">` alternativa. Rosca: ordem fixa orange → green → bone → granite; da 5ª
  categoria em diante soma-se em "Outros (n)" (soma dos valores reais, rotulada).
- Tipos TS em `components/dashboard/types.ts` (`DashboardStat`, `ChartDatum`, `DashboardChart`,
  `DashboardData`, `DashboardStatus`, `DashboardPeriodOption`).

## Decisões frente ao DESIGN.md

- Só tween 150–200ms (320ms apenas na entrada nomeada e na entrada única das marcas do gráfico), easing factory;
  nenhum spring/bounce/parallax/scroll. Sem sombra/glow.
- **Sem `layoutId`**: o `MotionProvider` da fundação carrega só `domAnimation` (sem layout projection). Em vez de
  trocar para `domMax` (mais bundle, arquivo da fundação), o indicador mede a posição do alvo e anima `y`
  (transform) — mesmo efeito visual, tween 200ms. *Ajuste sugerido à fundação, se `layoutId` for desejado em
  outras telas: `domMax`.*
- A largura da sidebar anima `width` (pedido explícito do escopo); é a única exceção a "só transform/opacity"
  — 200ms, uma vez por clique, sem reflow de listas grandes.
- Paleta do gráfico: validador do skill dataviz (`--mode dark --surface #101010`) — CVD (ΔE 14.4) e separação
  normal (ΔE 20.1) **passam**, contraste ≥ 3:1 passa; "faixa de luminosidade/croma" **falha por desenho** (paleta
  monocromática do DESIGN.md, que proíbe novos acentos). Compensado com codificação secundária: legenda textual
  sempre visível com valores, tabela alternativa, 2px de espaço entre fatias.

## Testes executados

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ok |
| `npm run lint` | ok (0 warnings) |
| `npx playwright test` (suíte completa, máquina ociosa, 2026-10-14) | **258 passed, 3 failed** — nenhuma falha na minha área (abaixo) |
| `npx playwright test e2e/a11y.spec.ts -g headings` (re-run) | 1 passed (falha anterior foi `page.goto ERR_ABORTED`) |
| `npx playwright test e2e/responsive.spec.ts -g "menu de navegação funcional" --repeat-each=3` | 27 passed |

Falhas restantes da suíte completa (fora da minha fronteira — só reportadas):
- `responsive › 1366x768 / 1920x1080 › login-mfa`: *strict mode violation* —
  `getByRole('heading', { name: 'Verificação em duas etapas' })` encontra o `<h1>` do desafio MFA **e** um `<h3>`
  de um slide do carrossel do login (`group "Verificação em duas etapas — 1 de …"`). Arquivo do agente de
  login/carrossel: renomear o título do slide ou não usar heading.
- `a11y › headings…`: `page.goto: net::ERR_ABORTED` (instabilidade do dev server); passou ao re-executar.

**"menu de navegação funcional" (relatado pelo coordenador):** investigado. Em rodadas concorrentes (vários
agentes com `next dev` na mesma `.next`/porta 3100) o clique em "Usuários" acontece (trace: a requisição RSC
`/administracao/usuarios?_rsc=…` é feita e responde 200 em 4,3 s), mas o chunk
`/_next/static/chunks/app/administracao/usuarios/page.js` fica pendente (> 10 s, status −1) enquanto o dev server
compila sob carga — a URL não muda em 15 s. Não é bloqueio da navegação: com a máquina ociosa o teste passa
9/9 e 27/27 (`--repeat-each=3`), e passou nas 9 larguras na suíte completa. Também houve `ERR_CONNECTION_REFUSED`
quando o servidor de outra execução foi encerrado no meio da minha. Recomendação: não rodar suítes em paralelo
contra o mesmo `next dev`.

**Correção feita após a 1ª suíte completa:** `axe 375px › dashboard` falhava com `scrollable-region-focusable`
(o painel deixou `<main>` rolável a 375px sem conteúdo focável). O estado vazio ganhou uma ação REAL — link
"Enquanto isso, revise a segurança da sua conta" → `/configuracoes/seguranca` (tela existente para todos os
perfis) — em vez de um `tabIndex` artificial.

`motion-shell.spec.ts`: recolher/expandir por mouse (largura 256→64, `aria-expanded`, `aria-controls`, nome
acessível mantido, tooltip + Esc, persistência após reload); por teclado (Enter/Space, foco mantido, ↑/↓/Home/End,
ring de foco); indicador ativo segue Home → Usuários → botão do grupo; submenu `aria-controls`/`aria-expanded`;
sem overflow com a sidebar recolhida/expandida em 1024/1366/1440/1920; menu móvel em 320/375/768 (slide termina
em x=0, foco preso, Esc e overlay fecham e devolvem foco); reduced motion (gaveta sem deslocamento, recolher
imediato); ADM vê "Administração" e USER/RH não (desktop e menu móvel); axe + console limpos com a sidebar
recolhida e tooltip aberto.

`motion-dashboard.spec.ts`: estado vazio (nenhum dígito no painel, sem StatCard/gráfico/skeleton/filtro);
`sfDashboardFrameIn` em exatamente 1 elemento e termina com opacity 1; entrada sequencial em navegação
client-side termina estável; reduced motion; sem overflow nas 9 resoluções (320…1920); axe e console limpos.

## Não feito / não testado

- **`AnimatedChart` e `StatCard` com dados não foram testados em navegador**: não há endpoint nem página com
  dados reais, e por regra não foi criada rota de demonstração. Cobertos só por typecheck/lint.
- Filtro de período: implementado de forma condicional em `DashboardOverview`, nunca renderizado hoje.
- Breadcrumbs do header não são filtrados por perfil (mostram a rota atual; a página trata o 403).
- Nenhuma dependência nova.
