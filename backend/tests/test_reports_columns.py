"""Seleção de colunas da exportação de relatórios (`columns=a,b`), ponta a ponta.

Reaproveita fixture e helpers de `test_reports_api`. Contrato: ausente => todas;
allowlist do catálogo do perfil; vazia/duplicada/desconhecida/fora do perfil => 400
`invalid_columns`; ordem do catálogo; cabeçalho e linhas alinhados (CSV e XLSX).
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from test_reports_api import (  # noqa: F401  (api = fixture)
    add_asset,
    api,
    csv_rows,
    export,
    get,
    types,
    xlsx_cells,
)

from app.models.audit import AuditLog
from app.services.report_catalog import REPORTS


def _keys(kind, who="ua"):
    internal = who != "rh"
    return [c.key for c in REPORTS[kind].columns if (internal or not c.internal) and c.key != "deleted_at"]


def _labels(kind, keys):
    by_key = {c.key: c.label for c in REPORTS[kind].columns}
    return [by_key[k] for k in keys]


def test_catalogo_expoe_key_e_label(api):
    for report in get(api, "").get_json()["reports"]:
        assert all(set(c) == {"key", "label"} for c in report["columns"])


def test_sem_parametro_exporta_todas_as_colunas(api):
    add_asset(api, api.ua, "1")
    assert csv_rows(export(api, "assets"))[0] == _labels("assets", _keys("assets"))


def test_todas_as_chaves_explicitas_igual_sem_parametro(api):
    add_asset(api, api.ua, "1", notes="n")
    every = ",".join(_keys("assets"))
    explicit = csv_rows(export(api, "assets", f"?columns={every}"))
    assert explicit[0] == csv_rows(export(api, "assets"))[0]
    assert len(explicit[1]) == len(explicit[0])


def test_poucas_colunas_csv_na_ordem_do_catalogo_e_alinhadas(api):
    add_asset(api, api.ua, "42", description="Mesa")
    rows = csv_rows(export(api, "assets", "?columns=description,patrimony_number"))
    assert rows[0] == ["Nº patrimonial", "Descrição"]  # catálogo, não a ordem da requisição
    assert rows[1] == ["42", "Mesa"]


def test_varias_colunas_xlsx_alinhadas(api):
    add_asset(api, api.ua, "42", description="Mesa", bond_status="Servidor")
    rows = xlsx_cells(export(api, "assets", "?format=xlsx&columns=bond_status,description,patrimony_number"))
    assert [c[1] for c in rows[0]] == ["Nº patrimonial", "Descrição", "Vínculo"]
    assert [c[1] for c in rows[1]] == ["42", "Mesa", "Servidor"]


@pytest.mark.parametrize("kind", ["assets", "movements", "inventory-items"])
def test_coluna_unica_por_relatorio(api, kind):
    key = REPORTS[kind].columns[0].key
    assert csv_rows(export(api, kind, f"?columns={key}"))[0] == _labels(kind, [key])


@pytest.mark.parametrize("query", [
    "?columns=", "?columns=,", "?columns=patrimony_number,", "?columns=,description",
    "?columns=patrimony_number,,description", "?columns=%20", "?columns=patrimony_number,patrimony_number",
    "?columns=nao_existe", "?columns=patrimony_number,password", "?columns=Patrimony_Number",
    "?columns=" + "a" * 600,
])
@pytest.mark.parametrize("fmt", ["csv", "xlsx"])
def test_colunas_invalidas_400_invalid_columns(api, query, fmt):
    response = export(api, "assets", f"{query}&format={fmt}")
    assert response.status_code == 400
    body = response.get_json()
    assert body["error"]["code"] == "invalid_columns"
    assert "nao_existe" not in str(body) and "password" not in str(body)


def test_columns_repetido_400(api):
    assert export(api, "assets", "?columns=description&columns=room").status_code == 400


def test_chave_de_outro_relatorio_e_invalida(api):
    assert export(api, "assets", "?columns=movement_type").status_code == 400
    assert export(api, "movements", "?columns=movement_type").status_code == 200


def test_rh_nao_amplia_acesso_com_columns(api):
    add_asset(api, api.ua, "1", notes="SEGREDO-NOTA")
    response = export(api, "assets", "?columns=patrimony_number,notes", who="rh")
    assert response.status_code == 400 and response.get_json()["error"]["code"] == "invalid_columns"
    assert b"SEGREDO" not in response.data
    assert types(api, "ACCESS_DENIED")
    ok = export(api, "assets", "?columns=patrimony_number,description", who="rh")
    assert ok.status_code == 200 and csv_rows(ok)[0] == ["Nº patrimonial", "Descrição"]
    assert export(api, "movements", "?columns=reason", who="rh").status_code == 400
    assert export(api, "inventory-items", "?columns=notes", who="rh").status_code == 400
    assert export(api, "assets", "?columns=notes", who="ua").status_code == 200


def test_deleted_at_exige_include_deleted(api):
    add_asset(api, api.ua, "1")
    assert export(api, "assets", "?columns=deleted_at").status_code == 400  # nada a exportar
    assert csv_rows(export(api, "assets", "?columns=patrimony_number,deleted_at"))[0] == ["Nº patrimonial"]
    adm = export(api, "assets", "?columns=patrimony_number,deleted_at&include_deleted=true", "adm", "aal2")
    assert csv_rows(adm)[0] == ["Nº patrimonial", "Excluído em (UTC)"]


def test_filtros_e_escopo_combinados_com_columns(api):
    add_asset(api, api.ua, "100", description="Notebook Dell")
    add_asset(api, api.ua, "200", description="Mesa")
    add_asset(api, api.ub, "300", description="Notebook alheio")
    rows = csv_rows(export(api, "assets", "?q=notebook&columns=description,patrimony_number&sort=-patrimony_number"))
    assert rows == [["Nº patrimonial", "Descrição"], ["100", "Notebook Dell"]]
    assert export(api, "assets", f"?unit_id={api.ub}&columns=description").status_code == 404
    assert len(csv_rows(export(api, "assets", "?columns=description", who="none"))) == 1


def test_formula_injection_em_colunas_selecionadas(api):
    add_asset(api, api.ua, "=1+1", description="@SUM(A1)")
    assert csv_rows(export(api, "assets", "?columns=description,patrimony_number"))[1] == ["'=1+1", "'@SUM(A1)"]
    cells = xlsx_cells(export(api, "assets", "?format=xlsx&columns=description,patrimony_number"))[1]
    assert all(text.startswith("'") for _, text in cells)


def test_auditoria_registra_colunas_exportadas_sem_conteudo(api):
    add_asset(api, api.ua, "SENHA-1", description="x")
    export(api, "assets", "?columns=description,patrimony_number")
    export(api, "assets", "?columns=nao_existe")
    with api.w.session() as db:
        logs = db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()
    assert len(logs) == 1 and logs[0].new_values["columns"] == ["patrimony_number", "description"]
    assert "SENHA" not in str(logs[0].new_values)
