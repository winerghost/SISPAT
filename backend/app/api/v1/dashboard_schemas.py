"""Schemas dos endpoints de leitura do dashboard (`/api/v1/dashboard/*`).

Consulta: `extra="forbid"` (parâmetro desconhecido -> 400 via `parse_query`).
Respostas: modelos tipados com limites; nenhum dado pessoal (só contagens,
siglas de unidade e rótulos de tipo derivados da descrição do bem).
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictInt

MESES_MIN, MESES_MAX, MESES_DEFAULT = 1, 24, 6


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DashboardNoQuery(_Query):
    """Sem parâmetros: qualquer um (inclusive `unit_id`) é rejeitado."""


class AquisicoesQuery(_Query):
    meses: int = Field(default=MESES_DEFAULT, ge=MESES_MIN, le=MESES_MAX)


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
