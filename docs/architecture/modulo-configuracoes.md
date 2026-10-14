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
