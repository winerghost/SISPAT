"""Vocabulário fechado e regra de classificação de bens (categoria / tipo de TI).

Fonte única dos valores aceitos nas colunas `assets.asset_category`,
`assets.tech_type` e `assets.operational_status` (migração
`0015_asset_tech_classification`; os CHECKs do banco espelham estas tuplas e um
teste garante a igualdade).

REGRA DE CLASSIFICAÇÃO (`classify_description`): determinística, a partir do
"tipo" inferido da descrição (`dashboard_service.infer_type`: primeira palavra
após o "(codigo_material)" inicial, maiúscula e sem acento). Palavra
desconhecida => `(None, None)`: NADA é inventado ("não informado"/"não
classificado"). A regra só preenche campos NULOS: é usada pela importação (bem
novo ou existente com categoria nula) e pelo comando `flask classify-assets`
(dry-run por padrão). `operational_status` nunca é deduzido.

MOTOR DE CLASSIFICAÇÃO FAMÍLIA/CATEGORIA (segunda metade deste módulo, a
partir de `RULES_VERSION`): vocabulário estendido (3 famílias x 20 categorias)
gravado nas colunas `assets.equipment_family`, `assets.equipment_category`,
`assets.classification_confidence`, `assets.classification_rule` e
`assets.classification_rules_version` (migração
`0018_equipment_classification`). Convive com o vocabulário legado acima, que
continua sendo a fonte dos CHECKs da 0015 e dos painéis de Tecnologia; os dois
são independentes e NÃO se sobrescrevem.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

CATEGORIES: tuple[str, ...] = ("TECNOLOGIA", "MOBILIARIO", "VEICULO", "EQUIPAMENTO", "OUTROS")
TECH_TYPES: tuple[str, ...] = ("COMPUTADOR", "NOTEBOOK", "MONITOR", "IMPRESSORA", "OUTRO_TI")
OPERATIONAL_STATUSES: tuple[str, ...] = ("EM_USO", "ESTOQUE", "MANUTENCAO", "BAIXADO")

NOT_CLASSIFIED = "NAO_CLASSIFICADO"  # filtro/rotulo: categoria nula
NOT_INFORMED = "NAO_INFORMADO"  # filtro/rotulo: tipo de TI ou situação nulos

CATEGORY_LABELS: dict[str, str] = {
    "TECNOLOGIA": "Tecnologia",
    "MOBILIARIO": "Mobiliário",
    "VEICULO": "Veículo",
    "EQUIPAMENTO": "Equipamento",
    "OUTROS": "Outros",
    NOT_CLASSIFIED: "Não classificado",
}
TECH_TYPE_LABELS: dict[str, str] = {
    "COMPUTADOR": "Computador",
    "NOTEBOOK": "Notebook",
    "MONITOR": "Monitor",
    "IMPRESSORA": "Impressora",
    "OUTRO_TI": "Outro item de TI",
    NOT_INFORMED: "Tipo não informado",
}
STATUS_LABELS: dict[str, str] = {
    "EM_USO": "Em uso",
    "ESTOQUE": "Em estoque",
    "MANUTENCAO": "Em manutenção",
    "BAIXADO": "Baixado",
    NOT_INFORMED: "Não informado",
}

_TI = "TECNOLOGIA"
# Primeira palavra da descrição (já normalizada) -> (categoria, tipo de TI).
_KEYWORDS: dict[str, tuple[str, str | None]] = {}


def _register(category: str, tech_type: str | None, words: str) -> None:
    for word in words.split():
        _KEYWORDS[word] = (category, tech_type)


_register(_TI, "COMPUTADOR", "COMPUTADOR MICROCOMPUTADOR CPU DESKTOP WORKSTATION")
_register(_TI, "NOTEBOOK", "NOTEBOOK LAPTOP NETBOOK ULTRABOOK")
_register(_TI, "MONITOR", "MONITOR")
_register(_TI, "IMPRESSORA", "IMPRESSORA MULTIFUNCIONAL PLOTTER")
_register(
    _TI,
    "OUTRO_TI",
    "SWITCH ROTEADOR ROUTER NOBREAK ESTABILIZADOR TABLET PROJETOR SERVIDOR SCANNER ESCANER "
    "WEBCAM TECLADO MOUSE FIREWALL STORAGE",
)
_register(
    "MOBILIARIO",
    None,
    "MESA CADEIRA ARMARIO GAVETEIRO ESTANTE POLTRONA SOFA BALCAO ARQUIVO LONGARINA "
    "BANCADA PRATELEIRA BIOMBO CREDENZA ESCRIVANINHA",
)
_register(
    "VEICULO",
    None,
    "AUTOMOVEL VEICULO CAMINHONETE CAMINHAO MOTOCICLETA MOTO ONIBUS UTILITARIO",
)
_register(
    "EQUIPAMENTO",
    None,
    "ARCONDICIONADO BEBEDOURO GELADEIRA REFRIGERADOR FRIGOBAR VENTILADOR MICROONDAS FORNO "
    "FOGAO TELEVISOR TELEVISAO TV CAFETEIRA PURIFICADOR TRITURADOR DESTRUIDOR",
)

_LEADING_CODE = re.compile(r"^\s*\([^)]*\)\s*")


def _first_word(description: str | None) -> str | None:
    if not description:
        return None
    text = _LEADING_CODE.sub("", description, count=1).strip()
    for word in text.split():
        folded = unicodedata.normalize("NFKD", word)
        folded = "".join(c for c in folded if not unicodedata.combining(c)).upper()
        folded = re.sub(r"[^A-Z0-9]", "", folded)
        if folded:
            return folded
    return None


def classify_description(description: str | None) -> tuple[str | None, str | None]:
    """`(categoria, tipo_ti)` pela regra acima; desconhecido => `(None, None)`."""
    word = _first_word(description)
    if word is None:
        return None, None
    return _KEYWORDS.get(word, (None, None))


def apply_if_unclassified(asset: object, description: str | None) -> bool:
    """Preenche categoria/tipo SÓ se `asset_category` for nulo e a regra casar.

    Nunca sobrescreve classificação existente (inclusive a manual). Retorna se
    houve alteração.
    """
    if getattr(asset, "asset_category", None) is not None:
        return False
    category, tech_type = classify_description(description)
    if category is None:
        return False
    asset.asset_category = category  # type: ignore[attr-defined]
    asset.tech_type = tech_type  # type: ignore[attr-defined]
    return True


# ===========================================================================
# Motor de classificação família / categoria / confiança (RULES_VERSION)
# ===========================================================================
# Regras declaradas como DADOS: `TERM_RULES` é uma lista ordenada por
# prioridade e as listas de contexto/exceções abaixo são configuráveis neste
# módulo. A classificação é PURA e DETERMINÍSTICA (nenhuma IA, nenhuma rede,
# nenhum acesso a banco): mesma descrição => mesmo resultado.
#
# Nada é inventado: descrição que nenhuma regra reconhece recebe
# OUTROS/OUTROS com confiança BAIXA e a regra que explica o motivo
# (`99_SEM_REGRA`), nunca um valor fictício. A descrição original em
# `raw_import_records` NUNCA é alterada.
#
# `RULES_VERSION` é gravada em `assets.classification_rules_version`: mudança
# de regra exige novo valor aqui (o backfill então reclassifica os bens).

RULES_VERSION = "2"

TI = "TI"
MOBILIARIO = "MOBILIARIO"
OUTROS = "OUTROS"
EQUIPMENT_FAMILIES: tuple[str, ...] = (TI, MOBILIARIO, OUTROS)

HIGH = "ALTA"
LOW = "BAIXA"
CLASSIFICATION_CONFIDENCES: tuple[str, ...] = (HIGH, LOW)

TI_CATEGORIES: tuple[str, ...] = (
    "COMPUTADOR", "NOTEBOOK", "MONITOR", "IMPRESSORA", "NOBREAK", "ESTABILIZADOR",
    "DOCKING", "REDE", "OUTRO_TI",
)
MOBILIARIO_CATEGORIES: tuple[str, ...] = (
    "MESA", "ARMARIO", "GAVETEIRO", "ESTACAO_TRABALHO", "CADEIRA", "POLTRONA", "SOFA",
    "ESTANTE", "OUTRO_MOB",
)
OUTROS_CATEGORIES: tuple[str, ...] = ("EQUIPAMENTO", "OUTROS")

EQUIPMENT_CATEGORIES_BY_FAMILY: dict[str, tuple[str, ...]] = {
    TI: TI_CATEGORIES,
    MOBILIARIO: MOBILIARIO_CATEGORIES,
    OUTROS: OUTROS_CATEGORIES,
}
# Vocabulário fechado das 20 categorias, na ordem das famílias.
EQUIPMENT_CATEGORIES: tuple[str, ...] = (
    TI_CATEGORIES + MOBILIARIO_CATEGORIES + OUTROS_CATEGORIES
)
# Cada categoria pertence a exatamente uma família (o CHECK do banco espelha).
CATEGORY_FAMILY: dict[str, str] = {
    category: family
    for family, categories in EQUIPMENT_CATEGORIES_BY_FAMILY.items()
    for category in categories
}

EQUIPMENT_FAMILY_LABELS: dict[str, str] = {
    TI: "Tecnologia da Informação",
    MOBILIARIO: "Mobiliário",
    OUTROS: "Outros",
    NOT_CLASSIFIED: "Não classificado",
}
EQUIPMENT_CATEGORY_LABELS: dict[str, str] = {
    "COMPUTADOR": "Computador",
    "NOTEBOOK": "Notebook",
    "MONITOR": "Monitor",
    "IMPRESSORA": "Impressora",
    "NOBREAK": "Nobreak",
    "ESTABILIZADOR": "Estabilizador",
    "DOCKING": "Docking station",
    "REDE": "Rede",
    "OUTRO_TI": "Outro item de TI",
    "MESA": "Mesa",
    "ARMARIO": "Armário",
    "GAVETEIRO": "Gaveteiro",
    "ESTACAO_TRABALHO": "Estação de trabalho",
    "CADEIRA": "Cadeira",
    "POLTRONA": "Poltrona",
    "SOFA": "Sofá",
    "ESTANTE": "Estante",
    "OUTRO_MOB": "Outro mobiliário",
    "EQUIPAMENTO": "Equipamento",
    "OUTROS": "Outros",
    NOT_CLASSIFIED: "Não classificado",
}
CONFIDENCE_LABELS: dict[str, str] = {HIGH: "Alta", LOW: "Baixa", NOT_INFORMED: "Não informado"}

# Tamanho máximo de `classification_rule`/`classification_rules_version`
# (espelhado nos CHECKs da migração 0018).
CLASSIFICATION_RULE_MAX = 64
CLASSIFICATION_RULES_VERSION_MAX = 16

# --- listas configuráveis (contexto e exceções) ----------------------------
# Termos que, quando são o ITEM PRINCIPAL da descrição, indicam acessório e
# não o bem em si (correção D1: só valem nos primeiros tokens, para que
# "...COMPUTADOR ... CABO DE ALIMENTACAO" continue sendo o computador).
ACCESSORY_TERMS: tuple[str, ...] = (
    "CARREGADOR", "FONTE", "BATERIA", "MALETA", "MOCHILA", "SUPORTE", "CABO",
)
HEAD_TOKENS = 2  # "item principal" = os 2 primeiros tokens da descrição

# "MESA" que NÃO é mobiliário (equipamento com nome composto).
MESA_EXCEPTION_TERMS: tuple[str, ...] = (
    "MESA DIGITALIZADORA", "MESA DE SOM", "MESA DE CORTE",
)

# GABINETE é ambíguo (gabinete de computador x armário): resolvido por contexto.
GABINETE_TI_CONTEXT: tuple[str, ...] = (
    "CPU", "PROCESSADOR", "PLACA MAE", "MEMORIA", "SSD", "HD", "INTEL", "AMD", "CELERON",
)
GABINETE_MOB_CONTEXT: tuple[str, ...] = (
    "PORTAS", "PORTA", "PRATELEIRA", "PRATELEIRAS", "MDF", "MADEIRA", "GAVETA", "GAVETAS",
    "ACO",
)

# Marcadores de acessório (correção D3): tudo o que vem depois descreve o que
# acompanha o bem, não o bem. "MICROCOMPUTADOR ... COMPOSTO DE MONITOR" é
# computador, não monitor.
ACCESSORY_MARKERS: tuple[str, ...] = (
    "ACOMPANHA", "ACOMPANHAM", "ACOMPANHANDO", "COM KIT", "COMPOSTO DE", "COMPOSTO POR",
    "COMPLETO COM",
)

# Identificadores das regras que não são simples listas de termos.
ACCESSORY_RULE_PRIORITY = "0"
GABINETE_RULE_PRIORITY = "7.5"
MESA_RULE_PRIORITY = "11"
NO_DESCRIPTION_RULE = "99_SEM_DESCRICAO"
NO_RULE = "99_SEM_REGRA"

_ACCESSORY_MARKER_RE = re.compile(
    r"(?<![A-Z0-9])(" + "|".join(re.escape(m) for m in ACCESSORY_MARKERS) + r")(?![A-Z0-9]).*$"
)
_MESA_FIRST_TOKEN_RE = re.compile(r"^MESA(?![A-Z0-9])")
# Medidas ("1,40 X 0,70", "120/60"): contexto de mobiliário para GABINETE.
_MEASURE_RE = re.compile(r"(?<![A-Z0-9])\d+[.,]?\d*\s*(?:X|/)\s*\d+[.,]?\d*(?![A-Z0-9])")


@dataclass(frozen=True)
class TermRule:
    """Regra de termo: a primeira cujo termo casa decide a classificação.

    `stage` 1 = avaliada ANTES da regra de GABINETE (prioridades 1..10);
    `stage` 2 = avaliada DEPOIS das regras de GABINETE e MESA (12..19), para
    que itens de TI/mobiliário mais específicos ganhem dos genéricos.
    """

    priority: str
    stage: int
    family: str
    category: str
    terms: tuple[str, ...]


# Lista ORDENADA por prioridade (a ordem é a prioridade; `stage` diz em que
# ponto do fluxo o grupo é avaliado). As prioridades 7.5 (GABINETE) e 11
# (MESA) não são regras de termo e estão em `classify_equipment`.
TERM_RULES: tuple[TermRule, ...] = (
    TermRule("1", 1, TI, "DOCKING", (
        "DOCKING", "DOCK STATION", "HUB DOCKING", "HUB USB-C", "HUB MULTIFUNCIONAL")),
    TermRule("2", 1, TI, "NOBREAK", ("NOBREAK", "NO-BREAK", "NO BREAK", "UPS")),
    TermRule("3", 1, TI, "ESTABILIZADOR", ("ESTABILIZADOR",)),
    TermRule("4", 1, TI, "IMPRESSORA", ("IMPRESSORA", "PRINTER", "MULTIFUNCIONAL")),
    TermRule("5", 1, TI, "NOTEBOOK", (
        "NOTEBOOK", "LAPTOP", "ULTRABOOK", "THINKPAD", "TP E14", "VAIO FE")),
    TermRule("6", 1, TI, "MONITOR", ("MONITOR",)),
    TermRule("7", 1, TI, "COMPUTADOR", (
        "MICROCOMPUTADOR", "MICRO COMPUTADOR", "COMPUTADOR", "DESKTOP", "CPU",
        "THINKCENTRE", "SFF", "ALL IN ONE")),
    TermRule("8", 1, MOBILIARIO, "ESTACAO_TRABALHO", (
        "ESTACAO DE TRABALHO", "ESTACAO TRABALHO")),
    TermRule("9", 1, MOBILIARIO, "GAVETEIRO", ("GAVETEIRO",)),
    TermRule("10", 1, MOBILIARIO, "ARMARIO", ("ARMARIO",)),
    TermRule("12", 2, MOBILIARIO, "POLTRONA", ("POLTRONA",)),
    TermRule("13", 2, MOBILIARIO, "CADEIRA", ("CADEIRA", "LONGARINA")),
    TermRule("14", 2, MOBILIARIO, "SOFA", ("SOFA",)),
    TermRule("15", 2, MOBILIARIO, "ESTANTE", ("ESTANTE", "PRATELEIRA")),
    TermRule("16", 2, TI, "REDE", (
        "SWITCH", "ROTEADOR", "ACCESS POINT", "ACESS POINT", "MODEM", "SERVIDOR",
        "NETSERVER", "RACK", "FIREWALL", "CENTRAL TELEFONICA")),
    TermRule("17", 2, TI, "OUTRO_TI", (
        "SCANNER", "PROJETOR", "CAMERA", "DRONE", "TABLET", "WEBCAM")),
    TermRule("18", 2, MOBILIARIO, "OUTRO_MOB", (
        "CABIDEIRO", "PULPITO", "PUPITO", "CLAVICULARIO", "QUADRO DE AVISO",
        "QUADRO PORTA CHAVES", "BALCAO", "ARQUIVO", "BIOMBO", "CREDENZA",
        "ESCRIVANINHA", "BANCADA")),
    TermRule("19", 2, OUTROS, "EQUIPAMENTO", (
        "AR CONDICIONADO", "CONDICIONADOR DE AR", "REFRIGERADOR", "FRIGOBAR",
        "GELADEIRA", "BEBEDOURO", "PURIFICADOR", "FILTRO", "MICROONDAS", "FORNO",
        "FOGAO", "TELEVISOR", "CESTO", "LIXEIRA", "CARRINHO", "VENTILADOR",
        "CAFETEIRA")),
)


@dataclass(frozen=True)
class EquipmentClassification:
    """Resultado da classificação: família, categoria, confiança e regra."""

    family: str
    category: str
    confidence: str
    rule: str


def normalize_description(description: str | None) -> str:
    """Descrição normalizada para casamento de termos (não persistida).

    Remove o "(codigo_material)" inicial, acentos e pontuação, passa para
    maiúsculas e colapsa espaços. `/` e `-` são preservados porque fazem parte
    de termos ("USB-C", "NO-BREAK", "120/60").
    """
    if not description:
        return ""
    text = _LEADING_CODE.sub("", description, count=1)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).upper()
    text = re.sub(r"[^A-Z0-9/\-\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def strip_accessory_tail(text: str) -> str:
    """Corte D3: descarta o trecho a partir de um marcador de acessório."""
    return _ACCESSORY_MARKER_RE.sub("", text).strip()


@lru_cache(maxsize=1024)
def _term_pattern(term: str) -> re.Pattern[str]:
    """Termo como palavra inteira, tolerando hífen/espaço entre as partes."""
    parts = [re.escape(part) for part in term.split()]
    return re.compile(r"(?<![A-Z0-9])" + r"[\s\-]*".join(parts) + r"(?![A-Z0-9])")


def first_matching_term(text: str, terms: tuple[str, ...]) -> str | None:
    """Primeiro termo da lista presente em `text` (ordem = prioridade)."""
    for term in terms:
        if _term_pattern(term).search(text):
            return term
    return None


def _rule_id(priority: str, suffix: str, term: str | None = None) -> str:
    rule = f"{priority}_{suffix}" if term is None else f"{priority}_{suffix}:{term}"
    return rule[:CLASSIFICATION_RULE_MAX]


def _result(family: str, category: str, confidence: str, rule: str) -> EquipmentClassification:
    return EquipmentClassification(
        family=family, category=category, confidence=confidence, rule=rule
    )


def classify_equipment(description: str | None) -> EquipmentClassification:
    """Classifica a descrição em família/categoria/confiança (função PURA).

    Fluxo (a primeira regra que casa decide):
        0     acessório como item principal (D1) -> OUTROS/OUTROS;
        1-10  termos de TI e de mobiliário específico;
        11    "MESA" como PRIMEIRO token (D2) -> MOBILIARIO/MESA, exceto as
              exceções de `MESA_EXCEPTION_TERMS`;
        7.5   GABINETE por contexto (TI x mobiliário; ambíguo -> BAIXA);
        12-19 demais termos de mobiliário, rede, outros de TI e equipamentos.

    Sem regra => OUTROS/OUTROS com confiança BAIXA (nunca valor fictício).
    """
    text = strip_accessory_tail(normalize_description(description))
    if not text:
        return _result(OUTROS, "OUTROS", LOW, NO_DESCRIPTION_RULE)

    # D1: a exclusão de acessório só vence quando o termo é o item principal
    # (primeiros tokens); citado no fim da descrição é só um item que acompanha.
    head = " ".join(text.split()[:HEAD_TOKENS])
    accessory = first_matching_term(head, ACCESSORY_TERMS)
    if accessory:
        return _result(
            OUTROS, "OUTROS", HIGH, _rule_id(ACCESSORY_RULE_PRIORITY, "ACESSORIO", accessory)
        )

    # D2: "MESA" como PRIMEIRO token é mobiliário mesmo que a descrição cite
    # computador ("MESA PARA TERMINAL DE COMPUTADOR"); já
    # "MICROCOMPUTADOR DE MESA" continua sendo TI (MESA não é o 1º token).
    if _MESA_FIRST_TOKEN_RE.search(text):
        exception = first_matching_term(text, MESA_EXCEPTION_TERMS)
        if exception:
            return _result(
                OUTROS, "OUTROS", LOW, _rule_id(MESA_RULE_PRIORITY, "MESA_EXCECAO", exception)
            )
        return _result(
            MOBILIARIO, "MESA", HIGH, _rule_id(MESA_RULE_PRIORITY, "MESA_PRIMEIRO_TOKEN")
        )

    for rule in TERM_RULES:
        if rule.stage != 1:
            continue
        term = first_matching_term(text, rule.terms)
        if term:
            return _result(
                rule.family, rule.category, HIGH, _rule_id(rule.priority, rule.category, term)
            )

    if first_matching_term(text, ("GABINETE",)):
        ti_context = first_matching_term(text, GABINETE_TI_CONTEXT)
        mob_context = first_matching_term(text, GABINETE_MOB_CONTEXT) or (
            "MEDIDAS" if _MEASURE_RE.search(text) else None
        )
        if ti_context and not mob_context:
            return _result(
                TI, "COMPUTADOR", HIGH,
                _rule_id(GABINETE_RULE_PRIORITY, "GABINETE_TI", ti_context),
            )
        if mob_context and not ti_context:
            return _result(
                MOBILIARIO, "ARMARIO", HIGH,
                _rule_id(GABINETE_RULE_PRIORITY, "GABINETE_MOB", mob_context),
            )
        return _result(
            OUTROS, "OUTROS", LOW, _rule_id(GABINETE_RULE_PRIORITY, "GABINETE_AMBIGUO")
        )

    # "MESA" fora do primeiro token nunca classifica como mesa; as exceções
    # ("MESA DIGITALIZADORA") ficam explicitamente em OUTROS/BAIXA.
    exception = first_matching_term(text, MESA_EXCEPTION_TERMS)
    if exception:
        return _result(
            OUTROS, "OUTROS", LOW, _rule_id(MESA_RULE_PRIORITY, "MESA_EXCECAO", exception)
        )

    for rule in TERM_RULES:
        if rule.stage != 2:
            continue
        term = first_matching_term(text, rule.terms)
        if term:
            return _result(
                rule.family, rule.category, HIGH, _rule_id(rule.priority, rule.category, term)
            )

    return _result(OUTROS, "OUTROS", LOW, NO_RULE)


# --- persistência ----------------------------------------------------------
# `category_override` pertence ao ADM: o motor NUNCA escreve nessa coluna e
# nunca reclassifica um bem que a tenha preenchida (o override prevalece).

CLASSIFICATION_COLUMNS: tuple[str, ...] = (
    "equipment_family",
    "equipment_category",
    "classification_confidence",
    "classification_rule",
    "classification_rules_version",
)


def classification_values(description: str | None) -> dict[str, str]:
    """Valores das colunas de classificação para a descrição informada."""
    result = classify_equipment(description)
    return {
        "equipment_family": result.family,
        "equipment_category": result.category,
        "classification_confidence": result.confidence,
        "classification_rule": result.rule,
        "classification_rules_version": RULES_VERSION,
    }


def _has_description(description: str | None) -> bool:
    return bool(description and description.strip())


def would_reclassify(asset: object, description: str | None) -> bool:
    """True se `apply_equipment_classification` mudaria o bem (sem mudá-lo)."""
    if getattr(asset, "category_override", None) is not None:
        return False
    if not _has_description(description):
        return False
    values = classification_values(description)
    return any(getattr(asset, name, None) != value for name, value in values.items())


def apply_equipment_classification(asset: object, description: str | None) -> bool:
    """Grava família/categoria/confiança/regra/versão no bem; retorna se mudou.

    Respeita `category_override` (override do ADM prevalece: nada é gravado) e
    não inventa classificação para bem sem descrição (as colunas continuam
    nulas = "não informado"). Não incrementa `version`: isso é
    responsabilidade de quem chama (importação e backfill).
    """
    if getattr(asset, "category_override", None) is not None:
        return False
    if not _has_description(description):
        return False
    changed = False
    for name, value in classification_values(description).items():
        if getattr(asset, name, None) != value:
            setattr(asset, name, value)
            changed = True
    return changed


def effective_equipment_category(asset: object) -> str | None:
    """Categoria efetiva: o override do ADM prevalece sobre a regra."""
    override = getattr(asset, "category_override", None)
    return override if override is not None else getattr(asset, "equipment_category", None)


def effective_equipment_family(asset: object) -> str | None:
    """Família efetiva (derivada da categoria efetiva, nunca inventada)."""
    category = effective_equipment_category(asset)
    if category is None:
        return getattr(asset, "equipment_family", None)
    return CATEGORY_FAMILY.get(category)
