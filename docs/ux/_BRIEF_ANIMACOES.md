# Brief compartilhado — Modernização visual / animações (2026-10-13)

Raiz: `C:\Users\winer\Videos\School\INVENTARIOAGU\SISPAT-AGU` · frontend em `frontend/` (Next 15 App Router,
React 19, TS, Tailwind 3). Leia `CLAUDE.md` e LEIA INTEGRALMENTE `DESIGN.md` antes de qualquer edição.

## Restrições do DESIGN.md (prevalecem sobre qualquer pedido de "SaaS premium")
- Transições curtas e mecânicas: **150–200 ms**, easing **cubic-bezier(0.4, 0, 0.2, 1)**; "feel de CLI, não de site de marketing".
- Cor/fundo/borda/stroke transicionam juntos (um "switch" único).
- **Proibido:** spring physics, bounce, parallax, efeitos dirigidos por scroll. Animações nomeadas com parcimônia
  (ex.: uma entrada do dashboard `sfDashboardFrameIn`). Superfície "parada e precisa".
- Use somente tokens/cores do DESIGN.md. Nunca edite DESIGN.md. Não edite CLAUDE.md (o coordenador cuida).

## Regras invioláveis
- Não alterar backend, Supabase, Google Sheets, autenticação, permissões, `src/lib/{api-client,session,supabase-client,auth-guard,csp,mfa}.ts`,
  `src/middleware.ts`, `next.config.ts`. A CSP usa nonce: **nada de `<script>` inline**, nada de `eval`; estilos inline
  (Motion) são permitidos (`style-src 'unsafe-inline'`). Lint proíbe `dangerouslySetInnerHTML`, `localStorage`, `javascript:`.
- Dependências já instaladas (não adicionar outras sem necessidade forte): `motion@13.4.4` (import de `motion/react`),
  `embla-carousel-react@8.6.0`, `embla-carousel-autoplay@8.6.0`, `recharts`, `@radix-ui/react-dialog`, `sonner`, `lucide-react`.
  **Sem GSAP.** Se precisar de outra lib, NÃO instale — registre a necessidade no relatório.
- **Sem dados fictícios como oficiais:** não existem endpoints de indicadores/patrimônios/inventários. Dashboard e
  gráficos devem mostrar estado vazio/"aguardando dados do backend" ou receber dados por props; nunca números de demonstração.
- **Sem conteúdo institucional fictício** nem imagens institucionais não autorizadas. Slides permitidos: orientações
  de uso/segurança do próprio sistema (ex.: "Ative a verificação em duas etapas"), claramente não-oficiais como comunicado.
  Painel de imagem do login: slot opcional que só exibe imagem se configurada (prop/asset autorizado); padrão sem imagem.
- Importação: sem progresso simulado; sucesso só após resposta do backend; preservar textos/regras dos botões
  "Pré-visualizar Importação" e "Confirmar Importação".
- `prefers-reduced-motion`: desativar deslocamentos/decorativos, autoplay de carrossel desligado, feedback funcional mantido.
  Use `MotionConfig reducedMotion="user"` + hook próprio.
- Acessibilidade WCAG 2.2 AA mantida: foco, Esc, retorno de foco, aria-live, carrossel com botões rotulados,
  pausa/play, `aria-roledescription="carousel"`, setas do teclado. Sem flashes.
- Performance: animar só `transform`/`opacity`; nada de animar centenas de linhas (limite ~20 itens com stagger);
  sem layout shift; Client Components só onde necessário; sem erros de hidratação.
- Testes existentes (`frontend/e2e`, 195 testes) devem continuar passando. Mocks: `e2e/support/mocks.ts`; sessão
  sintética em `sessionStorage["sispat-auth"]`; nada fora de localhost.
- Edite com Edit pontual; releia antes de editar (outros agentes trabalham em paralelo em arquivos vizinhos).
  Respeite sua fronteira de arquivos.

## Entrega
Relatório curto em `docs/ux/evidence/<seu-papel>.md`: o que foi feito, arquivos, decisões frente ao DESIGN.md,
testes executados (comandos e resultado), o que não foi feito e por quê. Ao final rode
`npm run typecheck && npm run lint` (e o que mais for pertinente).
