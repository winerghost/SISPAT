# SISPAT-AGU — Frontend

Next.js 14 (App Router) + TypeScript + Tailwind CSS. Camada de apresentação do
SISPAT-AGU — nunca mecanismo de segurança (toda regra de negócio e validação
crítica vive no backend Flask; ver `../CLAUDE.md`).

## Instalação

```bash
npm install
```

## Desenvolvimento

```bash
npm run dev
```

Abre em `http://localhost:3000`. Defina `NEXT_PUBLIC_API_URL` (ver
`../.env.example`) para apontar para o backend Flask local.

## Build de produção

```bash
npm run build
npm run start
```

`next.config.ts` usa `output: "standalone"`, exigido pelo `Dockerfile` desta
pasta (estágio `runtime` copia `.next/standalone`).

## Verificação de tipos / lint

```bash
npm run typecheck
npm run lint
```

## Animações

Sistema de animação reutilizável (Motion + Embla) dentro dos limites do DESIGN.md
(150–200 ms, sem spring/parallax), com suporte a `prefers-reduced-motion`. Use
`@/components/animations` e `@/lib/motion/tokens`, sempre com `m.*` (nunca `motion.*`).
Guia completo: [`../docs/ux/ANIMACOES.md`](../docs/ux/ANIMACOES.md). Testes: `npx playwright test --project=motion`.

## Testes E2E, responsividade e acessibilidade (Playwright + axe)

```bash
npx playwright install chromium   # uma vez
npm run test:e2e          # todos os testes (responsivo + a11y + funcional)
npm run test:responsive   # 9 resoluções: 320 → 1920 px
npm run test:a11y         # axe-core, WCAG 2.2 AA
```

O Playwright sobe o `next dev` na porta 3100 com variáveis **sintéticas**;
Supabase Auth e API Flask são mockados (`e2e/support/mocks.ts`) e qualquer
requisição fora de localhost é abortada. Nunca aponte estes testes para
Supabase/VPS reais. Evidências (screenshots) ficam em `test-results/`.

## Segurança do cliente

- CSP com nonce por requisição em `src/middleware.ts` (`src/lib/csp.ts`).
- Sessão Supabase em `sessionStorage` (chave `sispat-auth`), nunca em
  `localStorage` (regra de lint). Plano de migração para cookies HttpOnly em
  `../docs/security/SECURITY_AUDIT.md`.
- O frontend não toma decisões de segurança: toda autorização é do backend.

## Configurações

- Menu "Configurações" é um grupo: **Segurança** (todos) e **Inteligência
  Artificial** (só ADM — ocultar é UX; o backend exige ADM + AAL2). "Aparência"
  entra na Etapa 3 junto com a página.
- `/configuracoes` lista as subseções do perfil (fonte: `nav-items.ts`).
- `/configuracoes/inteligencia-artificial` usa `src/lib/ai-settings-api.ts`
  (contrato em `../docs/architecture/modulo-configuracoes.md`): estado geral,
  chaves só como "Configurada"/"Não configurada", provedor/modelo em `<select>`
  nativo (modelos só da allowlist do backend), switches nativos
  (`components/ui/switch.tsx`, `role="switch"`), teto mensal, `version` no
  PATCH (409 recarrega e avisa), aviso LGPD obrigatório para DeepSeek e
  "Testar conexão".

## Tema

O tema visual segue **estritamente** `../DESIGN.md` ("Factory" — terminal war
room, dark-only). Não altere cores, tipografia, raios ou espaçamentos sem
atualizar `DESIGN.md` primeiro — ele é a fonte oficial e imutável do Design
System. Os tokens estão traduzidos em `tailwind.config.ts` e
`src/app/globals.css`.

Ativo de marca: a logomarca da AGU (`src/assets/brand/agu-logo.png`, 640 px,
derivada de `../logo.png`) é exibida na tela de login por
`components/brand/agu-logo.tsx`, sobre um Light Surface Card (#eeeeee, raio
10px, sem sombra) para manter contraste; não recolorir nem aplicar filtros.

## Estrutura

```
src/
  app/                     # App Router (rotas, layout raiz, globals.css)
  components/
    layout/                # Shell: sidebar, header, itens de navegação
    ui/                     # Componentes base no padrão shadcn/ui
  features/                 # Módulos de domínio (ainda vazio — Fase 1)
  lib/                       # Cliente de API, provider do TanStack Query, utils
```

## Limitações conhecidas desta rodada

- Sem autenticação de frontend: não há login/sessão; o cliente de API
  (`src/lib/api-client.ts`) tem um ponto de extensão comentado para o header
  `Authorization` quando a sessão existir.
- Itens administrativos da sidebar são exibidos para todos os usuários (sem
  RBAC no frontend ainda) — ver comentários `TODO` em
  `src/components/layout/sidebar.tsx` e `nav-items.ts`.
- A busca global no header é um `<input>` estático, sem lógica de pesquisa.
- A página `administracao/importacao/google-sheets` é um placeholder; a tela
  real dos botões de importação será implementada em uma rodada futura.
