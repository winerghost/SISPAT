"""Serviço de importação de dados a partir do Google Sheets.

Orquestra a leitura (via `GoogleSheetsClient`, somente leitura) e a
classificação/gravação em `assets`, usando os modelos de pré-visualização
(`app.models.imports`) e de histórico de sincronização
(`app.models.sync`, `app.models.audit`) já existentes.

Duas operações principais:
    - `create_preview`: lê a planilha, classifica cada linha frente ao
      estado atual de `assets` e persiste uma `ImportPreview` +
      `ImportPreviewItem`s. NUNCA grava em `assets` (pré-visualização é
      estritamente leitura sobre essa tabela).
    - `confirm_preview`: aplica (cria/atualiza `assets`) os itens
      selecionados de uma pré-visualização ainda válida, registrando um
      `SyncJob`, um `RawImportRecord` por linha processada e um
      `AuditLog` da operação.

Injeção de dependências:
    `ImportService` recebe `db_session` (uma `sqlalchemy.orm.Session`) e
    `sheets_client` (um `GoogleSheetsClient`) no construtor, exatamente para
    permitir testes com mocks (ver `backend/tests/test_import_service.py`),
    seguindo o mesmo espírito de injeção já usado pelos próprios clientes de
    integração (`GoogleSheetsClient`, `N8nClient`), que aceitam `settings`
    opcional no construtor.

Gestão de transação — DESVIO INTENCIONAL do padrão usual do projeto:
    A maioria do código existente (`app.auth.supabase_auth`,
    `app.authorization.rbac`) abre e fecha sua própria sessão via
    `with get_db_session() as db: ...`, que faz commit/rollback automático
    ao final do bloco. Este serviço, em vez disso, RECEBE a sessão já aberta
    (para permitir injeção de mocks nos testes) e gerencia explicitamente
    quando confirmar (`commit()`) as mudanças, por dois motivos específicos:

    1. `confirm_preview` precisa persistir a transição de uma prévia para
       `EXPIRADA` MESMO QUANDO a confirmação como um todo falha (o chamador
       recebe um erro, mas o estado "expirada" tem que sobreviver para que
       uma nova tentativa não reencontre uma prévia zumbi com
       status='CONCLUIDA'). Se dependêssemos apenas do rollback automático
       de um `with get_db_session()` externo, essa escrita seria desfeita
       junto com o erro.
    2. A confirmação é "melhor esforço" por item: um item com falha de
       condição de corrida (ver `confirm_preview`) não pode abortar a
       transação inteira — os demais itens válidos, o `SyncJob` e o
       `AuditLog` da execução precisam ser persistidos do mesmo jeito.

    Por isso, a camada de API (`app.api.v1.imports`) ainda abre a sessão via
    `with get_db_session() as db: ...` (para obter/fechar a conexão
    corretamente), mas o `commit()` efetivo das mudanças de negócio ocorre
    dentro deste serviço. O `commit()` adicional (sem nada pendente) feito
    pelo `with` externo ao final do bloco é inofensivo (no-op).

Decisões de design assumidas (documentadas para revisão futura):
    - Comparação de `PATRIMONIO`: feita por igualdade de string EXATA (após
      `strip()`), sem normalização de caixa (case-sensitive) ou remoção de
      zeros à esquerda — consistente com `Asset.patrimony_number` sendo
      sempre `TEXT` (ver `app.models.assets`). Esta é uma decisão de design
      que pode ser revisada (ex.: normalizar para upper() também) caso a
      instituição confirme que o número patrimonial nunca é case-sensitive.
    - DUPLICADO entre linhas da própria planilha: a PRIMEIRA ocorrência de
      um `PATRIMONIO` normalizado nunca é marcada DUPLICADO (ela segue para
      a comparação normal com `assets`); toda ocorrência SEGUINTE do mesmo
      `PATRIMONIO` é marcada DUPLICADO, mesmo que a primeira ocorrência
      tenha sido classificada como INVALIDO por outro motivo (ex.: ID
      ausente). Ou seja, a contagem de ocorrências considera TODAS as
      linhas com aquele patrimônio, independentemente da classificação da
      primeira. Esta é uma decisão de design que pode ser revisada.
    - `matched_asset_id`: preenchido para EXISTENTE (o único ativo
      encontrado) e, em caráter informativo (best-effort), também para
      DUPLICADO quando exatamente um ativo já existir com aquele
      patrimônio — mas NUNCA para CONFLITANTE, já que por definição existe
      mais de um ativo ambíguo (não há um "o" candidato a apontar).
    - Controle de concorrência otimista (`version`) para itens EXISTENTE:
      como `ImportPreviewItem` (`app/models/imports.py`) não possui uma
      coluna dedicada para guardar a versão do asset correspondente no
      momento da pré-visualização — e este serviço está proibido de alterar
      modelos/migrações nesta tarefa — a versão lida é armazenada dentro do
      próprio `normalized_values` (JSONB já existente), na chave
      `_matched_asset_version_at_preview`. Isso é um uso pragmático de um
      campo flexível já existente, não uma coluna de schema nova. Se uma
      coluna dedicada for adicionada em uma fase futura (via migração), esta
      lógica deve ser atualizada para usá-la em vez da chave dentro do
      JSONB.
    - Resolução de vínculos para itens NOVO (etapa 3 do plano MConferencia,
      ver `app.services.import_references`): `unit_id` vem da sigla da coluna
      `UNIDADE` via `unit_aliases` (case-insensitive, trim; NUNCA por nome da
      unidade). Sigla vazia/sem alias/unidade inativa => item INVALIDO com
      mensagem clara (sem chute). `owner_unit_id` <- código de
      `UNIDADE_PERTENCENTE` em `units.code`; `located`, `registration_date`,
      `source_updated_at` <- valores normalizados; `notes` <- `OBSERVACAO`;
      `room_id` <- sala por NOME na unidade (nunca criada); 
      `responsible_person_id` <- 2ª `RESPONSAVEL` por chave de casamento entre
      pessoas ativas. Sala/pessoa/unidade pertencente não encontradas ou
      ambíguas => PENDÊNCIA (campo NULL), contada na prévia
      (`preview.pending_counts`, `pending_report`) e SEM bloquear a
      confirmação. `USUARIO` (e-mail) vira `usuario_person_id` só dentro de
      `normalized_values`; `assigned_user_id` permanece NULL. A 1ª
      `RESPONSAVEL` (ex.: `Ocioso`) é só `vinculo_situacao`, nunca pessoa. Os
      vínculos são resolvidos na prévia (informativo, em `_links`) e
      RESOLVIDOS DE NOVO na confirmação (autoritativo). Itens EXISTENTE
      continuam atualizando apenas descrição/origem (não sobrescrevem campos
      editados manualmente).
    - Cada linha gera, no máximo, uma consulta a `assets` por classificação
      (pré-visualização) e mais uma na confirmação (revalidação) — não há
      consulta em lote (`IN (...)`) nesta fase. Para volumes grandes de
      planilha, isso é um candidato a otimização futura, mas mantém a lógica
      simples e fácil de auditar nesta primeira versão.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import or_
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.config.settings import Settings, get_settings
from app.integrations.google_sheets_client import GoogleSheetsClient, GoogleSheetsClientError
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.imports import ImportPreview, ImportPreviewItem
from app.security.text_search import contains_ci
from app.services.asset_classification import apply_if_unclassified, classify_description
from app.services.pagination import DEFAULT_PAGE_SIZE, coerce_page_size, page_count
from app.models.sync import RawImportRecord, SyncJob
from app.services.patrimony_lock import (
    acquire_patrimony_lock,
    normalize_patrimony_number,
    normalized_column,
)
from app.services.import_references import (
    PENDING_CODES,
    ImportReferences,
    LinkResolution,
    message_for,
)
from app.security.sanitize import (
    canonical_header,
    has_control_chars,
    normalize_identifier,
)

logger = logging.getLogger(__name__)

# Tamanho do lote do IN ao pré-carregar assets por patrimônio.
_PREFETCH_CHUNK = 500

# Chave usada dentro de `ImportPreviewItem.normalized_values` (JSONB) para
# guardar a versão do asset correspondente no momento da pré-visualização,
# usada no controle de concorrência otimista de `confirm_preview` — ver
# docstring do módulo ("Controle de concorrência otimista").
_VERSION_AT_PREVIEW_KEY = "_matched_asset_version_at_preview"
# Linha de origem na planilha (1-based), preservada para rastreabilidade em
# `RawImportRecord.source_row_number` (mesmo racional de uso do JSONB acima).
_SOURCE_ROW_KEY = "_source_row_number"

# Allowlist do filtro `status` de `list_preview_items` (CWE-89/CWE-20).
_ALLOWED_CLASSIFICATIONS = frozenset({"NOVO", "EXISTENTE", "DUPLICADO", "INVALIDO", "CONFLITANTE"})
# Tamanho máximo do termo de busca (ILIKE) — evita padrões gigantes (API4).
MAX_SEARCH_LENGTH = 100
# Página máxima aceita (evita OFFSET gigantesco, API4).
MAX_PAGE = 10_000
# Namespace (int4) do advisory lock transacional por número patrimonial em
# `confirm_preview` (serializa confirmações concorrentes do mesmo patrimônio).
_ADVISORY_LOCK_NAMESPACE_ASSET_PATRIMONY = 0x5350_4154  # "SPAT"

# Nomes de cabeçalho (case-insensitive) usados para localizar valores dentro
# de `normalized_values`/`raw_values` — ver `_extract_field`.
_HEADER_PATRIMONIO = "PATRIMONIO"
_HEADER_ID = "ID"
_HEADER_DESCRICAO = "DESCRICAO"
_HEADER_UNIDADE = "UNIDADE"
_HEADER_OBSERVACAO = "OBSERVACAO"
# Chaves dentro de `normalized_values` escritas por este serviço.
_LINKS_KEY = "_links"
# Código (sem valor) do vínculo descartado na prévia; ver `screen_bond_status`.
_BOND_DISCARD_KEY = "_vinculo_descartado"
_VALID_LOCATED = frozenset({"SIM", "NAO", "DESCONHECIDO"})
_IMPORT_SOURCE = "google_sheets"

_SELECTABLE_CLASSIFICATIONS = ("NOVO", "EXISTENTE")
# Falhas detalhadas devolvidas na resposta (o total vai em `falhas_total`);
# a lista completa fica nos `RawImportRecord` REJEITADO do SyncJob.
MAX_LISTED_FAILURES = 100
_ERROR_PREFIX = "erro:"


class ImportServiceError(Exception):
    """Erro de domínio base de `ImportService`.

    A camada de API (`app.api.v1.imports`) captura esta família de
    exceções e as converte em respostas HTTP com mensagens genéricas (sem
    detalhe interno), via subclasses específicas abaixo.
    """


class UpstreamSourceError(ImportServiceError):
    """Falha ao ler a fonte externa (Google Sheets).

    A API deve converter esta exceção em HTTP 502 (ou 503), com uma
    mensagem genérica — nunca repassando o detalhe interno de
    `GoogleSheetsClientError` ao cliente.
    """


class PreviewNotFoundError(ImportServiceError):
    """Nenhuma `ImportPreview` encontrada com o `preview_id` informado.

    A API deve converter esta exceção em HTTP 404.
    """


class PreviewNotConfirmableError(ImportServiceError):
    """A pré-visualização não pode ser confirmada no estado atual.

    Cobre três situações, todas mapeadas pela API para HTTP 409:
        - `status` diferente de `'CONCLUIDA'` (já confirmada — mecanismo de
          IDEMPOTÊNCIA desta operação, ver docstring de `confirm_preview` —,
          falhou, ou já expirada).
        - a prévia expirou (`now() > expires_at`), transição para
          `'EXPIRADA'` que esta chamada acabou de persistir.
    """


def _extract_field(values: dict[str, Any] | None, header_name: str) -> Any:
    """Busca um valor em `values` (um dict de `raw_values`/`normalized_values`)
    pelo nome do cabeçalho, comparando de forma case-insensitive (após
    `strip()`).

    Necessário porque `GoogleSheetsClient` guarda cada valor sob uma chave
    igual ao cabeçalho exatamente como lido da planilha (preservando caixa),
    desambiguado apenas quando duplicado (ex.: `RESPONSAVEL_1`) — ver
    docstring de `app.integrations.google_sheets_client`. Retorna `None` se
    nenhuma chave corresponder.
    """
    target = canonical_header(header_name)
    for key, value in (values or {}).items():
        if isinstance(key, str) and canonical_header(key) == target:
            return value
    return None


def _normalize_patrimony(value: Any) -> str | None:
    """Normaliza um valor de PATRIMONIO para comparação (ver decisão de
    design documentada na docstring do módulo: NFC, remoção de caracteres
    invisíveis e `strip()`, sem alteração de caixa nem remoção de zeros à
    esquerda). `float` nunca é aceito (perderia zeros à esquerda) e valores
    com caracteres de controle são descartados (defesa em profundidade; o
    `GoogleSheetsClient` já os marca como erro bloqueante)."""
    if value is None or isinstance(value, (bool, float)):
        return None
    text = normalize_identifier(value if isinstance(value, str) else str(value))
    if not text or has_control_chars(text):
        return None
    return text


def _has_blocking_error(validation_errors: list[Any] | None) -> bool:
    """Indica se `validation_errors` (lista de strings vinda do
    `GoogleSheetsClient`) contém alguma entrada de erro bloqueante (prefixo
    `"erro: "`, distinta de um mero `"aviso: "`)."""
    for message in validation_errors or []:
        if isinstance(message, str) and message.strip().lower().startswith(_ERROR_PREFIX):
            return True
    return False


def _source_row_number_of(item: ImportPreviewItem) -> int | None:
    """Linha de origem (1-based) guardada em `normalized_values` na prévia."""
    value = (item.normalized_values or {}).get(_SOURCE_ROW_KEY)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _parse_iso_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _same_instant(a: datetime | None, b: datetime | None) -> bool:
    """Igualdade de instantes tolerando naive (tratado como UTC) vs aware."""
    if a is None or b is None:
        return a is b
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    return a == b


def would_classify(asset: Any, description: str | None) -> bool:
    """True se `apply_if_unclassified` alteraria o bem (sem alterá-lo)."""
    if getattr(asset, "asset_category", None) is not None:
        return False
    return classify_description(description)[0] is not None


class ImportService:
    """Serviço de importação de dados do Google Sheets para `assets`.

    Ver docstring do módulo para as decisões de design, a gestão de
    transação (desvio intencional do padrão `with get_db_session()`) e as
    suposições pendentes de confirmação institucional.
    """

    _asset_cache: dict[str, list[Asset]] | None = None  # padrão de classe

    def __init__(
        self,
        db_session: Session,
        sheets_client: GoogleSheetsClient,
        settings: Settings | None = None,
    ) -> None:
        self._db = db_session
        self._sheets_client = sheets_client
        self._settings = settings or get_settings()
        self._refs: ImportReferences | None = None
        # Cache em memória (somente durante `create_preview`): patrimônio
        # normalizado -> assets ATIVOS. Evita 1 query por linha (N+1).
        self._asset_cache: dict[str, list[Asset]] | None = None

    # ------------------------------------------------------------------
    # Consultas auxiliares a `assets`/`units`
    # ------------------------------------------------------------------

    _asset_cache: dict[str, list[Asset]] | None = None  # padrão de classe

    def _active_assets_by_patrimony(self, patrimony_number: str | None) -> list[Asset]:
        """Retorna todos os `assets` ATIVOS (`deleted_at IS NULL`) com este
        `patrimony_number`, comparado como `lower(trim)` (igual à API de bens;
        SEC-AST-01). Nunca grava em `assets` — apenas leitura."""
        if patrimony_number is None:
            return []
        if self._asset_cache is not None:
            return list(self._asset_cache.get(normalize_patrimony_number(patrimony_number), []))
        return (
            self._db.query(Asset)
            .filter(
                normalized_column(Asset.patrimony_number)
                == normalize_patrimony_number(patrimony_number),
                Asset.deleted_at.is_(None),
            )
            .all()
        )

    def _prefetch_active_assets(self, patrimony_numbers: set[str]) -> None:
        """Carrega em lote os assets ATIVOS dos patrimônios informados (mesma
        comparação `lower(trim)` da consulta unitária) e ativa o cache."""
        cache: dict[str, list[Asset]] = {}
        keys = sorted({normalize_patrimony_number(n) for n in patrimony_numbers})
        for start in range(0, len(keys), _PREFETCH_CHUNK):
            chunk = keys[start : start + _PREFETCH_CHUNK]
            found = (
                self._db.query(Asset)
                .filter(normalized_column(Asset.patrimony_number).in_(chunk), Asset.deleted_at.is_(None))
                .all()
            )
            for asset in found:
                cache.setdefault(normalize_patrimony_number(asset.patrimony_number), []).append(asset)
        self._asset_cache = cache

    def _references(self) -> ImportReferences:
        """Mapas de unidades/aliases/salas/pessoas (carga única por operação)."""
        if self._refs is None:
            self._refs = ImportReferences(self._db)
        return self._refs

    def _resolve_links(self, normalized_values: dict[str, Any] | None) -> LinkResolution:
        nv = normalized_values or {}
        return self._references().resolve(
            unit_sigla=_extract_field(nv, _HEADER_UNIDADE), normalized=nv
        )

    def _bond_status_of(self, normalized_values: dict[str, Any]) -> str | None:
        """ÚNICO caminho que produz `assets.bond_status` na importação:
        `normalize_bond_status` + descarte de valor reservado e de nome de
        pessoa (SEC-VF-01 item 2 / SEC-VF-04). Pessoas carregadas 1x/operação."""
        return self._references().screen_bond(normalized_values)[0]

    def _lock_patrimony(self, patrimony_number: str) -> None:
        """Advisory lock TRANSACIONAL por número patrimonial NORMALIZADO
        (`lower(btrim)`), com a MESMA chave da API de bens (SEC-AST-01; ver
        `app.services.patrimony_lock`). Bind parameter; liberado no
        commit/rollback."""
        acquire_patrimony_lock(self._db, patrimony_number)

    def _apply_item(
        self, item: ImportPreviewItem, now: datetime, confirmed_by_user_id: uuid.UUID
    ) -> tuple[str | None, int, int]:
        """Revalida e aplica UM item NOVO/EXISTENTE em `assets`.

        Retorna `(failure_reason, created_delta, updated_delta)`. Chamado
        dentro de um savepoint (ver `confirm_preview`).
        """
        if item.classification == "NOVO":
            existing = self._active_assets_by_patrimony(item.patrimony_number)
            if existing:
                return (
                    "condição de corrida: já existe um bem ativo com este número de "
                    "patrimônio (surgiu após a pré-visualização)",
                    0,
                    0,
                )
            links = self._resolve_links(item.normalized_values)
            if links.blocking is not None or links.unit_id is None:
                return (
                    f"não foi possível determinar a unidade: "
                    f"{message_for(links.blocking or 'unidade_ausente')}",
                    0,
                    0,
                )
            nv = item.normalized_values or {}
            located = nv.get("located_enum")
            notes = _extract_field(nv, _HEADER_OBSERVACAO)
            item.normalized_values = {
                **nv,
                _LINKS_KEY: links.to_json(),
                "usuario_person_id": str(links.usuario_person_id)
                if links.usuario_person_id
                else None,
            }
            asset = Asset(
                id=uuid4(),
                source_record_id=item.source_record_id,
                source_system=_IMPORT_SOURCE,
                patrimony_number=item.patrimony_number,
                description=item.description,
                unit_id=links.unit_id,
                owner_unit_id=links.owner_unit_id,
                room_id=links.room_id,
                responsible_person_id=links.responsible_person_id,
                assigned_user_id=None,  # contas do sistema; nunca vem da planilha
                located=located if located in _VALID_LOCATED else "DESCONHECIDO",
                notes=notes.strip() if isinstance(notes, str) and notes.strip() else None,
                registration_date=_parse_iso_date(nv.get("registration_date")),
                # Vínculo (1ª RESPONSAVEL): pertence à planilha; nunca é pessoa
                # (triagem autoritativa de novo aqui; ver `_bond_status_of`).
                bond_status=self._bond_status_of(nv),
                source_updated_at=_parse_iso_datetime(nv.get("source_updated_at_utc")) or now,
                created_by=confirmed_by_user_id,
                updated_by=confirmed_by_user_id,
                version=1,
            )
            apply_if_unclassified(asset, asset.description)  # só preenche; regra fechada
            self._db.add(asset)
            self._db.flush()
            item.matched_asset_id = asset.id
            return None, 1, 0

        if item.classification == "EXISTENTE":
            existing = self._active_assets_by_patrimony(item.patrimony_number)
            if len(existing) != 1:
                return (
                    "condição de corrida: o estado do bem mudou desde a pré-visualização "
                    "(zero ou múltiplos bens ativos encontrados com este patrimônio)",
                    0,
                    0,
                )
            asset = existing[0]
            # Trava a linha do bem e recarrega `version` do banco antes da
            # comparação otimista (fecha a janela entre ler e gravar).
            self._db.refresh(asset, with_for_update=True)
            baseline_version = (item.normalized_values or {}).get(_VERSION_AT_PREVIEW_KEY)
            if baseline_version is None or asset.version != baseline_version:
                return (
                    "falha de concorrência: o bem foi modificado desde a "
                    "pré-visualização (version diverge da versão lida)",
                    0,
                    0,
                )
            if asset.deleted_at is not None:
                return ("o bem foi excluído logicamente após a pré-visualização", 0, 0)
            # Vínculo é da planilha (não editável na UI): atualiza quando muda;
            # célula vazia NÃO apaga o valor existente (mesma regra da descrição).
            # Vínculo descartado (pessoa/reservado) conta como vazio: mantém o atual.
            bond = self._bond_status_of(item.normalized_values or {})
            source_updated = _parse_iso_datetime(
                (item.normalized_values or {}).get("source_updated_at_utc")
            )
            new_description = item.description if item.description else asset.description
            # INALTERADO: nada que a planilha traga difere do bem. Não grava nem
            # incrementa `version` (idempotência: reimportar a mesma planilha é
            # no-op) e a resposta conta o item em `inalterados`, não em `updated`.
            unchanged = (
                new_description == asset.description
                and (bond is None or bond == asset.bond_status)
                and asset.source_system == _IMPORT_SOURCE
                and asset.source_record_id == item.source_record_id
                and (source_updated is None or _same_instant(source_updated, asset.source_updated_at))
                and not would_classify(asset, new_description)
            )
            if unchanged:
                return None, 0, 0
            if item.description:
                asset.description = item.description
            if bond is not None and bond != asset.bond_status:
                asset.bond_status = bond
            # Classificação: só quando ainda nula (nunca sobrescreve a existente).
            apply_if_unclassified(asset, asset.description)
            asset.source_system = "google_sheets"
            asset.source_record_id = item.source_record_id
            asset.source_updated_at = source_updated or now
            asset.updated_by = confirmed_by_user_id
            asset.version = asset.version + 1
            self._db.add(asset)
            return None, 0, 1

        return f"classificação não selecionável: {item.classification!r}", 0, 0

    # ------------------------------------------------------------------
    # create_preview
    # ------------------------------------------------------------------

    def create_preview(self, requested_by_user_id: uuid.UUID) -> ImportPreview:
        """Lê a planilha de origem e produz uma `ImportPreview` classificada.

        Classificação de cada linha (ordem de precedência — a primeira regra
        que se aplicar decide a classificação da linha; ver docstring do
        módulo para as decisões de design por trás de cada regra):

            1. INVALIDO: a própria linha já trouxe um erro bloqueante do
               `GoogleSheetsClient` (`validation_errors` com prefixo
               `"erro: "`, ex.: PATRIMONIO ou ID ausente). NUNCA selecionável.
            2. DUPLICADO: já existe uma ocorrência ANTERIOR, nesta mesma
               leitura da planilha, com o mesmo PATRIMONIO normalizado.
               NUNCA selecionável por padrão (usuário pode revisar
               manualmente antes de confirmar, mas `confirm_preview` sempre
               ignora itens com esta classificação).
            3. CONFLITANTE: existem 2+ `assets` ATIVOS no banco com este
               mesmo `patrimony_number` — situação que não deveria ocorrer,
               tratada defensivamente. NUNCA selecionável automaticamente.
            4. EXISTENTE: existe exatamente 1 `asset` ATIVO com este
               `patrimony_number` — selecionada por padrão; confirmar
               ATUALIZA esse asset.
            5. NOVO: nenhum `asset` ATIVO com este `patrimony_number` —
               selecionada por padrão; confirmar CRIA um novo asset.

        NUNCA grava em `assets` — apenas lê, para classificar. Persiste a
        `ImportPreview` e seus `ImportPreviewItem`s via `self._db.add(...)` +
        `flush()`; o `commit()` final é responsabilidade do chamador (ver
        docstring do módulo) — qualquer exceção levantada aqui propaga sem
        que nada tenha sido efetivamente confirmado no banco.

        Levanta `UpstreamSourceError` se a leitura do Google Sheets falhar
        (`GoogleSheetsClientError`), sem expor o detalhe interno do cliente.
        """
        t0 = time.perf_counter()
        try:
            read_result = self._sheets_client.read_patrimony_rows()
        except GoogleSheetsClientError as exc:
            logger.error("import_service.create_preview: falha ao ler Google Sheets (%s)", exc)
            raise UpstreamSourceError(
                "Não foi possível ler a planilha de origem (Google Sheets)."
            ) from exc

        now = datetime.now(timezone.utc)
        ttl_minutes = getattr(self._settings, "import_preview_ttl_minutes", 60) or 60
        expires_at = now + timedelta(minutes=ttl_minutes)
        preview_id = uuid4()

        # Conta quantas vezes cada PATRIMONIO normalizado já apareceu nesta
        # mesma leitura, na ordem das linhas — usado para a regra DUPLICADO.
        seen_patrimony: dict[str, int] = {}
        seen_source_ids: set[str] = set()
        counts = {"NOVO": 0, "EXISTENTE": 0, "DUPLICADO": 0, "INVALIDO": 0, "CONFLITANTE": 0}
        items: list[ImportPreviewItem] = []
        pending_counts: dict[str, int] = {}
        self._refs = None  # sempre recarrega os mapas de apoio nesta operação
        t_read = time.perf_counter()

        # Pré-carga em lote (1 query por 500 patrimônios) dos assets ativos e
        # dos mapas de vínculo, em vez de consultas por linha.
        wanted: set[str] = set()
        for r in read_result.rows:
            nv = r.get("normalized_values") or {}
            pn = _normalize_patrimony(_extract_field(nv, _HEADER_PATRIMONIO))
            if pn is not None:
                wanted.add(pn)
        self._prefetch_active_assets(wanted)
        t_prefetch = time.perf_counter()
        try:
            return self._classify_and_persist(
                read_result, requested_by_user_id, now, expires_at, preview_id,
                seen_patrimony, seen_source_ids, counts, items, pending_counts,
                t0, t_read, t_prefetch,
            )
        finally:
            self._asset_cache = None

    def _classify_and_persist(
        self, read_result, requested_by_user_id, now, expires_at, preview_id,
        seen_patrimony, seen_source_ids, counts, items, pending_counts,
        t0, t_read, t_prefetch,
    ) -> ImportPreview:
        for row in read_result.rows:
            raw_values: dict[str, Any] = dict(row.get("raw_values") or {})
            normalized_values: dict[str, Any] = dict(row.get("normalized_values") or {})
            validation_errors: list[Any] = list(row.get("validation_errors") or [])
            source_row_number = row.get("source_row_number")
            if isinstance(source_row_number, int) and not isinstance(source_row_number, bool):
                normalized_values[_SOURCE_ROW_KEY] = source_row_number

            patrimony_number = _normalize_patrimony(
                _extract_field(normalized_values, _HEADER_PATRIMONIO)
            )
            description_raw = _extract_field(normalized_values, _HEADER_DESCRICAO)
            description = description_raw.strip() if isinstance(description_raw, str) else None
            source_record_id_raw = _extract_field(normalized_values, _HEADER_ID)
            source_record_id = (
                normalize_identifier(str(source_record_id_raw)) or None
                if source_record_id_raw is not None
                else None
            )

            # Defesa em profundidade: uma linha sem PATRIMONIO utilizável
            # NUNCA pode ser selecionável (ex.: cabeçalho duplicado/ambíguo,
            # valor só com caracteres invisíveis), mesmo que o cliente de
            # leitura não tenha marcado erro — `assets.patrimony_number` é
            # NOT NULL e a confirmação falharia no banco.
            if patrimony_number is None and not _has_blocking_error(validation_errors):
                validation_errors.append("erro: campo PATRIMONIO ausente, vazio ou inválido")

            # ID de origem repetido na planilha: aviso (não bloqueante) para
            # revisão do operador; IDs originais são preservados como estão.
            if source_record_id is not None:
                if source_record_id in seen_source_ids:
                    validation_errors.append(
                        "aviso: ID de origem repetido em outra linha da planilha"
                    )
                seen_source_ids.add(source_record_id)

            already_seen = (
                seen_patrimony.get(normalize_patrimony_number(patrimony_number), 0)
                if patrimony_number else 0
            )
            matched_asset_id: uuid.UUID | None = None

            if _has_blocking_error(validation_errors):
                classification = "INVALIDO"
                # Melhor esforço: ainda tenta localizar um asset correspondente,
                # apenas de forma informativa (não afeta a classificação).
                if patrimony_number is not None:
                    candidates = self._active_assets_by_patrimony(patrimony_number)
                    if len(candidates) == 1:
                        matched_asset_id = candidates[0].id
            elif patrimony_number is not None and already_seen > 0:
                classification = "DUPLICADO"
                candidates = self._active_assets_by_patrimony(patrimony_number)
                if len(candidates) == 1:
                    matched_asset_id = candidates[0].id
            else:
                candidates = self._active_assets_by_patrimony(patrimony_number)
                if len(candidates) > 1:
                    classification = "CONFLITANTE"
                    # Deliberadamente SEM matched_asset_id: a ambiguidade é
                    # exatamente o problema (ver docstring do módulo).
                elif len(candidates) == 1:
                    classification = "EXISTENTE"
                    matched_asset_id = candidates[0].id
                    normalized_values[_VERSION_AT_PREVIEW_KEY] = candidates[0].version
                else:
                    classification = "NOVO"
                    links = self._resolve_links(normalized_values)
                    normalized_values[_LINKS_KEY] = links.to_json()
                    normalized_values["usuario_person_id"] = (
                        str(links.usuario_person_id) if links.usuario_person_id else None
                    )
                    for code in links.pendencias:
                        pending_counts[code] = pending_counts.get(code, 0) + 1
                        level = "erro" if code == links.blocking else "aviso"
                        validation_errors.append(f"{level}: {message_for(code)}")
                    if links.blocking is not None:
                        classification = "INVALIDO"

            # Vínculo (1ª RESPONSAVEL) que seria descartado na confirmação
            # (nome de pessoa / valor reservado): aviso visível na prévia, sem
            # ecoar o valor. A confirmação refaz a triagem (autoritativa).
            if classification in _SELECTABLE_CLASSIFICATIONS:
                _, bond_discard = self._references().screen_bond(normalized_values)
                if bond_discard is not None:
                    normalized_values[_BOND_DISCARD_KEY] = bond_discard
                    validation_errors.append(f"aviso: {message_for(bond_discard)}")

            if patrimony_number is not None:
                seen_patrimony[normalize_patrimony_number(patrimony_number)] = already_seen + 1

            counts[classification] += 1
            selected_default = classification in _SELECTABLE_CLASSIFICATIONS

            items.append(
                ImportPreviewItem(
                    id=uuid4(),
                    preview_id=preview_id,
                    source_record_id=source_record_id,
                    patrimony_number=patrimony_number,
                    description=description,
                    raw_values=raw_values,
                    normalized_values=normalized_values,
                    classification=classification,
                    validation_errors=validation_errors or None,
                    matched_asset_id=matched_asset_id,
                    selected=selected_default,
                    created_at=now,
                )
            )

        t_classify = time.perf_counter()
        preview = ImportPreview(
            id=preview_id,
            requested_by=requested_by_user_id,
            source="google_sheets",
            status="CONCLUIDA",
            total_rows=len(read_result.rows),
            count_novo=counts["NOVO"],
            count_existente=counts["EXISTENTE"],
            count_duplicado=counts["DUPLICADO"],
            count_invalido=counts["INVALIDO"],
            count_conflitante=counts["CONFLITANTE"],
            created_at=now,
            expires_at=expires_at,
        )

        self._db.add(preview)
        if items:
            self._db.add_all(items)
        self._db.flush()
        t_end = time.perf_counter()
        logger.info(
            "import_service.create_preview: linhas=%d leitura=%.2fs prefetch=%.2fs "
            "classificacao=%.2fs persistencia=%.2fs total=%.2fs",
            len(read_result.rows), t_read - t0, t_prefetch - t_read,
            t_classify - t_prefetch, t_end - t_classify, t_end - t0,
        )

        # Atributo transitório (não persistido): contadores de pendências de
        # vínculo, para a prévia exibir sem bloquear a confirmação.
        preview.pending_counts = {  # type: ignore[attr-defined]
            code: pending_counts.get(code, 0) for code in PENDING_CODES
        }
        return preview

    def pending_report(self, preview_id: uuid.UUID) -> dict[str, int]:
        """Contadores de pendências de vínculo de uma prévia (a partir dos itens).

        Chaves = `PENDING_CODES` (unidade sem alias, sala não encontrada,
        pessoa não encontrada/ambígua, ...). Somente leitura.
        """
        counts = {code: 0 for code in PENDING_CODES}
        items = (
            self._db.query(ImportPreviewItem)
            .filter(ImportPreviewItem.preview_id == preview_id)
            .all()
        )
        for item in items:
            links = (item.normalized_values or {}).get(_LINKS_KEY) or {}
            for code in links.get("pendencias") or []:
                if code in counts:
                    counts[code] += 1
        return counts

    # ------------------------------------------------------------------
    # list_preview_items (suporte à tela de revisão / paginação da API)
    # ------------------------------------------------------------------

    def list_preview_items(
        self,
        preview_id: uuid.UUID,
        status: str | None = None,
        search: str | None = None,
        page: int = 1,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        """Lista, de forma paginada, os itens de uma `ImportPreview`.

        `status` filtra por `classification` exata, restrita à allowlist
        `_ALLOWED_CLASSIFICATIONS` (case-insensitive; valor fora dela resulta
        em página vazia, sem consultar os itens). `search` busca (ILIKE) em
        `patrimony_number` OU `description` como TEXTO LITERAL: `%`, `_` e
        `\\` são escapados (`escape_like`) e o termo é limitado a
        `MAX_SEARCH_LENGTH` caracteres. Tudo via bind parameters do ORM —
        nenhum valor é concatenado no SQL. Ordenação fixa (sem coluna
        controlada pelo cliente). Levanta `PreviewNotFoundError` se
        `preview_id` não existir.
        """
        preview = self._db.query(ImportPreview).filter(ImportPreview.id == preview_id).first()
        if preview is None:
            raise PreviewNotFoundError(f"pré-visualização {preview_id} não encontrada")

        safe_page = min(max(page, 1), MAX_PAGE)
        safe_page_size = coerce_page_size(page_size)

        normalized_status = status.strip().upper() if isinstance(status, str) else None
        if normalized_status and normalized_status not in _ALLOWED_CLASSIFICATIONS:
            return {
                "preview": preview,
                "total": 0,
                "page": safe_page,
                "page_size": safe_page_size, "pages": 0,
                "items": [],
            }

        query = self._db.query(ImportPreviewItem).filter(
            ImportPreviewItem.preview_id == preview.id
        )
        if normalized_status:
            query = query.filter(ImportPreviewItem.classification == normalized_status)
        search_term = search.strip()[:MAX_SEARCH_LENGTH] if isinstance(search, str) else ""
        if search_term:
            query = query.filter(
                or_(
                    contains_ci(ImportPreviewItem.patrimony_number, search_term),
                    contains_ci(ImportPreviewItem.description, search_term),
                )
            )

        total = query.count()
        results = (
            # Desempate por `id`: todos os itens de uma prévia compartilham o
            # mesmo `created_at`, e sem um critério total a paginação do
            # PostgreSQL pode repetir/omitir itens entre páginas.
            query.order_by(ImportPreviewItem.created_at.asc(), ImportPreviewItem.id.asc())
            .offset((safe_page - 1) * safe_page_size)
            .limit(safe_page_size)
            .all()
        )

        return {
            "preview": preview,
            "total": total,
            "page": safe_page,
            "page_size": safe_page_size, "pages": page_count(total, safe_page_size),
            "items": results,
        }

    # ------------------------------------------------------------------
    # confirm_preview
    # ------------------------------------------------------------------

    def confirm_preview(
        self,
        preview_id: uuid.UUID,
        confirmed_by_user_id: uuid.UUID,
        selected_item_ids: list[uuid.UUID],
    ) -> dict[str, Any]:
        """Confirma (aplica em `assets`) os itens selecionados de uma prévia.

        Passos (ver docstring do módulo para a gestão de transação e as
        decisões de design por trás de cada regra):

            1. Busca a `ImportPreview`; `PreviewNotFoundError` se não existir
               (API: 404).
            2. Se `status != 'CONCLUIDA'`, levanta `PreviewNotConfirmableError`
               (API: 409). Isto é o mecanismo de IDEMPOTÊNCIA desta operação:
               uma segunda chamada com o mesmo `preview_id` encontra
               `status == 'CONFIRMADA'` (já aplicado na primeira chamada) e
               falha aqui, SEM duplicar nenhuma gravação em `assets`.
            3. Se `now() > expires_at`, marca `status='EXPIRADA'`, CONFIRMA
               (`commit()`) essa transição imediatamente — ela deve
               sobreviver mesmo que esta chamada falhe — e levanta
               `PreviewNotConfirmableError` (API: 409).
            4. Filtra `selected_item_ids` para os itens que: (a) pertencem a
               esta prévia, (b) têm `classification` em `('NOVO',
               'EXISTENTE')`. Qualquer outro id (inexistente, ou de um item
               INVALIDO/DUPLICADO/CONFLITANTE) é contado em `ignorados`, sem
               erro — silenciosamente ignorado, exatamente como pedido.
            5. Para cada item elegível, REVALIDA contra o estado ATUAL de
               `assets` (pode ter mudado desde a pré-visualização):
                   - NOVO: se já existir qualquer asset ativo com aquele
                     `patrimony_number`, é uma condição de corrida -> FALHA
                     para este item (não cria), reportado em `falhas`.
                   - EXISTENTE: se não houver mais exatamente 1 asset ativo
                     com aquele `patrimony_number`, OU se a versão atual do
                     asset divergir da versão lida na pré-visualização
                     (`_matched_asset_version_at_preview`, guardada dentro de
                     `normalized_values` — ver docstring do módulo), é uma
                     falha de concorrência -> FALHA para este item (não
                     atualiza), reportado em `falhas`.
               Uma falha de item NUNCA aborta os demais itens, nem o
               `SyncJob`/`AuditLog` desta execução — é tratada item a item.
            6. Aplica (INSERT/UPDATE) cada item válido em `assets`, cria um
               `SyncJob` (resumo da execução) e um `RawImportRecord` por
               linha processada (sucesso ou falha), e um `AuditLog`
               (`entity_type='import'`, `operation='CONFIRM_IMPORT'`).
            7. Marca `ImportPreview.status='CONFIRMADA'`,
               `confirmed_at`/`confirmed_by`, e CONFIRMA (`commit()`) tudo
               de uma vez.

        Retorna um dict: `{"sync_job_id", "status" (CONCLUIDO/PARCIAL/FALHOU),
        "created", "updated", "ignorados", "inalterados" (EXISTENTE sem
        diferença: nada gravado), "nao_gravados" (por classificação/motivo),
        "pendencias_vinculo", "falhas_total", "falhas"}`, onde `falhas` é uma
        lista (<= `MAX_LISTED_FAILURES`) de dicts
        `{"item_id", "row", "patrimony_number", "reason"}`.
        """
        preview = self._db.query(ImportPreview).filter(ImportPreview.id == preview_id).first()
        if preview is None:
            raise PreviewNotFoundError(f"pré-visualização {preview_id} não encontrada")

        # Concorrência (dupla confirmação simultânea): trava a linha da
        # prévia (`SELECT ... FOR UPDATE`) e RECARREGA seu estado antes de
        # checar o status. Uma segunda requisição concorrente bloqueia aqui
        # até a primeira concluir (commit) e então enxerga
        # status='CONFIRMADA' -> 409, sem duplicar gravações em `assets`.
        self._db.refresh(preview, with_for_update=True)

        if preview.status != "CONCLUIDA":
            raise PreviewNotConfirmableError(
                f"pré-visualização não pode ser confirmada (status atual: {preview.status!r})"
            )

        if preview.source != _IMPORT_SOURCE:
            # Prévias de outras origens (ex.: cadastros) têm serviço próprio.
            raise PreviewNotConfirmableError(
                "esta pré-visualização não é uma importação de bens"
            )
        self._refs = None

        now = datetime.now(timezone.utc)
        expires_at = preview.expires_at
        if expires_at.tzinfo is None:  # timestamptz volta aware no PostgreSQL
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if now > expires_at:
            preview.status = "EXPIRADA"
            self._db.add(preview)
            # Esta escrita precisa sobreviver mesmo que a confirmação falhe
            # (ver docstring do módulo) — commit explícito antes de levantar.
            self._db.commit()
            raise PreviewNotConfirmableError(
                "pré-visualização expirada; solicite uma nova pré-visualização"
            )

        items = (
            self._db.query(ImportPreviewItem)
            .filter(ImportPreviewItem.preview_id == preview.id)
            .all()
        )
        items_by_id = {item.id: item for item in items}

        selected_ids_set = set(selected_item_ids)
        eligible_items = [
            item
            for item_id, item in items_by_id.items()
            if item_id in selected_ids_set and item.classification in _SELECTABLE_CLASSIFICATIONS
        ]
        # Ordem determinística (por patrimônio) para que os advisory locks
        # abaixo sejam sempre adquiridos na mesma ordem por execuções
        # concorrentes — evita deadlock entre duas confirmações.
        eligible_items.sort(key=lambda it: (it.patrimony_number or "", str(it.id)))
        eligible_ids = {item.id for item in eligible_items}
        ignorados = len(selected_ids_set - eligible_ids)
        nao_gravados = self._unwritten_summary(items, selected_ids_set)

        created = 0
        updated = 0
        inalterados = 0
        # Pendências de vínculo dos bens EFETIVAMENTE criados (resolução
        # autoritativa da confirmação): só contadores por código.
        pendencias_vinculo: dict[str, int] = {code: 0 for code in PENDING_CODES}
        falhas: list[dict[str, Any]] = []

        sync_job = SyncJob(
            id=uuid4(),
            source="google_sheets",
            status="EM_EXECUCAO",
            started_at=now,
            records_read=len(eligible_items),
        )
        self._db.add(sync_job)

        for item in eligible_items:
            failure_reason: str | None = None

            if item.patrimony_number is None:
                # Defesa em profundidade: nunca deveria ser NOVO/EXISTENTE.
                failure_reason = "número patrimonial ausente ou inválido"
            else:
                # Serializa, dentro desta transação, qualquer outra
                # confirmação concorrente que toque o MESMO patrimônio (não
                # há índice único parcial em assets.patrimony_number — ver
                # relatório de auditoria). Liberado no commit/rollback.
                self._lock_patrimony(item.patrimony_number)
                # Savepoint por item: uma falha de banco (constraint, dado
                # inválido) desfaz SOMENTE este item, que vira `falha`; os
                # demais itens, o SyncJob e o AuditLog seguem normalmente.
                savepoint = self._db.begin_nested()
                try:
                    failure_reason, delta_created, delta_updated = self._apply_item(
                        item, now, confirmed_by_user_id
                    )
                    self._db.flush()
                except StaleDataError:
                    # `version_id_col` em Asset: o UPDATE ... WHERE version=:v
                    # não afetou linha (outro processo alterou o bem).
                    savepoint.rollback()
                    logger.warning(
                        "import_service.confirm_preview: StaleDataError no item %s", item.id
                    )
                    failure_reason = (
                        "falha de concorrência: o bem foi modificado por outro processo "
                        "durante a confirmação (version diverge)"
                    )
                except SQLAlchemyError as exc:
                    savepoint.rollback()
                    logger.error(
                        "import_service.confirm_preview: erro de banco ao aplicar item %s (%s)",
                        item.id,
                        type(exc).__name__,
                    )
                    failure_reason = "erro de banco ao aplicar o item; nenhuma alteração gravada"
                else:
                    savepoint.commit()
                    created += delta_created
                    updated += delta_updated
                    if failure_reason is not None:
                        pass  # rejeitado por revalidação: contado em `falhas`
                    elif not (delta_created or delta_updated):
                        inalterados += 1
                    elif delta_created:
                        links = (item.normalized_values or {}).get(_LINKS_KEY) or {}
                        for code in links.get("pendencias") or []:
                            if code in pendencias_vinculo:
                                pendencias_vinculo[code] += 1

            if failure_reason is not None:
                falhas.append(
                    {
                        "item_id": str(item.id),
                        "row": _source_row_number_of(item),
                        "patrimony_number": item.patrimony_number,
                        "reason": failure_reason,
                    }
                )

            raw_status = "REJEITADO" if failure_reason is not None else "IMPORTADO"
            self._db.add(
                RawImportRecord(
                    id=uuid4(),
                    sync_job_id=sync_job.id,
                    source_record_id=item.source_record_id or str(item.id),
                    source_row_number=_source_row_number_of(item),
                    raw_values=item.raw_values,
                    normalized_values=item.normalized_values,
                    validation_errors=(
                        {"reason": failure_reason} if failure_reason is not None else None
                    ),
                    import_status=raw_status,
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
                f"{len(falhas)} item(ns) não importado(s); ver RawImportRecord REJEITADO "
                f"associado a este SyncJob para detalhes por item."
            )
        self._db.add(sync_job)

        preview.status = "CONFIRMADA"
        preview.confirmed_at = datetime.now(timezone.utc)
        preview.confirmed_by = confirmed_by_user_id
        self._db.add(preview)

        audit_result = "FALHA" if sync_job.status == "FALHOU" else "SUCESSO"
        self._db.add(
            AuditLog(
                id=uuid4(),
                actor_user_id=confirmed_by_user_id,
                entity_type="import",
                entity_id=str(preview.id),
                operation="CONFIRM_IMPORT",
                previous_values={"status": "CONCLUIDA"},
                new_values={
                    "status": "CONFIRMADA",
                    "sync_job_id": str(sync_job.id),
                    "created": created,
                    "updated": updated,
                    "ignorados": ignorados,
                    "inalterados": inalterados,
                    "falhas": len(falhas),
                    "job_status": sync_job.status,
                },
                result=audit_result,
            )
        )

        # Commit único de toda a execução (itens aplicados, SyncJob,
        # RawImportRecords, AuditLog e a transição da prévia para
        # CONFIRMADA) — ver docstring do módulo.
        self._db.commit()

        return {
            "sync_job_id": sync_job.id,
            "status": sync_job.status,
            "created": created,
            "updated": updated,
            "ignorados": ignorados,
            "inalterados": inalterados,
            "nao_gravados": nao_gravados,
            "pendencias_vinculo": pendencias_vinculo,
            "falhas_total": len(falhas),
            # Lista completa só no RawImportRecord; a resposta traz no máximo N.
            "falhas": falhas[:MAX_LISTED_FAILURES],
        }

    @staticmethod
    def _unwritten_summary(
        items: list[ImportPreviewItem], wanted: set[uuid.UUID]
    ) -> dict[str, Any]:
        """Itens da prévia que esta confirmação NÃO grava, por classificação e motivo.

        Só contadores e códigos (sem PII, sem valores da planilha). O motivo é o
        código da pendência que bloqueou o vínculo (`unidade_sem_alias`...),
        `duplicado_na_origem`, `patrimonio_conflitante` ou `dados_invalidos`.
        `nao_selecionados` = NOVO/EXISTENTE que o ADM desmarcou.
        """
        by_class = {"DUPLICADO": 0, "INVALIDO": 0, "CONFLITANTE": 0}
        by_reason: dict[str, int] = {}
        not_selected = 0
        for item in items:
            if item.classification in _SELECTABLE_CLASSIFICATIONS:
                if item.id not in wanted:
                    not_selected += 1
                continue
            by_class[item.classification] = by_class.get(item.classification, 0) + 1
            blocking = ((item.normalized_values or {}).get(_LINKS_KEY) or {}).get("blocking")
            if blocking in PENDING_CODES:
                code = blocking
            elif item.classification == "DUPLICADO":
                code = "duplicado_na_origem"
            elif item.classification == "CONFLITANTE":
                code = "patrimonio_conflitante"
            else:
                code = "dados_invalidos"
            by_reason[code] = by_reason.get(code, 0) + 1
        return {
            "total": sum(by_class.values()),
            "por_classificacao": by_class,
            "por_motivo": by_reason,
            "nao_selecionados": not_selected,
        }
