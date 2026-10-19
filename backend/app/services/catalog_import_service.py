"""Importação dos CADASTROS de apoio (unidades, salas, pessoas) a partir do Sheets.

Fluxo prévia -> confirmação, reaproveitando `ImportPreview`/`ImportPreviewItem`
(``source = 'catalog:units|rooms|people'``; `ImportService.confirm_preview`
recusa essas prévias e este serviço recusa as de bens). Fonte NÃO confiável:
nada é gravado na prévia além de `import_previews*`; a confirmação é
transacional (savepoint por item), registra `SyncJob`, `RawImportRecord` por
linha e um `AuditLog` na MESMA transação, e é idempotente (prévia
`CONFIRMADA` -> 409).

Regras de negócio (plano `docs/architecture/plano-importacao-mconferencia.md`
3.1; normalização em `app.services.catalog_normalizer`):

- Unidades (``ID, UNIDADE=sigla, Orgao='023401 - NOME'``): casa por
  ``units.code``. Existente -> grava ``source_record_id`` se vazio (nome NÃO é
  alterado, divergência vira aviso). Ausente -> cria. Garante o alias
  ``unit_aliases`` da sigla (sigla já ligada a OUTRA unidade -> CONFLITANTE).
- Salas (``ID, SALA, UNIDADE=sigla``): unicidade (unidade, nome casefold).
  ``06`` e ``6`` são distintas, mas aparecem em "prováveis duplicatas".
- Pessoas (``ID, NOME, EMAIL, TELEFONE, UNIDADE=sigla``): duplicata por e-mail
  -> mantém a 1ª, a outra é DUPLICADO; ``Ocioso`` e e-mail sem domínio válido
  NÃO viram pessoa. Existente -> só preenche telefone/``source_record_id``
  vazios (nunca sobrescreve nome/e-mail/unidade).
- Sigla vazia/sem alias, nome vazio etc. -> INVALIDO (pendente; nada é chutado).
- ID repetido na origem: mantém as linhas, sinaliza conflito; só a 1ª linha
  importável grava o ``source_record_id`` (índice único); o ID original de
  todas permanece em `raw_import_records`.
- Grafia NUNCA é corrigida; nomes suspeitos vão para o relatório.

Sem rotas nesta etapa; a camada de API (próxima onda) deve exigir ADM+AAL2 e
as permissões de cadastro, e registrar a negação via `record_security_event`.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.authorization import rbac
from app.config.settings import Settings, get_settings
from app.integrations.google_sheets_client import GoogleSheetsClient, GoogleSheetsClientError
from app.models.audit import AuditLog
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.people import ResponsiblePerson
from app.models.sync import RawImportRecord, SyncJob
from app.models.units import Room, Unit, UnitAlias
from app.security.sanitize import canonical_header
from app.services.catalog_normalizer import (
    MAX_NAME,
    SIGLA_RE,
    clean_text,
    has_forbidden_chars,
    is_placeholder_person,
    normalize_person_name,
    normalize_room_name,
    normalize_source_id,
    parse_person_email,
    parse_phone,
    room_key,
    room_probable_duplicate_key,
    suspicious_name_reasons,
)
from app.services.import_normalizer import parse_owner_unit, person_match_key
from app.services.import_service import (
    ImportServiceError,
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
)

logger = logging.getLogger(__name__)

KINDS = ("units", "rooms", "people")
SOURCE_PREFIX = "catalog:"
_SELECTABLE = ("NOVO", "EXISTENTE")
_ALIAS_MAX = 32
_ADVISORY_NAMESPACE = 0x5350_4341  # "SPCA"

# Cabeçalhos exigidos por cadastro (forma canônica; alternativas por "|").
_REQUIRED_HEADERS: dict[str, tuple[str, ...]] = {
    "units": ("ID", "UNIDADE", "ORGAO"),
    "rooms": ("ID", "SALA", "UNIDADE"),
    "people": ("ID", "NOME", "EMAIL|E-MAIL", "TELEFONE", "UNIDADE"),
}

# Códigos de pendência.
P_UNIT_MISSING = "unidade_ausente"
P_UNIT_NO_ALIAS = "unidade_sem_alias"
P_UNIT_INACTIVE = "unidade_inativa"
P_SIGLA_INVALID = "sigla_invalida"
P_ORGAO_INVALID = "orgao_invalido"
P_NAME_MISSING = "nome_ausente"
P_NAME_INVALID = "nome_invalido"
P_PLACEHOLDER = "marcador_ocioso"
P_EMAIL_INVALID = "email_invalido"
P_ALIAS_CONFLICT = "sigla_ligada_a_outra_unidade"
P_SIGLA_REPEATED = "sigla_repetida_com_outro_orgao"
PENDING_CODES = (
    P_UNIT_MISSING,
    P_UNIT_NO_ALIAS,
    P_UNIT_INACTIVE,
    P_SIGLA_INVALID,
    P_ORGAO_INVALID,
    P_NAME_MISSING,
    P_NAME_INVALID,
    P_PLACEHOLDER,
    P_EMAIL_INVALID,
    P_ALIAS_CONFLICT,
    P_SIGLA_REPEATED,
)
_PEND_MESSAGES = {
    P_UNIT_MISSING: "coluna UNIDADE vazia; linha pendente",
    P_UNIT_NO_ALIAS: "sigla de UNIDADE sem alias cadastrado; linha pendente (nada é chutado)",
    P_UNIT_INACTIVE: "a unidade da sigla está inativa; linha pendente",
    P_SIGLA_INVALID: (
        f"sigla vazia, com mais de {_ALIAS_MAX} caracteres ou fora do padrão [A-Za-z0-9._-]"
    ),
    P_ORGAO_INVALID: (
        f"Orgao fora do formato 'NNNNNN - NOME' (nome até {MAX_NAME} caracteres, "
        "sem caracteres de controle/invisíveis)"
    ),
    P_NAME_MISSING: "nome vazio",
    P_NAME_INVALID: (
        f"nome com mais de {MAX_NAME} caracteres ou com caracteres de controle/invisíveis"
    ),
    P_PLACEHOLDER: "marcador 'Ocioso' não é pessoa; ignorado",
    P_EMAIL_INVALID: "e-mail sem formato/domínio válido; linha não vira pessoa",
    P_ALIAS_CONFLICT: "sigla já associada a outra unidade",
    P_SIGLA_REPEATED: "sigla repetida na planilha para outro órgão",
}


class CatalogSourceNotConfiguredError(ImportServiceError):
    """Aba do cadastro sem nome/GID configurado (settings opcionais)."""


class CatalogSchemaError(ImportServiceError):
    """A aba não tem as colunas exigidas (mensagem lista só nomes de coluna)."""


@dataclass
class _Candidate:
    row_number: int
    raw: dict[str, Any]
    source_id: str | None
    label: str | None = None
    nv: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    pend: list[str] = field(default_factory=list)
    classification: str = "NOVO"

    def block(self, code: str) -> None:
        self.pend.append(code)
        self.errors.append(f"erro: {_PEND_MESSAGES[code]}")
        self.classification = "INVALIDO"

    def warn(self, text: str) -> None:
        self.errors.append(f"aviso: {text}")


@dataclass(frozen=True)
class CatalogPreviewResult:
    preview: ImportPreview
    report: dict[str, Any]


def _cell(values: dict[str, Any], *names: str) -> Any:
    targets = {canonical_header(n) for n in names}
    for key, value in values.items():
        if isinstance(key, str) and canonical_header(key) in targets:
            return value
    return None


class CatalogImportService:
    """Prévia/confirmação da importação de unidades, salas e pessoas."""

    def __init__(
        self,
        db_session: Session,
        sheets_client: GoogleSheetsClient,
        settings: Settings | None = None,
    ) -> None:
        self._db = db_session
        self._sheets = sheets_client
        self._settings = settings or get_settings()
        self._scope: set[uuid.UUID] = set()  # unidades do ADM da operação em curso

    def _load_scope(self, actor: uuid.UUID) -> set[uuid.UUID]:
        """Escopo de unidade do ADM (`user_unit_access`; vazio = nada; SEC-CAT-02)."""
        self._scope = set(rbac.get_accessible_unit_ids(actor, self._db))
        return self._scope

    # ------------------------------------------------------------------
    # Leitura da fonte
    # ------------------------------------------------------------------

    def _read(self, kind: str) -> list[dict[str, Any]]:
        if kind not in KINDS:
            raise ValueError("cadastro desconhecido")
        name = getattr(self._settings, f"google_sheets_{kind}_sheet_name", None)
        gid = getattr(self._settings, f"google_sheets_{kind}_sheet_gid", None)
        if not (name and str(name).strip()) and not (gid and str(gid).strip()):
            raise CatalogSourceNotConfiguredError(
                f"Aba do cadastro '{kind}' não configurada (nome ou GID)."
            )
        try:
            result = self._sheets.read_tab_rows(sheet_name=name or None, sheet_gid=gid or None)
        except GoogleSheetsClientError as exc:
            logger.error("catalog_import: falha ao ler Google Sheets (%s)", exc)
            raise UpstreamSourceError(
                "Não foi possível ler a planilha de origem (Google Sheets)."
            ) from exc
        canon = [canonical_header(h) for h in result.headers]
        for requirement in _REQUIRED_HEADERS[kind]:
            options = requirement.split("|")
            found = [c for c in canon if c in options]
            if not found:
                raise CatalogSchemaError(f"A aba não possui a coluna '{options[0]}'.")
            if len(found) > 1:
                raise CatalogSchemaError(f"A coluna '{options[0]}' está duplicada na aba.")
        return list(result.rows)

    # ------------------------------------------------------------------
    # Dados de apoio (somente leitura)
    # ------------------------------------------------------------------

    def _alias_map(
        self, scoped: bool
    ) -> tuple[dict[str, uuid.UUID], dict[uuid.UUID, Unit]]:
        """Aliases/unidades. `scoped=True` (salas/pessoas): SÓ unidades do escopo do
        ADM; fora dele a sigla fica indistinguível de uma sigla sem alias.
        `scoped=False` (cadastro de unidades): mapa completo, para detectar
        conflito de sigla com qualquer unidade (nunca religar alias alheio)."""
        units = {
            u.id: u
            for u in self._db.execute(select(Unit)).scalars().all()
            if not scoped or u.id in self._scope
        }
        aliases: dict[str, uuid.UUID] = {}
        for alias in self._db.execute(select(UnitAlias)).scalars().all():
            if scoped and alias.unit_id not in units:
                continue
            aliases[(clean_text(alias.alias) or "").casefold()] = alias.unit_id
        return aliases, units

    def _resolve_unit(
        self, cand: _Candidate, aliases: dict[str, uuid.UUID], units: dict[uuid.UUID, Unit]
    ) -> uuid.UUID | None:
        raw_sigla = _cell(cand.raw, "UNIDADE")
        sigla = clean_text(raw_sigla)
        cand.nv["unidade_sigla"] = sigla
        if sigla is None:
            cand.block(P_SIGLA_INVALID if has_forbidden_chars(raw_sigla) else P_UNIT_MISSING)
            return None
        if SIGLA_RE.fullmatch(sigla) is None:
            cand.block(P_SIGLA_INVALID)
            return None
        unit_id = aliases.get(sigla.casefold())
        if unit_id is None or unit_id not in units:
            cand.block(P_UNIT_NO_ALIAS)
            return None
        if not units[unit_id].active:
            cand.block(P_UNIT_INACTIVE)
            return None
        cand.nv["unit_id"] = str(unit_id)
        return unit_id

    # ------------------------------------------------------------------
    # Prévia
    # ------------------------------------------------------------------

    def create_preview(self, kind: str, requested_by_user_id: uuid.UUID) -> CatalogPreviewResult:
        rows = self._read(kind)
        self._load_scope(requested_by_user_id)
        cands: list[_Candidate] = []
        for row in rows:
            raw = dict(row.get("raw_values") or {})
            sid_raw = clean_text(_cell(raw, "ID"))
            cand = _Candidate(
                row_number=int(row.get("source_row_number") or 0),
                raw=raw,
                source_id=sid_raw,
                errors=[e for e in (row.get("validation_errors") or []) if isinstance(e, str)],
            )
            if sid_raw is not None and normalize_source_id(sid_raw) is None:
                cand.warn("ID de origem acima de 64 caracteres; source_record_id não será gravado")
            cand.nv["_kind"] = kind
            cand.nv["_row"] = cand.row_number
            cands.append(cand)
            if any(e.startswith("erro:") for e in cand.errors):
                cand.classification = "INVALIDO"

        aliases, units = self._alias_map(scoped=kind != "units")
        if kind == "units":
            self._classify_units(cands, aliases, units)
        elif kind == "rooms":
            self._classify_rooms(cands, aliases, units)
        else:
            self._classify_people(cands, aliases, units)
        self._assign_source_ids(kind, cands)

        now = datetime.now(timezone.utc)
        ttl = getattr(self._settings, "import_preview_ttl_minutes", 60) or 60
        preview_id = uuid4()
        counts = {"NOVO": 0, "EXISTENTE": 0, "DUPLICADO": 0, "INVALIDO": 0, "CONFLITANTE": 0}
        items: list[ImportPreviewItem] = []
        for cand in cands:
            counts[cand.classification] += 1
            items.append(
                ImportPreviewItem(
                    id=uuid4(),
                    preview_id=preview_id,
                    source_record_id=cand.source_id,
                    patrimony_number=None,
                    description=cand.label,
                    raw_values=cand.raw,
                    normalized_values={**cand.nv, "_pend": list(cand.pend)},
                    classification=cand.classification,
                    validation_errors=cand.errors or None,
                    selected=cand.classification in _SELECTABLE,
                    created_at=now,
                )
            )
        preview = ImportPreview(
            id=preview_id,
            requested_by=requested_by_user_id,
            source=f"{SOURCE_PREFIX}{kind}",
            status="CONCLUIDA",
            total_rows=len(cands),
            count_novo=counts["NOVO"],
            count_existente=counts["EXISTENTE"],
            count_duplicado=counts["DUPLICADO"],
            count_invalido=counts["INVALIDO"],
            count_conflitante=counts["CONFLITANTE"],
            created_at=now,
            expires_at=now + timedelta(minutes=ttl),
        )
        self._db.add(preview)
        if items:
            self._db.add_all(items)
        self._db.flush()
        return CatalogPreviewResult(preview=preview, report=self._build_report(kind, items))

    def get_report(self, preview_id: uuid.UUID, actor: uuid.UUID) -> dict[str, Any]:
        """Relatório da prévia; só o AUTOR (`requested_by`) a lê (404 uniforme)."""
        preview = self._db.get(ImportPreview, preview_id)
        if (
            preview is None
            or not str(preview.source).startswith(SOURCE_PREFIX)
            or preview.requested_by != actor
        ):
            raise PreviewNotFoundError("pré-visualização não encontrada")
        items = (
            self._db.execute(
                select(ImportPreviewItem).where(ImportPreviewItem.preview_id == preview.id)
            )
            .scalars()
            .all()
        )
        return self._build_report(str(preview.source)[len(SOURCE_PREFIX):], list(items))

    # --- classificação por cadastro -------------------------------------

    def _classify_units(
        self, cands: list[_Candidate], aliases: dict[str, uuid.UUID], units: dict[uuid.UUID, Unit]
    ) -> None:
        by_code = {u.code: u for u in units.values()}
        seen_code: dict[str, int] = {}
        seen_sigla: dict[str, tuple[str, int]] = {}
        for cand in cands:
            sigla = clean_text(_cell(cand.raw, "UNIDADE"))
            raw_orgao = _cell(cand.raw, "ORGAO")
            code, name = (
                (None, None)
                if has_forbidden_chars(raw_orgao)
                else parse_owner_unit(raw_orgao, [])
            )
            if name is not None and len(name) > MAX_NAME:
                name = None  # recusado abaixo; nunca persistido
            cand.nv.update({"unidade_sigla": sigla, "unit_code": code, "unit_name": name})
            cand.label = f"{code} - {name}" if code and name else None
            if cand.classification == "INVALIDO":
                continue
            if sigla is None or len(sigla) > _ALIAS_MAX or SIGLA_RE.fullmatch(sigla) is None:
                cand.block(P_SIGLA_INVALID)
                continue
            if code is None or name is None:
                cand.block(P_ORGAO_INVALID)
                continue
            if code in seen_code:
                cand.classification = "DUPLICADO"
                cand.warn(f"órgão {code} repetido (1ª ocorrência na linha {seen_code[code]})")
                continue
            prev = seen_sigla.get(sigla.casefold())
            if prev is not None and prev[0] != code:
                cand.classification = "CONFLITANTE"
                cand.pend.append(P_SIGLA_REPEATED)
                cand.errors.append(f"erro: {_PEND_MESSAGES[P_SIGLA_REPEATED]} (linha {prev[1]})")
                continue
            seen_code[code] = cand.row_number
            seen_sigla[sigla.casefold()] = (code, cand.row_number)
            existing = by_code.get(code)
            alias_unit = aliases.get(sigla.casefold())
            if existing is not None and existing.id not in self._scope:
                # Unidade existente fora do escopo do ADM: indistinguível de sigla sem alias.
                cand.block(P_UNIT_NO_ALIAS)
                continue
            if existing is not None:
                cand.classification = "EXISTENTE"
                cand.nv["existing_id"] = str(existing.id)
                if clean_text(existing.name) != name:
                    cand.warn("nome do órgão difere do cadastrado; nome NÃO será alterado")
                if not existing.active:
                    cand.warn("unidade cadastrada está inativa; não será reativada")
                if alias_unit is not None and alias_unit != existing.id:
                    cand.classification = "CONFLITANTE"
                    cand.pend.append(P_ALIAS_CONFLICT)
                    cand.errors.append(f"erro: {_PEND_MESSAGES[P_ALIAS_CONFLICT]}")
                    continue
            elif alias_unit is not None:
                cand.classification = "CONFLITANTE"
                cand.pend.append(P_ALIAS_CONFLICT)
                cand.errors.append(f"erro: {_PEND_MESSAGES[P_ALIAS_CONFLICT]}")
                continue
            cand.nv["create_alias"] = alias_unit is None

    def _classify_rooms(
        self, cands: list[_Candidate], aliases: dict[str, uuid.UUID], units: dict[uuid.UUID, Unit]
    ) -> None:
        existing: dict[tuple[str, str], Room] = {}
        for room in self._db.execute(select(Room)).scalars().all():
            existing[(str(room.unit_id), room_key(room.name))] = room
        seen: dict[tuple[str, str], int] = {}
        for cand in cands:
            name = normalize_room_name(_cell(cand.raw, "SALA"))
            cand.label = name
            cand.nv["room_name"] = name
            unit_id = self._resolve_unit(cand, aliases, units) if cand.classification != "INVALIDO" else None
            if cand.classification == "INVALIDO":
                continue
            if name is None:
                raw_cell = _cell(cand.raw, "SALA")
                missing = clean_text(raw_cell) is None and not has_forbidden_chars(raw_cell)
                cand.block(P_NAME_MISSING if missing else P_NAME_INVALID)
                continue
            if unit_id is None:
                continue
            key = (str(unit_id), room_key(name))
            cand.nv["probable_key"] = f"{unit_id}|{room_probable_duplicate_key(name)}"
            if key in seen:
                cand.classification = "DUPLICADO"
                cand.warn(f"sala repetida na unidade (1ª ocorrência na linha {seen[key]})")
                continue
            seen[key] = cand.row_number
            found = existing.get(key)
            if found is not None:
                cand.classification = "EXISTENTE"
                cand.nv["existing_id"] = str(found.id)
                if not found.active:
                    cand.warn("sala cadastrada está inativa; não será reativada")
        self._flag_probable_duplicates(cands)

    @staticmethod
    def _flag_probable_duplicates(cands: list[_Candidate]) -> None:
        groups: dict[str, list[_Candidate]] = {}
        for cand in cands:
            key = cand.nv.get("probable_key")
            if key and cand.classification != "DUPLICADO":
                groups.setdefault(key, []).append(cand)
        for members in groups.values():
            names = {m.nv.get("room_name") for m in members}
            if len(names) > 1:
                for member in members:
                    member.nv["probable_duplicate"] = True
                    member.warn(
                        "provável duplicata de outra sala da unidade ("
                        + ", ".join(sorted(str(n) for n in names if n != member.nv.get("room_name")))
                        + "); salas mantidas distintas, revisar"
                    )

    def _classify_people(
        self, cands: list[_Candidate], aliases: dict[str, uuid.UUID], units: dict[uuid.UUID, Unit]
    ) -> None:
        by_email: dict[str, ResponsiblePerson] = {}
        by_name_unit: dict[tuple[str, str], ResponsiblePerson] = {}
        for person in self._db.execute(select(ResponsiblePerson)).scalars().all():
            if person.unit_id not in self._scope:
                continue  # SEC-CAT-02: pessoas de unidades fora do escopo não existem aqui
            if person.email:
                by_email[person.email.strip().lower()] = person
            by_name_unit[(str(person.unit_id), person_match_key(person.name) or "")] = person
        seen_email: dict[str, int] = {}
        seen_name: dict[tuple[str, str], int] = {}
        for cand in cands:
            raw_name = clean_text(_cell(cand.raw, "NOME"))
            name = normalize_person_name(raw_name)
            email, email_problem = parse_person_email(_cell(cand.raw, "EMAIL", "E-MAIL"))
            phone, phone_warning = parse_phone(_cell(cand.raw, "TELEFONE"))
            cand.label = name
            cand.nv.update({"person_name": name, "email": email, "phone": phone})
            if phone_warning:
                cand.errors.append(phone_warning)
            if cand.classification == "INVALIDO":
                continue
            if raw_name is not None and name != raw_name:
                cand.warn("sufixo ' -' removido do nome")
            if is_placeholder_person(name, clean_text(_cell(cand.raw, "EMAIL", "E-MAIL"))):
                cand.block(P_PLACEHOLDER)
                continue
            if name is None:
                forbidden = has_forbidden_chars(_cell(cand.raw, "NOME"))
                cand.block(P_NAME_INVALID if forbidden else P_NAME_MISSING)
                continue
            if len(name) > MAX_NAME:
                cand.block(P_NAME_INVALID)
                continue
            if email_problem:
                cand.block(P_EMAIL_INVALID)
                continue
            reasons = suspicious_name_reasons(name)
            if reasons:
                cand.nv["suspect"] = reasons
                cand.warn("nome suspeito (" + "; ".join(reasons) + "); grafia NÃO corrigida, revisar")
            if email is None:
                cand.warn("pessoa sem e-mail")
            unit_id = self._resolve_unit(cand, aliases, units)
            if unit_id is None:
                continue
            nkey = (str(unit_id), person_match_key(name) or "")
            if email is not None:
                if email in seen_email:
                    cand.classification = "DUPLICADO"
                    cand.warn(f"e-mail repetido (1ª ocorrência na linha {seen_email[email]}); mantida a 1ª")
                    continue
                seen_email[email] = cand.row_number
                found = by_email.get(email)
            else:
                if nkey in seen_name:
                    cand.classification = "DUPLICADO"
                    cand.warn(f"pessoa repetida na unidade (1ª ocorrência na linha {seen_name[nkey]})")
                    continue
                seen_name[nkey] = cand.row_number
                found = by_name_unit.get(nkey)
            if found is not None:
                cand.classification = "EXISTENTE"
                cand.nv["existing_id"] = str(found.id)
                if person_match_key(found.name) != person_match_key(name):
                    cand.warn("nome difere do cadastrado; nome NÃO será alterado")
                if not found.active:
                    cand.warn("pessoa cadastrada está inativa; não será reativada")

    def _assign_source_ids(self, kind: str, cands: list[_Candidate]) -> None:
        model = {"units": Unit, "rooms": Room, "people": ResponsiblePerson}[kind]
        owners = {
            sid: str(eid)
            for sid, eid in self._db.execute(
                select(model.source_record_id, model.id).where(model.source_record_id.is_not(None))
            ).all()
        }
        occurrences: dict[str, list[int]] = {}
        for cand in cands:
            sid = normalize_source_id(cand.source_id)
            if sid is not None:
                occurrences.setdefault(sid, []).append(cand.row_number)
        claimed: set[str] = set()
        for cand in cands:
            sid = normalize_source_id(cand.source_id)
            cand.nv["store_source_id"] = None
            if sid is None:
                continue
            rows = occurrences[sid]
            if len(rows) > 1:
                cand.nv["id_conflict"] = True
                cand.warn(f"ID {sid!r} repetido na origem (linhas {rows}); linhas mantidas")
            if cand.classification not in _SELECTABLE:
                continue
            owner = owners.get(sid)
            if owner is not None and owner != cand.nv.get("existing_id"):
                cand.nv["id_conflict"] = True
                cand.warn(f"ID {sid!r} já pertence a outro registro; source_record_id não gravado")
                continue
            if sid in claimed:
                continue  # conflito já sinalizado; só a 1ª linha grava o ID
            claimed.add(sid)
            cand.nv["store_source_id"] = sid

    # --- relatório --------------------------------------------------------

    @staticmethod
    def _build_report(kind: str, items: list[ImportPreviewItem]) -> dict[str, Any]:
        pend = {code: 0 for code in PENDING_CODES}
        classes = {"NOVO": 0, "EXISTENTE": 0, "DUPLICADO": 0, "INVALIDO": 0, "CONFLITANTE": 0}
        id_conflicts: dict[str, list[int]] = {}
        suspects: list[dict[str, Any]] = []
        probable: dict[str, dict[str, Any]] = {}
        for item in items:
            nv = item.normalized_values or {}
            row = nv.get("_row")
            classes[item.classification] = classes.get(item.classification, 0) + 1
            for code in nv.get("_pend") or []:
                if code in pend:
                    pend[code] += 1
            if nv.get("id_conflict") and item.source_record_id:
                id_conflicts.setdefault(item.source_record_id, []).append(row)
            if nv.get("suspect"):
                suspects.append({"row": row, "name": nv.get("person_name"), "reasons": nv["suspect"]})
            if nv.get("probable_duplicate"):
                group = probable.setdefault(
                    str(nv.get("probable_key")), {"names": [], "rows": []}
                )
                group["names"].append(nv.get("room_name"))
                group["rows"].append(row)
        return {
            "kind": kind,
            "total": len(items),
            "classificacoes": classes,
            "pendencias": pend,
            "ids_repetidos": [{"id": k, "linhas": v} for k, v in id_conflicts.items()],
            "nomes_suspeitos": suspects,
            "provaveis_duplicatas": list(probable.values()),
        }

    # ------------------------------------------------------------------
    # Confirmação
    # ------------------------------------------------------------------

    def _lock(self, kind: str) -> None:
        """Serializa confirmações concorrentes do mesmo cadastro (só PostgreSQL)."""
        bind = self._db.get_bind()
        if bind is not None and bind.dialect.name == "postgresql":
            self._db.execute(
                select(func.pg_advisory_xact_lock(_ADVISORY_NAMESPACE, func.hashtext(kind)))
            )

    def confirm_preview(
        self,
        preview_id: uuid.UUID,
        confirmed_by_user_id: uuid.UUID,
        selected_item_ids: list[uuid.UUID],
        alias_item_ids: list[uuid.UUID] | None = None,
    ) -> dict[str, Any]:
        """Aplica os itens NOVO/EXISTENTE selecionados. Retorna
        ``{sync_job_id, created, updated, ignorados, falhas}``.

        Só o AUTOR da prévia confirma (outro ADM -> `PreviewNotFoundError`, 404
        uniforme) e o escopo de unidade é revalidado por item. Alias de sigla
        (`unit_aliases`) só é criado para itens de unidades presentes em
        ``alias_item_ids`` (opt-in explícito) cujo `create_alias` da prévia é verdadeiro."""
        preview = self._db.execute(
            select(ImportPreview).where(ImportPreview.id == preview_id)
        ).scalar_one_or_none()
        if (
            preview is None
            or not str(preview.source).startswith(SOURCE_PREFIX)
            or preview.requested_by != confirmed_by_user_id
        ):
            raise PreviewNotFoundError("pré-visualização não encontrada")
        kind = str(preview.source)[len(SOURCE_PREFIX):]
        if kind not in KINDS:
            raise PreviewNotFoundError("pré-visualização não encontrada")
        self._db.refresh(preview, with_for_update=True)
        if preview.status != "CONCLUIDA":
            raise PreviewNotConfirmableError(
                f"pré-visualização não pode ser confirmada (status atual: {preview.status!r})"
            )
        now = datetime.now(timezone.utc)
        expires = preview.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if now > expires:
            preview.status = "EXPIRADA"
            self._db.add(preview)
            self._db.commit()
            raise PreviewNotConfirmableError(
                "pré-visualização expirada; solicite uma nova pré-visualização"
            )

        self._lock(kind)
        self._load_scope(confirmed_by_user_id)
        alias_wanted = set(alias_item_ids or [])
        all_items = (
            self._db.execute(
                select(ImportPreviewItem).where(ImportPreviewItem.preview_id == preview.id)
            )
            .scalars()
            .all()
        )
        wanted = set(selected_item_ids)
        eligible = [i for i in all_items if i.id in wanted and i.classification in _SELECTABLE]
        eligible.sort(key=lambda i: ((i.normalized_values or {}).get("_row") or 0, str(i.id)))
        ignorados = len(wanted - {i.id for i in eligible})

        sync_job = SyncJob(
            id=uuid4(),
            source=preview.source,
            status="EM_EXECUCAO",
            started_at=now,
            records_read=len(eligible),
        )
        self._db.add(sync_job)
        created = updated = 0
        falhas: list[dict[str, Any]] = []
        for item in eligible:
            reason: str | None = None
            savepoint = self._db.begin_nested()
            try:
                reason, d_created, d_updated = self._apply(
                    kind, item, confirmed_by_user_id, item.id in alias_wanted
                )
                self._db.flush()
            except SQLAlchemyError as exc:
                savepoint.rollback()
                logger.error(
                    "catalog_import.confirm: erro de banco no item %s (%s)", item.id, type(exc).__name__
                )
                reason = "erro de banco ao aplicar o item; nenhuma alteração gravada"
            else:
                if reason is None:
                    savepoint.commit()
                    created += d_created
                    updated += d_updated
                else:
                    savepoint.rollback()
            nv = item.normalized_values or {}
            if reason is not None:
                falhas.append(
                    {
                        "item_id": str(item.id),
                        "row": nv.get("_row"),
                        "label": item.description,
                        "reason": reason,
                    }
                )
            self._db.add(
                RawImportRecord(
                    id=uuid4(),
                    sync_job_id=sync_job.id,
                    source_record_id=item.source_record_id or f"linha-{nv.get('_row')}",
                    source_row_number=nv.get("_row") if isinstance(nv.get("_row"), int) else None,
                    raw_values=item.raw_values,
                    normalized_values=item.normalized_values,
                    validation_errors={"reason": reason} if reason is not None else None,
                    import_status="REJEITADO" if reason is not None else "IMPORTADO",
                )
            )

        sync_job.records_created = created
        sync_job.records_updated = updated
        sync_job.records_failed = len(falhas)
        sync_job.finished_at = datetime.now(timezone.utc)
        if falhas and not (created or updated):
            sync_job.status = "FALHOU"
        elif falhas:
            sync_job.status = "PARCIAL"
        else:
            sync_job.status = "CONCLUIDO"
        if falhas:
            sync_job.error_summary = (
                f"{len(falhas)} item(ns) não importado(s); ver RawImportRecord REJEITADO."
            )
        preview.status = "CONFIRMADA"
        preview.confirmed_at = datetime.now(timezone.utc)
        preview.confirmed_by = confirmed_by_user_id
        self._db.add(
            AuditLog(
                id=uuid4(),
                actor_user_id=confirmed_by_user_id,
                entity_type="catalog_import",
                entity_id=str(preview.id),
                operation="CONFIRM_CATALOG_IMPORT",
                previous_values={"status": "CONCLUIDA"},
                new_values={
                    "kind": kind,
                    "status": "CONFIRMADA",
                    "sync_job_id": str(sync_job.id),
                    "created": created,
                    "updated": updated,
                    "ignorados": ignorados,
                    "falhas": len(falhas),
                },
                result="FALHA" if sync_job.status == "FALHOU" else "SUCESSO",
            )
        )
        self._db.commit()
        return {
            "sync_job_id": sync_job.id,
            "created": created,
            "updated": updated,
            "ignorados": ignorados,
            "falhas": falhas,
        }

    # --- aplicação por cadastro (revalida contra o estado ATUAL) ----------

    def _apply(
        self, kind: str, item: ImportPreviewItem, actor: uuid.UUID, with_alias: bool = False
    ) -> tuple[str | None, int, int]:
        nv = item.normalized_values or {}
        if kind == "units":
            return self._apply_unit(item, nv, actor, with_alias)
        if kind == "rooms":
            return self._apply_room(item, nv)
        return self._apply_person(item, nv)

    def _source_id_free(self, model: Any, sid: str | None, own_id: uuid.UUID | None) -> str | None:
        if not sid:
            return None
        owner = self._db.execute(
            select(model.id).where(model.source_record_id == sid)
        ).scalar_one_or_none()
        return sid if owner is None or owner == own_id else None

    def _apply_unit(
        self, item: ImportPreviewItem, nv: dict[str, Any], actor: uuid.UUID, with_alias: bool = False
    ) -> tuple[str | None, int, int]:
        code, name, sigla = nv.get("unit_code"), nv.get("unit_name"), nv.get("unidade_sigla")
        if not code or not name or not sigla:
            return "dados da linha incompletos", 0, 0
        if len(name) > MAX_NAME or has_forbidden_chars(name) or SIGLA_RE.fullmatch(sigla) is None:
            return "dados da linha inválidos", 0, 0
        unit = self._db.execute(select(Unit).where(Unit.code == code)).scalar_one_or_none()
        created = updated = 0
        if item.classification == "NOVO":
            if unit is not None:
                return "condição de corrida: a unidade já existe", 0, 0
            unit = Unit(
                id=uuid4(),
                code=code,
                name=name,
                active=True,
                source_record_id=self._source_id_free(Unit, nv.get("store_source_id"), None),
            )
            self._db.add(unit)
            created = 1
        else:
            if unit is None or unit.id not in self._scope:
                return "a unidade deixou de existir", 0, 0
            sid = self._source_id_free(Unit, nv.get("store_source_id"), unit.id)
            if unit.source_record_id is None and sid:
                unit.source_record_id = sid
                updated = 1
        self._db.flush()
        current = self._db.execute(
            select(UnitAlias).where(func.lower(UnitAlias.alias) == sigla.casefold())
        ).scalar_one_or_none()
        if current is None:
            # Alias NOVO só com opt-in explícito do ADM (a planilha é entrada não
            # confiável e o alias decide a unidade dos bens importados).
            if with_alias and nv.get("create_alias"):
                self._db.add(UnitAlias(id=uuid4(), alias=sigla, unit_id=unit.id, created_by=actor))
                updated = updated or (1 if not created else 0)
        elif current.unit_id != unit.id:
            return "sigla já associada a outra unidade", 0, 0
        return None, created, updated

    def _apply_room(self, item: ImportPreviewItem, nv: dict[str, Any]) -> tuple[str | None, int, int]:
        name, unit_id = nv.get("room_name"), nv.get("unit_id")
        if not name or not unit_id:
            return "dados da linha incompletos", 0, 0
        uid = uuid.UUID(unit_id)
        unit = self._db.get(Unit, uid)
        if unit is None or not unit.active or uid not in self._scope:
            return "a unidade da sala não existe ou está inativa", 0, 0
        key = room_key(name)
        found = next(
            (r for r in self._db.execute(select(Room).where(Room.unit_id == uid)).scalars().all()
             if room_key(r.name) == key),
            None,
        )
        if item.classification == "NOVO":
            if found is not None:
                return "condição de corrida: a sala já existe na unidade", 0, 0
            self._db.add(
                Room(
                    id=uuid4(),
                    unit_id=uid,
                    name=name,
                    active=True,
                    source_record_id=self._source_id_free(Room, nv.get("store_source_id"), None),
                )
            )
            return None, 1, 0
        if found is None:
            return "a sala deixou de existir", 0, 0
        sid = self._source_id_free(Room, nv.get("store_source_id"), found.id)
        if found.source_record_id is None and sid:
            found.source_record_id = sid
            return None, 0, 1
        return None, 0, 0

    def _apply_person(self, item: ImportPreviewItem, nv: dict[str, Any]) -> tuple[str | None, int, int]:
        name, email, phone = nv.get("person_name"), nv.get("email"), nv.get("phone")
        unit_id = nv.get("unit_id")
        if not name or not unit_id:
            return "dados da linha incompletos", 0, 0
        uid = uuid.UUID(unit_id)
        unit = self._db.get(Unit, uid)
        if unit is None or not unit.active or uid not in self._scope:
            return "a unidade da pessoa não existe ou está inativa", 0, 0
        existing_id = nv.get("existing_id")
        if item.classification == "NOVO":
            if email and self._db.execute(
                select(ResponsiblePerson.id).where(func.lower(ResponsiblePerson.email) == email)
            ).first():
                return "condição de corrida: já existe pessoa com este e-mail", 0, 0
            if not email:
                # SEC-CAT-03: sem e-mail a identidade é (unidade, nome); rechecar.
                key = person_match_key(name)
                same_unit = self._db.execute(
                    select(ResponsiblePerson.name).where(ResponsiblePerson.unit_id == uid)
                ).scalars().all()
                if any(person_match_key(n) == key for n in same_unit):
                    return "condição de corrida: a pessoa já existe na unidade", 0, 0
            self._db.add(
                ResponsiblePerson(
                    id=uuid4(),
                    name=name,
                    email=email,
                    phone=phone,
                    unit_id=uid,
                    active=True,
                    source_record_id=self._source_id_free(
                        ResponsiblePerson, nv.get("store_source_id"), None
                    ),
                )
            )
            return None, 1, 0
        person = self._db.get(ResponsiblePerson, uuid.UUID(existing_id)) if existing_id else None
        if person is None or person.unit_id not in self._scope:
            return "a pessoa deixou de existir", 0, 0
        changed = False
        if person.phone is None and phone:
            person.phone = phone
            changed = True
        sid = self._source_id_free(ResponsiblePerson, nv.get("store_source_id"), person.id)
        if person.source_record_id is None and sid:
            person.source_record_id = sid
            changed = True
        return None, 0, 1 if changed else 0
