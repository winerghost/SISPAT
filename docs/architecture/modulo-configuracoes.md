# Módulo de Configurações — contrato da API

Fonte de verdade compartilhada entre backend e frontend. Plano completo:
`C:\Users\winer\.claude\plans\stateless-wandering-kahn.md` (local). Erros seguem o formato
padrão `{"error": {"code": "...", "message": "..."}}` de `backend/app/errors.py`.

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
| `page_size` | 1 a 100, padrão 25 |

Resposta: `{"total": 0, "page": 1, "page_size": 25, "users": [UserSummary]}`.

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

**Sessões revogadas:** `require_auth` rejeita com 401 todo JWT cujo `iat` seja anterior a
`users.sessions_revoked_at`.

### Histórico: `GET /api/v1/users/<uuid>/audit?page=&page_size=` (`audit.read`)

```json
{
  "total": 0,
  "page": 1,
  "page_size": 25,
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
- Armazenamento no bucket **privado** `avatars` do Supabase Storage (o bucket ainda não foi criado em produção). Sem bucket ou com o Storage fora do ar → 503 `storage_unavailable`; o resto do sistema segue funcionando.
- `GET /api/v1/me` passa a incluir `"has_avatar": bool`, para o header decidir se pede `GET /api/v1/me/avatar-url`. A URL nunca vem no `/me`.

### Notas de implementação (Etapa 2)

- Código: `backend/app/services/user_admin_service.py` (regras), `avatar_service.py` (imagem),
  `integrations/supabase_storage_client.py`, rotas finas em `api/v1/users.py`, `units.py`,
  `me.py` e `user_admin_http.py`. Testes: `backend/tests/test_user_admin_*.py` e
  `test_avatar_*.py`.
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
- **`password-reset`:** usa `POST /auth/v1/recover`, e o próprio Supabase envia o e-mail;
  nenhum link passa pelo backend. O destino é a nova `PASSWORD_RESET_REDIRECT_URL`, que
  precisa estar em `INVITE_ALLOWED_REDIRECT_URLS`; se vazia, usa a 1ª URL dessa lista. Alvo
  inativo, redirect não configurado ou erro do Supabase → `{"result": "unavailable"}`
  (auditado como FALHA). Limites: 5/h por alvo e 20/h por ADM. A cota por alvo só é
  consumida depois de o escopo ser confirmado (UA-RL-01); alvo alheio dá 404 sem gastar
  a cota da vítima.
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
  fora → 503 e nada muda. O objeto se chama `<uuid4>.webp`, na raiz do bucket. O SQL do
  bucket está em `backend/migrations/sql/0008_storage_avatars.sql` (**não aplicado**).
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

## Etapa 3 — Aparência (preferências do próprio usuário)

Qualquer perfil autenticado (`require_auth`, sem AAL2 nem permissão); o alvo é sempre o
usuário do JWT (nenhum id vem do cliente). Tabela `user_preferences` (migração 0005).

### `GET /api/v1/me/preferences`

200 `{"density": "comfortable"|"compact", "font_scale": 100|112|125, "version": int}`.
Sem linha: `comfortable` / `100` / `version: 0` (o GET não cria linha).

### `PATCH /api/v1/me/preferences`

Corpo `{"density"?, "font_scale"?, "version"}` (`extra="forbid"`). `version` é obrigatório
(inteiro >= 0; `0` cria a primeira linha) e ao menos uma preferência deve vir. Resposta: mesmo
formato do GET. Erros no formato `{"error": {"code", "message"}}`:

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
  usuário) na mesma transação, com `previous_values`/`new_values` = `{density, font_scale, version}`.
- Rate limit por usuário (falha fechada): leitura 600/h, escrita 60/h.
- Matriz de permissões: sem permissão nova (rota AUTH, como `/me`); registrada em
  `test_sec_route_inventory.py`.
