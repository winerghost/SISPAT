"""Schemas dos endpoints de leitura do dashboard (`/api/v1/dashboard/*`).

Consulta: `extra="forbid"` (parâmetro desconhecido -> 400 auditado via
`parse_query`; repetido -> 400; valor nunca ecoado). `DashboardFilters` é o
schema ÚNICO de filtros de todos os endpoints de agregação: todos opcionais e
combináveis (E lógico). Os filtros comuns com `GET /assets` (`unit_id`,
`owner_unit_id`, `room_id`, `responsible_person_id`, `located`, `bond_status`)
usam as MESMAS regras de validação (`asset_schemas`) e de SQL
(`asset_service.asset_filter_clauses`).

Respostas: modelos tipados com limites; nenhum dado pessoal (só contagens,
siglas de unidade, nomes de sala, vínculos e rótulos de tipo derivados da
descrição do bem).
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from app.api.v1.asset_schemas import LocatedStatus, clean_bond_status_filter
from app.services.import_normalizer import BOND_STATUS_MAX

MESES_MIN, MESES_MAX, MESES_DEFAULT = 1, 24, 6
PERIODO_MAX_ANOS = 5
TIPO_MAX = 40
# Formato de `dashboard_service.infer_type`: A-Z0-9 (até 40) ou NAO_CLASSIFICADO.
# O balde interno `__OUTROS__` não casa com o padrão e o rótulo de saída
# `OUTROS` é recusado no validador (um tipo real "OUTROS" sai como OUTROSTIPO).
_TIPO_RE = re.compile(r"^(?:[A-Z0-9]{1,40}|NAO_CLASSIFICADO)$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

BoolText = Literal["true", "false"]
InventarioFiltro = Literal["conferido", "nao_conferido", "encontrado", "nao_encontrado"]


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DashboardNoQuery(_Query):
    """Sem parâmetros: qualquer um é rejeitado (mantido para rotas futuras)."""


def _add_years(value: date, years: int) -> date:
    try:
        return value.replace(year=value.year + years)
    except ValueError:  # 29/02 -> 28/02
        return value.replace(year=value.year + years, day=28)


class DashboardFilters(_Query):
    """Filtros do dashboard (catálogo em docs/ux/DASHBOARD_PERSONALIZACAO.md)."""

    unit_id: uuid.UUID | None = None
    owner_unit_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    responsible_person_id: uuid.UUID | None = None
    has_room: BoolText | None = None
    has_responsible: BoolText | None = None
    located: LocatedStatus | None = None
    bond_status: str | None = Field(default=None, min_length=1, max_length=BOND_STATUS_MAX)
    tipo: str | None = Field(default=None, min_length=1, max_length=TIPO_MAX)
    registrado_desde: date | None = None
    registrado_ate: date | None = None
    inventario: InventarioFiltro | None = None
    movimentacao_pendente: BoolText | None = None

    @field_validator("bond_status")
    @classmethod
    def _bond_status(cls, value: str | None) -> str | None:
        return clean_bond_status_filter(value)

    @field_validator("tipo")
    @classmethod
    def _tipo(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not _TIPO_RE.match(value) or value == "OUTROS":
            raise ValueError("tipo inválido")
        return value

    @field_validator("registrado_desde", "registrado_ate", mode="before")
    @classmethod
    def _date(cls, value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, str) or not _ISO_DATE_RE.match(value.strip()):
            raise ValueError("data deve ser AAAA-MM-DD")
        parsed = date.fromisoformat(value.strip())
        if parsed.year < 1900:
            raise ValueError("data inválida")
        return parsed

    @model_validator(mode="after")
    def _periodo(self) -> "DashboardFilters":
        desde, ate = self.registrado_desde, self.registrado_ate
        if desde is not None and ate is not None:
            if desde > ate:
                raise ValueError("período invertido")
            if ate > _add_years(desde, PERIODO_MAX_ANOS):
                raise ValueError("período maior que o permitido")
        return self

    def active_names(self) -> list[str]:
        """NOMES dos filtros ativos, na ordem do schema (nunca os valores)."""
        return [name for name in DashboardFilters.model_fields if getattr(self, name) is not None]


class AquisicoesQuery(DashboardFilters):
    meses: int = Field(default=MESES_DEFAULT, ge=MESES_MIN, le=MESES_MAX)


# Vocabulário fechado de classificação (espelha `app.services.asset_classification`).
CategoriaFiltro = Literal[
    "TECNOLOGIA", "MOBILIARIO", "VEICULO", "EQUIPAMENTO", "OUTROS", "NAO_CLASSIFICADO"
]
TipoTiFiltro = Literal["COMPUTADOR", "NOTEBOOK", "MONITOR", "IMPRESSORA", "OUTRO_TI", "NAO_INFORMADO"]
StatusOperacionalFiltro = Literal["EM_USO", "ESTOQUE", "MANUTENCAO", "BAIXADO", "NAO_INFORMADO"]


class TechFilters(DashboardFilters):
    """Filtros dos painéis de Tecnologia: os comuns do dashboard + classificação.

    `categoria`, `tipo_ti` e `status` são Literal fechados (valor fora da lista
    -> 400 sem eco). O período (`registrado_desde/ate`, <= 5 anos) herda a
    validação de `DashboardFilters`.
    """

    categoria: CategoriaFiltro | None = None
    tipo_ti: TipoTiFiltro | None = None
    status: StatusOperacionalFiltro | None = None

    def active_names(self) -> list[str]:
        """NOMES dos filtros ativos, na ordem do schema (nunca os valores)."""
        return [name for name in type(self).model_fields if getattr(self, name) is not None]


ExportFormat = Literal["csv", "xlsx"]


class TechExportQuery(TechFilters):
    format: ExportFormat = "csv"

    def active_names(self) -> list[str]:
        return [n for n in super().active_names() if n != "format"]


class TechCountItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[A-Z_]{1,32}$")
    label: str = Field(max_length=64)
    value: StrictInt = Field(ge=1)


class TechResumoOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_bens: StrictInt = Field(ge=0)
    tecnologia: StrictInt = Field(ge=0)
    nao_classificados: StrictInt = Field(ge=0)
    tecnologia_sem_responsavel: StrictInt = Field(ge=0)
    tecnologia_sem_tipo: StrictInt = Field(ge=0)
    tecnologia_sem_status: StrictInt = Field(ge=0)
    filtros_aplicados: list[str] = Field(default_factory=list, max_length=20)


class TechCategoriaOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    categorias: list[TechCountItem] = Field(max_length=8)
    tipos_ti: list[TechCountItem] = Field(max_length=8)


class TechSemResponsavelUnidade(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unidade: str = Field(max_length=64)
    value: StrictInt = Field(ge=1)


class TechSemResponsavelOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tecnologia: StrictInt = Field(ge=0)
    sem_responsavel: StrictInt = Field(ge=0)
    percentual: float | None = None
    por_unidade: list[TechSemResponsavelUnidade] = Field(max_length=20)


class TechTempoItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9_]{1,24}$")
    label: str = Field(max_length=48)
    value: StrictInt = Field(ge=1)


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Variacao(_Out):
    total_bens: float | None
    valor_total: None = None
    em_manutencao: None = None
    baixas_ano: None = None


class ResumoOut(_Out):
    total_bens: StrictInt = Field(ge=0)
    localizados: StrictInt = Field(ge=0)
    nao_localizados: StrictInt = Field(ge=0)
    desconhecidos: StrictInt = Field(ge=0)
    movimentacoes_pendentes: StrictInt = Field(ge=0)
    inventarios_abertos: StrictInt = Field(ge=0)
    novos_30d: StrictInt = Field(ge=0)
    # Sem coluna correspondente no modelo: sempre null (contrato com o frontend).
    valor_total: None = None
    em_manutencao: None = None
    baixas_ano: None = None
    variacao: Variacao
    filtros_aplicados: list[str] = Field(default_factory=list, max_length=20)


class PorUnidadeItem(_Out):
    unidade: str = Field(max_length=64)
    total: StrictInt = Field(ge=0)
    tipos: dict[str, StrictInt]


class PorSituacaoItem(_Out):
    id: str = Field(max_length=32)
    value: StrictInt = Field(ge=1)


class SerieMensalPonto(_Out):
    x: str = Field(pattern=r"^\d{4}-\d{2}$")
    y: StrictInt = Field(ge=0)


class SerieMensal(_Out):
    id: str = Field(max_length=64)
    data: list[SerieMensalPonto] = Field(max_length=MESES_MAX)


class LocalizacaoUnidadeItem(_Out):
    unidade: str = Field(max_length=64)
    sim: StrictInt = Field(ge=0)
    nao: StrictInt = Field(ge=0)
    desconhecido: StrictInt = Field(ge=0)
    total: StrictInt = Field(ge=1)


class RotuloItem(_Out):
    """Item de pizza/barras com rótulo de texto vindo da planilha (sala/vínculo)."""

    id: str = Field(max_length=BOND_STATUS_MAX + 8)
    label: str = Field(max_length=280)
    value: StrictInt = Field(ge=1)


class PendenciasOut(_Out):
    sem_responsavel: StrictInt = Field(ge=0)
    sem_sala: StrictInt = Field(ge=0)
    ociosos: StrictInt = Field(ge=0)
    nao_localizados: StrictInt = Field(ge=0)


class InventarioOut(_Out):
    conferidos: StrictInt = Field(ge=0)
    nao_conferidos: StrictInt = Field(ge=0)
    encontrados: StrictInt = Field(ge=0)
    nao_encontrados: StrictInt = Field(ge=0)


class TipoItem(_Out):
    value: str = Field(pattern=r"^(?:[A-Z0-9]{1,40}|NAO_CLASSIFICADO)$")
    count: StrictInt = Field(ge=1)
