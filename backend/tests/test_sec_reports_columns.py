"""Regressão AppSec: casos de borda de `columns` na exportação de relatórios."""
from __future__ import annotations

import pytest
from test_reports_api import add_asset, api, csv_rows, export  # noqa: F401


@pytest.mark.parametrize("query", [
    "?columns=description%00", "?columns=description%0d%0ax", "?columns=%3Cscript%3E",
    "?columns=description%EF%BC%8Cpatrimony_number", "?columns=descri%C3%A7%C3%A3o",
    "?columns=DESCRIPTION", "?columns=description;patrimony_number",
])
def test_chaves_com_unicode_controle_ou_case_sao_400_sem_eco(api, query):
    response = export(api, "assets", query)
    assert response.status_code == 400
    body = response.get_data(as_text=True)
    assert "script" not in body and "descri" not in body.replace("invalid_columns", "")


def test_espacos_ao_redor_das_chaves_sao_tolerados_e_alinhados(api):
    add_asset(api, api.ua, "7", description="Cadeira")
    rows = csv_rows(export(api, "assets", "?columns=%20description%20,%20patrimony_number"))
    assert rows == [["Nº patrimonial", "Descrição"], ["7", "Cadeira"]]
