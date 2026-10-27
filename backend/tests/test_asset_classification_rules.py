"""Motor de classificação família/categoria/confiança (`classify_equipment`).

Regras determinísticas, sem IA e sem banco: só a função pura e os helpers de
persistência em memória. Os 22 casos de `FIXTURES` são o conjunto aprovado
(protótipo validado contra os 1.069 bens reais); os demais testes travam os
conflitos conhecidos (MESA x computador de mesa, GABINETE por contexto,
acessórios) e as correções D1, D2 e D3.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import asset_classification as ac

# (descrição, família, categoria, confiança esperada ou None = indiferente)
FIXTURES = [
    ("MICROCOMPUTADOR DE MESA DESKTOP THINKCENTRE M920S SFF / WINDOWS 10 PRO - "
     "ACOMPANHA: CADEADO COM TRAVA TUBULAR", "TI", "COMPUTADOR", None),
    ("GABINETE METAL CPU POS MASTER D610 PROCESSADOR CELERON DC G3900, 2.8, SR2HV "
     "TRAY DSK INTEL PLACA MAE: POS-PIB15", "TI", "COMPUTADOR", "ALTA"),
    ("NOTEBOOK . VAIO FE14 VJFE49F11X- BO111H PROC AMD RYZEM 5 5500U WINDOWS 11 PRO "
     "MEMORIA 16 GB SSD 256GB", "TI", "NOTEBOOK", None),
    ("COMPUTADOR MICROCOMPUTADOR NOTEBOOK TP E14, GEN 2, WINDOWS 10, PRO 64, MOUSE E "
     "TECLADO USB", "TI", "NOTEBOOK", None),
    ("MICROCOMPUTADOR THINKCENTRE ACOMPANHA: MONITOR", "TI", "COMPUTADOR", None),
    ("MICROCOMPUTADOR THINKCENTRE ACOMPANHA: ESTABILIZADOR", "TI", "COMPUTADOR", None),
    ("MONITOR LED 24 POLEGADAS", "TI", "MONITOR", None),
    ("HUB DOCKING STATION MULTIFUNCIONAL USB-C", "TI", "DOCKING", None),
    ("DOCKING STATION PARA NOTEBOOK LENOVO", "TI", "DOCKING", None),
    ("IMPRESSORA MULTIFUNCIONAL LASER", "TI", "IMPRESSORA", None),
    ("NOBREAK 1500VA BIVOLT", "TI", "NOBREAK", None),
    ("ESTABILIZADOR 300VA", "TI", "ESTABILIZADOR", None),
    ("CARREGADOR PARA NOTEBOOK", "OUTROS", "OUTROS", None),
    ("GAVETEIRO VOLANTE 3 GAVETAS", "MOBILIARIO", "GAVETEIRO", None),
    ("ARMARIO ALTO 2 PORTAS", "MOBILIARIO", "ARMARIO", None),
    ("MESA RETANGULAR 1,40 X 0,70", "MOBILIARIO", "MESA", None),
    ("MESA DE REUNIAO REDONDA", "MOBILIARIO", "MESA", None),
    ("ESTACAO DE TRABALHO EM L", "MOBILIARIO", "ESTACAO_TRABALHO", None),
    ("GABINETE DE ACO 2 PORTAS COM PRATELEIRA", "MOBILIARIO", "ARMARIO", "ALTA"),
    ("TELEFONE DE MESA IP", "OUTROS", "OUTROS", None),
    ("MESA DIGITALIZADORA WACOM", "OUTROS", "OUTROS", "BAIXA"),
    ("GABINETE ATX PRETO", "OUTROS", "OUTROS", "BAIXA"),
]


@pytest.mark.parametrize(
    "description,family,category,confidence", FIXTURES, ids=range(len(FIXTURES))
)
def test_fixtures_aprovadas(description, family, category, confidence) -> None:
    result = ac.classify_equipment(description)
    assert (result.family, result.category) == (family, category), result
    if confidence is not None:
        assert result.confidence == confidence, result
    assert result.rule  # a regra que decidiu é sempre registrada


def test_sem_regra_e_sem_descricao_vao_para_outros_baixa() -> None:
    for description in (None, "", "   ", "(123)", "OBJETO TOTALMENTE DESCONHECIDO"):
        result = ac.classify_equipment(description)
        assert (result.family, result.category, result.confidence) == ("OUTROS", "OUTROS", "BAIXA")
        assert result.rule in (ac.NO_RULE, ac.NO_DESCRIPTION_RULE)


def test_funcao_e_pura_e_nao_altera_a_descricao() -> None:
    description = "(00138020-6) MONITOR LED 24 POLEGADAS"
    first = ac.classify_equipment(description)
    second = ac.classify_equipment(description)
    assert first == second
    assert description == "(00138020-6) MONITOR LED 24 POLEGADAS"  # intacta


# --- D2: MESA x itens "de mesa" -----------------------------------------------------


@pytest.mark.parametrize(
    "description,expected",
    [
        # MESA como PRIMEIRO token vence as regras de TI (D2).
        ("MESA MADEIRA COMPUTADOR MESA PARA MICRO/TERMINAL DE COMPUTADOR BRANCA",
         ("MOBILIARIO", "MESA")),
        ("MESA PARA TERMINAL DE COMPUTADOR", ("MOBILIARIO", "MESA")),
        # "DE MESA" no meio da descrição não torna o bem um móvel.
        ("MICROCOMPUTADOR DE MESA DELL OPTIPLEX", ("TI", "COMPUTADOR")),
        ("COMPUTADOR DE MESA LENOVO", ("TI", "COMPUTADOR")),
        # Nem TI nem mobiliário: sem regra, OUTROS.
        ("TELEFONE DE MESA IP", ("OUTROS", "OUTROS")),
        ("LUMINARIA DE MESA", ("OUTROS", "OUTROS")),
        # Exceções explícitas de MESA (equipamentos de nome composto).
        ("MESA DIGITALIZADORA WACOM", ("OUTROS", "OUTROS")),
        ("MESA DE SOM 8 CANAIS", ("OUTROS", "OUTROS")),
    ],
)
def test_conflito_mesa(description, expected) -> None:
    result = ac.classify_equipment(description)
    assert (result.family, result.category) == expected, result


def test_mesa_excecao_fica_com_confianca_baixa_e_regra_explicita() -> None:
    result = ac.classify_equipment("MESA DIGITALIZADORA WACOM")
    assert result.confidence == "BAIXA"
    assert result.rule.startswith(f"{ac.MESA_RULE_PRIORITY}_MESA_EXCECAO:")


# --- GABINETE nos 3 contextos -------------------------------------------------------


@pytest.mark.parametrize(
    "description,expected,confidence",
    [
        ("GABINETE METAL INTEL CELERON SSD 240GB", ("TI", "COMPUTADOR"), "ALTA"),
        ("GABINETE DE ACO 2 PORTAS COM PRATELEIRA", ("MOBILIARIO", "ARMARIO"), "ALTA"),
        ("GABINETE DE MADEIRA 1,20 X 0,60", ("MOBILIARIO", "ARMARIO"), "ALTA"),
        ("GABINETE ATX PRETO", ("OUTROS", "OUTROS"), "BAIXA"),
        # Contexto dos dois lados: ambíguo, nunca "escolhe" um deles.
        ("GABINETE DE MADEIRA COM PROCESSADOR INTEL", ("OUTROS", "OUTROS"), "BAIXA"),
    ],
)
def test_gabinete_por_contexto(description, expected, confidence) -> None:
    result = ac.classify_equipment(description)
    assert (result.family, result.category, result.confidence) == (*expected, confidence), result
    assert result.rule.startswith(ac.GABINETE_RULE_PRIORITY)


# --- D1/D3: acessórios --------------------------------------------------------------


ACESSORIO_NO_FIM = [
    ("MICROCOMPUTADOR DE MESA DELL 3040 - OPTIPLEX 3020 MICRO - GABINETE TIPO MICRO "
     "PADRAO BTX - CABO DE ALIMENTACAO", "MICROCOMPUTADOR DE MESA DELL 3040"),
    ("NOTEBOOK DELL LATITUDE COM MALETA E CARREGADOR", "NOTEBOOK DELL LATITUDE"),
    ("MONITOR LED 24 COM SUPORTE DE PAREDE", "MONITOR LED 24"),
    ("IMPRESSORA LASER COM FONTE BIVOLT", "IMPRESSORA LASER"),
]


@pytest.mark.parametrize("description,sem_acessorio", ACESSORIO_NO_FIM)
def test_acessorio_citado_no_fim_nao_muda_a_categoria(description, sem_acessorio) -> None:
    """D1: o termo de acessório só vence quando é o ITEM PRINCIPAL."""
    com = ac.classify_equipment(description)
    sem = ac.classify_equipment(sem_acessorio)
    assert (com.family, com.category) == (sem.family, sem.category), (com, sem)
    assert com.family != "OUTROS"


def test_acessorios_nao_mudam_a_contagem_por_categoria() -> None:
    """A distribuição por categoria é a mesma com e sem a cauda de acessórios."""
    from collections import Counter

    com = Counter(ac.classify_equipment(d).category for d, _ in ACESSORIO_NO_FIM)
    sem = Counter(ac.classify_equipment(d).category for _, d in ACESSORIO_NO_FIM)
    assert com == sem
    assert sum(com.values()) == len(ACESSORIO_NO_FIM)  # nenhum item perdido/duplicado


@pytest.mark.parametrize("term", ac.ACCESSORY_TERMS)
def test_acessorio_como_item_principal_vai_para_outros(term) -> None:
    result = ac.classify_equipment(f"{term} PARA NOTEBOOK DELL")
    assert (result.family, result.category) == ("OUTROS", "OUTROS")
    assert result.rule == f"{ac.ACCESSORY_RULE_PRIORITY}_ACESSORIO:{term}"


@pytest.mark.parametrize("marker", ac.ACCESSORY_MARKERS)
def test_marcadores_de_acessorio_cortam_o_restante(marker) -> None:
    """D3: o que vem depois do marcador acompanha o bem, não o define."""
    result = ac.classify_equipment(f"MICROCOMPUTADOR DE MESA IMAC A1418, {marker} MONITOR, TECLADO")
    assert (result.family, result.category) == ("TI", "COMPUTADOR"), result


def test_d3_caso_real_composto_de_monitor() -> None:
    result = ac.classify_equipment(
        "MICROCOMPUTADOR DE MESA MARCA APPLE IMAC A1418, COMPOSTO DE MONITOR, TECLADO"
    )
    assert (result.family, result.category) == ("TI", "COMPUTADOR")


# --- vocabulário --------------------------------------------------------------------


def test_vocabulario_fechado_com_20_categorias_em_3_familias() -> None:
    assert ac.EQUIPMENT_FAMILIES == ("TI", "MOBILIARIO", "OUTROS")
    assert len(ac.TI_CATEGORIES) == 9 and len(ac.MOBILIARIO_CATEGORIES) == 9
    assert len(ac.OUTROS_CATEGORIES) == 2
    assert len(ac.EQUIPMENT_CATEGORIES) == 20
    assert len(set(ac.EQUIPMENT_CATEGORIES)) == 20  # sem duplicatas entre famílias
    assert set(ac.CATEGORY_FAMILY) == set(ac.EQUIPMENT_CATEGORIES)
    assert set(ac.EQUIPMENT_CATEGORIES_BY_FAMILY) == set(ac.EQUIPMENT_FAMILIES)
    assert ac.CLASSIFICATION_CONFIDENCES == ("ALTA", "BAIXA")
    # POLTRONA é categoria própria, separada de CADEIRA (decisão do usuário).
    assert ac.CATEGORY_FAMILY["POLTRONA"] == "MOBILIARIO"
    assert ac.classify_equipment("POLTRONA PRESIDENTE").category == "POLTRONA"
    assert ac.classify_equipment("CADEIRA GIRATORIA").category == "CADEIRA"


def test_rotulos_cobrem_o_vocabulario() -> None:
    assert set(ac.EQUIPMENT_FAMILY_LABELS) == set(ac.EQUIPMENT_FAMILIES) | {ac.NOT_CLASSIFIED}
    assert set(ac.EQUIPMENT_CATEGORY_LABELS) == set(ac.EQUIPMENT_CATEGORIES) | {ac.NOT_CLASSIFIED}
    assert set(ac.CONFIDENCE_LABELS) == set(ac.CLASSIFICATION_CONFIDENCES) | {ac.NOT_INFORMED}


def test_regras_sao_dados_consistentes_e_ordenados() -> None:
    priorities = [rule.priority for rule in ac.TERM_RULES]
    assert len(priorities) == len(set(priorities))  # prioridade é única
    for rule in ac.TERM_RULES:
        assert rule.stage in (1, 2)
        assert rule.family in ac.EQUIPMENT_FAMILIES
        assert rule.category in ac.EQUIPMENT_CATEGORIES_BY_FAMILY[rule.family]
        assert rule.terms and all(term == term.strip().upper() for term in rule.terms)
    # os grupos são contíguos: primeiro todos do estágio 1, depois do estágio 2
    stages = [rule.stage for rule in ac.TERM_RULES]
    assert stages == sorted(stages)


def test_toda_regra_cabe_nos_checks_do_banco() -> None:
    assert len(ac.RULES_VERSION) <= ac.CLASSIFICATION_RULES_VERSION_MAX
    assert ac.RULES_VERSION == ac.RULES_VERSION.strip()
    descriptions = [d for d, *_ in FIXTURES] + [d for d, _ in ACESSORIO_NO_FIM]
    descriptions += [f"{t} X" for t in ac.ACCESSORY_TERMS]
    descriptions += [term for rule in ac.TERM_RULES for term in rule.terms]
    for description in descriptions:
        rule = ac.classify_equipment(description).rule
        assert 1 <= len(rule) <= ac.CLASSIFICATION_RULE_MAX
        assert rule == rule.strip()


def test_vocabulario_legado_da_0015_continua_intacto() -> None:
    """Regressão: o motor novo foi ADICIONADO, não substituiu o vocabulário
    legado (CHECKs da 0015, painéis de Tecnologia, filtro de Bens)."""
    assert ac.CATEGORIES == ("TECNOLOGIA", "MOBILIARIO", "VEICULO", "EQUIPAMENTO", "OUTROS")
    assert ac.TECH_TYPES == ("COMPUTADOR", "NOTEBOOK", "MONITOR", "IMPRESSORA", "OUTRO_TI")
    assert ac.OPERATIONAL_STATUSES == ("EM_USO", "ESTOQUE", "MANUTENCAO", "BAIXADO")
    assert ac.classify_description("(1) NOTEBOOK DELL") == ("TECNOLOGIA", "NOTEBOOK")
    legado = SimpleNamespace(asset_category=None, tech_type=None)
    assert ac.apply_if_unclassified(legado, "NOTEBOOK X") is True
    assert (legado.asset_category, legado.tech_type) == ("TECNOLOGIA", "NOTEBOOK")


# --- persistência (sem banco) -------------------------------------------------------


def _asset(**kw):
    base = {name: None for name in ac.CLASSIFICATION_COLUMNS}
    base["category_override"] = None
    base.update(kw)
    return SimpleNamespace(**base)


def test_apply_grava_as_cinco_colunas_e_e_idempotente() -> None:
    asset = _asset()
    assert ac.would_reclassify(asset, "MONITOR LED 24") is True
    assert ac.apply_equipment_classification(asset, "MONITOR LED 24") is True
    assert (asset.equipment_family, asset.equipment_category) == ("TI", "MONITOR")
    assert asset.classification_confidence == "ALTA"
    assert asset.classification_rule.startswith("6_MONITOR")
    assert asset.classification_rules_version == ac.RULES_VERSION
    # 2ª aplicação não altera nada (idempotente)
    assert ac.apply_equipment_classification(asset, "MONITOR LED 24") is False
    assert ac.would_reclassify(asset, "MONITOR LED 24") is False


def test_override_do_adm_prevalece_e_nunca_e_escrito() -> None:
    asset = _asset(
        category_override="MESA",
        equipment_family="TI",
        equipment_category="MONITOR",
        classification_confidence="ALTA",
        classification_rule="6_MONITOR:MONITOR",
        classification_rules_version=ac.RULES_VERSION,
    )
    assert ac.apply_equipment_classification(asset, "NOTEBOOK DELL") is False
    assert ac.would_reclassify(asset, "NOTEBOOK DELL") is False
    assert asset.category_override == "MESA"
    assert asset.equipment_category == "MONITOR"  # regra anterior preservada
    assert ac.effective_equipment_category(asset) == "MESA"
    assert ac.effective_equipment_family(asset) == "MOBILIARIO"


def test_bem_sem_descricao_nao_recebe_classificacao_ficticia() -> None:
    for description in (None, "", "   "):
        asset = _asset()
        assert ac.apply_equipment_classification(asset, description) is False
        assert ac.would_reclassify(asset, description) is False
        assert all(getattr(asset, name) is None for name in ac.CLASSIFICATION_COLUMNS)
        assert ac.effective_equipment_category(asset) is None


def test_mudanca_de_descricao_e_de_versao_de_regras_reclassifica(monkeypatch) -> None:
    asset = _asset()
    ac.apply_equipment_classification(asset, "MONITOR LED 24")
    assert ac.would_reclassify(asset, "NOTEBOOK DELL") is True
    asset.classification_rules_version = "0"  # classificado por regra antiga
    assert ac.would_reclassify(asset, "MONITOR LED 24") is True
    assert ac.apply_equipment_classification(asset, "MONITOR LED 24") is True
    assert asset.classification_rules_version == ac.RULES_VERSION
