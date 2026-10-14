# Telas de dados — evidência (2026-10-13)

Papel: Desenvolvedor Frontend de Telas de Dados (tabelas, formulários, importação).
Base: fundação (`@/components/animations`, `m.*`, `@/lib/motion/tokens`). Nenhum arquivo da fundação,
de `src/lib/**`, backend ou regra de negócio foi alterado.

## Arquivos

Novos
- `frontend/src/components/ui/status-indicator.tsx` — `StatusIndicator` (idle/loading/success/warning/error):
  ícone + texto Geist Mono, `role="status"` + `aria-live="polite"`, cores só em ícone/texto.
- `frontend/src/components/ui/empty-state.tsx` — `EmptyState` (FadeIn, sem heading, variante `plain` p/ tabela).
- `frontend/src/components/ui/form-field.tsx` — `FormField` (render prop: `id`, `required`, `aria-required`,
  `aria-invalid`, `aria-describedby` → dica + erro), `*` visual `aria-hidden`, erro = `FormMessage`
  (`role="alert"`) com entrada fade + 4 px e saída imediata; `RequiredLegend`; classes
  `selectControlClassName`/`textareaControlClassName`. Pronto para os futuros formulários
  (patrimônio, unidade, sala, responsável, inventário, movimentação, permissões) — que NÃO foram criados.
- `frontend/src/components/features/imports/classification.ts` — rótulo/ícone/tom por classificação (fonte única).
- `frontend/src/components/features/imports/preview-review-alert.tsx` — aviso de duplicado/inválido/conflitante.
- `frontend/src/components/features/users/invite-user-dialog.tsx` — convite extraído da página.
- `frontend/src/components/features/users/users-table.tsx` — tabela de usuários.
- `frontend/e2e/motion-data.spec.ts` — 20 testes (projeto `motion`).

Editados
- `ui/table.tsx` — `"use client"`; linha com `transition-factory`, hover **e** `focus-within`, `data-state=selected`;
  `Table busy` (opacity 60 % + `aria-busy`); `AnimatedTableBody`/`AnimatedTableRow` (StaggerContainer
  `as="tbody"`, limite 20); `TableEmpty`.
- `ui/badge.tsx` — `transition-factory`, ícones filhos 12 px.
- `features/imports/preview-summary-cards.tsx` — StaggerContainer + `AnimatedCounter` (valores reais do
  `summary`, `live="off"`) + ícone por classificação.
- `features/imports/preview-items-table.tsx` — `keepPreviousData` (resultados anteriores ficam visíveis,
  esmaecidos, até a resposta), corpo remontado só quando os dados novos chegam (stagger ≤ 20 linhas),
  `LoadingSkeleton variant="table"`, EmptyState, badge ícone + texto, linha selecionada, indicador
  "Atualizando…" na paginação, pílulas com `transition-factory`. Query/filtros/params inalterados.
- `features/imports/confirm-import-dialog.tsx` — botão "Confirmar" com `loading` (texto "Confirmando…" mantido).
- `app/administracao/importacao/google-sheets/page.tsx` — indicador "Requisição:" derivado só do estado
  real das mutations; `AnimatePresence mode="wait"` entre vazio / skeleton (`cards` + `table`) / prévia /
  resultado (fade + 4 px); resultado com `AnimatedCounter`; erro com SlideIn. Textos/regras de
  "Pré-visualizar Importação" e "Confirmar Importação" preservados (ADM + confirmação expressa no modal).
- `app/administracao/usuarios/page.tsx` — usa os componentes acima; `keepPreviousData` + "Carregando página…";
  revogação com `Button loading`; Esc não fecha o modal durante o envio.

## Decisões frente ao DESIGN.md
- Durações 150/200 ms, `ease-factory`, tween; só `opacity`/`transform`; deslocamentos 4 px. Sem spring/bounce.
- Cores: signal-orange / metric-green só em ícone, texto e borda; nunca fill. Cada estado tem ícone + texto.
- **Sem barra de percentual**: o backend (`POST /preview`, `POST /confirm`) não devolve progresso; o indicador
  mostra apenas idle → lendo → prévia pronta/expirada/falha e confirmando → concluída/falha.
- Sucesso só no `onSuccess` (toast + resumo); erros com as mensagens genéricas já existentes (nada do corpo
  da resposta é exibido — testado).
- Erros de campo: só a entrada anima; um `role="alert"` em fade-out seria um "fantasma" para leitores de tela.
- Convite: `noValidate` com validação por campo (UX; o backend valida). `required`/`type=email` continuam no DOM.
  Foco vai ao primeiro campo inválido. Justificativa virou seção expansível (`aria-expanded`/`aria-controls`).
- Ordenação: não existe no backend (`/items` e `/users` só aceitam filtros/paginação) — não foi inventada.

## Testes executados
| Comando | Resultado |
|---|---|
| `npm run typecheck` | ok |
| `npm run lint` | ok (0 warnings) |
| `npx playwright test e2e/motion-data.spec.ts` | 20/20 passed |
| `npx playwright test --project=e2e -g "importação Google"` / convite | passed |
| `npx playwright test` (suíte completa, 262 testes, 3 workers) | 256 passed, 6 failed — nenhum em telas de dados (ver abaixo) |
| reexecução dos 5 que falharam (exceto `motion-zzdebug`) | 4 passed; `headings` passou isolado (36 s, 1 worker) |

Falhas da suíte completa: `responsive 320x568 login/login-mfa`, `375x667 seguranca-modal` (ENOENT no
screenshot), `axe 375px dashboard`, `a11y headings` (timeout de 60 s: abre 13 telas em sequência no mesmo
teste — frágil sob carga) e `motion-zzdebug.spec.ts` (arquivo temporário de outro agente, já removido).
Todas são de telas/arquivos de outros agentes ou de concorrência no servidor; reexecutadas, passaram.

`motion-data.spec.ts`: prévia com resposta segurada (status "Lendo planilha…", skeleton, sem progressbar,
`aria-busy`) → contadores com os valores exatos do mock + tabela + axe (após `waitForAnimations`); filtro
mantém as 8 linhas com `aria-busy` até a resposta e termina com 1 linha opaca; estado vazio; seleção
(`data-state`) e modal (foco dentro, Esc, retorno de foco); confirmação atrasada (nada de sucesso/toast antes,
Esc bloqueado, depois resumo "Criados" = 5); erro 500 genérico; reduced motion (leitura única: contadores já no
valor final, sem transform residual); tabela de usuários; convite (3 alerts, foco, `aria-required`,
`aria-invalid`, descrição, seção expansível, loading com resposta atrasada); erro na lista; sem overflow nas
9 resoluções (importação com prévia e modal de convite com erros); sem erros de console.

Observação de ambiente: outros agentes rodavam Playwright/Next dev em paralelo no mesmo servidor (porta
3100) — houve falhas transitórias (`ERR_CONNECTION_REFUSED`, timeout de hidratação, `ENOENT` em
`test-results/.playwright-artifacts-*`, `SyntaxError` do Next em `/login` durante edição alheia). Os mesmos
testes passaram ao serem reexecutados com o servidor estável. Recomenda-se rodar a suíte final sem execuções
concorrentes.

## Não feito / pendências
- Progresso real de importação: depende de o backend expor progresso (ex.: `sync_job` com contadores); hoje não.
- Formulários de patrimônio/unidade/etc.: módulos inexistentes — só o `FormField` reutilizável foi criado.
- Seletor real de unidades no convite: falta endpoint de listagem (TODO mantido).
- Ajuste sugerido à fundação (não aplicado): `StaggerItem` poderia aceitar `data-*` tipado; hoje
  `AnimatedTableRow` declara `data-state` manualmente.
