"""Serviço de configuração da IA (`ai_settings`, linha única `id = 1`).

Consumido pelas rotas finas de `app/api/v1/ai_settings.py`. Contrato das
respostas: `docs/architecture/modulo-configuracoes.md` (Etapa 1).

Regras:
    - Chaves de API NUNCA passam por aqui: só `key_status()` ("configured" |
      "not_configured"). Auditoria e respostas contêm apenas campos de config.
    - `AI_ENABLED=false` no ambiente vence o banco: `status="disabled"` e
      `env_enabled=false`, qualquer que seja a linha.
    - Linha `id = 1` ausente (banco sem seed): GET devolve o padrão desligado
      (`version=1`, `updated_at=null`); o PATCH com `version=1` cria a linha.
    - Concorrência: `SELECT ... FOR UPDATE` + comparação de `version` (sem
      lost update); `version` incrementado explicitamente. Inserção
      concorrente da linha ausente -> IntegrityError -> 409.
    - Troca de `provider` sem `model`: mantém o modelo atual se ele estiver
      na allowlist do novo provedor; senão usa o padrão do provedor
      (`default_model`); `provider="none"` zera o modelo. `model` enviado
      com `provider="none"` -> 400 `invalid_model`.
    - DeepSeek sem aceite prévio exige `acknowledge_international_transfer:
      true`; o aceite grava `deepseek_acknowledged_at/by` e é auditado.
    - Auditoria `AI_SETTINGS_UPDATED` (previous/new) na MESMA transação.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config.settings import Settings, get_settings
from app.models.audit import AuditLog
from app.models.mixins import utcnow
from app.models.settings import AI_SETTINGS_SINGLETON_ID, AISettings
from app.services.ai.factory import _AUTO, AIConfig, compute_status, key_status
from app.services.ai.models import (
    AI_FEATURES,
    PROVIDER_DEEPSEEK,
    PROVIDER_NONE,
    default_model,
    is_allowed_model,
    models_by_provider,
)
from app.services.ai.service import AIActor, AIService

logger = logging.getLogger(__name__)

AI_SETTINGS_ENTITY_TYPE = "ai_settings"
OPERATION_AI_SETTINGS_UPDATED = "AI_SETTINGS_UPDATED"
OPERATION_AI_DEEPSEEK_ACKNOWLEDGED = "AI_DEEPSEEK_ACKNOWLEDGED"

DEFAULT_MONTHLY_TOKEN_CAP = 200_000  # espelha o server_default da migração 0005


class AISettingsError(Exception):
    """Erro de domínio com status HTTP e código estável do contrato."""

    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class AISettingsVersionConflictError(AISettingsError):
    status_code = 409
    code = "version_conflict"
    message = "As configurações foram alteradas por outra pessoa. Recarregue e tente novamente."


class AISettingsInvalidModelError(AISettingsError):
    status_code = 400
    code = "invalid_model"
    message = "Modelo fora da lista permitida para o provedor."


class AISettingsDeepseekAckRequiredError(AISettingsError):
    status_code = 400
    code = "deepseek_ack_required"
    message = (
        "Para usar o DeepSeek é necessário confirmar a transferência internacional de dados "
        "(acknowledge_international_transfer: true)."
    )


def _iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _normalized_features(raw: Any) -> dict[str, bool]:
    source = raw if isinstance(raw, dict) else {}
    return {name: source.get(name) is True for name in AI_FEATURES}


def _snapshot(row: AISettings | None) -> dict[str, Any]:
    """Campos de configuração auditáveis (nunca chaves)."""
    if row is None:
        return {
            "enabled": False,
            "provider": PROVIDER_NONE,
            "model": None,
            "features": _normalized_features(None),
            "monthly_token_cap": DEFAULT_MONTHLY_TOKEN_CAP,
            "deepseek_acknowledged": False,
            "version": 1,
        }
    return {
        "enabled": row.enabled is True,
        "provider": row.provider or PROVIDER_NONE,
        "model": row.model,
        "features": _normalized_features(row.features),
        "monthly_token_cap": int(row.monthly_token_cap)
        if row.monthly_token_cap is not None
        else DEFAULT_MONTHLY_TOKEN_CAP,
        "deepseek_acknowledged": row.deepseek_acknowledged_at is not None,
        "version": int(row.version) if row.version is not None else 1,
    }


class AISettingsService:
    """Lê/atualiza `ai_settings` e executa o teste de conexão.

    `db` pode ser None apenas para `test_connection` (que não usa o banco).
    """

    def __init__(
        self,
        db: Session | None,
        *,
        settings: Settings | None = None,
        redis_client: Any = _AUTO,
        http_session: Any | None = None,
    ) -> None:
        self._db = db
        self._settings = settings
        self._redis = redis_client
        self._http_session = http_session

    # ------------------------------------------------------------------
    def _get_settings(self) -> Settings:
        return self._settings or get_settings()

    def _load_row(self, *, for_update: bool = False) -> AISettings | None:
        assert self._db is not None
        stmt = select(AISettings).where(AISettings.id == AI_SETTINGS_SINGLETON_ID)
        if for_update:
            stmt = stmt.with_for_update()
        return self._db.execute(stmt).scalars().first()

    def load_config(self) -> AIConfig:
        return AIConfig.from_row(self._load_row())

    def _view(self, row: AISettings | None) -> dict[str, Any]:
        settings = self._get_settings()
        snap = _snapshot(row)
        config = AIConfig.from_row(row)
        if settings.ai_enabled:
            status = compute_status(config, settings=settings, redis_client=self._redis)
        else:
            status = "disabled"
        return {
            "status": status,
            "env_enabled": bool(settings.ai_enabled),
            "enabled": snap["enabled"],
            "provider": snap["provider"],
            "model": snap["model"],
            "features": snap["features"],
            "monthly_token_cap": snap["monthly_token_cap"],
            "deepseek_acknowledged": snap["deepseek_acknowledged"],
            "keys": key_status(settings),
            "models": models_by_provider(),
            "version": snap["version"],
            "updated_at": _iso_utc(getattr(row, "updated_at", None)) if row is not None else None,
        }

    # ------------------------------------------------------------------
    def get_view(self) -> dict[str, Any]:
        return self._view(self._load_row())

    def update(
        self,
        changes: Any,
        *,
        actor_user_id: uuid.UUID,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Aplica `changes` (`AISettingsUpdate`) com controle otimista.

        Levanta `AISettingsError` (409/400) sem alterar nada em caso de erro.
        """
        assert self._db is not None
        row = self._load_row(for_update=True)
        previous = _snapshot(row)
        if int(changes.version) != previous["version"]:
            raise AISettingsVersionConflictError()

        fields = changes.model_fields_set

        current_provider = previous["provider"]
        new_provider = changes.provider if "provider" in fields and changes.provider else current_provider
        provider_changed = new_provider != current_provider

        # --- modelo ---------------------------------------------------
        if "model" in fields and changes.model is not None:
            if new_provider == PROVIDER_NONE or not is_allowed_model(new_provider, changes.model):
                raise AISettingsInvalidModelError()
            new_model = changes.model
        elif new_provider == PROVIDER_NONE:
            new_model = None
        elif provider_changed:
            current_model = previous["model"]
            new_model = (
                current_model
                if is_allowed_model(new_provider, current_model)
                else default_model(new_provider)
            )
        else:
            new_model = previous["model"]

        # --- aceite DeepSeek -------------------------------------------
        acknowledge_now = False
        if new_provider == PROVIDER_DEEPSEEK and not previous["deepseek_acknowledged"]:
            if changes.acknowledge_international_transfer is not True:
                raise AISettingsDeepseekAckRequiredError()
            acknowledge_now = True

        # --- funcionalidades / demais campos ---------------------------
        new_features = dict(previous["features"])
        if "features" in fields and changes.features is not None:
            for name in changes.features.model_fields_set:
                value = getattr(changes.features, name)
                if name in AI_FEATURES and isinstance(value, bool):
                    new_features[name] = value

        new_enabled = changes.enabled if "enabled" in fields and changes.enabled is not None else previous["enabled"]
        new_cap = (
            changes.monthly_token_cap
            if "monthly_token_cap" in fields and changes.monthly_token_cap is not None
            else previous["monthly_token_cap"]
        )

        now = utcnow()
        if row is None:
            row = AISettings(id=AI_SETTINGS_SINGLETON_ID, created_at=now)
            self._db.add(row)

        row.enabled = bool(new_enabled)
        row.provider = new_provider
        row.model = new_model
        row.features = new_features
        row.monthly_token_cap = int(new_cap)
        row.version = previous["version"] + 1
        row.updated_by = actor_user_id
        row.updated_at = now
        if acknowledge_now:
            row.deepseek_acknowledged_at = now
            row.deepseek_acknowledged_by = actor_user_id

        new_snapshot = _snapshot(row)
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=actor_user_id,
                entity_type=AI_SETTINGS_ENTITY_TYPE,
                entity_id=str(AI_SETTINGS_SINGLETON_ID),
                operation=OPERATION_AI_SETTINGS_UPDATED,
                previous_values=previous,
                new_values=new_snapshot,
                request_id=request_id,
                result="SUCESSO",
            )
        )
        if acknowledge_now:
            self._db.add(
                AuditLog(
                    id=uuid.uuid4(),
                    actor_user_id=actor_user_id,
                    entity_type=AI_SETTINGS_ENTITY_TYPE,
                    entity_id=str(AI_SETTINGS_SINGLETON_ID),
                    operation=OPERATION_AI_DEEPSEEK_ACKNOWLEDGED,
                    previous_values={"deepseek_acknowledged": False},
                    new_values={"deepseek_acknowledged": True, "provider": PROVIDER_DEEPSEEK},
                    request_id=request_id,
                    result="SUCESSO",
                )
            )

        try:
            self._db.flush()
        except IntegrityError as exc:
            # Inserção concorrente da linha id=1 (banco sem seed): mesma
            # semântica de conflito de versão. O chamador faz o rollback.
            logger.warning("ai_settings: conflito ao gravar (%s)", type(exc).__name__)
            raise AISettingsVersionConflictError() from None

        return self._view(row)

    # ------------------------------------------------------------------
    def test_connection(self, config: AIConfig, *, actor_user_id: uuid.UUID) -> dict[str, Any]:
        """Teste com prompt fixo, sem dados do sistema. Nunca lança; sem
        mensagem do provedor na resposta."""
        try:
            service = AIService(
                config,
                settings=self._get_settings(),
                redis_client=self._redis,
                http_session=self._http_session,
            )
            outcome = service.test_connection(AIActor(user_id=actor_user_id))
            result, latency = outcome.result, outcome.latency_ms
        except Exception as exc:  # noqa: BLE001 - resposta sempre neutra
            logger.error("ai_settings: falha no teste de conexão (%s)", type(exc).__name__)
            result, latency = "unavailable", None
        if result not in ("ok", "disabled", "not_configured", "unavailable"):
            result = "unavailable"
        return {"result": result, "latency_ms": latency if isinstance(latency, int) else None}
