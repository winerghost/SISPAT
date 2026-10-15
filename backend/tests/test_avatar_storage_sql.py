"""Estático: SQL do bucket `avatars` (0008, NÃO aplicado) — privado, só backend."""
from __future__ import annotations

import re
from pathlib import Path

SQL = (Path(__file__).resolve().parents[1] / "migrations" / "sql" / "0008_storage_avatars.sql").read_text(
    encoding="utf-8"
)
CODE = re.sub(r"--[^\n]*", "", SQL)


def test_cabecalho_declara_nao_aplicado():
    assert "NÃO APLICADO — requer autorização" in SQL


def test_bucket_privado_com_limites():
    assert re.search(r"VALUES \('avatars', 'avatars', false, 1048576, ARRAY\['image/webp'\]\)", CODE)
    assert "SET public = false" in CODE
    assert not re.search(r"public\s*=\s*true|,\s*true\s*,", CODE, re.IGNORECASE)


def test_nenhum_acesso_para_papeis_de_cliente():
    assert re.search(r"AS RESTRICTIVE\s+FOR ALL\s+TO anon, authenticated", CODE)
    assert "USING (bucket_id <> 'avatars')" in CODE and "WITH CHECK (bucket_id <> 'avatars')" in CODE
    assert not re.search(r"\bGRANT\b", CODE, re.IGNORECASE)
    assert not re.search(r"AS\s+PERMISSIVE", CODE, re.IGNORECASE)
    # Nenhuma política permissiva para anon/authenticated (CREATE POLICY sem RESTRICTIVE).
    for match in re.finditer(r"CREATE POLICY.*?;", CODE, re.S):
        assert "AS RESTRICTIVE" in match.group(0)


def test_idempotente_e_nao_destrutivo():
    assert "ON CONFLICT (id) DO UPDATE" in CODE and "IF NOT EXISTS" in CODE
    assert not re.search(r"\b(DROP|DELETE|TRUNCATE)\b", CODE, re.IGNORECASE)
