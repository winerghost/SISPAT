"""Testes de segurança — escopo por unidade (IDOR/BOLA, cenários 1, 2 e 4).

Os endpoints patrimoniais (bens, unidades, inventários, movimentações,
relatórios, exportações) AINDA NÃO EXISTEM (fora do escopo da Fase 1). Estes
testes validam os utilitários reutilizáveis que eles deverão usar
(`app.authorization.rbac`): `has_unit_access`, `require_unit_access`,
`get_accessible_unit_ids`, `units_outside_scope` e `apply_unit_scope`, com
uma rota de teste montada apenas neste arquivo e perfis ADM/USER/RH.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from flask import Blueprint, Flask, g, jsonify
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app.authorization.rbac import (
    apply_unit_scope,
    get_accessible_unit_ids,
    has_unit_access,
    require_unit_access,
    units_outside_scope,
)
from app.errors import register_error_handlers
from app.models.assets import Asset

UNIT_A = uuid.UUID("11111111-1111-4111-8111-111111111111")
UNIT_B = uuid.UUID("22222222-2222-4222-8222-222222222222")
UNIT_GHOST = uuid.UUID("33333333-3333-4333-8333-333333333333")  # inexistente

USERS = {
    "ADM": SimpleNamespace(id=uuid.UUID("aaaaaaaa-0000-4000-8000-000000000001"), active=True),
    "USER": SimpleNamespace(id=uuid.UUID("aaaaaaaa-0000-4000-8000-000000000002"), active=True),
    "RH": SimpleNamespace(id=uuid.UUID("aaaaaaaa-0000-4000-8000-000000000003"), active=True),
}
# Todos os perfis têm acesso apenas à unidade A (ADM NÃO tem bypass).
ACCESS = {(USERS[r].id, UNIT_A) for r in USERS}


class _FakeQuery:
    """Simula `db.query(UserUnitAccess).filter(...).first()` lendo os valores
    ligados às expressões SQLAlchemy (`coluna == valor`)."""

    def __init__(self):
        self._conds = []

    def filter(self, *conds):
        self._conds.extend(conds)
        return self

    def first(self):
        values = {c.left.key: c.right.value for c in self._conds}
        return object() if (values.get("user_id"), values.get("unit_id")) in ACCESS else None

    def all(self):
        values = {c.left.key: c.right.value for c in self._conds}
        return [(unit,) for (user, unit) in ACCESS if user == values.get("user_id")]


class _FakeSession:
    def query(self, *_entities):
        return _FakeQuery()


@contextmanager
def _fake_db():
    yield _FakeSession()


@pytest.fixture(autouse=True)
def _patch_db():
    with patch("app.authorization.rbac.get_db_session", _fake_db):
        yield


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


@pytest.fixture()
def app():
    app = Flask(__name__)
    register_error_handlers(app)
    bp = Blueprint("scope_test", __name__)

    def _login():
        from flask import request

        g.current_user = USERS[request.headers["X-Test-Role"]]

    bp.before_request(_login)

    @bp.route("/units/<uuid:unit_id>/assets", methods=["GET"])
    @require_unit_access("unit_id")
    def list_assets(unit_id):
        return jsonify({"unit_id": str(unit_id)})

    @bp.route("/units/<unit_id>/raw", methods=["GET"])
    @require_unit_access("unit_id")
    def raw(unit_id):
        return jsonify({"ok": True})

    @bp.route("/assets", methods=["POST"])
    @require_unit_access("unit_id", source="json")
    def create_asset():
        return jsonify({"ok": True}), 201

    @bp.route("/exports", methods=["GET"])
    @require_unit_access("unit_id", source="args")
    def export_assets():
        return jsonify({"ok": True})

    app.register_blueprint(bp)
    return app


@pytest.fixture()
def client(app):
    return app.test_client()


ROLES = ["ADM", "USER", "RH"]


# Cenário 1 — acesso entre unidades -------------------------------------------


@pytest.mark.parametrize("role", ROLES)
def test_leitura_da_propria_unidade_permitida(client, role):
    response = client.get(f"/units/{UNIT_A}/assets", headers={"X-Test-Role": role})
    assert response.status_code == 200


@pytest.mark.parametrize("role", ROLES)
def test_leitura_de_outra_unidade_negada_e_auditada(client, events, role):
    response = client.get(f"/units/{UNIT_B}/assets", headers={"X-Test-Role": role})
    assert response.status_code == 403
    assert events and events[0]["event_type"] == "UNIT_SCOPE_DENIED"
    assert events[0]["target"] == {"type": "unit", "id": str(UNIT_B)}


# Cenário 2 — alteração em outra unidade -------------------------------------


@pytest.mark.parametrize("role", ROLES)
def test_criacao_em_outra_unidade_negada(client, role):
    denied = client.post("/assets", json={"unit_id": str(UNIT_B)}, headers={"X-Test-Role": role})
    allowed = client.post("/assets", json={"unit_id": str(UNIT_A)}, headers={"X-Test-Role": role})
    missing = client.post("/assets", json={}, headers={"X-Test-Role": role})
    assert (denied.status_code, allowed.status_code, missing.status_code) == (403, 201, 403)


# Cenário 4 — exportações -----------------------------------------------------


@pytest.mark.parametrize("role", ROLES)
def test_exportacao_de_outra_unidade_negada(client, role):
    assert client.get(f"/exports?unit_id={UNIT_B}", headers={"X-Test-Role": role}).status_code == 403
    assert client.get(f"/exports?unit_id={UNIT_A}", headers={"X-Test-Role": role}).status_code == 200
    assert client.get("/exports", headers={"X-Test-Role": role}).status_code == 403


# Cenário 5 — enumeração -------------------------------------------------------


@pytest.mark.parametrize("role", ROLES)
def test_unidade_inexistente_e_alheia_tem_resposta_identica(client, role):
    other = client.get(f"/units/{UNIT_B}/assets", headers={"X-Test-Role": role})
    ghost = client.get(f"/units/{UNIT_GHOST}/assets", headers={"X-Test-Role": role})
    assert other.status_code == ghost.status_code == 403
    assert other.get_json() == ghost.get_json()


@pytest.mark.parametrize("bad", ["1", "2", "..", "' OR 1=1 --", "11111111"])
def test_id_malformado_negado_sem_consultar_banco(client, bad):
    with patch("app.authorization.rbac.get_db_session") as db:
        response = client.get(f"/units/{bad}/raw", headers={"X-Test-Role": "ADM"})
    assert response.status_code == 403
    db.assert_not_called()


# Helpers ---------------------------------------------------------------------


def test_has_unit_access_usuario_inativo_ou_ausente_negado():
    assert has_unit_access(None, UNIT_A) is False
    inactive = SimpleNamespace(id=USERS["ADM"].id, active=False)
    assert has_unit_access(inactive, UNIT_A) is False
    assert has_unit_access(USERS["ADM"], str(UNIT_A).upper()) is True


def test_get_accessible_unit_ids_e_units_outside_scope():
    db = _FakeSession()
    assert get_accessible_unit_ids(USERS["USER"].id, db) == {UNIT_A}
    assert get_accessible_unit_ids(None, db) == set()
    assert units_outside_scope(USERS["ADM"].id, [UNIT_A, UNIT_B, "x"], db) == [str(UNIT_B), "x"]


def test_apply_unit_scope_filtra_no_banco_e_escopo_vazio_nao_retorna_nada():
    query = Session().query(Asset)
    scoped = apply_unit_scope(query, Asset.unit_id, USERS["RH"].id, _FakeSession())
    sql = str(scoped.statement.compile(dialect=postgresql.dialect()))
    assert "assets.unit_id IN" in sql

    empty = apply_unit_scope(query, Asset.unit_id, uuid.uuid4(), _FakeSession())
    sql_empty = str(empty.statement.compile(dialect=postgresql.dialect()))
    assert "false" in sql_empty.lower()


def test_require_unit_access_sem_usuario_retorna_401(app):
    from werkzeug.exceptions import Unauthorized

    view = require_unit_access("unit_id")(lambda unit_id: "ok")
    with app.test_request_context("/"):
        with pytest.raises(Unauthorized):
            view(unit_id=UNIT_A)


def test_require_unit_access_source_invalido():
    with pytest.raises(ValueError):
        require_unit_access("unit_id", source="cookie")
