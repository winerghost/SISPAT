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
"""
from __future__ import annotations

import re
import unicodedata

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
