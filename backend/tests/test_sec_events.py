"""Testes de segurança — registro estruturado de eventos em `audit_logs` (A09).

Valida `app.authorization.security_events`: formato estável (pronto para
notificação futura via n8n externo, sem chamá-lo), ausência de dados
sensíveis, gravação em `AuditLog` e resiliência (falha ao gravar nunca
derruba a requisição; fila limitada contra amplificação).
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from flask import Flask, g

from app.authorization import security_events as se
from app.models.audit import AuditLog


def test_evento_estruturado_tem_campos_estaveis_e_sem_dados_sensiveis():
    app = Flask(__name__)
    actor = uuid.uuid4()
    with app.test_request_context(
        "/api/v1/users/invite", method="POST", headers={"Authorization": "Bearer SEGREDO"}
    ):
        g.current_user = type("U", (), {"id": actor})()
        event = se.build_security_event(
            se.EVENT_PRIVILEGE_ESCALATION_ATTEMPT,
            severity=se.SEVERITY_HIGH,
            details={"fields": ["role"], "texto": "x" * 1000},
        )
    assert event["schema"] == "sispat.security_event/v1"
    assert event["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"
    assert event["notify"] is True
    assert event["actor_user_id"] == str(actor)
    assert event["request"]["method"] == "POST"
    assert event["request"]["path"] == "/api/v1/users/invite"
    assert event["request"]["request_id"]
    assert len(event["details"]["texto"]) <= 301
    assert "SEGREDO" not in repr(event) and "Bearer" not in repr(event)
    uuid.UUID(event["event_id"])


def test_persist_event_grava_audit_log_com_mapeamento_correto():
    session = MagicMock()

    @contextmanager
    def fake_db():
        yield session

    event = se.build_security_event(
        se.EVENT_ACCESS_DENIED, actor_user_id=uuid.uuid4(), target_type="user", target_id="alvo-1"
    )
    with patch("app.database.session.get_db_session", fake_db):
        se._persist_event(event)
    added = session.add.call_args.args[0]
    assert isinstance(added, AuditLog)
    assert added.entity_type == "security_event"
    assert added.entity_id == "alvo-1"
    assert added.operation == "ACCESS_DENIED"
    assert added.result == "FALHA"
    assert added.new_values["schema"] == "sispat.security_event/v1"


def test_falha_no_dispatch_nao_propaga_excecao():
    with patch.object(se, "_dispatch", side_effect=RuntimeError("banco fora do ar")):
        event = se.record_security_event(se.EVENT_AUTH_FAILED)
    assert event is not None and event["event_type"] == "AUTH_FAILED"


def test_fila_limitada_descarta_sem_bloquear():
    writer = se._BackgroundAuditWriter(max_size=1)
    with patch.object(writer, "_ensure_started"):
        assert writer.submit({"event_type": "A"}) is True
        assert writer.submit({"event_type": "B"}) is False


def test_escritor_em_segundo_plano_grava_e_sobrevive_a_falhas():
    writer = se._BackgroundAuditWriter(max_size=10)
    persisted: list[str] = []

    def fake_persist(event):
        if event["event_type"] == "FALHA":
            raise RuntimeError("erro de banco")
        persisted.append(event["event_type"])

    with patch.object(se, "_persist_event", side_effect=fake_persist):
        writer.submit({"event_type": "FALHA"})
        writer.submit({"event_type": "OK"})
        writer._queue.join()
    assert persisted == ["OK"]


def test_requisicao_continua_quando_auditoria_falha():
    """Mesmo com o banco de auditoria indisponível, a negação (403) segue normal."""
    from app.authorization.rbac import require_role

    app = Flask(__name__)
    view = require_role("ADM")(lambda: "ok")
    with patch.object(se, "_persist_event", side_effect=RuntimeError("fora do ar")):
        with app.test_request_context("/"):
            g.current_user = type("U", (), {"id": uuid.uuid4()})()
            g.current_user_roles = {"USER"}
            from werkzeug.exceptions import Forbidden

            try:
                view()
            except Forbidden:
                pass
            else:  # pragma: no cover
                raise AssertionError("esperava 403")
