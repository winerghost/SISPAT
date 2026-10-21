"""Revisão AppSec 2026-10-21 — filtros do dashboard combinados (IDOR) e expurgo de prévias.

Relatório: docs/security/SECURITY_AUDIT.md (rodada 2026-10-21).

Complementa `test_sec_vinculo_filtros.py` (IDs isolados) e
`test_import_preview_purge.py` (funcional):

- IDs de outra unidade COMBINADOS com os filtros novos (`has_room`, `located`,
  `bond_status=__none__`) dão a MESMA resposta de um UUID inexistente, em todos
  os agregados, também para RH e para ADM em AAL2;
- valores fora da allowlist de `has_room`/`located` -> 400 sem eco;
- expurgo: `audit_logs` anteriores, `raw_import_records`, `sync_jobs` e
  `assets` ficam intactos; a saída da CLI e a auditoria não trazem conteúdo
  das prévias (patrimônio, nomes, e-mails) nem IDs; `--older-than-days` não
  aceita fração/notação estranha.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import func, select
from test_import_preview_purge import NOW, cli, engine, seed  # noqa: F401
from test_sec_vinculo_filtros import DASH, _seed_two_units, api, dash  # noqa: F401

from _catalog_db import new_session
from app.models.audit import AuditLog
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.sync import RawImportRecord, SyncJob
from app.services.import_preview_purge import OPERATION_PURGED, purge_import_previews

# --- Dashboard: IDOR com filtros combinados -------------------------------------------

COMBOS = [
    {"has_room": "true"},
    {"has_room": "false"},
    {"located": "NAO"},
    {"bond_status": "__none__"},
    {"bond_status": "VinculoSecretoB"},
    {"has_room": "true", "located": "NAO", "bond_status": "VinculoSecretoB"},
]


@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
@pytest.mark.parametrize("field", ["unit_id", "room_id"])
@pytest.mark.parametrize("extra", COMBOS)
def test_id_alheio_combinado_igual_a_inexistente(api, who, aal, field, extra):
    room_b, _person_b = _seed_two_units(api)
    alien = {"unit_id": api.ub, "room_id": room_b}[field]
    for name in DASH:
        real = dash(api, name, who, aal, **{field: str(alien)}, **extra)
        ghost = dash(api, name, who, aal, **{field: str(uuid.uuid4())}, **extra)
        assert real.status_code == ghost.status_code == 200, (name, extra)
        assert real.get_json() == ghost.get_json(), (name, field, extra)
        text = real.get_data(as_text=True)
        for secret in ("Secreta", "VinculoSecretoB", "COFRE", "UB"):
            assert secret not in text, (name, secret)


@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
def test_filtro_de_vinculo_de_outra_unidade_nao_e_oraculo(api, who, aal):
    """`bond_status` existente só na outra unidade == valor que não existe."""
    _seed_two_units(api)
    for name in DASH:
        real = dash(api, name, who, aal, bond_status="VinculoSecretoB")
        ghost = dash(api, name, who, aal, bond_status="NaoExisteEmLugarNenhum")
        assert real.get_json() == ghost.get_json(), name


@pytest.mark.parametrize(
    "params",
    [
        {"has_room": "yes"},
        {"has_room": "TRUE"},
        {"has_room": "true' OR '1'='1"},
        {"located": "sim"},
        {"located": "SIM;DROP TABLE assets"},
        {"room_id": "../../etc/passwd"},
        {"unit_id": "00000000-0000-0000-0000-00000000000g"},
        {"bond_status": "Ocioso\u0000"},
    ],
)
def test_valores_fora_da_allowlist_400_sem_eco(api, params):
    _seed_two_units(api)
    for name in ("resumo", "por-sala", "por-vinculo"):
        response = dash(api, name, **params)
        assert response.status_code == 400, (name, params)
        body = response.get_data(as_text=True)
        for value in params.values():
            assert value not in body


# --- Expurgo de prévias -------------------------------------------------------------


def _snapshot(engine, model, *cols):
    with new_session(engine) as db:
        return sorted(tuple(str(getattr(r, c)) for c in cols) for r in db.execute(select(model)).scalars())


def test_expurgo_preserva_auditoria_anterior_e_trilha_permanente(engine, seed):
    with new_session(engine) as db:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=None,
                entity_type="import_previews",
                entity_id=str(seed["confirmada_velha"]),
                operation="IMPORT_CONFIRMED",
                previous_values=None,
                new_values={"preview_id": str(seed["confirmada_velha"])},
                result="SUCESSO",
            )
        )
        db.commit()
    audits_before = _snapshot(engine, AuditLog, "id", "operation", "entity_id", "new_values")
    raw_before = _snapshot(engine, RawImportRecord, "id", "source_record_id", "raw_values", "import_status")
    jobs_before = _snapshot(engine, SyncJob, "id", "status")

    with new_session(engine) as db:
        purge_import_previews(db, older_than_days=7, now=NOW)
        db.commit()

    audits_after = _snapshot(engine, AuditLog, "id", "operation", "entity_id", "new_values")
    assert set(audits_before) <= set(audits_after)  # nada apagado/alterado
    assert len(audits_after) == len(audits_before) + 1  # só o IMPORT_PREVIEWS_PURGED
    assert _snapshot(engine, RawImportRecord, "id", "source_record_id", "raw_values", "import_status") == raw_before
    assert _snapshot(engine, SyncJob, "id", "status") == jobs_before


def test_cli_e_auditoria_sem_conteudo_das_previas(cli, engine, seed):
    pii = {"PATRIMONIO": "PII-0001", "RESPONSAVEL": "Maria Sintetica da Silva", "USUARIO": "maria@agu.gov.br"}
    with new_session(engine) as db:
        db.add(
            ImportPreviewItem(
                id=uuid.uuid4(),
                preview_id=seed["expirada_velha"],
                raw_values=pii,
                classification="NOVO",
                created_at=NOW,
            )
        )
        db.commit()
    for args in (["purge-import-previews", "--dry-run"], ["purge-import-previews"]):
        result = cli.invoke(args=args)
        assert result.exit_code == 0, result.output
        for value in list(pii.values()) + [str(v) for v in seed.values()]:
            assert value not in result.output
    with new_session(engine) as db:
        (audit,) = db.execute(select(AuditLog).where(AuditLog.operation == OPERATION_PURGED)).scalars()
        dumped = json.dumps([audit.previous_values, audit.new_values, audit.entity_id])
        count = db.execute(select(func.count()).select_from(ImportPreview)).scalar_one()
    for value in list(pii.values()) + [str(v) for v in seed.values()]:
        assert value not in dumped
    assert count == 4


@pytest.mark.parametrize("value", ["7.5", "1e3", "0x7", " 7; DELETE", "365000", ""])
def test_cli_rejeita_dias_malformados(cli, engine, seed, value):
    result = cli.invoke(args=["purge-import-previews", "--older-than-days", value])
    assert result.exit_code != 0
    with new_session(engine) as db:
        assert db.execute(select(func.count()).select_from(ImportPreview)).scalar_one() == len(seed)
