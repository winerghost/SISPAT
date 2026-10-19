"""Resolução de referências da importação de bens (etapa 3 do plano MConferencia).

Dado o conteúdo (NÃO confiável) de uma linha da planilha já normalizada,
resolve vínculos CONTRA O BANCO, somente leitura e sem criar nada:

- ``UNIDADE`` (sigla) -> ``unit_aliases`` (case-insensitive, trim) -> unidade
  ATIVA. Sigla ausente/sem alias/unidade inativa => ``blocking`` (o item NOVO
  vira INVALIDO; nunca se escolhe uma unidade "parecida").
- ``UNIDADE_PERTENCENTE`` (código de 6 dígitos) -> ``units.code`` (ativa).
- ``SALA`` -> sala ativa pelo NOME dentro da unidade do bem (casefold, espaços
  colapsados). Inexistente => pendência, campo NULL (sala não é criada).
- 2ª ``RESPONSAVEL`` -> pessoa ativa por chave de casamento (casefold, sem
  acento, espaços colapsados). Inexistente/ambígua => pendência, NULL.
- ``USUARIO`` (e-mail) -> pessoa ativa por e-mail; fica SÓ em
  ``normalized_values['usuario_person_id']`` (``assets.assigned_user_id``
  referencia contas do sistema e permanece NULL).
- 1ª ``RESPONSAVEL`` (``Ocioso``/``Servidor``...) é só situação
  (``vinculo_situacao``): NUNCA é procurada como pessoa.

Pendências NÃO bloqueiam a confirmação de itens válidos.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.catalog_normalizer import clean_text, is_placeholder_person, room_key
from app.services.import_normalizer import person_match_key

# Códigos de pendência (contadores da prévia).
UNIT_NO_ALIAS = "unidade_sem_alias"
UNIT_INACTIVE = "unidade_inativa"
UNIT_MISSING = "unidade_ausente"
OWNER_NOT_FOUND = "unidade_pertencente_nao_encontrada"
ROOM_NOT_FOUND = "sala_nao_encontrada"
ROOM_AMBIGUOUS = "sala_ambigua"
PERSON_NOT_FOUND = "pessoa_nao_encontrada"
PERSON_AMBIGUOUS = "pessoa_ambigua"
USUARIO_NOT_FOUND = "usuario_pessoa_nao_encontrada"
USUARIO_AMBIGUOUS = "usuario_pessoa_ambigua"

PENDING_CODES = (
    UNIT_NO_ALIAS,
    UNIT_INACTIVE,
    UNIT_MISSING,
    OWNER_NOT_FOUND,
    ROOM_NOT_FOUND,
    ROOM_AMBIGUOUS,
    PERSON_NOT_FOUND,
    PERSON_AMBIGUOUS,
    USUARIO_NOT_FOUND,
    USUARIO_AMBIGUOUS,
)

_MESSAGES = {
    UNIT_NO_ALIAS: "sigla de UNIDADE sem alias cadastrado em unit_aliases",
    UNIT_INACTIVE: "a unidade da sigla de UNIDADE está inativa",
    UNIT_MISSING: "campo UNIDADE vazio",
    OWNER_NOT_FOUND: "UNIDADE_PERTENCENTE sem unidade ativa com este código",
    ROOM_NOT_FOUND: "SALA não encontrada na unidade; room_id ficará vazio",
    ROOM_AMBIGUOUS: "SALA corresponde a mais de uma sala da unidade; room_id ficará vazio",
    PERSON_NOT_FOUND: "RESPONSAVEL (pessoa) não encontrado entre as pessoas ativas",
    PERSON_AMBIGUOUS: "RESPONSAVEL (pessoa) ambíguo entre as pessoas ativas",
    USUARIO_NOT_FOUND: "USUARIO (e-mail) sem pessoa ativa correspondente",
    USUARIO_AMBIGUOUS: "USUARIO (e-mail) corresponde a mais de uma pessoa ativa",
}
_BLOCKING = (UNIT_NO_ALIAS, UNIT_INACTIVE, UNIT_MISSING)


def message_for(code: str) -> str:
    return _MESSAGES.get(code, code)


@dataclass
class LinkResolution:
    """Resultado da resolução de uma linha (ids como UUID; JSON via `to_json`)."""

    unit_id: uuid.UUID | None = None
    owner_unit_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    responsible_person_id: uuid.UUID | None = None
    usuario_person_id: uuid.UUID | None = None
    blocking: str | None = None  # código bloqueante (item não pode ser criado)
    pendencias: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        def _s(v: uuid.UUID | None) -> str | None:
            return str(v) if v is not None else None

        return {
            "unit_id": _s(self.unit_id),
            "owner_unit_id": _s(self.owner_unit_id),
            "room_id": _s(self.room_id),
            "responsible_person_id": _s(self.responsible_person_id),
            "usuario_person_id": _s(self.usuario_person_id),
            "blocking": self.blocking,
            "pendencias": list(self.pendencias),
        }


class ImportReferences:
    """Mapas em memória (carga única por operação) das tabelas de apoio."""

    def __init__(self, db: Session) -> None:
        units = db.query(Unit).all()
        self._unit_active = {u.id: bool(u.active) for u in units}
        self._unit_by_code = {u.code: u.id for u in units if u.active}
        self._alias: dict[str, uuid.UUID] = {}
        for alias in db.query(UnitAlias).all():
            self._alias[(clean_text(alias.alias) or "").casefold()] = alias.unit_id
        self._rooms: dict[tuple[uuid.UUID, str], list[uuid.UUID]] = {}
        for room in db.query(Room).filter(Room.active.is_(True)).all():
            self._rooms.setdefault((room.unit_id, room_key(room.name)), []).append(room.id)
        self._people_by_key: dict[str, list[uuid.UUID]] = {}
        self._people_by_email: dict[str, list[uuid.UUID]] = {}
        for person in db.query(ResponsiblePerson).filter(ResponsiblePerson.active.is_(True)).all():
            key = person_match_key(person.name)
            if key:
                self._people_by_key.setdefault(key, []).append(person.id)
            if person.email:
                self._people_by_email.setdefault(person.email.strip().lower(), []).append(person.id)

    def resolve(self, *, unit_sigla: Any, normalized: dict[str, Any]) -> LinkResolution:
        out = LinkResolution()
        sigla = clean_text(unit_sigla)
        if sigla is None:
            out.blocking = UNIT_MISSING
        else:
            unit_id = self._alias.get(sigla.casefold())
            if unit_id is None:
                out.blocking = UNIT_NO_ALIAS
            elif not self._unit_active.get(unit_id, False):
                out.blocking = UNIT_INACTIVE
            else:
                out.unit_id = unit_id
        if out.blocking:
            out.pendencias.append(out.blocking)

        owner_code = normalized.get("owner_unit_code")
        if isinstance(owner_code, str) and owner_code:
            out.owner_unit_id = self._unit_by_code.get(owner_code)
            if out.owner_unit_id is None:
                out.pendencias.append(OWNER_NOT_FOUND)

        sala = clean_text(normalized.get("sala_codigo"))
        if sala is not None and out.unit_id is not None:
            matches = self._rooms.get((out.unit_id, room_key(sala)), [])
            if len(matches) == 1:
                out.room_id = matches[0]
            else:
                out.pendencias.append(ROOM_NOT_FOUND if not matches else ROOM_AMBIGUOUS)

        pessoa = normalized.get("responsavel_pessoa")
        key = normalized.get("responsavel_pessoa_key") or person_match_key(pessoa)
        if key and not is_placeholder_person(pessoa, None):
            people = self._people_by_key.get(key, [])
            if len(people) == 1:
                out.responsible_person_id = people[0]
            else:
                out.pendencias.append(PERSON_NOT_FOUND if not people else PERSON_AMBIGUOUS)

        email = normalized.get("usuario_email")
        if isinstance(email, str) and email:
            people = self._people_by_email.get(email.lower(), [])
            if len(people) == 1:
                out.usuario_person_id = people[0]
            else:
                out.pendencias.append(USUARIO_NOT_FOUND if not people else USUARIO_AMBIGUOUS)
        return out

