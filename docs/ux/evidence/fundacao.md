# Fundação de animações — evidência (2026-10-13)

Papel: Arquiteto de Animações (fundação). Base para os agentes de layout, dashboard e telas.
Restrições aplicadas do DESIGN.md (Motion Philosophy): 150–200 ms, `cubic-bezier(0.4, 0, 0.2, 1)`,
tween (sem spring/bounce/parallax/scroll), cor+fundo+borda+stroke transicionando juntos, uma única
entrada nomeada (`sfDashboardFrameIn`). Sem sombra/glow/lift.

## Arquivos

Criados
- `frontend/src/lib/motion/tokens.ts` — `DURATION` (s: fast .15 / base .2 / slow .32 só p/ entradas nomeadas),
  `DURATION_MS`, `EASE_FACTORY` (array) e `EASE_FACTORY_CSS`, `DISTANCE` (sm 4px / md 8px), `SCALE_IN_FROM` (0.98),
  `STAGGER` (0.03 s, máx. 12 itens), `TRANSITION_FAST/BASE/SLOW` (tween).
- `frontend/src/lib/motion/presets.ts` — variants `fade`, `slideUp`/`slideUpVariants(px)`, `scaleIn`, `page`,
  `reducedFade`, `staggerContainer`, `staggerItem`, `staggerItemDelay()`, `PRESETS`. Rótulos: `hidden`/`visible`/`exit`.
- `frontend/src/hooks/use-reduced-motion.ts` — `usePrefersReducedMotion()` (alias `useReducedMotion`).
- `frontend/src/components/animations/` — `motion-provider.tsx`, `use-entrance.ts`, `fade-in.tsx`, `slide-in.tsx`,
  `scale-in.tsx`, `stagger-container.tsx`, `animated-card.tsx`, `animated-counter.tsx`, `animated-page.tsx`,
  `animated-presence-list.tsx`, `index.ts`.
- `frontend/src/app/template.tsx` — `<AnimatedPage>` em toda rota.
- `frontend/src/components/ui/loading-skeleton.tsx` — variantes `table` / `cards` / `lines`.
- `frontend/e2e/motion-foundation.spec.ts` — 6 testes (projeto Playwright `motion`).

Editados (pontual)
- `app/layout.tsx` — só envolve o conteúdo de `<QueryProvider>` com `<MotionProvider>` (AuthGuard, skip link,
  `force-dynamic` intactos).
- `app/globals.css` — `--motion-duration-{fast,base,slow}`, `--motion-distance-{sm,md}`; utilitários
  `.transition-factory`, `.transition-factory-press`, `.skeleton-shimmer`; `@keyframes sf-shimmer`; ajuste de
  duração/easing do sonner; bloco global `@media (prefers-reduced-motion: reduce)`.
- `tailwind.config.ts` — `duration-fast/base/slow`, `ease-factory`, keyframes + `animate-fade-in|fade-out|dialog-in|
  dialog-out|slide-up|dashboard-frame-in|spin-slow`.
- `components/ui/dialog.tsx` — overlay fade (200/150 ms), conteúdo fade + `scale` 0.98→1. As classes antigas
  (`animate-in`, `zoom-in-95`…) eram no-op (plugin `tailwindcss-animate` não instalado). Foco/Esc/retorno de foco
  preservados (lógica de `returnFocusRef` intocada).
- `components/ui/button.tsx` — `transition-factory-press` + press `active:scale-[0.98]` (off em reduced motion e na
  variante `link`); nova prop `loading` (desabilita, `aria-busy`, spinner `aria-hidden`, rótulo mantido). Todas as
  variantes preservadas, inclusive `outlineOnLight`. Com `asChild` não há spinner (Slot exige filho único).
- `components/ui/skeleton.tsx` — shimmer discreto (faixa 4 % bone em `::after`, só transform), `aria-hidden`.
- `components/ui/input.tsx` — `transition-factory`, hover `graphite-mid`, `aria-invalid` → borda `signal-orange`
  (status), foco continua `bone`.
- `components/ui/sonner.tsx` — só comentário (o ajuste é CSS em globals.css).
- `playwright.config.ts` — projeto `motion` (`/motion-.*\.spec\.ts/`) para o novo spec rodar.
- `e2e/support/screens.ts` — `openScreen` agora aguarda animações finitas terminarem (`waitForAnimations`,
  exportado). Motivo: o axe mede contraste com a opacidade corrente; medir no meio do fade de 200 ms gerou falso
  positivo intermitente de `color-contrast`. Animações infinitas (shimmer/spinner) são ignoradas.

## Decisões

- **Conteúdo nunca escondido pelo SSR.** O Motion grava o estado `initial` no HTML (ex.: `opacity:0`). Política em
  `use-entrance.ts`: o que monta *durante a hidratação inicial* usa `initial={false}` (aparece pronto, HTML idêntico
  servidor/cliente → sem mismatch); só o que monta *depois* (navegação client-side, dados que chegaram) anima. O
  teste "SSR: wrapper de página não chega escondido no HTML" confere que o wrapper sai sem `opacity:0`/`translate`.
  Consequência: a 1ª carga de `/login` não anima (as rotas protegidas animam, pois montam após o AuthGuard).
- **Transição de página** (`template.tsx`): fade + 4 px, 200 ms, sem exit (App Router não anima saída). O
  `<main id="conteudo">` e o skip link estão no layout, fora do wrapper → foco intacto. Ao fim o Motion deixa
  `transform: none` (não cria containing block para `position: fixed`).
- **Reduced motion em 3 camadas:** `MotionConfig reducedMotion="user"`; componentes usam `initial={false}` quando
  `usePrefersReducedMotion()`; CSS global zera a duração de animações/transições (0.01 ms, não `none`, para o
  `animationend` do Radix Presence continuar desmontando o Dialog). Shimmer oculto; o sonner já se desliga sozinho.
- **Hook SSR-safe:** o `useReducedMotion` do Motion lê `matchMedia` no inicializador do `useState` (pode divergir
  do HTML do servidor). O hook próprio usa `useSyncExternalStore` (snapshot de servidor `false`), reage a mudanças
  da preferência e respeita `MotionConfig reducedMotion="always"|"never"`.
- **LazyMotion + `m.*`**, features `domAnimation` **síncronas**: testei features assíncronas (import dinâmico) e
  um `m.*` montado antes do chunk ficava parado em `opacity:0` (pego pelo axe) — revertido. `strict` não foi
  ligado: um `motion.*` esquecido por outro agente não deve derrubar a tela; custa só bundle.
- **Dialog:** anima a propriedade CSS individual `scale`, que compõe com o `translate(-50%,-50%)` do Tailwind.
- **AnimatedCounter:** escreve a contagem direto no DOM (sem re-render por frame), sempre termina em `value` exato
  (onComplete + cleanup), `tabular-nums`, número visual `aria-hidden` + cópia `sr-only` com `aria-live` (padrão
  `polite`; use `off` em grades) contendo só o valor final. Sob reduced motion ou montado na hidratação: sem contagem.
- **Stagger:** atraso por item via `custom`, só para os primeiros N (padrão 12, teto 20); demais aparecem sem
  animação.

## Testes executados

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ok |
| `npm run lint` | ok (0 warnings) |
| `npx playwright test` (suíte completa) | **201 passed** (195 anteriores + 6 novos) |
| `npx playwright test --project=a11y -g axe --repeat-each=3` | 78 passed (após `waitForAnimations`) |
| `npm run build` | ok |

`motion-foundation.spec.ts`: reduced motion (carga + navegação: wrapper `opacity 1`, `transform none`, shimmer
`display:none`); transição de rota (termina estável, foco não cai no `<body>`, skip link → `<main>` → Tab entra no
conteúdo); modal (animação `sf-dialog-in`, Esc fecha e devolve foco, também sob reduced motion); sem erros de
console/`pageerror` em `/login` e `/`; HTML SSR sem `opacity:0`.

## Bundle (`npm run build`, First Load JS)

| Rota | Antes | Depois |
|---|---|---|
| `/login` | 182 kB | 183 kB |
| `/` | 103 kB | 103 kB |

Atenção: a tabela do Next não atribui às rotas os chunks do root layout. O Motion (core `m` + `domAnimation`)
fica num chunk compartilhado de **~27 kB gzip** (medido em `.next/static/chunks`) carregado pelo layout/template
em todas as rotas. É o custo real da fundação; usar `motion.*` em vez de `m.*` o aumentaria.

## Não feito / pendências

- Nenhuma dependência nova. `sfDashboardFrameIn` existe só como utility `animate-dashboard-frame-in` (320 ms,
  fade + 8 px): o DESIGN.md cita o nome mas não define os keyframes — valores escolhidos dentro das restrições.
  Aplicá-la (uma única vez) é tarefa do agente do dashboard.
- A 1ª carga de `/login` não anima (decisão de segurança acima).
- Telas existentes não foram migradas para as primitivas (fora da minha fronteira).

## API para os outros agentes

Import único: `import { … } from "@/components/animations"`. Para algo custom use `m.*` de `motion/react`
(nunca `motion.*`). Tokens: `import { DURATION, EASE_FACTORY, DISTANCE } from "@/lib/motion/tokens"`.

```tsx
// Entrada simples (fade 200ms). `delay` em segundos; `disabled` desliga.
<FadeIn className="flex flex-col gap-4">…</FadeIn>

// Fade + 8px (ou "sm" = 4px); direction "up" | "down"; nunca > 8px.
<SlideIn distance="sm">…</SlideIn>

// Destaque pontual, scale 0.98 → 1.
<ScaleIn>…</ScaleIn>

// Lista escalonada: só os primeiros `limit` itens animam (padrão 12, teto 20).
<StaggerContainer as="ul" limit={12} className="grid gap-6">
  {items.map((it, i) => (
    <StaggerItem as="li" key={it.id} index={i}>…</StaggerItem>
  ))}
</StaggerContainer>

// Card (Feature Card escuro ou Light Surface Card). Hover = só cor de borda.
<AnimatedCard interactive surface="dark">…</AnimatedCard>
<AnimatedCard surface="light" enter={false}>…</AnimatedCard>

// Contador: SOMENTE valor real (props/backend). Formatação pt-BR padrão.
<AnimatedCounter value={total} className="text-heading" />
<AnimatedCounter value={pct} decimals={1} format={(n) => `${n.toFixed(1)}%`} live="off" />

// Lista com saída animada (chips/filtros — não tabelas).
<AnimatedPresenceList>
  {chips.map((c) => <PresenceItem key={c.id}>{c.label}</PresenceItem>)}
</AnimatedPresenceList>

// Página: já aplicada globalmente via app/template.tsx — não reaplicar.

// Hooks (SSR-safe) para decisões próprias (ex.: autoplay do carrossel).
const reduced = usePrefersReducedMotion();
const initial = useEntranceInitial(); // false | "hidden" → <m.div initial={initial} animate="visible" />

// Variants prontos para m.* custom:
import { m } from "motion/react";
import { slideUp, fade, scaleIn } from "@/lib/motion/presets";
<m.section variants={slideUp} initial={initial} animate="visible" />
```

CSS / Tailwind / UI:

```tsx
className="transition-factory"          // cor+fundo+borda+stroke, 150ms, ease factory
className="transition-factory-press"    // idem + transform/opacity (press)
className="duration-base ease-factory"  // tokens avulsos (fast 150 / base 200 / slow 320)
className="animate-dashboard-frame-in"  // sfDashboardFrameIn — USAR UMA VEZ (frame do dashboard)
className="animate-fade-in"             // ou animate-slide-up: entradas só CSS (rodam sem JS)
<Button loading>Salvar</Button>         // aria-busy + spinner; rótulo mantido
<Skeleton className="h-4 w-1/2" />      // shimmer discreto, off em reduced motion
<LoadingSkeleton variant="table" count={5} columns={4} label="Carregando usuários…" />
<LoadingSkeleton variant="cards" count={3} />
```

Regras: animar só `opacity`/`transform`; nada de spring/bounce/parallax/scroll; ≤ 20 itens com stagger; o bloco
reduced-motion global zera as utilities `animate-*`. Em testes axe use `waitForAnimations(page)` de
`e2e/support/screens.ts` (já chamado por `openScreen`).
