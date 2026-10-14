"""Testes de regressão — XSS armazenado via dados importados (resposta JSON).

Auditoria AppSec 2026-10-13 (backend-data). O backend NUNCA renderiza
HTML: devolve JSON (`application/json`) e preserva o texto original da
planilha; a defesa contra XSS é o escape contextual no frontend (React).
Sem rede, sem banco.
"""
from __future__ import annotations

import json
import uuid

from flask import jsonify

from app import create_app
from app.api.v1.imports import _serialize_item
from app.models.imports import ImportPreviewItem

_PAYLOAD = '<img src=x onerror="alert(1)"><script>alert(2)</script>'


def test_item_com_html_e_serializado_como_json_sem_alteracao() -> None:
    app = create_app()
    item = ImportPreviewItem(
        id=uuid.uuid4(),
        preview_id=uuid.uuid4(),
        source_record_id="1",
        patrimony_number="000123",
        description=_PAYLOAD,
        classification="NOVO",
        selected=True,
        validation_errors=None,
    )
    with app.test_request_context("/"):
        response = jsonify({"items": [_serialize_item(item)]})

    assert response.mimetype == "application/json"
    body = json.loads(response.get_data(as_text=True))
    # texto preservado (sem sanitização destrutiva) e dentro de string JSON
    assert body["items"][0]["description"] == _PAYLOAD
    assert body["items"][0]["patrimony_number"] == "000123"


def test_rotas_inexistentes_respondem_json_e_nao_html() -> None:
    client = create_app().test_client()
    response = client.get(f"/api/v1/nao-existe/{_PAYLOAD}")
    assert response.status_code == 404
    assert response.mimetype == "application/json"
    assert "<script>" not in response.get_data(as_text=True)
