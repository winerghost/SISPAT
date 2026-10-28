# Revisão QA/AppSec — Onda 4 (classificação patrimonial e painéis do dashboard, 2026-10-27)

Resumo documental da Onda 4. Escopo: as Ondas 1-3 (catálogo de 12 painéis,
`PUT /dashboard/preferences`, dados dos painéis, fila de revisão, override de categoria,
exportações, tela de personalização e `/dashboard/classificacao`). Contrato:
`docs/architecture/dashboard-api.md`; regras: `docs/architecture/classificacao-patrimonial.md`.

## Parecer

Os resultados abaixo foram informados pelo responsável pela rodada e conferidos apenas
quanto à existência dos arquivos de teste citados; esta redação não reexecutou a suíte.
Não afirma ausência de vulnerabilidades. **Ressalvas centrais: nada foi validado em
PostgreSQL real nem em Python 3.11+.**

## Testes novos da Onda 4

- `backend/tests/test_qa_onda4_equipment.py` (22 funções de teste): gravação REAL em
  `audit_logs` para mass assignment e acessos negados; mesma resposta e mesmo evento para ID
  alheio, inexistente, excluído e painel proibido; override (vocabulário fechado, versão
  estrita, repetição idempotente); `csv_safety` com `-`, TAB e CR em CSV e XLSX (inclusive
  no nº patrimonial); nenhum dado pessoal em respostas e auditorias de exportação (inclusive
  RH); ADM sem AAL2 negado em toda rota administrativa nova.
- `backend/tests/test_qa_onda4_preferences.py` (14 funções de teste): `PUT
  /dashboard/preferences` com política READ + `reports.read`; alvo sempre o `sub` do JWT;
  painel proibido nunca habilitado (nem por `restore_default`, ids repetidos ou
  desconhecidos); versão otimista; negação gravada de fato em `audit_logs`.
- `frontend/e2e/dashboard-qa-onda4-functional.spec.ts`: axe (WCAG 2.2 AA) em 320/768/1920 px
  para o dashboard (ADM/USER/RH) e para `/dashboard/classificacao` (inclui o diálogo de
  confirmação), ausência de rolagem horizontal, `prefers-reduced-motion`, nada em
  `localStorage`/`sessionStorage` e nenhum texto do servidor na tela. Usa contrato MOCKADO
  (`frontend/e2e/dashboard-equipment-support.ts`); nenhuma chamada sai da máquina.

## Resultados reais informados

| Verificação | Resultado |
|---|---|
| Backend `pytest` (suíte completa), Python 3.10, SQLite | **14344 passed, 64 skipped, 4 xfailed, 0 failed**; +90 testes novos na Onda 4 |
| Playwright (`E2E_WORKERS=1`) | 48 passed (`dashboard-equipment-functional` + `dashboard-layout-functional`), 15 passed (spec novo da Onda 4), 26 passed (`dashboard.spec.ts`); relato do agente de QA |
| `scripts/security-audit.sh` | **gitleaks e trivy NÃO EXECUTADOS** (binários ausentes); `pip-audit` **inconclusivo** (a suíte rodou em Python 3.10; a imagem do backend usa Python 3.12, `backend/Dockerfile`) |

Não verificado: PostgreSQL (CHECKs, índice `ix_assets_equipment_active`, `FOR UPDATE`,
`jsonb` da `user_dashboard_preferences`, comportamento de `COALESCE`/`nulls_last` reais),
Python 3.11+, carga/volume, varredura de segredos (gitleaks) e de imagem/FS (trivy).

## Achados QA4-01 a QA4-06

Fonte do texto: relatório do agente de QA da Onda 4 (QA4-01, 02, 05 e 06) e conferência
no código (QA4-03 e QA4-04).

| ID | Achado | Severidade/status |
|---|---|---|
| QA4-01 | Em `PUT /dashboard/preferences`, painel inexistente dá 400 e painel do catálogo proibido ao perfil dá 403 `panel_forbidden`; as rotas de dados e exportação dão 404 idêntico. Quem testa ids distingue o que existe no catálogo e é só-ADM. Código: `dashboard_schemas.py:328-333`, `dashboard_panels_service.py:514-526` | BAIXA (informativo), aberto; opcional unificar a resposta mantendo o evento de auditoria |
| QA4-02 | Em `PUT /dashboard/preferences`, o conflito de versão (`dashboard_panels_service.py:476-477`) é checado antes do painel proibido (`:514`): painel proibido com `version` errada devolve 409 sem gravar `DASHBOARD_PANEL_FORBIDDEN`; repetido com a versão certa, é auditado | BAIXA (informativo), aberto; opcional validar os painéis antes da versão |
| QA4-03 | O painel `sync_status` é GLOBAL: `ultima_importacao` e `ultimo_job` não são filtrados por escopo de unidade nem pelos filtros do painel (só `conflitos_pendentes` respeita o escopo). Código: `sync_status` em `backend/app/services/dashboard_equipment_service.py` | ABERTO, registrado como limitação aceita (painel só ADM; apenas contagens e datas, nenhum registro de bem); decisão de manter ou escopar fica com o responsável |
| QA4-04 | Não existe remoção de override: só há `POST /assets/<id>/category-override`; não há rota para voltar à classificação por regra | ABERTO, lacuna de produto; contornável apenas por novo override ou SQL manual |
| QA4-05 | O sync de bens EXISTENTES agora sobrescreve `unit_id`, `owner_unit_id`, sala, responsável, localizado e data de registro vindos da planilha (`import_service.py:416-442`, `:540-562`, commit 13287da). A auditoria é só a do job (`:1191-1210`), sem valor anterior por bem; mudar `unit_id` altera o escopo de USER/RH sem aviso. Não afeta classificação nem idempotência (override preservado) | BAIXA a MÉDIA (governança, fora da classificação), aberto; avaliar auditoria por bem (anterior/novo) |
| QA4-06 | `record_security_event` envia a uma fila em segundo plano e descarta o evento (só loga) se a fila estiver cheia (`security_events.py:211-225`): eventos de mass assignment e negação são best effort, ao contrário dos eventos de serviço (override, `DASHBOARD_PANEL_FORBIDDEN`, exportação), gravados na mesma transação | Informativo, aceito pelo desenho; monitorar a fila |

## Política confirmada no código (referência)

- `PUT /dashboard/preferences` usa a política READ (`reports.read`, 60 gravações/h)
  porque só altera a preferência do próprio usuário; ver a justificativa em
  `docs/architecture/dashboard-api.md`.
- Painel inexistente, malformado ou proibido ao perfil devolve a MESMA 404 `not_found`
  (`authorize_panel` + evento `ACCESS_DENIED`); painel proibido na gravação de
  preferências devolve 403 `panel_forbidden` com `DASHBOARD_PANEL_FORBIDDEN` na mesma
  transação.
- Override e fila de revisão: `require_auth -> require_role(ADM) -> require_aal2 ->
  permissão`; escopo de unidade via `asset_scope_clause`; ID alheio == inexistente == excluído.
- Exportações: `app.security.csv_safety`; auditoria com formato, nº de linhas e NOMES dos
  filtros (nunca valores).

## Recomendações

1. Reexecutar a suíte em PostgreSQL real e em Python 3.11+ antes do próximo deploy.
2. Rodar `scripts/security-audit.sh` com gitleaks e trivy instalados e resolver o status
   do pip-audit no interpretador correto.
3. Decidir QA4-03 (escopar ou aceitar) e QA4-04 (rota de remoção de override auditada, ADM +
   AAL2, com `version`).
4. Decidir QA4-05 (auditoria por bem no sync).
5. Resolver a decisão de backfill (`docs/architecture/classificacao-patrimonial.md`) antes de
   importar Bens.
