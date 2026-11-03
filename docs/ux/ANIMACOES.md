# SISPAT-AGU — Modernização visual: animações, transições e microinterações

Data: 2026-10-14 · Escopo: somente o frontend (`frontend/`). Backend, Supabase, autenticação,
permissões e integração com o Google Sheets **não foram alterados**. `DESIGN.md` está intacto.
Evidências detalhadas de cada frente estão em `docs/ux/evidence/`.

> **Documento histórico.** Este é o relatório da rodada de 2026-10-14. A fundação
> de movimento (§1 a §3, §5) continua valendo e é a referência para novas telas;
> o que mudou desde então está na seção seguinte. As medições de §6 e o resultado
> de §9 são daquela data e **não foram reexecutados**.

## Estado atual (2026-10-29)

Conferido contra o código hoje; só o que divergia do relatório de 2026-10-14:

- **Caminho da transição de rotas**: com os *route groups* do Next.js, o
  `template.tsx` é por grupo —
  `frontend/src/app/(app)/template.tsx` e
  `frontend/src/app/(publico)/template.tsx`. Não existe `src/app/template.tsx`.
- **Home (`/`)**: não mostra mais o estado vazio "Indicadores ainda
  indisponíveis". Hoje tem introdução com entrada escalonada
  (`StaggerContainer`), o atalho `DashboardShortcut` para `/dashboard`, o widget
  de alertas e os de IA (`AlertsWidget`, `AiInsightsWidget`, `AskSispatBox`). A
  Home **não repete números** — os indicadores vivem em `/dashboard`.
- **Dashboard com dados reais**: existe. `/dashboard` é a grade do catálogo de
  painéis do backend; o relatório imprimível usa a composição legada. Gráficos em
  Nivo 0.99.0 (`animate={false}`), `StatCard` em uso de verdade e `AnimatedCounter`
  só com valor já confirmado pelo backend. Ver `DASHBOARD.md`.
  `DashboardOverview` e `DashboardEmptyState` (`src/components/dashboard/`)
  continuam **sem uso** por nenhuma página. `AnimatedChart`, ao contrário do que
  este documento dizia, **é usado** — de forma indireta: `nivo-bar-charts.tsx` e
  `nivo-pie-chart.tsx` o importam, e esses chegam às páginas do dashboard via
  `dynamic()` (`dashboard-tech-panels.tsx`, `located-chart-view.tsx`).
  Conferido em 2026-11-01.
- **Ordenação e formulários**: as tabelas têm ordenação por allowlist do backend
  (`aria-sort` + botão) e existem os formulários de patrimônio, unidades, salas,
  pessoas, movimentações, inventários e usuários — o relatório antigo dizia que
  não existiam porque os módulos ainda não haviam sido entregues.
- **Paginação**: a `PaginationBar` comum ("Exibindo X–Y de N …") com seletor
  50/100/200 (padrão 50) substituiu as paginações por tela.
- **Login**: o painel lateral de orientações (`AuthGuidancePanel` + `InfoSlider`,
  a partir de `lg`, depois do formulário na ordem do DOM) continua lá; o slot de
  imagem institucional segue vazio por padrão. `ImageCarousel` e `AssetGallery`
  continuam sem uso em alguma página.
- **Logomarca pública** (`src/components/brand/agu-logo.tsx`, usada por
  `src/app/(publico)/layout.tsx`): usa o ativo **oficial**
  `src/assets/brand/agu-logo.png` (640×381, PNG RGBA transparente), aplicado
  direto sobre o canvas `#101010` e dimensionado por LARGURA
  (`h-auto w-36 brightness-125 sm:w-44` = 144 px / 176 px, com
  `sizes="(min-width: 640px) 176px, 144px"`). As dimensões vêm do import
  estático e há `priority` para o LCP, logo sem *layout shift*. O único efeito
  é o filtro `brightness-125`: nada de sombra, blur, glow ou `mix-blend-*`,
  conforme o DESIGN.md. O mesmo arquivo é o lido por `/og`. Histórico: entre
  2026-10-29 e 2026-11-01 o cabeçalho exibiu uma troca sazonal temporária, já
  revertida em 2026-11-01.
- **Versões**: `motion@13.4.4`, `embla-carousel-react@8.6.0` e
  `embla-carousel-autoplay@8.6.0` seguem fixas; o projeto está em `next@15.5.28` e
  `react@19.3.0`.

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
| `src/app/(app)/template.tsx` e `src/app/(publico)/template.tsx` | Transição entre rotas (fade + 4 px, 200 ms; foco e skip link fora do wrapper) — um por *route group* |
| `src/components/carousel/` | `Carousel` (base Embla, WAI-ARIA), `InfoSlider`, `ImageCarousel`, `CarouselImage` |
| `src/components/features/assets/asset-gallery.tsx` | Galeria de patrimônio (miniaturas, ampliação, zoom por botões, placeholder); **ainda sem uso** |
| `src/components/dashboard/` | `DashboardOverview`, `StatCard`, `AnimatedChart` (Nivo 0.99, carregado sob demanda, `animate={false}`; Recharts removido em 2026-10-20), `DashboardEmptyState` |
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
- **Dashboard (estado de 2026-10-14):** não existia endpoint de indicadores, então `/` mostrava
  o estado vazio honesto "Indicadores ainda indisponíveis", **sem nenhum número de demonstração**;
  cards com contador animado e gráficos estavam prontos e recebiam dados por props.
  *Hoje*: os endpoints existem, `/dashboard` e o relatório imprimível usam dados reais e a Home
  não repete números — ver "Estado atual" e `DASHBOARD.md`.
- **Importação Google Sheets:** indicador que reflete só o estado real das requisições, skeleton
  durante a leitura, contadores que chegam aos valores exatos do backend, ícone + texto por
  classificação, alertas de duplicidade/conflito, modal com loading (Esc bloqueado durante o
  envio), sucesso só após a resposta. **Sem barra de percentual**, porque o backend não informa
  progresso. Textos e regras de "Pré-visualizar Importação" e "Confirmar Importação" mantidos.
- **Tabelas:** destaque de linha em hover/foco, linha selecionada, linhas antigas esmaecidas
  com `aria-busy` até a resposta chegar, entrada limitada a 20 linhas, estado vazio. A ordenação
  não existia nesta rodada (o backend ainda não a suportava); *hoje* as listas ordenam pela
  allowlist do backend, com `aria-sort` e botão no cabeçalho.
- **Formulários:** `FormField` reutilizável (`*` + `aria-required`, erros suaves com
  `role="alert"`), foco no primeiro campo inválido, botão com loading, seção expansível. Nesta
  rodada os formulários de patrimônio, unidade, sala etc. **não existiam** (módulos ainda não
  entregues); *hoje* existem e seguem este padrão — ver `PATRIMONIOS.md`,
  `CADASTROS_APOIO.md`, `MOVIMENTACOES.md`, `INVENTARIOS.md` e `USUARIOS.md`.

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

1. Imagens de patrimônio: a galeria (`AssetGallery`) continua sem uso e nenhuma origem de
   imagem de bem foi adicionada ao `img-src` de `src/lib/csp.ts` (hoje o `img-src` só libera
   `'self'`, `data:`, `blob:` e o prefixo assinado de avatares do Supabase Storage). Quando as
   fotos de bens entrarem, servi-las só com autorização do backend — nunca públicas.
2. `DashboardOverview`, `AnimatedChart` e `DashboardEmptyState` nunca foram ligados a uma
   página: os painéis reais usam `StatCard` + os gráficos Nivo diretamente. Decidir entre
   adotá-los ou removê-los.
3. Para usar `layoutId` em outros pontos, a fundação precisaria de `domMax` (aumenta o bundle). A
   sidebar resolveu o indicador sem isso.
4. ~~Não rodar suítes Playwright em paralelo contra o mesmo `next dev` (porta 3100): isso causou
   falhas intermitentes durante o trabalho.~~ **Resolvido em 2026-11-02**: o `webServer` do
   `playwright.config.ts` passou a servir `next build && next start`, então não há mais compilação
   sob demanda para competir. Os cinco testes que falhavam por esse motivo (três viewports de
   `responsive › menu de navegação funcional`, `a11y › axe 375px › dashboard-painel` e
   `dashboard-charts-functional.spec.ts:124`) passam com os 4 workers padrão.
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
