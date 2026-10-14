# Autenticação + carrosséis — evidência (2026-10-13)

Papel: Desenvolvedor Frontend de Autenticação e Carrosséis. Só apresentação: nenhuma chamada Supabase/MFA,
AuthGuard, redirecionamento, mensagem anti-enumeração ou arquivo de `src/lib/**` foi alterado. Foram usados
apenas componentes da fundação (`@/components/animations`, `m.*` de `motion/react`, tokens de
`@/lib/motion/tokens`) e as dependências já instaladas (`embla-carousel-react`, `embla-carousel-autoplay`).

## Arquivos

Criados
- `frontend/src/components/carousel/carousel.tsx`: base Embla, padrão WAI-ARIA APG de carrossel.
- `frontend/src/components/carousel/info-slider.tsx`: slides só de texto (eyebrow, título e corpo).
- `frontend/src/components/carousel/image-carousel.tsx`: slides de imagem com legenda opcional e estado vazio.
- `frontend/src/components/carousel/carousel-image.tsx`: `next/image` (`fill`, `sizes` responsivo, lazy,
  skeleton como placeholder, fallback "Imagem indisponível" quando a imagem falha).
- `frontend/src/components/carousel/index.ts`: barrel.
- `frontend/src/components/features/auth/`: `animated-form-message.tsx`, `auth-field.tsx`,
  `auth-guidance-panel.tsx`, `step-indicator.tsx`, `login-guidance.ts`, `use-media-query.ts`, `index.ts`.
- `frontend/src/components/features/assets/asset-gallery.tsx`: miniaturas, ampliação em Dialog, navegação e zoom
  por botões. **Não está em uso em nenhuma página.**
- `frontend/e2e/motion-auth.spec.ts`, `frontend/e2e/motion-carousel.spec.ts` (projeto Playwright `motion`).

Editados (só apresentação)
- `app/login/page.tsx`
  - Card com `SlideIn` (4px).
  - Troca senha → MFA com `FadeIn key={step}`.
  - Erros com `AnimatedFormMessage` (`role="alert"` e `id="login-error"` mantidos) e `<Button loading>`.
  - Rótulos acompanham o foco do campo (`AuthField`).
  - Status "Acesso confirmado. Redirecionando…" logo **depois** do `router.push` real, sem atrasar o redirect.
  - "Voltar" devolve o foco ao e-mail (antes caía no `<body>`). O `signOut` local foi mantido.
  - A partir de `lg`, painel lateral `AuthGuidancePanel`.
- `app/ativar-conta/page.tsx`
  - `StepIndicator` (Validar convite → Definir senha → Conta ativada); só reflete a fase real.
  - Skeleton e `role="status"` durante a validação.
  - Fases trocam com `FadeIn`, junto com `AnimatedFormMessage` e `<Button loading>`.
  - Sucesso só após a resposta de `activateInvite()`.
- `app/configuracoes/seguranca/page.tsx`
  - `StepIndicator` (Escanear QR code → Informar código → Concluído). Só chega a "Concluído" após
    `challengeAndVerify` real e exibe o status "Verificação em duas etapas ativada.".
  - Skeleton com status para leitor de tela, `AnimatedFormMessage` (inclusive no Dialog, `surface="light"`) e
    `<Button loading>`.
  - **O bloco do QR code e da chave manual (segredo TOTP) não é animado nem logado.**

## Decisões frente ao DESIGN.md

- **Sem bounce.** O integrador do Embla é físico (velocidade × atrito 0,68), não temporal. Simulei a fórmula de
  `ScrollBody`: com `duration` 10–16 ele ultrapassa o alvo em 0,6–5,9 % (bounce, proibido). Com 20 o overshoot é
  < 0,01 %, mas o slide leva ~430 ms para assentar.
- **Navegação em 200 ms.** Botões, teclado, indicadores e autoplay fazem salto (`scrollTo(i, true)` /
  `jump: true`) mais um fade de opacidade de **200 ms com `cubic-bezier(0.4,0,0.2,1)`** (`DURATION_MS.base` e
  `EASE_FACTORY_CSS`), via Web Animations API. Só `opacity` é animada.
- **Arraste e toque** usam a física do Embla com `duration: 20`, para o slide acompanhar o dedo.
- **Reduced motion:** `duration: 0`, sem fade e sem autoplay (o botão de pausa nem aparece).
- **A11y do carrossel (APG)**
  - Raiz: `role="region"`, `aria-roledescription="carousel"`, `aria-label`, focável. ←/→/Home/End funcionam
    com o foco na raiz ou em qualquer controle.
  - Slides: `role="group"`, `aria-roledescription="slide"`, "n de N". Slides fora de vista ficam `inert`.
  - Controles: anterior/próximo rotulados; indicadores "Slide n de N" com `aria-current` (estado por forma
    pill/ponto + cor, inativos em warm-granite com 5:1); alvos ≥ 24 px.
  - `aria-live` fica `polite` quando o carrossel não está girando e `off` durante o autoplay.
- **Autoplay (WCAG 2.2.2):** opcional, intervalo configurável (mínimo 4 s; o login usa 8 s).
  - Botão Pausar/Retomar visível.
  - Pausa com hover e com foco dentro do carrossel.
  - Qualquer interação (botões, teclado, arraste) deixa o autoplay pausado até "Retomar".
  - Estado exposto em `data-autoplay`.
- **Login:** painel **depois** do formulário no DOM (o Tab chega primeiro aos campos). Abaixo de `lg` ele fica
  oculto por CSS e o autoplay só liga quando a media query `lg` casa (`useMediaQuery`, SSR-safe).
  - Orientações de uso do próprio sistema, com texto neutro: MFA, cadastro só por convite, nunca compartilhar
    códigos, sessão termina ao fechar a aba.
  - O painel não é comunicado oficial e não traz imagem: `LOGIN_INSTITUTIONAL_IMAGE = null`; a prop `image`
    é um slot opcional.
- **Erros animados.** `AnimatePresence mode="wait"` com `key` = texto: nunca existem dois `#login-error` ao
  mesmo tempo, e uma mensagem repetida é anunciada de novo. Entrada em fade + 4 px (150 ms), saída só fade.
- **Etapa MFA sem esperar a saída.** A troca de etapa não usa `AnimatePresence`: o campo do código existe no
  mesmo commit e o efeito de foco existente continua funcionando.
- **Imagens / segurança.**
  - URLs só por props, sem imagens embutidas. Devem vir do backend já autorizadas (URL assinada de curta
    duração), nunca públicas.
  - `unoptimized`: o otimizador do Next buscaria e cachearia a URL fora da autorização, e o `next.config` não
    declara `remotePatterns`.

## Testes executados

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ok |
| `npm run lint` | ok (0 warnings) |
| `npx playwright test e2e/motion-auth.spec.ts e2e/motion-carousel.spec.ts` | **21 passed** |
| `npx playwright test -g "login\|ativar\|seguranca"` (a11y/responsive/e2e das telas de auth) | 84 passed, 4 falhas ambientais (servidor dev derrubado por outro agente; ver abaixo) |
| `npx playwright test` (suíte completa, última execução) | **254 passed, 7 failed** — nenhuma falha em telas/arquivos desta fronteira |

`motion-auth.spec.ts` (6 testes):
- Erro de credenciais entra com fade (opacidade < 1 na inserção), mantém `role="alert"`, `id="login-error"`,
  `aria-invalid` e `aria-describedby`; axe limpo; sem erros de console.
- `<Button loading>` com o token do Supabase atrasado: `aria-busy`, desabilitado e com spinner.
- Senha → MFA: foco no código, axe limpo; "Voltar" devolve o foco ao e-mail; código errado mostra o alerta;
  código certo exibe o status "Acesso confirmado" e redireciona.
- Reduced motion: o alerta aparece sem `transform`.
- `/ativar-conta`: indicador de etapas e erro com alerta.
- `/configuracoes/seguranca`: etapas QR → código → concluído, que só avançam após a verificação real.

`motion-carousel.spec.ts` (15 testes):
- Semântica APG e axe limpo.
- Ordem de Tab: campos do login → Entrar → carrossel.
- Botões e indicadores, com loop; teclado ←/→/Home/End.
- Arraste com mouse; arraste por toque (CDP `Input.dispatchTouchEvent`, `hasTouch`).
- Autoplay: avança sozinho (8 s); pausa com foco, hover e botão; `aria-live` alterna entre `off` e `polite`.
- Fade de 200 ms só de opacidade com o easing do sistema (captura de `Element.animate`).
- Reduced motion: autoplay `off`, sem botão de pausa e sem fade.
- Mobile: painel oculto e autoplay `off`.
- Sem overflow e sem alvos < 24 px/sobrepostos em 320/375/768/1024/1440 (inclusive após trocar de slide);
  sem erros de console.

### Falhas restantes da suíte completa (fora da minha fronteira)

- `responsive.spec.ts › menu de navegação funcional` em várias larguras: o clique em "Usuários" no menu não
  troca a URL de `/` em 15 s. Reproduz isolado (4 de 4). É a navegação do shell (sidebar/menu), sem relação com
  login/carrossel.
- `a11y.spec.ts › headings` estoura 60 s em `importacao`: `getByRole('table')` não aparece após "Pré-visualizar
  Importação" (tela de importação, de outro agente).
- `functional.spec.ts › proteção de rotas` (`/`) e `› USER sem MFA`: o redirect do AuthGuard e a navegação
  client-side passaram de 15 s em execuções sob carga. Passam isolados (11 passed na nova execução).
- Ambiente compartilhado: durante as execuções, o `next dev` (porta 3100, reaproveitado) foi derrubado e
  `test-results/` e `.next/` foram apagados por execuções paralelas de outros agentes. Isso causou
  `ERR_CONNECTION_REFUSED`, `ENOENT` de traces e `TS6053 .next/types`, todos transitórios.
- Achado sobre o ambiente de testes: em `next dev` a 1ª navegação para `/` após o MFA pode levar mais de 15 s
  (compilação sob demanda). No meu spec o `toHaveURL` desse passo usa 45 s. Não há bug de produto: o
  `pushState` acontece (verificado com instrumentação de `history`).
- Nos meus specs, `getByRole('alert')` também casa o `__next-route-announcer__` (`role="alert"`) do Next; por
  isso usei `#login-error[role=alert]` etc.

## Não feito / pendências

- **AssetGallery e ImageCarousel não têm teste automatizado.** Não existe rota que os use (por instrução, nenhuma
  rota de demo foi criada) e o teste de componente do Playwright (`@playwright/experimental-ct-react`) não está
  instalado. Typecheck e lint cobrem os dois. O código do Carousel base usado por eles é o mesmo exercitado pelo
  InfoSlider.
- **CSP:** `img-src` hoje aceita só `'self' data: blob:`. Quando o módulo de patrimônios existir, a origem das
  imagens autorizadas precisa entrar em `src/lib/csp.ts` (fora da minha fronteira).
- **Fundação:** nenhum ajuste necessário.
