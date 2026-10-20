# Revisão AppSec — Preferência `dashboard_charts` e migração Recharts → Nivo (2026-10-20)

Revisão **somente leitura** (nenhum código de produção alterado). Revisor: agente AppSec.

## Parecer: **APROVADO COM RESSALVAS**

Não foram encontrados achados Críticos, Altos ou Médios. Há 2 achados Baixos e 8
Informativos (abaixo). Nenhum deles bloqueia o deploy, mas L-1 e L-2 devem ser
corrigidos/cobertos no próximo ciclo. Este parecer **não** afirma que o sistema está livre
de vulnerabilidades: vale apenas para o escopo e os limites descritos ao final.

## Escopo

A) `backend/app/api/v1/schemas.py` (`DashboardChartsPatch`, `PreferencesUpdateRequest`,
`parse_body`), `backend/app/services/preferences_service.py`, `backend/app/models/settings.py`,
`backend/app/api/v1/me.py`, `backend/migrations/versions/0011_user_preferences_dashboard_charts.py`,
`backend/migrations/sql/0014_user_preferences_dashboard_charts.sql`,
`backend/tests/test_dashboard_charts_preferences.py`, `frontend/src/lib/preferences-api.ts`,
`frontend/src/lib/ui-preferences.ts`.

B) `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/components/dashboard/`
(`chart-shell.tsx`, `nivo-bar-charts.tsx`, `nivo-pie-chart.tsx`, `nivo-line-charts.tsx`,
`chart-theme.ts`, `animated-chart.tsx`), `frontend/src/components/features/dashboard/`
(`dashboard-panels.tsx`, `chart-type-menu.tsx`, `use-dashboard-chart-prefs.ts`,
`dashboard-transform.ts`), `frontend/src/lib/csp.ts`, `frontend/e2e/dashboard*.spec.ts`.

## Ferramentas e resultados reais

| Ferramenta | Versão | Resultado |
|---|---|---|
| `npm audit --omit=dev --json` | npm 11.16.0 / Node v24.18.0 | 0 vulnerabilidades (info/low/moderate/high/critical = 0); 143 deps de produção |
| `npm ls @nivo/core @react-spring/web recharts` | idem | `@nivo/*@0.99.0`, `@react-spring/web@10.1.2`; `recharts` ausente da árvore |
| Análise do lock (script Node, só leitura) | lockfileVersion 3 | 70 pacotes na árvore do Nivo; 70/70 com `integrity sha512-` e `resolved` em `https://registry.npmjs.org/`; nenhum `hasInstallScript`; `recharts`/`victory-vendor` ausentes |
| grep em `node_modules/@nivo/*/dist/*.mjs`, `@react-spring/*`, `use-debounce`, `react-virtualized-auto-sizer`, `d3-*/src` | — | nenhuma ocorrência de `eval(`, `new Function`, `innerHTML`, `dangerouslySetInnerHTML`, `new Worker`, `importScripts`, `document.write`, `insertAdjacentHTML` |
| grep no código revisado (B) | — | nenhum `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` |
| Sonda Pydantic (script Python isolado contra `PreferencesUpdateRequest`) | Python 3.10.0 | `" stacked "` → `literal_error`; `{"user_id":…}` aninhado → `extra_forbidden` em `("dashboard_charts","user_id")`; `version: true` → `int_type`; `{"units": null}` aceito (restaurar padrão) |

**Não executados** (instrução do coordenador: memória limitada / outros processos):
pytest completo, Playwright, `scripts/security-audit.sh --strict`.

## A) Preferência `dashboard_charts` — verificações

| Item | Resultado |
|---|---|
| Allowlist fechada | OK — `Literal` por painel em `schemas.py:225-227`; espelhada em `preferences_service.py:47-51`; o serviço também refiltra a leitura (`_stored_charts`, `:57-68`). |
| `extra="forbid"` | OK — `DashboardChartsPatch(_StrictModel)` (`schemas.py:93,217`); objetos aninhados/listas/números/strings com espaços → 400. |
| Mass assignment | OK para o nível superior (`user_id`, `role`, `unit_id`, `deleted_at` → 400 + evento; teste `test_mass_assignment_rejeitado`). Ver **L-1** para chaves privilegiadas aninhadas. |
| Alvo só via JWT | OK — `me.py:118-121` usa `g.current_user.id`; `user_id` em query/cabeçalho é ignorado (teste `test_isolamento_entre_usuarios`). Cache do React Query (`["me", …]`) é removido no logout (`session.ts:123`). |
| 409 | OK — versão comparada sob `SELECT … FOR UPDATE`; corrida na 1ª inserção → `IntegrityError` → 409 (`preferences_service.py:106-109,148-152`). |
| Auditoria | OK — `USER_PREFERENCES_UPDATED` na mesma transação, `previous/new` só com densidade, escala, tipos (allowlist) e versão; sem token/e-mail (teste `test_auditoria_sem_dados_sensiveis`). |
| Risco de 500 por CHECK de 512 bytes | Não alcançável: o maior JSON possível (`{"units": "horizontal", "status": "donut", "monthly": "area"}`) tem ~60 bytes. Um CHECK violado viraria 409, não 500 (ver **I-1**). |
| Dado legado inválido | Tratado — chaves/valores fora da allowlist e valores padrão são descartados em `_stored_charts`; o próximo PATCH regrava o JSON limpo. CHECK `jsonb_typeof = 'object'` impede não-objeto. Sem teste dedicado (ver **L-2**). |
| Frontend valida resposta | OK — `preferences-api.ts:62-96` exige as 3 chaves na allowlist, `density`/`font_scale` válidos e `version` inteiro seguro; caso contrário lança erro (o painel usa padrões e esconde o seletor). Cookie `sispat-ui` só guarda densidade/escala. |

## B) Nivo 0.99.0 — verificações

| Item | Resultado |
|---|---|
| Versões pinadas | OK — `@nivo/bar|core|line|pie` exatamente `0.99.0` (`package.json:17-20`); `@react-spring/web` transitivo `10.1.2` (faixa `^10.0` no `@nivo/core`, travada pelo lock). |
| Integridade no lock | OK — 70/70 pacotes com sha512 e registry oficial; nenhum script de instalação. |
| Licenças | Permissivas e compatíveis, mas **não todas MIT**: MIT 44, ISC 15 (d3 v3+/internmap/delaunator), BSD-3-Clause 10 (d3 v1/v2 aninhados), Unlicense 1 (`robust-predicates`). Ver **I-5**. |
| Transitivas novas | d3-array/color/delaunay/format/interpolate/path/scale/scale-chromatic/shape/time/time-format, internmap, delaunator, robust-predicates, lodash 4.18.1, use-debounce 10.1.1, react-virtualized-auto-sizer 1.0.26, csstype, `@react-spring/{animated,core,rafz,shared,types,web}` 10.1.2 e `@types/d3-*`. `d3-color` 3.1.0 (já com a correção do ReDoS GHSA-36jr-mh4h-2g58). |
| XSS | OK — nomes de unidade (`row.unidade`), situação e tipo chegam ao Nivo **só como texto**: eixos via `format` (string), rótulos via `label`/`pointLabel` (números formatados), tooltips por `TooltipBox` (nós de texto React), legenda e tabela em JSX. As chaves internas do Nivo são `u0..`, `s0..` (nunca texto do backend como chave de dados ou id de `<defs>`); buscas usam `Map`/`typeof === "number"` (sem prototype pollution). Cores vêm só de `chart-theme.ts`. `dashboard-api.ts` valida tipos e tamanhos da resposta. |
| CSP | Nada novo: `csp.ts` não foi alterado; Nivo/react-spring aplicam estilo via CSSOM (`element.style`), sem `<style>` injetado, `eval`, `Function` ou Worker. O único `Function('return this')()` da árvore (`lodash/_root.js:7`) não executa no navegador (ver **I-6**). |
| Animação | OK — `animate={false}` nos 3 componentes Nivo usados em todas as variantes (`nivo-bar-charts.tsx:193,318`, `nivo-pie-chart.tsx:89`, `nivo-line-charts.tsx:146`); react-spring aplica valores imediatos (sem mola). Única transição: `FadeIn` (opacidade, respeita reduced motion). |
| Acessibilidade | OK — `role="img"` com `aria-label` = título + resumo com todos os números (`chart-shell.tsx:162-172`); SVG dentro de wrapper `aria-hidden`; `role="presentation"` + `isFocusable={false}` (bar/line; pie não tem foco por padrão); legenda textual com botões `aria-pressed` como alternativa de teclado ao clique; `<table>` alternativa `sr-only`. Nada se perde ao desligar a a11y interna do Nivo. |
| Menu durante salvamento | OK — estado aberto derivado `requestedOpen && !busy` e fechamento por efeito (`chart-type-menu.tsx:66-69`); clique/Enter/Espaço/setas bloqueados com `aria-disabled` (`:106-118,170-176`); `save` também ignora chamadas com `isPending` (`use-dashboard-chart-prefs.ts:90`). Coberto por e2e (`dashboard-charts-functional.spec.ts:237-290`, não executado nesta revisão). |

## Achados

### Baixos

**L-1 — Chave privilegiada aninhada é auditada com severidade baixa e sem o nome real**
(CVSS 3.1: 0.0 — lacuna de detecção, sem impacto em C/I/A)
- Local: `backend/app/api/v1/schemas.py:369-373` (`parse_body` usa só `err["loc"][0]`).
- Cenário: `PATCH /api/v1/me/preferences` com `{"version":0,"dashboard_charts":{"user_id":"<uuid>"}}`
  (ou `role`, `deleted_at`). A requisição É rejeitada com 400 (sem impacto), mas o evento é
  `MASS_ASSIGNMENT_REJECTED`/LOW com `fields=["dashboard_charts"]`, em vez de
  `PRIVILEGE_ESCALATION_ATTEMPT`/HIGH com `dashboard_charts.user_id`. Alertas de tentativa de
  escalonamento não disparam. Vale para qualquer modelo aninhado futuro.
- Correção sugerida: em `parse_body`, para `extra_forbidden`, montar o caminho completo
  (`".".join(map(str, err["loc"]))`) para a mensagem/evento e classificar como privilegiado se a
  **folha** (`loc[-1]`) estiver em `PRIVILEGED_FIELD_NAMES`. Atenção: `units`/`status` estão nessa
  lista, mas nunca são "extra" em `DashboardChartsPatch`, então não há falso positivo.
- Teste de regressão: `backend/tests/test_sec_preferences.py` — parametrizar `user_id`, `role`,
  `deleted_at`, `auth_user_id` dentro de `dashboard_charts` e afirmar 400 + evento
  `PRIVILEGE_ESCALATION_ATTEMPT` com o campo `dashboard_charts.<campo>`, e zero linhas gravadas.

**L-2 — Cobertura de teste incompleta (XSS por variante de gráfico e dado legado)**
(CVSS 3.1: N/A — lacuna de teste; a análise estática não achou falha)
- Local: `frontend/e2e/dashboard.spec.ts:139-147` cobre o payload `XSS_IMG` só no nome da unidade,
  no tipo padrão (barras agrupadas) e na tabela. Não há teste com payload em **id de situação**
  (pizza/rosca/barras + tooltip), **tipo de bem** (nome de série: legenda/tooltip) e nas variantes
  empilhada/horizontal/linha/área. No backend, não há teste de linha legada com
  `dashboard_charts` inválido (ex.: `{"units":"pie","x":1,"status":"pie"}`).
- Correção sugerida: novo `frontend/e2e/security-dashboard-charts.spec.ts` (para cada tipo de
  painel: payload `<img src=x onerror=window.__xss=1>` em `unidade`, chave de `tipos` e `id` de
  situação; passar o mouse para abrir o tooltip; afirmar `window.__xss === undefined`, 0 `img` no
  `main` e o texto literal visível na legenda/tabela). No backend, um teste em
  `test_sec_preferences.py` que grava JSON legado inválido direto no banco e afirma: o GET devolve
  os padrões resolvidos e o PATCH seguinte grava só chaves válidas.

### Informativos

- **I-1** `preferences_service.py:148-152` — qualquer `IntegrityError` (CHECK de tamanho/objeto, FK
  de usuário removido) vira 409 `version_conflict`. Isso é seguro (não gera 500 nem expõe detalhes),
  mas a mensagem confunde. Hoje não é alcançável. Sugestão: 409 só para `UniqueViolation`
  (SQLSTATE 23505); para o resto, log sem dados e erro genérico.
- **I-2** `backend/app/models/settings.py:89-93` — o modelo ORM não declara os CHECKs
  `ck_user_preferences_dashboard_charts_object/_size`. Os testes em SQLite usam o metadata do ORM e
  não aplicam essas restrições. Sugestão: declarar em `__table_args__` para o modelo bater com o
  banco.
- **I-3** Documentação inconsistente: os cabeçalhos de `0011_user_preferences_dashboard_charts.py:3-4`
  e `sql/0014_…sql:3-4` dizem "NÃO foi aplicada", enquanto `docs/database/historico-migracoes.md:48`
  diz "APLICADA". Corrigir os cabeçalhos.
- **I-4** O lock tem **8 cópias aninhadas** de `@react-spring/web@10.1.2` (em `@nivo/annotations`,
  `arcs`, `axes`, `bar`, `core`, `line`, `text`, `tooltip`) e nenhuma na raiz. Isso pode duplicar o
  módulo no bundle (desempenho, não segurança). Sugestão: `npm dedupe` e conferir o lock e o
  tamanho dos chunks.
- **I-5** As licenças não são todas MIT (ISC, BSD-3-Clause, Unlicense). Todas são permissivas e
  compatíveis, mas exigem preservar avisos (BSD-3). Registrar no SBOM/NOTICE.
- **I-6** `lodash/_root.js:7` contém `Function('return this')()`. Só executa sem `global`/`self`, o
  que não acontece no navegador. Se executasse, a CSP de produção (sem `unsafe-eval`) bloquearia.
  Sem ação.
- **I-7** Um PATCH sem efeito (ex.: `{"units": null}` já no padrão) incrementa `version` e grava
  auditoria. É ruído limitado pelo rate limit (60/h por usuário). Opcional: responder 200 sem
  gravar quando nada mudar.
- **I-8** `preferences-api.ts:85-86` aceita `version` negativo. Isso é inofensivo (o backend rejeita
  com `ge=0`). Opcional: exigir `>= 0`.

## O que NÃO foi verificado

- pytest (inclusive `test_dashboard_charts_preferences.py`), Playwright/axe e
  `scripts/security-audit.sh --strict` **não foram executados**. A conclusão vem de leitura de
  código, de sonda isolada do schema e de análise do lock e do `node_modules`.
- O estado real do Supabase (coluna, CHECKs e dados existentes em `user_preferences`) não foi
  consultado. A aplicação da 0014 foi assumida conforme o coordenador e o histórico.
- Integridade dos tarballs contra o registry: só foram conferidos formato e origem do hash, sem
  novo download/verificação (`npm ci` limpo + `npm audit signatures` pendentes).
- Bundle de produção (`next build`): não foi verificado se aparecem violações de CSP em runtime,
  nem a duplicação de chunks (I-4).
- Os dists `.cjs` do Nivo não foram inspecionados, só os `.mjs` usados pelo Next.
- Teste manual com leitor de tela (NVDA/VoiceOver) e comportamento do tooltip do Nivo em toque.
- Desempenho/Core Web Vitals após a troca de biblioteca.

## Status das correções (2026-10-20)

- **L-1 — CORRIGIDO.** `parse_body` monta o caminho completo do campo extra
  (`dashboard_charts.role`) e `reject_unexpected_fields` classifica como privilegiado
  quando o último segmento está em `PRIVILEGED_FIELD_NAMES` (evento
  `PRIVILEGE_ESCALATION_ATTEMPT`, severidade `high`). Regressão em
  `backend/tests/test_sec_preferences.py`
  (`test_chave_privilegiada_aninhada_e_auditada_como_escalada` com `role`, `unit_id`,
  `is_admin` e `deleted_at`, e `test_chave_comum_aninhada_continua_low`).
- **I-3 — CORRIGIDO.** Os cabeçalhos da 0011 e da 0014 agora dizem "APLICADA".
- **L-2, I-4 — PENDENTES** (por decisão do responsável, depois do deploy): testes de XSS
  por variante/tooltip e de dado legado inválido; `npm dedupe` de `@react-spring/web`.
- I-1, I-2, I-5 a I-8: sem ação neste ciclo.
- Desde então foram executados: pytest completo e Playwright em 4 grupos (resultados em
  `docs/deploy/PRONTIDAO_2026-10-19.md`).
