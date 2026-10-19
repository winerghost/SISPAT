"""Testes dos normalizadores puros dos cadastros (exemplos reais do usuário)."""
from __future__ import annotations

import pytest

from app.services.catalog_normalizer import (
    clean_text,
    is_placeholder_person,
    normalize_person_name,
    normalize_room_name,
    parse_person_email,
    parse_phone,
    room_key,
    room_probable_duplicate_key,
    suspicious_name_reasons,
)


def test_nome_remove_sufixo_traco_e_colapsa_espacos() -> None:
    assert normalize_person_name("ERICA LISSANDRA BERTOLOSSI DANTAS -") == (
        "ERICA LISSANDRA BERTOLOSSI DANTAS"
    )
    assert normalize_person_name("MANOEL NASCIMENTO DOS SANTOS ") == "MANOEL NASCIMENTO DOS SANTOS"
    assert normalize_person_name("  ANA   MARIA  ") == "ANA MARIA"
    assert normalize_person_name("ANA-MARIA") == "ANA-MARIA"  # hífen interno preservado
    assert normalize_person_name("   ") is None


def test_grafia_nao_e_corrigida_apenas_sinalizada() -> None:
    name = normalize_person_name("JÕAO GUILHERME VILLANOVA VIDAL")
    assert name == "JÕAO GUILHERME VILLANOVA VIDAL"  # inalterado
    assert suspicious_name_reasons(name)
    for ok in (
        "CLEITON GOMES BANDEIRA",
        "KEILY CRISTINY AZEVEDO LEITE",
        "JOÃO DA SILVA",
        "SEBASTIÃO LIMA",
        "MARIA DE FÁTIMA SOUZA",
        "CARLOS SILVA DOS SANTOS",
    ):
        assert suspicious_name_reasons(ok) == [], ok
    assert suspicious_name_reasons("ANA 2 SILVA")
    assert suspicious_name_reasons("ANA#SILVA")


@pytest.mark.parametrize(
    "value,expected",
    [
        ("cleiton.bandera@agu.gov.br", "cleiton.bandera@agu.gov.br"),
        ("newton.campos@AGU.GOV.BR", "newton.campos@agu.gov.br"),
        ("  keily.leite@agu.gov.br ", "keily.leite@agu.gov.br"),
        (None, None),
        ("", None),
    ],
)
def test_email_minusculo_e_validado(value, expected) -> None:
    email, problem = parse_person_email(value)
    assert email == expected
    assert problem is None


def test_email_sem_dominio_valido_e_problema() -> None:
    assert parse_person_email("Ocioso@ocioso") == (None, "e-mail sem formato/domínio válido")
    assert parse_person_email("sem-arroba")[1]


def test_ocioso_nao_e_pessoa() -> None:
    assert is_placeholder_person("Ocioso", "Ocioso@ocioso")
    assert is_placeholder_person("OCIOSO", None)
    assert is_placeholder_person("Fulano", "ocioso@ocioso")
    assert not is_placeholder_person("CLEITON GOMES BANDEIRA", "cleiton.bandera@agu.gov.br")


@pytest.mark.parametrize(
    "value,expected",
    [
        ("5563984069566", "5563984069566"),
        ("5563991027317", "5563991027317"),
        ("(63) 98406-9566", "63984069566"),
        ("6334567890", "6334567890"),
        (None, None),
    ],
)
def test_telefone_so_digitos_com_ou_sem_55(value, expected) -> None:
    phone, warning = parse_phone(value)
    assert phone == expected
    assert warning is None


@pytest.mark.parametrize("value", ["123", "1234567890123456", "4463984069566"])
def test_telefone_invalido_vira_none_com_aviso(value) -> None:
    phone, warning = parse_phone(value)
    assert phone is None
    assert warning and warning.startswith("aviso:")


SALAS_REAIS = {
    "897bb3a9": "2",
    "897bb3a10": "3",
    "3cfe560c": "9",
    "c7fe6a6e": "11",
    "6d8e7c12": "13",
    "c3872cae": "30 A",
    "38599d91": "Auditório",
    "5cdd6692": "07 - Amamentação",
    "b628c38b": "07 - ANM",
    "dad16e14": "06",
    "f96128de": "6",
    "452be58b": "Sala do servidor ANTT",
}


def test_salas_reais_chaves_distintas_e_provaveis_duplicatas() -> None:
    keys = {sid: room_key(normalize_room_name(n)) for sid, n in SALAS_REAIS.items()}
    assert len(set(keys.values())) == len(keys)  # 06 e 6 são distintas
    assert room_key("Sala  do   Servidor ANTT") == room_key("sala do servidor antt")
    assert room_probable_duplicate_key("06") == room_probable_duplicate_key("6")
    assert room_probable_duplicate_key("07 - ANM") != room_probable_duplicate_key("07 - Amamentação")
    assert room_probable_duplicate_key("Auditório") == room_probable_duplicate_key("auditorio")
    assert room_probable_duplicate_key("2") != room_probable_duplicate_key("29")


def test_nome_de_sala_vazio_ou_longo_e_invalido() -> None:
    assert normalize_room_name("  ") is None
    assert normalize_room_name("x" * 201) is None
    assert normalize_room_name("  30   A ") == "30 A"
    assert clean_text(None) is None
