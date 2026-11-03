# Módulo de Configurações — contrato da API

Fonte de verdade compartilhada entre backend e frontend. Erros seguem o formato
padrão `{"error": {"code": "...", "message": "..."}}` de `backend/app/errors.py`.
(O plano original está num arquivo LOCAL fora do repositório, em
`~/.claude/plans/`; não é referência verificável por quem lê este documento.)

Rotas, schemas e permissões reconferidos contra o código em 2026-10-29
(`backend/app/api/v1/{ai_settings,email_settings,users,me,security,dashboard,ai}.py`,
`schemas.py`, `user_admin_http.py`, `app/services/{user_admin_service,
user_deletion_service,preferences_service,invite_service,invite_delivery,
password_reset_delivery}.py`). Nessa data: `alembic_version` de produção =
`0019_user_soft_delete` (head, cadeia linear 0001→0019) e a permissão
`users.delete` está semeada e vinculada SOMENTE ao perfil ADM (consulta somente
leitura). As telas correspondentes existem em `/administracao/usuarios`,
`/administracao/perfis-permissoes` (consulta), `/administracao/vinculos-unidades`,
`/administracao/auditoria`, `/administracao/integracoes`,
`/administracao/configuracoes-sistema` e `/configuracoes/{perfil,seguranca,
aparencia,inteligencia-artificial}`.

## Etapa 1 — Inteligência Artificial

Todas as rotas: `require_auth → require_role("ADM") → require_aal2 → require_permission → rate_limit`.
USER/RH → 403; ADM sem AAL2 → 403 `AAL2_REQUIRED`. Todos negados e auditados.

### `GET /api/v1/settings/ai` (permissão `settings.ai.manage`)

```json
{
  "status": "disabled",
  "env_enabled": false,
  "enabled": false,
  "provider": "none",
  "model": null,
  "features": {
    "alerts_explain": false,
    "executive_summary": false,
    "assistant": false,
    "data_quality": false
  },
  "monthly_token_cap": 200000,
  "deepseek_acknowledged": false,
  "keys": {
    "openai": "not_configured",
    "anthropic": "not_configured",
    "deepseek": "not_configured"
  },
  "models": {
    "openai": ["..."],
    "anthropic": ["..."],
    "deepseek": ["..."]
  },
  "version": 1,
  "updated_at": "2026-10-14T15:00:00Z"
}
```

- `updated_at`: ISO 8601 UTC, ou `null` se a configuração nunca foi gravada.

- `status`: `"active"` (env ligado + banco ligado + provedor com chave + circuito fechado),
  `"disabled"` (desligado no env ou no banco), `"unavailable"` (ligado, mas sem chave,
  circuito aberto ou cota esgotada). A UI nunca recebe a razão técnica detalhada.
- `keys.*`: somente `"configured"` | `"not_configured"`. A chave NUNCA é retornada.
- `provider`: `"none" | "openai" | "anthropic" | "deepseek"`.
- `models`: allowlist do backend por provedor; a UI só oferece esses valores.

### `PATCH /api/v1/settings/ai` (permissão `settings.ai.manage`)

Corpo (`extra="forbid"`; todos opcionais exceto `version`):

```json
{
  "version": 1,
  "enabled": true,
  "provider": "anthropic",
  "model": "<valor da allowlist>",
  "features": {"assistant": true},
  "monthly_token_cap": 200000,
  "acknowledge_international_transfer": true
}
```

- Resposta 200: mesmo corpo do GET, com `version` incrementado.
- 409 `version_conflict`: `version` desatualizado.
- 400 `invalid_model`: modelo fora da allowlist do provedor.
- 400 `deepseek_ack_required`: `provider="deepseek"` sem
  `acknowledge_international_transfer: true` (o aceite é gravado com data e ADM, e auditado).
- 400 `validation_error`: campo desconhecido, como `api_key` ou `updated_by`.
  Gera o evento `MASS_ASSIGNMENT_REJECTED` ou `PRIVILEGE_ESCALATION_ATTEMPT`.
- `features` aceita só as 4 chaves acima. `monthly_token_cap` fica entre 0 e 50.000.000.

### `POST /api/v1/settings/ai/test` (permissão `settings.ai.manage`, 5/h por ADM)

Sem corpo. Envia um prompt fixo, sem nenhum dado do sistema.

```json
{"result": "ok", "latency_ms": 840}
```

- `result`: `"ok" | "disabled" | "not_configured" | "unavailable"`.
- Sempre responde 200, mesmo quando o provedor falha. Nunca expõe a mensagem de erro do provedor.

### Notas de implementação (backend, Etapa 1)

- Código: `backend/app/api/v1/ai_settings.py` (rotas finas) e
  `backend/app/services/ai_settings_service.py` (regras); testes em
  `backend/tests/test_ai_settings_api.py`.
- Rate limit por ADM (fail-closed): GET 300/h, PATCH 30/h, `/test` 5/h.
- Troca de `provider` sem `model`: mantém o modelo atual se estiver na allowlist do novo
  provedor; senão usa o padrão do provedor (primeiro da allowlist). `provider="none"` zera o
  modelo; `model` enviado com `provider="none"` → 400 `invalid_model`.
- `null` explícito em qualquer campo do PATCH → 400 `validation_error` (omitir = manter).
- Linha `ai_settings` ausente (banco sem seed): GET devolve o padrão desligado com
  `version: 1` e `updated_at: null`; o PATCH com `version: 1` cria a linha.
- Concorrência: `SELECT ... FOR UPDATE` + comparação de `version`; 409 `version_conflict`.
- Auditoria: `AI_SETTINGS_UPDATED` (previous/new, só campos de config) e, no primeiro aceite,
  `AI_DEEPSEEK_ACKNOWLEDGED`, na mesma transação.

## Etapa 2 — Gestão de usuários

Rotas administrativas: `require_auth → require_role("ADM") → require_aal2 → require_permission(...) → rate_limit`.
**Escopo:** o ADM só enxerga e altera usuários com ao menos uma unidade no seu escopo
(`user_unit_access`) ou sem nenhuma unidade (convites pendentes). Alvo fora do escopo,
inexistente ou com ID malformado → **mesmo 404 `not_found`**, com o mesmo número de consultas.
Todo `version` é o `users.version` atual; divergência → 409 `version_conflict`.

### Objeto `UserSummary`

```json
{
  "id": "uuid",
  "name": "…",
  "email": "…",
  "active": true,
  "role": "ADM",
  "units": [{"id": "uuid", "code": "…", "name": "…"}],
  "has_avatar": false,
  "created_at": "ISO UTC",
  "last_login_at": null,
  "deactivated_at": null,
  "version": 3
}
```

- `role`: `"ADM" | "USER" | "RH" | null`. `null` significa sem perfil, ou seja, acesso revogado.
- `last_login_at` e `deactivated_at`: ISO UTC ou `null`.
- **`last_login_at` — quem grava, quando e com qual semântica.** Quem grava é
  `require_auth` (`backend/app/auth/supabase_auth.py` →
  `backend/app/services/login_tracking_service.py`), **uma vez por sessão** e só
  depois de todas as negações (excluído, inativo, sessão revogada). O instante é o
  do **primeiro fator de autenticação da sessão** (`min` dos `timestamp` do claim
  `amr` do JWT), estável entre refreshes do access token; sem `amr` utilizável, cai
  em `now()` com janela mínima de 15 min. É **último LOGIN, não última atividade**:
  navegar pelo sistema na mesma sessão não move o valor. Gravar é melhor-esforço —
  falhar nunca derruba a autenticação. Cada gravação efetiva também insere uma
  linha `LOGIN` em `audit_logs` (`entity_type='auth'`, `result='SUCESSO'`,
  `new_values={"aal": ...}`), na mesma transação; ver
  [`estrategia-auditoria.md`](./estrategia-auditoria.md), seção 2.2.1.
  `null` significa **nenhum login registrado desde 2026-10-29** (data em que a
  gravação passou a existir) — a tela mostra "Nunca". Não houve backfill a partir
  do Supabase Auth: o motivo está na seção 2.2.2 do mesmo documento. Sem migração:
  a coluna `users.last_login_at` já existia na `0001`; a anonimização de conta
  (`user_deletion_service`) zera o valor.

### `GET /api/v1/users` (`users.manage`)

Parâmetros de consulta (allowlist; parâmetro desconhecido → 400 `validation_error`):

| Parâmetro | Regra |
|---|---|
| `q` | Nome ou e-mail, até 100 caracteres, busca por trecho |
| `role` | `ADM`, `USER` ou `RH` |
| `unit_id` | UUID |
| `active` | `true` ou `false` |
| `sort` | `name`, `-name`, `email`, `-email`, `created_at`, `-created_at`, `last_login_at` ou `-last_login_at` (padrão `name`) |
| `page` | ≥ 1 |
| `page_size` | 50, 100 ou 200, padrão 50 |

Resposta: `{"total": 0, "page": 1, "page_size": 50,
  "pages": 0, "users": [UserSummary]}`.

### `GET /api/v1/users/<uuid>` (`users.manage`)

Retorna um `UserSummary`.

### `GET /api/v1/units` (ADM + AAL2, `users.manage`)

Retorna as unidades do escopo do ADM, usadas no seletor de vínculos:
`{"units": [{"id", "code", "name"}]}`.

### `PATCH /api/v1/users/<uuid>` (`users.assign_role` e/ou `users.assign_unit`)

Corpo (`extra="forbid"`):

```json
{"version": 3, "role": "USER", "unit_ids": ["uuid"], "confirm_privilege_change": true}
```

- Resposta 200: `UserSummary` com `version` novo.
- Promover a ADM ou rebaixar um ADM sem `confirm_privilege_change: true` → 400 `confirmation_required`.
- O ADM alterando o próprio perfil → 409 `self_change_forbidden`.
- Remover o último ADM ativo → 409 `last_admin`.
- `unit_ids` fora do escopo do ADM → 403 `unit_out_of_scope`. `unit_ids` tem de 1 a 50 itens.
- Auditoria: `USER_ROLE_CHANGED` e/ou `USER_UNITS_CHANGED` (previous/new). Mudança de privilégio também gera evento HIGH.

### Ações de conta (corpo `{"version": n}`, salvo indicação)

| Rota | Permissão | Efeito / erros |
|---|---|---|
| `POST /users/<uuid>/deactivate` (corpo pode ter `reason` ≤ 1000) | `users.deactivate` | `active=false`, `deactivated_at/by`, ban no Supabase, `sessions_revoked_at=now`. 409 `self_change_forbidden`, `last_admin`. → `UserSummary` |
| `POST /users/<uuid>/activate` | `users.activate` | `active=true`, unban no Supabase. → `UserSummary` |
| `POST /users/<uuid>/revoke-sessions` (sem `version`) | `users.revoke_sessions` | `sessions_revoked_at=now`. → `{"sessions_revoked_at": "ISO"}` |
| `POST /users/<uuid>/password-reset` (sem corpo) | `users.reset_password` | E-mail de recuperação via Supabase (`redirect_to` da allowlist). → `{"result": "sent" \| "unavailable"}`. O ADM nunca vê link nem senha. Limite de 5/h por alvo |
| `POST /users/<uuid>/mfa-reset` (sem corpo) | `users.reset_mfa` | Exige **reautenticação**: a sessão do ADM precisa ter verificado TOTP há ≤ 5 min (claim `amr`), senão 403 `REAUTH_REQUIRED`. Remove todos os fatores do alvo. → `{"removed_factors": n}`. Evento HIGH. Não se aplica a si mesmo (409 `self_change_forbidden`) |
| `POST /users/<uuid>/revoke` (rota existente) | `users.revoke_access` | Mantida por compatibilidade: agora também desativa e encerra sessões |
| `POST /users/<uuid>/delete` (corpo `{"version", "confirm_text"}`) | `users.delete` | Exclusão LÓGICA + anonimização irreversível: `deleted_at/by`, `anonymized_at`, `active=false`, `sessions_revoked_at=now`, papéis/unidades removidos, convite PENDENTE → REVOGADO, foto apagada do bucket e identidade APAGADA no Supabase Auth (libera o e-mail para reconvite). `audit_logs` preservado (`actor_user_id` intacto). `confirm_text` = e-mail exato do alvo. 400 `confirmation_mismatch`, 409 `self_change_forbidden`/`version_conflict`/`last_admin`, 404 idêntico para inexistente/alheio/já excluído. Limite 5/h por ADM e 3/h por alvo. Evento HIGH `USER_DELETED`. → `UserSummary` anonimizado + `deleted_at` |

**Sessões revogadas:** `require_auth` rejeita com 401 todo JWT cujo `iat` seja anterior a
`users.sessions_revoked_at`.

### Migração da exclusão lógica de usuário — `0019_user_soft_delete`

Registro exigido pelo projeto para toda migração (conferido no arquivo
`backend/migrations/versions/0019_user_soft_delete.py` em 2026-10-29):

- **O que cria** (aditiva e idempotente, sem backfill — tudo nasce `NULL`): em
  `public.users`, as colunas `deleted_at timestamptz NULL`,
  `deleted_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL` e
  `anonymized_at timestamptz NULL`; o CHECK
  `ck_users_deleted_requires_anonymized` (`deleted_at IS NULL OR anonymized_at
  IS NOT NULL`); e a permissão `users.delete`, vinculada SOMENTE ao perfil ADM
  (confirmado por consulta somente leitura em 2026-10-29). Nenhuma constraint de
  unicidade é alterada: `users.email` segue `NOT NULL UNIQUE`, e a anonimização
  grava um endereço único não roteável derivado do `id` (domínio `.invalid`,
  RFC 2606), o que LIBERA o e-mail original para um convite futuro.
- **Espelho `.sql`:** `backend/migrations/sql/0022_user_soft_delete.sql` (a
  numeração do espelho é deslocada em +3 em relação à revisão Alembic desde o
  início do projeto; a correspondência é verificada por
  `backend/tests/test_db_static.py`).
- **Rollback:** `alembic downgrade 0018_equipment_classification` (ou o
  `DOWNGRADE_SQL` do próprio arquivo, no SQL Editor). Remove apenas a permissão,
  o CHECK e as três colunas; `audit_logs` e as demais colunas de `users` ficam
  intactos. A anonimização já executada **não é reversível** — só se perde a
  marcação de quem foi excluído.
- **Backup antes de aplicar ou reverter:**
  `pg_dump "$DATABASE_URL" --no-owner --no-privileges -t public.users -t public.permissions -t public.role_permissions -f backup_pre_0019.sql`
  (ou o dump completo, conforme o roteiro de `docs/deploy/`). Nunca aplicar nem
  reverter em produção sem autorização explícita.
- **Ordem de implantação (obrigatória):** o DDL vem ANTES da imagem nova do
  backend. `app.models.rbac.User` declara as três colunas e a consulta de
  autenticação as seleciona; sem elas no banco, TODA requisição autenticada
  falharia.
- **Por que a exclusão é lógica, com garantia do banco:** quatro FKs `RESTRICT`
  apontam para `users.id` (`asset_movements.requested_by`,
  `import_previews.requested_by`, `inventories.created_by`,
  `invites.invited_by`) e `audit_logs.actor_user_id` é `ON DELETE SET NULL`, mas
  o gatilho `trg_audit_logs_block_update_delete` (da `0004`) RECUSA esse
  `UPDATE`. Por isso a linha de `users` precisa continuar existindo: é o que
  mantém a trilha append-only íntegra, com `actor_user_id` preservado.

### Histórico: `GET /api/v1/users/<uuid>/audit?page=&page_size=` (`audit.read`)

```json
{
  "total": 0,
  "page": 1,
  "page_size": 50,
  "pages": 0,
  "events": [
    {
      "id": "uuid",
      "occurred_at": "ISO",
      "operation": "USER_ROLE_CHANGED",
      "result": "SUCESSO",
      "actor": {"id": "uuid", "name": "…"},
      "changes": {"role": {"from": "USER", "to": "ADM"}}
    }
  ]
}
```

- Inclui eventos em que o usuário é alvo (`entity_id`) ou autor (`actor_user_id`).
- `actor` pode ser `null`.
- `changes` só traz chaves da allowlist: `role`, `units`, `active`, `avatar`, `sessions_revoked_at`. Nunca segredos ou tokens.

### Foto de perfil

| Rota | Quem |
|---|---|
| `PUT /api/v1/users/<uuid>/avatar` / `DELETE` | ADM + AAL2 + `users.avatar.manage` |
| `GET /api/v1/users/<uuid>/avatar-url` | ADM + AAL2 + `users.manage` |
| `PUT /api/v1/me/avatar` / `DELETE` / `GET /api/v1/me/avatar-url` | o próprio usuário autenticado |

- `PUT`: `multipart/form-data` com o campo `file`, até 2 MiB. Formatos JPEG, PNG ou WebP, validados pelos bytes iniciais; extensão e Content-Type não são confiáveis.
  - Lado ≤ 4096 px e total ≤ 16 MP.
  - A imagem é recodificada para WebP 512×512, sem EXIF/ICC, com nome aleatório.
  - Resposta: `{"has_avatar": true}`.
- Erros do `PUT`: 413 `file_too_large` e 400 `unsupported_image`.
- `GET avatar-url`: `{"url": "<URL assinada>", "expires_in": 300}`, ou 404 `not_found` quando não há foto.
- Armazenamento no bucket **privado** `avatars` do Supabase Storage. Sem bucket ou com o Storage fora do ar → 503 `storage_unavailable`; o resto do sistema segue funcionando. Se o bucket já existe em produção é **a confirmar** (a verificação de 2026-10-29 cobriu tabelas, colunas, índices e permissões do banco, não o Storage).
- `GET /api/v1/me` passa a incluir `"has_avatar": bool`, para o header decidir se pede `GET /api/v1/me/avatar-url`. A URL nunca vem no `/me`.

### `GET /api/v1/me` (qualquer usuário autenticado, só `require_auth`)

Única fonte de verdade do frontend sobre a identidade da sessão atual
(`backend/app/api/v1/me.py`):

```json
{
  "id": "uuid",
  "name": "…",
  "email": "…",
  "roles": ["ADM"],
  "permissions": ["assets.read", "…"],
  "current_aal": "aal2",
  "mfa_required": true,
  "has_avatar": false,
  "last_login_at": "ISO UTC ou null"
}
```

- `current_aal`: `"aal1" | "aal2"` da sessão atual (claim `aal`; qualquer valor
  inesperado é tratado como `aal1`).
- `mfa_required`: **dica de roteamento**, nunca autorização — é `true` sempre que
  `ADM` estiver em `roles`, mesmo com a sessão já em `aal2`. A autorização real é
  `require_aal2` no backend.
- `last_login_at`: ISO UTC ou `null`. É o **último login do titular** com a mesma
  semântica e a mesma origem descritas no objeto `UserSummary` acima; está no
  payload para que o próprio titular possa notar um acesso que não foi dele (LGPD
  art. 18, II) e **não autoriza nada**.
  Limitação conhecida: porque a gravação ocorre no primeiro acesso da sessão, o
  valor devolvido é o início da **sessão atual** — o titular não vê o acesso
  penúltimo (pendência registrada em
  [`estrategia-auditoria.md`](./estrategia-auditoria.md), seção 6.4.1).

### Notas de implementação (Etapa 2)

- Código: `backend/app/services/user_admin_service.py` (regras), `avatar_service.py` (imagem),
  `integrations/supabase_storage_client.py`, rotas finas em `api/v1/users.py`, `units.py`,
  `me.py` e `user_admin_http.py`. Testes: `backend/tests/test_user_admin_*.py` e
  `test_avatar_*.py`.
- **Último acesso (2026-10-29):** `backend/app/services/login_tracking_service.py`
  grava `users.last_login_at` com um `UPDATE` condicional e insere a linha `LOGIN`
  de auditoria só quando o `UPDATE` afeta a linha (`rowcount > 0`) — 1 por sessão,
  não por requisição. O `UPDATE` **não** incrementa `users.version` (um login não
  pode causar 409 no PATCH que um ADM tenha em tela). Chamada em
  `app/auth/supabase_auth.py` (`_record_login_best_effort`); `"aal"` entrou na
  allowlist `CHANGE_KEYS` de `app/services/admin_audit_service.py` para a linha
  aparecer na API de auditoria. Sem migração Alembic (coluna já existia na `0001`).
  Testes: `backend/tests/test_last_login_tracking.py`.
- **PATCH e permissões:** o decorator exige `users.manage`; depois da validação do corpo e
  antes de qualquer consulta, `role` exige `users.assign_role` e `unit_ids` exige
  `users.assign_unit` (403 `forbidden`, auditado). Sem `role` nem `unit_ids` → 400
  `validation_error`; `null` explícito → 400.
- **Auto-alteração:** qualquer PATCH sobre a própria conta (perfil ou unidades) → 409
  `self_change_forbidden`. Também valem para `deactivate` e `mfa-reset`.
- **Escopo:** as "unidades do alvo" são os vínculos `user_unit_access` somados às unidades de
  convites pendentes. Usuário sem nenhuma unidade (ex.: acesso revogado) é visível a todo ADM
  com `users.manage`, para poder ser reativado. Um ADM sem unidades não vê ninguém. `units`
  do `UserSummary` lista só unidades do escopo do ADM. O PATCH de `unit_ids` substitui só os
  vínculos do escopo dele; vínculos com unidades alheias são preservados. `unit_id` alheio ou
  inexistente na listagem → lista vazia. Unidade inativa em `unit_ids` → 400
  `validation_error`.
- `role` com mais de um papel: vale a precedência ADM > RH > USER. O filtro `role` da
  listagem significa "possui o papel".
- **`version`:** incrementado por PATCH com mudança, `deactivate` e `activate`. Não mudam o
  `version`: `revoke-sessions`, `mfa-reset`, `password-reset` e foto. Operação sem efeito
  (PATCH igual ao estado atual, desativar quem já está inativo, ativar quem já está ativo)
  → 200 com o estado atual, sem auditoria.
- **Desativação:** o banco é gravado primeiro (`active=false`, `sessions_revoked_at`). O ban
  no Supabase vem depois do commit, em melhor esforço: se falhar, a resposta continua 200 e
  é gravado o evento `USER_PROVIDER_SYNC_FAILED`.
- **Ativação:** o unban vem antes da gravação. Se falhar → 502
  `auth_provider_unavailable` (código novo) e nada é alterado. O mesmo código vale para falha
  do Supabase no `mfa-reset`. `sessions_revoked_at` é mantido, então tokens antigos seguem
  inválidos.
- **`mfa-reset`:** além de remover os fatores, grava `sessions_revoked_at=now`, encerrando
  as sessões AAL2 do alvo. Isso vale também quando a remoção falha ou fica parcial, inclusive
  com fator de id fora do padrão, que conta como falha (UA-MFA-01). Nesses casos a resposta é
  502 `auth_provider_unavailable` e a auditoria registra `FALHA` com `removed_factors`.
- **`password-reset`:** desde 2026-10-27 o **backend monta e envia o e-mail**
  (`app.services.password_reset_delivery`): `POST /auth/v1/admin/generate_link`
  (`type=recovery`, que NÃO envia nada) devolve o `hashed_token`, o backend monta
  `<redirect>?token_hash=...&type=recovery` e despacha por `send_email_safely` (SMTP
  próprio). O `POST /auth/v1/recover` deixou de ser usado porque o e-mail do template do
  Supabase usa `{{ .ConfirmationURL }}`, um GET de uso único em `/auth/v1/verify` que
  scanners de antivírus de e-mail consomem 2–4 s após o envio — ver
  `docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md`. O ADM continua sem ver link nem
  senha, e o `audit_logs` recebe só `result`/`reason` (nunca token, e-mail ou redirect).
  O destino é `PASSWORD_RESET_REDIRECT_URL`, que precisa estar em
  `INVITE_ALLOWED_REDIRECT_URLS`; se vazia, usa a 1ª URL dessa lista (se a configurada
  estiver fora da lista, o resultado é `None` e nada é enviado). Exige `EMAIL_ENABLED=true`
  com SMTP configurado: com e-mail desligado a resposta é `unavailable` /
  `reason=email_disabled`. `reason` possíveis: `inactive_user`,
  `redirect_not_configured`, `provider_unavailable`, `provider_error`, `email_disabled`,
  `email_failed`, `link_not_allowed`. Limites: 5/h por alvo, 20/h por ADM e o teto global
  `EMAIL_MAX_PER_HOUR`. A cota por alvo só é consumida depois de o escopo ser confirmado
  (UA-RL-01); alvo alheio dá 404 sem gastar a cota da vítima.
- **Convite pendente:** atribuir perfil pelo PATCH marca o convite pendente do alvo como
  `REVOGADO` (substituído), para a ativação posterior não duplicar papéis.
- **`revoke` (legado):** agora também grava `active=false`, `deactivated_at/by`,
  `sessions_revoked_at` e `version+1`, e faz o ban em melhor esforço. Seu 404 usa a mesma
  mensagem genérica dos demais.
- **Sessões revogadas (UA-SESS-01/02):** `iat` tem precisão de segundos. Com
  `sessions_revoked_at` preenchido, o JWT só é aceito se as duas condições valerem:
  - `iat` > segundo truncado da revogação (o token emitido no mesmo segundo é rejeitado);
  - o `amr` é bem-formado, com todas as entradas válidas, e o **menor** instante é > esse corte.

  `amr` ausente ou malformado → 401 (falha fechada). Assim, um refresh (que mantém o `amr`
  original) ou um TOTP re-verificado ou fator novo numa sessão antiga (que acrescenta só uma
  entrada recente) não reabrem a sessão. Um login novo, com todos os instantes depois do
  corte, é aceito.
- **`amr` (suposição a validar em homologação):** lista de `{"method", "timestamp"}`, com
  timestamp em segundos Unix. A reautenticação exige `method == "totp"` com timestamp entre
  agora − 300 s e agora + 30 s. Qualquer outro formato, inclusive lista de strings da RFC
  8176, → 403 `REAUTH_REQUIRED`.
- **Foto:** sem `multipart/form-data`, sem `file`, com mais de um `file` ou com arquivo
  vazio → 400 `unsupported_image`. Campo extra no formulário → 400 `validation_error`,
  auditado. A foto antiga é apagada depois do commit, em melhor esforço; se falhar, fica um
  objeto órfão e o erro vai para o log. No `DELETE`, o Storage é chamado primeiro; se estiver
  fora → 503 e nada muda. O objeto se chama `<uuid4>.webp`, na raiz do bucket. O SQL de
  criação do bucket está em `backend/migrations/sql/0008_storage_avatars.sql` — espelho SEM
  revisão Alembic correspondente (ele mexe no schema `storage`, do Supabase, não no
  `public`); se foi executado em produção é **a confirmar**.
- **Histórico:** em `changes.units`, as unidades fora do escopo do ADM são omitidas. Eventos
  de segurança aparecem com `changes: {}`. Os eventos em que o usuário consultado é só o
  **autor** entram apenas quando o alvo do evento é um usuário vinculado a uma unidade do
  escopo de quem consulta (UA-AUD-01). Ações sobre outras unidades, convites ou sem alvo não
  aparecem.
- **Escopo total para privilégio (UA-SCOPE-01, negar por padrão):** é preciso que **todas**
  as unidades do alvo (vínculos e convites pendentes) estejam no escopo do ator, e que haja
  ao menos uma, para:
  - promover a ADM;
  - rebaixar um ADM;
  - desativar um ADM;
  - `mfa-reset`.

  Na promoção e no rebaixamento, as unidades finais também precisam estar todas no escopo e
  não podem ficar vazias.
- **Conta órfã** (sem unidades): o ator só pode reativá-la (`activate`) ou atribuir unidades
  do próprio escopo, com ou sem perfil no mesmo PATCH. Promover a ADM só é permitido se, na
  mesma operação, a conta receber unidades do escopo. Perfil sem unidades, `deactivate`,
  `revoke-sessions`, `password-reset`, `mfa-reset` e foto (PUT/DELETE) são negados.
- **Resposta das negações de escopo total ou de órfã:** 403 `target_out_of_scope` (código
  novo), auditado como `ACCESS_DENIED` (`reason: target_out_of_scope`, severidade HIGH).
  Alvo fora de qualquer escopo continua com o 404 `not_found` único.
- **Ator revalidado (UA-TOCTOU-01):** PATCH, `deactivate`, `activate`, `revoke-sessions` e
  `mfa-reset` releem, dentro da transação e depois do advisory lock quando ele existe, se o
  ator continua ADM ativo. Se não continuar → 403 `forbidden`. A rota legada `revoke` ainda
  não faz essa revalidação (residual).
- **Upload sem `Content-Length` nem `wsgi.input_terminated`:** o stream é tratado como vazio
  (400), e o corpo nunca é lido sem limite (UA-UP-01).
- **Rate limit por ADM/hora (falha fechada):** listagem 1200; `/units` e `audit` 300;
  detalhe e `avatar-url` 600; PATCH 60; `deactivate`, `activate` e `revoke-sessions` 30;
  `mfa-reset` 10; foto (PUT/DELETE) 30. Rotas `/me/avatar*`, por usuário: escrita 20,
  leitura 600.
- **Infra (pendente, fora do backend):** o `client_max_body_size 2m` do Nginx
  (`infra/cloudpanel/vhost.conf.example`) barra uploads perto de 2 MiB por causa da
  sobrecarga do multipart. Recomendo `3m`.

## Convites de acesso (cadastro só por convite)

Conferido contra o código em 2026-10-29: `backend/app/api/v1/users.py`,
schemas `InviteRequest`/`RevokeRequest` em `app/api/v1/schemas.py`, regra em
`app/services/invite_service.py`, entrega do e-mail em
`app/services/invite_delivery.py`, modelo em `app/models/invites.py`. Não existe
`/register` nem `/signup` em nenhum blueprint.

| Método e rota | Pilha | Limite (fail-closed) |
|---|---|---|
| `POST /api/v1/users/invite` | `require_auth → require_role("ADM") → require_aal2 → require_permission("users.invite")` | 10/h por ADM |
| `POST /api/v1/users/activate-invite` | **só `require_auth`** (ver abaixo) | 10/h por usuário |
| `POST /api/v1/users/<uuid>/revoke` | `require_auth → require_role("ADM") → require_aal2 → require_permission("users.revoke_access")` | 10/h por ADM |

Redis indisponível bloqueia (503) em vez de liberar: `fail_open=False` nas três.

### `POST /users/invite`

Corpo (`InviteRequest`, `extra="forbid"`): `email` (3–254, regex simples de
e-mail), `name` (1–200), `intended_role_code` (1–32), `unit_ids` (1 a 50 UUIDs),
`justification` (opcional, ≤ 2000). Resposta **201**:
`{id, email, name, intended_role_code, status, unit_ids, created_at, expires_at}` —
`status` nasce `PENDENTE` (CHECK `ck_invites_status`: `PENDENTE|ACEITO|EXPIRADO|REVOGADO`)
e `expires_at = now() + INVITE_TTL_DAYS` (padrão 7). **Nenhuma resposta deste módulo
inclui token ou link.**

- `intended_role_code` fora de `{USER, RH}` (inclusive `ADM`) → **400** e evento
  `PRIVILEGE_ESCALATION_ATTEMPT` severidade HIGH. Convite nunca concede ADM.
- Unidade fora do escopo do ADM (ou inexistente — mesma resposta) → **403** com
  `UNIT_SCOPE_DENIED`.
- Já existe convite `PENDENTE` para o e-mail → **409**, garantido também no banco
  pelo índice único parcial `uq_invites_pending_email`
  (`lower(email) WHERE status = 'PENDENTE'`, declarado em `app/models/invites.py`).
- Falha ao falar com o Supabase Auth, ou `INVITE_ALLOWED_REDIRECT_URLS` vazia →
  **502** com mensagem genérica.

**Entrega à prova de scanner (2026-10-28).** O convite NÃO usa mais
`POST /auth/v1/invite` (template do painel, cujo `{{ .ConfirmationURL }}` é um GET
de uso único em `/auth/v1/verify` que scanners de antivírus consomem segundos após
o envio). O fluxo atual: `admin/generate_link` (`type=invite`, que cria o usuário no
Auth e **não** envia e-mail) devolve o `hashed_token`; o backend monta
`<redirect_to>?token_hash=...&type=invite` e envia por SMTP próprio
(`invite_delivery.deliver_invite`, irmão de `password_reset_delivery`). O
`redirect_to` é a PRIMEIRA URL de `INVITE_ALLOWED_REDIRECT_URLS`, obrigatoriamente
`https://` e com caminho `/ativar-conta`; o token nunca é logado, auditado,
devolvido nem colocado em exceção, e vai no link com `quote(safe="")`. A página só
chama `verifyOtp` depois do clique da pessoa (UX em `docs/ux/ATIVACAO_CONVITE.md`).

**Consequência operacional:** `generate_link` já cria a conta no Supabase Auth. Se o
e-mail não sair, `create_invite` trata como falha e NÃO grava nada localmente.

### `POST /users/activate-invite`

É o próprio convidado que ativa. Exige **apenas** `require_auth` por desenho: ao
criar o convite, o serviço já insere a linha em `users` (`active=True`) com ZERO
papéis e ZERO unidades — sem papel, o conjunto de permissões é vazio e nenhuma outra
rota responde, então o usuário só alcança `GET /api/v1/me` e esta rota. Não
introduzir um estado "pendente" via `users.active=False`: isso quebraria
`require_auth` exatamente aqui.

Sem corpo. Qualquer corpo não vazio → **400**; se for objeto, os nomes de campo
passam por `reject_unexpected_fields` (tentativa de enviar `role`, `unit_ids`,
`is_admin`... é registrada como escalonamento de privilégio). Papel e unidades vêm
EXCLUSIVAMENTE do convite gravado pelo ADM. Respostas: **200**
`{"role": "USER|RH", "units": ["<uuid>", ...]}`; **404** sem convite pendente para o
usuário atual; **409** se o convite encontrado já expirou (ele é marcado `EXPIRADO`
nessa mesma chamada e nunca mais pode ser aceito); **502** em falha inesperada. As
falhas gravam `INVITE_ACTIVATION_FAILED` (`reason: not_found|expired`, severidade
baixa).

### `POST /users/<uuid>/revoke` (legado, mantido)

Corpo opcional `{"reason"?: ≤ 1000}` (`RevokeRequest`, `extra="forbid"`; **não**
aceita `version`). Resposta **200** `{"status": "revoked", "user_id": "<uuid>"}` —
é a única ação de conta que não devolve `UserSummary`. Além de remover papéis e
vínculos, hoje também grava `active=false`, `deactivated_at/by`,
`sessions_revoked_at` e `version + 1`, e faz o ban no Supabase em melhor esforço.

- Autorrevogação → **409** + `REVOKE_BLOCKED` (`reason: self_revoke`).
- Último ADM ativo → **409** + `REVOKE_BLOCKED` (`reason: last_admin`, HIGH).
- Alvo que não compartilha nenhuma unidade com o ADM, inexistente ou malformado →
  o MESMO **404** genérico, com `UNIT_SCOPE_DENIED`. O escopo do alvo soma os
  vínculos de `user_unit_access` às unidades de convites **PENDENTES** dele (casados
  por `auth_user_id` ou e-mail normalizado), para que um convidado ainda não ativado
  não fique irrevogável; a consulta de convites roda sempre, para que alvo alheio e
  inexistente executem o mesmo número de consultas (AUD-14-07).
- Sucesso grava `USER_ACCESS_REVOKED` (HIGH, `result=SUCESSO`).
- Residual conhecido: esta rota legada NÃO revalida o ator dentro da transação
  (UA-TOCTOU-01), ao contrário de PATCH/`deactivate`/`activate`/`revoke-sessions`/
  `mfa-reset`.

**Pendência operacional (não é código):** impedir cadastro direto pelo GoTrue
(`POST /auth/v1/signup` com a chave `anon`) é configuração do painel do Supabase —
Authentication > Settings > "Allow new users to sign up" deve estar DESATIVADA. O
backend não tem como impor isso; é verificação da equipe responsável pelo projeto
Supabase.

## MFA do próprio usuário (`/api/v1/security/...`)

Documentado a partir do código em 2026-10-29 (`backend/app/api/v1/security.py`);
estas duas rotas não constavam de nenhum documento de `docs/architecture/`. Elas
sustentam a tela `/configuracoes/seguranca`. O CADASTRO do fator (enroll/verify
TOTP) é feito pelo frontend direto no Supabase Auth e **não** passa por este
módulo — por isso um ADM em `aal1` consegue cadastrar o primeiro fator.

### `DELETE /api/v1/security/mfa/factors/<uuid>`

`require_auth → require_aal2 → rate_limit` (5/h por usuário, fail-closed). Sem
permissão granular — decisão AUD-14-03 registrada no módulo:
`security.manage_mfa` (semeada só para ADM no espelho
`backend/migrations/sql/0005_seed_security_permissions.sql`, que não tem revisão
Alembic equivalente — não confundir com a revisão `0005_settings_ai_users`)
fica reservada para uma futura
rota ADMINISTRATIVA de recuperação assistida (remover fator de OUTRO usuário),
que **não existe**; exigi-la aqui impediria USER/RH de remover o próprio fator.
Autosserviço estrito: age só sobre o `auth_user_id` da sessão.

- Sucesso: **204** sem corpo, com evento HIGH `MFA_FACTOR_DELETED`.
- `factor_id` que não seja UUID → 404 pelo conversor da rota, antes da view
  (impede normalização de `..` e injeção de query na URL da API Admin). O UUID é
  canonicalizado em minúsculas antes da comparação — sem isso um ADM burlaria a
  regra do último fator mandando o mesmo id em maiúsculas.
- Fator que não é do próprio usuário, ou inexistente → o mesmo **404**.
- ADM tentando remover o ÚNICO fator `verified` → **409** + evento HIGH
  `MFA_FACTOR_DELETE_BLOCKED` (`reason: adm_last_verified_factor`). É a política
  de MFA obrigatório para ADM.
- Usuário local sem `auth_user_id` → 409; falha na API Admin do Supabase →
  **502** genérico (detalhe só no log do servidor).
- A remoção é SEMPRE feita pelo backend com a Service Role Key, nunca pelo SDK
  no navegador: é o que permite aplicar a regra acima.

### `POST /api/v1/security/mfa/factor-added-notice`

`require_auth → rate_limit` (10/h por usuário, fail-closed). Sem corpo (corpo
presente → 400). Aviso de melhor-esforço que o frontend envia depois do enroll:
se o usuário tem papel ADM **e** a sessão está em `aal1`, grava o evento HIGH
`ADM_TOTP_ENROLL_AAL1` (quem tem só a senha pode ter virado dono do 2º fator).
Qualquer outro caso responde IGUAL e não registra nada — a rota não é oráculo de
perfil. Não altera o cadastro do fator nem concede nada.

## E-mail transacional — `POST /api/v1/settings/email/test`

Documentado a partir do código em 2026-10-29
(`backend/app/api/v1/email_settings.py`); também não constava em
`docs/architecture/`. Apoia `/administracao/integracoes`.

`require_auth → require_role("ADM") → require_aal2 →
require_permission("settings.email.manage") → rate_limit` (3/h por ADM).
Corpo vazio ou ausente (`EmptyBody`, `extra="forbid"`: qualquer campo → 400
`validation_error`). **O destinatário é o e-mail do próprio ADM autenticado,
nunca um endereço vindo do cliente.** Resposta 200 `{"result": ...}` com
`sent | disabled | failed`; `EMAIL_ENABLED=false` devolve `disabled` sem tentar
enviar. Auditoria: evento `EMAIL_TEST_REQUESTED` (`target_type=email_settings`,
`details.outcome`), severidade baixa, ou `FALHA`/média quando `failed` — nunca
o endereço, o corpo da mensagem ou credencial de SMTP. O envio passa por
`send_email_safely`, que aplica o teto `EMAIL_MAX_PER_HOUR` e nunca levanta
exceção. A permissão `settings.email.manage` vem de
`0006_email_settings_permission` (espelho `sql/0009_email_settings_permission.sql`;
rollback `alembic downgrade 0005_settings_ai_users`, `pg_dump` antes).

## Etapa 3 — Aparência (preferências do próprio usuário)

Qualquer perfil autenticado (`require_auth`, sem AAL2 nem permissão); o alvo é sempre o
usuário do JWT (nenhum id vem do cliente). Tabela `user_preferences` (migração 0005).

### `GET /api/v1/me/preferences`

200 `{"density": "comfortable"|"compact", "font_scale": 100|112|125, "dashboard_charts": {"units", "status", "monthly", "location", "bond", "rooms"}, "dashboard_layout": {"order": [9 IDs], "hidden": [...]}, "version": int}`.
Sem linha: `comfortable` / `100` / gráficos e layout padrão / `version: 0` (o GET não cria linha).

`dashboard_charts` (tipo de gráfico por painel do dashboard; allowlist FECHADA, sempre devolvido
com as 6 chaves resolvidas): `units` in {`grouped` (padrão), `stacked`, `horizontal`};
`status` in {`pie` (padrão), `donut`, `bar`}; `monthly` in {`line` (padrão), `area`, `bar`};
`location` in {`stacked` (padrão), `grouped`, `horizontal`}; `bond` in {`donut` (padrão), `pie`,
`bar`}; `rooms` in {`horizontal` (padrão), `bar`}.
Persistido em `user_preferences.dashboard_charts` (JSONB NOT NULL DEFAULT `{}`, CHECK <= 512
bytes), só com as chaves não padrão.

`dashboard_layout` (ordem/visibilidade dos painéis; migração `0013_dashboard_layout_prefs`):
IDs da allowlist FECHADA `kpis`, `units`, `status`, `monthly`, `location`, `bond`, `pending`,
`rooms`, `inventory` (esta é a ordem padrão). `order` sempre traz os 9 IDs na ordem efetiva;
`hidden` traz os ocultos na ordem padrão. Persistido em `user_preferences.dashboard_layout`
(JSONB NOT NULL DEFAULT `{}`, CHECK <= 1024 bytes) só quando difere do padrão. Dado legado
inválido no banco (chave desconhecida, tipo errado, ID fora da allowlist, todos ocultos) é
ignorado e cai no padrão (nunca 500).

### `PATCH /api/v1/me/preferences`

Corpo `{"density"?, "font_scale"?, "dashboard_charts"?, "dashboard_layout"?, "version"}` (`extra="forbid"`).
`dashboard_charts` é parcial (merge por chave); `null` numa chave restaura o padrão dela (remove
do JSON salvo); chave desconhecida, valor fora da allowlist, tipo errado ou objeto aninhado -> 400. `version` é obrigatório
(inteiro >= 0; `0` cria a primeira linha) e ao menos uma preferência (ou uma chave de `dashboard_charts`/`dashboard_layout`, ou `dashboard_layout: null`) deve vir. Resposta: mesmo
formato do GET.

`dashboard_layout` aceita `{"order"?: [...], "hidden"?: [...]}` (`extra="forbid"`): ausente =
manter; `null` na chave = padrão dela; `"dashboard_layout": null` = layout padrão (`{}`). Cada
lista: só IDs da allowlist, sem repetição, até 9. `order` parcial é aceito (os ausentes vão ao
fim, na ordem padrão). `hidden` com os 9 IDs (nenhum visível) -> 400. `null` explícito continua
proibido nos demais campos. Erros no formato `{"error": {"code", "message"}}`:

- 400 `validation_error`: valor fora da allowlist, tipo errado, `null`, nenhum campo de
  preferência, campo desconhecido ou privilegiado (`user_id`, `role`, `unit_id`...), que também
  gera evento de segurança (`MASS_ASSIGNMENT_REJECTED` / `PRIVILEGE_ESCALATION_ATTEMPT`).
- 409 `version_conflict`: versão diferente da atual (inclui `version > 0` sem linha e inserção
  concorrente da primeira linha).

### Notas de implementação (Etapa 3)

- Código: `backend/app/services/preferences_service.py`, schema `PreferencesUpdateRequest`
  em `api/v1/schemas.py`, rotas em `api/v1/me.py`. Testes: `backend/tests/test_preferences_api.py`.
- `SELECT ... FOR UPDATE` + comparação de `version`; a primeira linha nasce com `version = 1`.
- Auditoria `USER_PREFERENCES_UPDATED` (entidade `user_preferences`, `entity_id` = id do
  usuário) na mesma transação, com `previous_values`/`new_values` = `{density, font_scale, dashboard_charts, dashboard_layout, version}` (sem dados pessoais).
  Testes dos gráficos: `backend/tests/test_dashboard_charts_preferences.py`; do layout:
  `backend/tests/test_dashboard_layout_preferences.py`.
- Rate limit por usuário (falha fechada): leitura 600/h, escrita 60/h.
- Matriz de permissões: sem permissão nova (rota AUTH, como `/me`); registrada em
  `test_sec_route_inventory.py`.

## Etapa 4a — Alertas determinísticos

Sem IA: regras em SQL (ORM, parametrizadas) em `backend/app/services/alerts/`
(`rules.py`, `service.py`); rota em `backend/app/api/v1/dashboard.py`. A IA (4b) só
priorizará/explicará estes resultados; nunca gera SQL.

### `GET /api/v1/dashboard/alerts`

Qualquer perfil autenticado (USER/RH/ADM), sem AAL2 e sem permissão granular (rota AUTH, como
`/me`; registrada em `test_sec_route_inventory.py`; sem permissão nova na matriz). Rate limit
por usuário, falha fechada: 120/h. Resposta `Cache-Control: no-store`:

```
{"generated_at": "2026-10-15T12:00:00Z",
 "items": [{"code", "severity": "info"|"warning"|"critical", "title", "description", "count"}],
 "unavailable": ["<code da regra que falhou>"]}
```

Só entram itens com `count > 0` (ordenados por severidade). Cada regra roda em sessão própria; se
falhar, só o código vai em `unavailable` (causa só no log, pelo nome da exceção) e a resposta
segue 200. Contagens < 5 NÃO são suprimidas aqui (supressão vale só para payload de IA).

### Regras (códigos)

Todas aplicam `apply_unit_scope` (escopo vazio = nada) e consideram só bens ativos
(`deleted_at IS NULL`). O cliente não envia nenhum filtro/unidade (parâmetros são ignorados).

| Código | Severidade | Regra |
|---|---|---|
| `assets_duplicate_patrimony` | critical | bens ativos no escopo com o mesmo `patrimony_number` (`GROUP BY`/`HAVING > 1`); `count` = bens envolvidos |
| `assets_unchecked` | warning | nenhum `inventory_items.checked_at` nos últimos N dias (inclui nunca conferidos) |
| `assets_no_movement` | info | nenhuma movimentação (exceto CANCELADA/REJEITADA) nos últimos N dias |
| `assets_no_responsible` | warning | `responsible_person_id` e `assigned_user_id` nulos |
| `assets_no_location` | warning | `room_id` e `location_id` nulos |
| `assets_nonstandard_patrimony` | info | número fora da regex configurada (operador `!~` do PostgreSQL, regex como parâmetro) |
| `sync_conflicts_pending` | warning | `SyncConflict` PENDENTE ligado a bem do escopo |
| `import_records_conflict` | warning | `RawImportRecord` CONFLITO cujo `source_record_id` casa com `assets.source_record_id` de bem do escopo |
| `movement_spike` | warning | por `movement_type`: movimentos dos últimos 7 dias >= mínimo e > média + k·σ das N semanas anteriores (um item por tipo, até 20) |

Baixas: N/A (não existe o conceito; `movement_type` é texto livre — sugestão 8 do plano).

### Configuração (`.env`, todos opcionais)

`ALERTS_UNCHECKED_DAYS=365`, `ALERTS_NO_MOVEMENT_DAYS=365`, `ALERTS_PATRIMONY_REGEX`
(default `^[0-9A-Za-z][0-9A-Za-z./-]{0,31}$`; regex inválida torna só aquela regra
`unavailable`), `ALERTS_SPIKE_BASELINE_WEEKS=8`, `ALERTS_SPIKE_SIGMA=3.0`,
`ALERTS_SPIKE_MIN_COUNT=5`.

### Privacidade (RH incluído)

As regras só leem colunas de identificadores/datas e devolvem contagens; nenhum nome, e-mail
ou matrícula é lido ou devolvido, então RH recebe exatamente o mesmo formato (sem identificar
pessoas). O único texto vindo do banco é o `movement_type` (importado, não confiável) em
`movement_spike`, saneado (somente imprimíveis, 60 caracteres).

### Limitações conhecidas

- `SyncConflict` sem `asset_id` e `RawImportRecord` sem bem correspondente não têm unidade e
  por isso NÃO são contados para ninguém (falha segura).
- `assets_unchecked`/`assets_no_movement` não excluem bens recém-cadastrados (podem ser
  numerosos logo após a importação).
- Sem índice novo (nenhuma migração): `inventory_items(asset_id, checked_at)` e
  `asset_movements(asset_id, created_at)` ajudariam os `NOT EXISTS` em bases grandes.
- Testes: `backend/tests/test_alerts_api.py` (SQLite com schema real; `REGEXP` emulado).

## Etapa 4b — IA no dashboard

Consultiva e somente leitura. Cada funcionalidade tem flag própria em `ai_settings.features`
(`alerts_explain`, `executive_summary`, `data_quality`, `assistant`); `AI_ENABLED=false` no
ambiente vence tudo. Qualquer falha (sem chave, circuito aberto, cota, Redis fora, timeout,
resposta vazia, bloqueio da redação) degrada para `NullProvider`: respostas 200 neutras, nada é
gravado, sem exceção. Chaves só em env; logs só com `type(exc).__name__`.

### Tasks Celery (`app/tasks/ai_tasks.py`, agenda em `app/celery_app.py`)

| Task | Funcionalidade | Agenda (UTC) | Cache (Redis, TTL) |
|---|---|---|---|
| `sispat.ai.alerts_priority` | `alerts_explain` | a cada 6 h | `sispat:ai:insights:<unit_id>:alert_priority` (8 h) |
| `sispat.ai.executive_summary` | `executive_summary` | diária 09:00 | `...:executive_summary` (30 h) |
| `sispat.ai.quality_suggestions` | `data_quality` | diária 09:30 | `...:quality_suggestion` (30 h) |

Sem argumentos (nenhuma entrada de usuário chega às tasks). Para cada unidade ativa: roda as
regras determinísticas de `services/alerts` limitadas à unidade (`app/services/ai/insights.py`),
monta um DTO agregado (só código da regra, severidade e contagem; `unit_code`/`unit_label`;
no resumo, `metrics.total`), passa por `AIService.run_feature` (flag -> redação com allowlist,
contagens 1..4 viram `"<5"` e varredura bloqueante de CPF/e-mail/telefone/JWT/chaves ->
prompt com `<dados>` -> provedor) e grava o texto puro. Unidade sem alertas não chama a IA. As
tasks não aplicam o rate limit por usuário/unidade (o custo é limitado pelo agendamento e pelo
teto mensal de tokens). Falha de cota/circuito/chave interrompe o laço.

### `GET /api/v1/ai/insights`

`require_auth` (qualquer perfil), escopo = unidades do usuário, só lê o cache (nunca chama o
provedor), `Cache-Control: no-store`. Contrato:

```
{"status": "ok"|"unavailable", "generated_at": ISO|null,
 "items": [{"kind": "alert_priority"|"executive_summary"|"quality_suggestion", "title", "text"}]}
```

IA desligada, flag da funcionalidade desligada, sem cache, Redis fora ou usuário sem unidade:
`200 {"status":"unavailable","generated_at":null,"items":[]}`. Com mais de uma unidade, o título
recebe o nome da unidade. Rate limit de rota 300/h com `fail_open` (a IA falha fechada sozinha).

### `POST /api/v1/ai/ask`

`require_auth` + permissão `ai.use` + flag `assistant`. Corpo `{"question": str 1..500}`
(`extra="forbid"`; campo extra -> 400 auditado). Resposta `200 {"status":"ok","answer","tools_used"}`
ou `200 {"status":"unavailable"}` quando a IA está desligada/degradada ou a pergunta é bloqueada
pela redação (CPF/e-mail...); `429 rate_limited` quando estoura o limite por usuário
(`AI_RATE_LIMIT_PER_USER`) ou por unidade (`AI_RATE_LIMIT_PER_UNIT`). Cada chamada ao provedor
consome 1 do limite (uma pergunta com ferramentas usa até 4).

Function calling por protocolo de texto (`services/ai/assistant.py`): o modelo responde com
texto final ou com uma linha `{"tool","args"}`. Quem decide e executa é o backend
(`services/ai/tools.py`): allowlist fechada (`contar_bens`, `listar_alertas`, `bens_por_sala`,
`contagem_responsaveis`), argumentos validados por schema `extra="forbid"` estrito, escopo SEMPRE
via `apply_unit_scope` do usuário autenticado (a unidade nunca vem do LLM nem do cliente), nenhum
SQL do LLM, no máximo 3 execuções por pergunta (um 4º pedido -> `unavailable`). Ferramenta fora
da allowlist vira resultado `recusada` (nada executa, não entra em `tools_used`); argumentos
inválidos viram `argumentos_invalidos`. Nenhuma ferramenta devolve nome, e-mail ou matrícula; as
que tocam responsáveis retornam só contagens (RH incluído). A pergunta e os resultados (rótulos de
sala são dado importado não confiável) vão no bloco `<dados>`, com `<`, `>`, `&` escapados; o
system prompt é fixo. Saída em texto puro, sem controle, truncada em 2000 caracteres. Auditoria
`AI_USAGE` sem conteúdo (provedor, modelo, funcionalidade, tokens, resultado).

### Limitações / pendências

- `ai.use` está semeada só para ADM (migração 0005). USER/RH recebem 403 em `/ai/ask` até uma
  migração/seed conceder a permissão (decisão de produto; nenhuma migração foi criada aqui).
- Rótulos de sala podem conter texto livre importado: a varredura pega CPF/e-mail/telefone, não
  nomes próprios.
- A task reaproveita as regras de alerta com uma sessão que fixa o escopo na unidade processada
  (`_UnitScopedSession`); um `scope_unit_ids` explícito em `RuleContext` seria mais limpo.
- Testes: `test_ai_insights.py`, `test_ai_assistant_api.py`, `test_ai_tools.py`
  (infra em `test_ai_dash_support.py`).

## Tabela `unit_aliases` (importação de bens)

Migração Alembic `0007_unit_aliases` (espelho `backend/migrations/sql/0010_unit_aliases.sql`).
Mapeia a sigla da coluna UNIDADE da planilha (ex.: `UEA`)
para `units.id`: `alias` único case-insensitive (`lower(alias)`), 1..32 caracteres
sem espaços nas pontas, `unit_id` FK `ON DELETE RESTRICT`, RLS default-deny e
REVOKE de anon/authenticated. Seed: `UEA` → unidade de code `023404` (ignorado se a
unidade não existir).

Estado em 2026-10-29: o `alembic_version` de produção é `0019_user_soft_delete`, muito
além desta revisão, e a resolução de siglas está em uso na importação. Rollback (só com
autorização e `pg_dump` antes): `alembic downgrade 0006_email_settings_permission`
(remove apenas a tabela `unit_aliases`). Verificação de presença do DDL:
`docs/database/historico-migracoes.md`.

## Migrações 0009 e 0010 (índices únicos e correção de permissões)

Duas migrações separadas na cadeia linear `0008` → `0009` → `0010`.

**Estado em 2026-10-29 (substitui o aviso anterior, que dizia `alembic_version` = `0006`
e "não aplicadas"):** o carimbo de produção é `0019_user_soft_delete`, portanto já passou
por estas duas revisões, e uma consulta somente leitura ao catálogo confirmou a existência
de `uq_assets_patrimony_number_active` (0009). O seed da 0010 também está **efetivo**: o
perfil USER ficou sem `rooms.manage` e sem `inventory.create` (conferência em produção
registrada em `docs/permissions/matriz-permissoes.md`, §3.2). Fica **a confirmar** apenas
`uq_asset_movements_one_pending`, o outro índice da 0009 (ver
`docs/database/historico-migracoes.md`, que marca o DDL da 0009 como "a confirmar"). O
comando de referência para alinhar carimbo sem DDL continua `alembic stamp <revisão>`.

| Alembic | Espelho SQL (colar nesta ordem) | Efeito |
|---|---|---|
| `0009_uniq_idx_assets_movements` | `backend/migrations/sql/0012_unique_indexes_assets_movements.sql` | SEC-AST-01: `uq_assets_patrimony_number_active` em `assets (lower(btrim(patrimony_number))) WHERE deleted_at IS NULL`. SEC-MOV-02: `uq_asset_movements_one_pending` em `asset_movements (asset_id) WHERE status = 'PENDENTE'`. |
| `0010_seed_permission_corrections` | `backend/migrations/sql/0013_seed_permission_corrections.sql` | Revoga do perfil USER `rooms.manage` e `inventory.create` (a matriz as reserva ao ADM). |

- 0009: cada índice é precedido de verificação que aborta com contagem (sem dados pessoais) se
  houver duplicatas. `CREATE UNIQUE INDEX IF NOT EXISTS`, idempotente. (A frase original
  "tabelas de bens/movimentações têm 0 linhas hoje" valia na data da escrita da migração;
  o volume atual de `assets` **não** foi medido nesta revisão.)
- 0010: as rotas já exigem papel ADM; é correção de menor privilégio (sem mudança de
  comportamento da API). `DELETE` restrito ao perfil USER e a essas duas permissões; idempotente.
  O teste `test_db_static.py` abre exceção explícita e verificada só para este DELETE.
- Pré-requisitos no banco: 0007/0008 (espelhos 0010/0011) já aplicados.

Aplicar (após autorização explícita), uma das opções:

- SQL Editor do Supabase: colar `0012_...sql`; depois, se desejado, `0013_...sql`.
- Alembic (só com `alembic_version` correto): `cd backend && alembic upgrade 0009_uniq_idx_assets_movements`
  e depois `alembic upgrade 0010_seed_permission_corrections` (ou `alembic upgrade head`).

Reverter (nesta ordem inversa):

```sql
-- 0010 (devolve as permissões ao USER)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r
JOIN public.permissions p ON p.code IN ('rooms.manage', 'inventory.create')
WHERE r.code = 'USER'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 0009
DROP INDEX IF EXISTS public.uq_asset_movements_one_pending;
DROP INDEX IF EXISTS public.uq_assets_patrimony_number_active;
```

Alembic: `alembic downgrade 0009_uniq_idx_assets_movements` e
`alembic downgrade 0008_catalog_source_ids_perms`.

Nota: o índice `uq_assets_patrimony_number_active` existe só na migração (não no modelo
SQLAlchemy), porque testes existentes (`test_alerts_api`, `test_sec_alerts`, importação) criam
duplicatas ativas no SQLite para exercitar a regra de alerta `assets_duplicate_patrimony`. Após
aplicar a 0009 essa regra deixa de ter casos reais no PostgreSQL (defesa em profundidade).
