# Revisão QA — Onda C: painel `located_by_unit_chart` e `/records` (2026-10-29)

Escopo: gráfico de barras de bens localizados/não localizados por unidade
(`GET /dashboard/panels/located_by_unit_chart/data`) e a lista de registros do clique
(`GET /dashboard/panels/located_by_unit_chart/records`). Perfis com acesso: ADM, USER e RH,
sem dado pessoal para nenhum. Fonte: relatório do agente de QA; a QA não alterou código de
produção. Contratos em `docs/architecture/dashboard-api.md`.

## Resultados informados pela QA

| Verificação | Resultado |
|---|---|
| pytest dos 2 arquivos novos (`test_dashboard_located_qa.py`, `test_dashboard_located_prefs.py`) | 161 passed, 0 failed |
| Suíte completa do backend (`scripts/test-backend.sh -- --no-cov -q`, Python 3.10, SQLite) | 15003 testes, 0 failures, 0 errors, 69 skipped; rodou antes de edições triviais nos 2 arquivos novos, depois reexecutados à parte |
| Playwright `e2e/dashboard` (`E2E_WORKERS=1`) | 185 passed; specs `dashboard-located-functional` 25 passed e `dashboard-located-qa-functional` 19 passed isolados |
| `scripts/security-audit.sh` | bandit, semgrep, `npm audit` de produção e compose OK; gitleaks e trivy NÃO EXECUTADOS (binários ausentes); pip-audit do lock sem vulnerabilidades, o de `requirements-dev.txt` não verificado (Python 3.10; `pillow==13.0.0` exige 3.11+) |

Cobertura: IDOR multiunidade (inclui `outras` = complemento exato do top 15 dentro do
escopo), ausência de PII em respostas, `audit_logs` e eventos, 36 consultas hostis com 400
sem eco, AAL2 e métodos, corretude numérica e paginação estável, nº de queries constante
(9 a 15 com 8, 1.068 e 18.000 bens), preferências (ADM 13, USER 10, RH 8), frontend (sem
storage/`dangerouslySetInnerHTML`/`eval`, axe WCAG 2.2 AA e sem rolagem horizontal em
320/768/1920, foco preso, reduced-motion).

## Achados

| ID | Sev. | Achado | Status |
|---|---|---|---|
| I-1 | Baixa/Info | Escopo por `owner_unit_id`: bem da unidade B cuja dona é A aparece para o USER de A como barra "UB", e a lista do clique concorda. É a regra canônica de `/assets` (`asset_scope_clause`) | Confirmar se é o comportamento desejado |
| I-2 | Info | `located` NULL ou fora do enum conta como DESCONHECIDO no gráfico (`dashboard_equipment_service.py:248`), mas o clique filtra `== "DESCONHECIDO"` (`dashboard_located_service.py:74`). Inalcançável hoje: a coluna é NOT NULL com enum (`models/assets.py:215`) | Sem ação; rever se a coluna virar nullable |
| I-3 | Info | `page_size=50.0`, `1e2`, `+50` são aceitos por coerção do pydantic, só se caírem na allowlist | Sem ação |
| I-4 | Info | Em `/data`, query inválida em painel proibido ou inexistente dá 400 (o mesmo nos dois casos, sem oráculo); em `/records` o 404 vem primeiro | Sem ação |
| I-5 | Info | O `path` do evento de segurança registra o painel pedido (truncado); fica só no log | Sem ação |
| P-1 | Pré-existente | `assets-edit-redesign-functional.spec.ts:447`: axe `color-contrast` no detalhe do bem a 320px, falhou 3 de 3 isolado | Ver abaixo |

### P-1
A QA concluiu que é anterior à demanda por inalteração do código: a tela de bens e o spec
estão inalterados desde o commit 0343c84 (`git status` e `git log`, somente leitura). Não foi
reproduzido no HEAD (exigiria checkout) nem identificado o elemento exato do contraste.
Esse mesmo teste já havia falhado de forma intermitente na correção da Onda 3. Tratar em
demanda própria.

## Não verificado
PostgreSQL real (índices, `NOT NULL`/enum) e Python 3.11+; gitleaks e trivy; pip-audit de
`requirements-dev.txt`; suíte e2e completa depois da QA (a última completa, 3158 testes,
fechou com 5 falhas: 4 intermitentes que passaram isoladas e P-1).

## Bloqueios de deploy
Nenhum no painel nem em `/records`. Pendências fora dele: P-1, gitleaks/trivy e o pip-audit
em Python >= 3.11.
