# SISPAT-AGU — Modernização visual: animações, transições e microinterações

Data: 2026-10-14 · Escopo: somente o frontend (`frontend/`). Backend, Supabase, autenticação,
permissões e integração com o Google Sheets **não foram alterados**. `DESIGN.md` está intacto.
Evidências detalhadas de cada frente estão em `docs/ux/evidence/`.

## 1. Princípio: o DESIGN.md prevalece

O DESIGN.md define o movimento como "curto e mecânico — o feel de uma ferramenta CLI, não de
um site de marketing": **150–200 ms**, `cubic-bezier(0.4, 0, 0.2, 1)`, cor, fundo e borda
trocando juntos, e **sem spring, bounce, parallax ou efeitos dirigidos por scroll**. O pedido de
"qualidade visual de SaaS moderno" foi atendido **dentro** desse limite:

| Pedido do prompt | Decisão |
|---|---|
| Animações "elaboradas" | Deslocamentos de 4–8 px, fade e scale de 0.98; só `transform`/`opacity` |
| Spring/gestos | Proibido pelo DESIGN.md; tween com o easing oficial em tudo |
| Carrossel Embla | A física do Embla causava bounce: botões, teclado e autoplay **saltam** para o slide com fade de 200 ms; só o arraste usa a física (`duration: 20`, sem bounce) |
| `sfDashboardFrameIn` | Citado no DESIGN.md sem definição; implementado como `animate-dashboard-frame-in` (320 ms, fade + 8 px) e usado **uma vez** |
| GSAP | Não utilizado: nenhum caso exigiu |

## 2. Dependências adicionadas

`motion@13.4.4`, `embla-carousel-react@8.6.0` e `embla-carousel-autoplay@8.6.0`, todas com
mais de 2 semanas de publicação e versões fixas; `npm audit --omit=dev` = 0. O Motion usa
`LazyMotion` + `domAnimation` com componentes `m.*`, o que reduz o bundle.

## 3. Arquitetura reutilizável

| Caminho | Conteúdo |
|---|---|
| `src/lib/motion/tokens.ts` | `DURATION` (fast 150, base 200, slow 320 ms), `EASE_FACTORY`, `DISTANCE` (4/8 px) |
| `src/lib/motion/presets.ts` | variants `fade`, `slideUp`, `scaleIn`, `page`, `staggerItem` |
| `src/hooks/use-reduced-motion.ts` | `usePrefersReducedMotion()` seguro para SSR (`useSyncExternalStore`) |
| `src/components/animations/` | `MotionProvider`, `FadeIn`, `SlideIn`, `ScaleIn`, `StaggerContainer`/`StaggerItem` (limite de itens), `AnimatedCard`, `AnimatedCounter`, `AnimatedPage`, `AnimatedPresenceList` |
| `src/app/template.tsx` | Transição entre rotas (fade + 4 px, 200 ms; foco e skip link fora do wrapper) |
| `src/components/carousel/` | `Carousel` (base Embla, WAI-ARIA), `InfoSlider`, `ImageCarousel`, `CarouselImage` |
| `src/components/features/assets/asset-gallery.tsx` | Galeria de patrimônio (miniaturas, ampliação, zoom por botões, placeholder); **ainda sem uso** |
| `src/components/dashboard/` | `DashboardOverview`, `StatCard`, `AnimatedChart` (Recharts, carregado sob demanda), `DashboardEmptyState` |
| `src/components/ui/` | `Dialog` animado, `Button loading`, `Skeleton`/`LoadingSkeleton`, `FormField`, `EmptyState`, `StatusIndicator`, `Table` com destaque de linha e seleção |
| Classes CSS | `transition-factory`, `transition-factory-press`, `ease-factory`, `animate-*` |

**Regra de SSR:** o conteúdo nunca sai do servidor com `opacity: 0`. O que monta na hidratação
inicial usa `initial={false}`; só anima o que monta depois (navegação, dados que chegaram).

## 4. O que foi implementado por tela

- **Transição de páginas:** fade + slide-up de 4 px em todas as rotas, sem animação de saída e sem
  perda de foco.
- **Login:** entrada do formulário, foco animado dos campos, botão com loading, erros com
  `role="alert"`, troca senha → MFA com fade e foco no campo de código, status "Acesso confirmado"
  sem atrasar o redirect real. A partir de `lg`, painel lateral com **orientações de uso do
  sistema** (texto de ajuda, não comunicado oficial) e slot de imagem institucional **vazio por
  padrão**. No celular o painel não aparece.
- **MFA e ativação de conta:** indicador de etapas (QR → código → concluído). "Concluído" só
  aparece após a resposta real; o QR e o segredo TOTP não são animados nem registrados em log.
- **Sidebar:** recolhível (256 → 64 px; estado em `sessionStorage`), tooltip no modo recolhido,
  indicador animado da página ativa, setas/Home/End, submenu "Administração" com `aria-expanded`.
- **Menu móvel:** gaveta com slide de 200 ms e overlay; foco preso, Esc e retorno de foco mantidos.
- **Permissões na navegação:** antes não havia filtro algum (TODO). Agora "Administração" só
  aparece para ADM segundo `/api/v1/me`. **É apenas UX: o backend continua autorizando tudo.**
- **Dashboard:** não existe endpoint de indicadores, então `/` mostra o estado vazio honesto
  "Indicadores ainda indisponíveis", **sem nenhum número de demonstração**. Cards com contador
  animado e gráficos de barras/rosca estão prontos e recebem dados reais por props.
- **Importação Google Sheets:** indicador que reflete só o estado real das requisições, skeleton
  durante a leitura, contadores que chegam aos valores exatos do backend, ícone + texto por
  classificação, alertas de duplicidade/conflito, modal com loading (Esc bloqueado durante o
  envio), sucesso só após a resposta. **Sem barra de percentual**, porque o backend não informa
  progresso. Textos e regras de "Pré-visualizar Importação" e "Confirmar Importação" mantidos.
- **Tabelas:** destaque de linha em hover/foco, linha selecionada, linhas antigas esmaecidas
  com `aria-busy` até a resposta chegar, entrada limitada a 20 linhas, estado vazio. Não foi
  criada ordenação, porque o backend não a suporta.
- **Formulários:** `FormField` reutilizável (`*` + `aria-required`, erros suaves com
  `role="alert"`), foco no primeiro campo inválido, botão com loading, seção expansível. Os
  formulários de patrimônio, unidade, sala etc. **não foram criados** (módulos inexistentes).

## 5. Movimento reduzido (`prefers-reduced-motion`)

Três camadas: `MotionConfig reducedMotion="user"`, `initial={false}` nos componentes e um bloco
CSS global que leva as durações a 0,01 ms (não 0, porque o Radix depende de `animationend`).
Nesse modo: sem deslocamentos, sem shimmer, sem press-scale, carrossel sem autoplay, contadores
mostram o valor final imediatamente e gráficos sem animação. O feedback funcional é preservado.

## 6. Desempenho

**Core Web Vitals** medidos no build de produção (`next start`, rede externa bloqueada, script em
Playwright com PerformanceObserver), na rota `/login`:

| Perfil | Movimento | LCP | CLS | INP (proxy) |
|---|---|---|---|---|
| Desktop 1366×768 | normal | 172 ms | 0.0001 | 16 ms |
| Desktop 1366×768 | reduzido | 152 ms | 0 | 16 ms |
| Celular intermediário 375×667, CPU 4× mais lenta | normal | 172 ms | 0.0079 | 24 ms |
| Celular intermediário 375×667, CPU 4× mais lenta | reduzido | 340 ms | 0.0079 | 24 ms |

Metas "boas" do Google: LCP < 2,5 s, CLS < 0,1, INP < 200 ms. Medição local (sem latência de rede
real): serve para comparar versões, não substitui uma medição em campo.

**JavaScript carregado na primeira visita** (tabela do `next build`):

| Rota | Antes | Depois |
|---|---|---|
| `/` | 103 kB | 168 kB (o Recharts passou a ser carregado sob demanda; chegou a 274 kB antes da correção) |
| `/login` | 182 kB | 257 kB |
| Demais rotas | 186–230 kB | 261–284 kB |

O aumento vem do Motion (chunk compartilhado), do Embla no login e dos novos componentes. Os
Core Web Vitals continuam bons, então não foram feitas otimizações adicionais.

## 7. Testes

Novos specs Playwright no projeto `motion`: `motion-foundation`, `motion-auth`,
`motion-carousel`, `motion-shell`, `motion-dashboard` e `motion-data`. Eles cobrem navegação
entre páginas, sidebar, menu móvel, modais (Esc e retorno de foco), formulários, carrossel por
teclado, toque e botões, pausa do autoplay, movimento reduzido, responsividade nas 9 resoluções,
importação, mensagens de erro, login com MFA, ausência de erros de console/hidratação e
filtragem do menu por perfil. Os testes anteriores de responsividade, axe e funcionais continuam
na suíte. Resultado final: ver §9.

**Não testado em navegador:** `ImageCarousel`, `AssetGallery`, e `StatCard`/`AnimatedChart`
**com dados**, porque nenhuma página os usa ainda e não foram criadas rotas de demonstração.
Firefox/WebKit e leitores de tela reais ficam para a próxima rodada.

## 8. Pendências e recomendações

1. Quando existir o módulo de patrimônios: adicionar a origem autorizada das imagens ao
   `img-src` de `src/lib/csp.ts` e servir as imagens só com autorização do backend (nunca públicas).
2. Quando existir o endpoint de indicadores: ligar `DashboardOverview` aos dados reais e testar
   os gráficos com dados.
3. Para usar `layoutId` em outros pontos, a fundação precisaria de `domMax` (aumenta o bundle). A
   sidebar resolveu o indicador sem isso.
4. Não rodar suítes Playwright em paralelo contra o mesmo `next dev` (porta 3100): isso causou
   falhas intermitentes durante o trabalho.
5. Paleta dos gráficos: o DESIGN.md só permite monocromático mais dois acentos, o que limita a
   separação por cor. Por isso a legenda com valores fica sempre visível e há uma tabela para
   leitores de tela.

## 9. Resultado final da verificação

Execução final de 2026-10-14, sem outras execuções concorrentes:

| Verificação | Resultado |
|---|---|
| `npm run typecheck` / `npm run lint` | OK / 0 avisos |
| `npm run build` | OK |
| `npx playwright test` (261 testes: responsivo, a11y/axe, funcional, motion) | **260 passed, 1 failed**. A falha foi `responsive › 320x568 › login`, o **primeiro** teste da execução: o `next dev` ainda compilava a página sob demanda. Repetido isoladamente (`--repeat-each=3`), todos os testes de 320px passaram. Classificada como intermitente de ambiente de desenvolvimento; recomenda-se rodar o E2E contra `next build && next start` no CI. |
| Backend `pytest` | 482 passed (nenhum arquivo do backend foi alterado nesta etapa) |
| `DESIGN.md` | intacto |
| `CLAUDE.md` | 79 linhas |
