# Revisão de autorização (AppSec) — 2026-10-19

Escopo: revisão estática, somente leitura (nenhum teste, suíte ou `security-audit.sh` executado; nenhuma execução dinâmica). Código de produção não alterado. Este parecer NÃO afirma ausência de vulnerabilidades; cobre só os arquivos listados.

Arquivos lidos: `services/invite_service.py`, `api/v1/users.py`, `api/v1/catalog_http.py`, `api/v1/schemas.py`, `api/v1/admin_access.py`, `api/v1/admin_schemas.py`, `services/admin_access_service.py`, `services/admin_audit_service.py`, `services/asset_service.py` (history), `api/v1/assets.py`, `config/settings.py`, `errors.py` (handlers).

## Parecer: APROVADO COM RESSALVAS (nenhum achado Crítico/Alto)

## Controles confirmados
- `/admin/roles`, `/admin/permissions`, `/admin/unit-access`: cadeia `require_auth -> require_role("ADM") -> require_aal2 -> require_permission -> rate_limit`; `NoQuery`/`UnitAccessQuery` com `extra="forbid"` e enums fechados; 400 auditado para parâmetro desconhecido/repetido. Consultas por coluna (sem e-mail/telefone/auth_user_id). Contagens e vínculos limitados às unidades do ator; `unit_id` alheio e inexistente retornam o mesmo vazio.
- `POST /users/invite`: ADM+AAL2+`users.invite`; papel ADM recusado e auditado como escalonamento; `units_outside_scope` com 403 igual para inexistente/alheia; `activate-invite` rejeita corpo (mass assignment auditado); papel/unidades só do convite; validação defensiva de `intended_role_code` na ativação; advisory lock anti-reuso.
- `POST /users/<id>/revoke`: escopo de unidade com 404 idêntico para inexistente/alheio (inclui convite pendente), autorrevogação e último ADM bloqueados, lock anti-TOCTOU.
- `asset history`: `_load` aplica escopo; `include_deleted` negado a não-ADM; RH não recebe `reason` (SEC-REV-03) nem `actor_user_id`; `notes` só entra como nome de campo na trilha.
- `safe_scalar`: CPF-like redigido (SEC-REV-04); strings com espaço, `@` ou longas viram `[redacted]`.
- `reject_unexpected_fields`: neutraliza CR/LF e controles Unicode (SEC-REV-02), trunca nomes, evento HIGH para campos privilegiados.
- `settings.py:529-536`: CORS e `INVITE_ALLOWED_REDIRECT_URLS` só https em produção, falha no startup; `invite_service.py:297-304` repete a checagem em profundidade.

## Achados

### M-1 (Médio, CVSS 3.1 ~5.3 AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L) — SEC-REV-01 corrigido só no catálogo
`read_body` (`catalog_http.py:85-87`) trata `RecursionError`, mas as demais rotas ainda usam `request.get_json(silent=True)` direto: `users.py:239, 328, 443, 568, 603, 634`, `user_admin_http.py:119`, `me.py:114`, `imports.py:220`, `ai.py:114`, `ai_settings.py:88,111`, `email_settings.py:59`. `silent=True` não captura `RecursionError`; JSON profundamente aninhado (cabe em 1 MiB) vira 500 pelo `handle_unexpected_exception` (`errors.py:170`): sem vazamento de conteúdo, mas sem 400 e sem auditoria, e custo de CPU por requisição. Exige autenticação (a maioria ADM+AAL2), por isso Médio.
Correção: mover o helper seguro (`safe_get_json`) para `app/api/v1/schemas.py` e usá-lo em todas as rotas; ou registrar handler de `RecursionError` -> 400 padronizado.
Teste: estender `tests/test_sec_catalog_api_review.py` com corpo `"["*50000` contra `/users/invite`, `/users/<id>/revoke`, `/me/preferences`, `/imports/confirm` esperando 400.

### B-1 (Baixo, ~4.3 AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N) — Revogação remove vínculos fora do escopo do ator
`invite_service.py:661-663` apaga TODOS os `UserUnitAccess` e `:654-655` TODOS os `UserRole` do alvo, e `:681-688` desativa a conta globalmente. `users.py:468` só exige UMA unidade em comum. Um ADM de unidade A pode, portanto, retirar o acesso do usuário a unidades B/C que ele não administra (efeito além do escopo).
Correção: decisão de produto. Ou restringir a revogação às unidades do ator (e só desativar a conta se não restarem vínculos), ou exigir cobertura de TODAS as unidades do alvo, ou documentar como regra.
Teste: ADM(A) revoga usuário (A,B); verificar o comportamento escolhido para B.

### B-2 (Baixo, ~3.1) — Oráculo de existência de convite/e-mail entre unidades
`invite_service.py:274-285` + `users.py:294-295`: o 409 ecoa o e-mail e é global (não escopado por unidade). Um ADM pode sondar se existe convite pendente para e-mail de outra unidade. Também o 400 de unidade inexistente/inativa (`:260-271`) distingue "inexistente" de "inativa" para IDs que passaram do `units_outside_scope` (já escopadas, sem vazamento relevante).
Correção: 409 com mensagem genérica sem e-mail; opcionalmente escopar a checagem pelas unidades do ator.

### B-3 (Baixo, ~3.1) — `safe_scalar` deixa passar inteiros e identificadores sem formato de CPF
`admin_audit_service.py:124-125`: `int` passa sem filtro (um CPF/matrícula gravado como inteiro em `details` apareceria). `safe_token` aceita matrículas alfanuméricas curtas. As chaves exibidas são allowlist (`CHANGE_KEYS`, `SECURITY_DETAIL_KEYS`), mitigando.
Correção: manter allowlist estrita de chaves; considerar redigir inteiros com 11 dígitos; teste de regressão com `{"x": 12345678901}` em chaves permitidas.

### B-4 (Baixo/Informativo) — PII em `audit_logs`
`invite_service.py:407-411` grava o e-mail completo do convidado em `new_values`, e `:697-698` grava `reason` em texto livre. A projeção em `admin_audit_service` oculta ambos (fora da allowlist), mas o dado em repouso contém PII; alinhar à política LGPD/retenção. Sem segredo ou token gravado (confirmado).

### I-1 (Informativo)
Fail-closed em `activate_invite_endpoint` (`users.py:306`) usa só `require_auth`, por desenho (documentado); o limite de 10/h cobre abuso. Sem achado.

## Regressões SEC-REV-01..04
- 01: parcial (ver M-1).
- 02: OK (`schemas.py:309`).
- 03: OK (`asset_service.py:408-412`, aplicado a `previous_values` e `new_values`).
- 04: OK para strings no formato de CPF (ver B-3 para inteiros).

## Pendências / não verificado
Nenhuma execução (pytest, Playwright, `security-audit.sh`); sem confirmação dinâmica dos achados, nem de `rbac.require_aal2`/`require_permission` internamente (assumidos corretos), nem do RLS no banco.

## Correções
- **M-1 (tratado):** novo helper único `get_json_body()` em `backend/app/api/v1/schemas.py` captura `RecursionError` e devolve `[]` (não nulo, não objeto, `!= {}`), que toda rota já rejeita com o 400 de corpo inválido existente (contratos inalterados). Adotado por `catalog_http.read_body`, `users.py` (invite, activate-invite, revoke, update, deactivate, activate), `user_admin_http.reject_any_body`, `me.py`, `imports.py`, `ai.py`, `ai_settings.py` e `email_settings.py`. Também `rbac.py` (fonte `json` do escopo de unidade) trata `RecursionError`. Testes: `backend/tests/test_sec_json_depth.py`.
- **B-3 (tratado):** `safe_scalar` (`admin_audit_service.py`) redige inteiros de 11 dígitos (CPF sem máscara), positivos ou negativos. Teste em `test_sec_json_depth.py`. Limitação: CPF com zeros à esquerda armazenado como int teria menos de 11 dígitos e não é redigido.
- Execução: suíte completa NÃO rodada; apenas os arquivos de teste das rotas tocadas (ver relatório do coordenador).
