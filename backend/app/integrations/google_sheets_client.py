"""Cliente de leitura para a planilha Google Sheets de origem do acervo patrimonial.

Este módulo implementa **somente leitura**. Nenhum método de escrita na
planilha é fornecido — a Fase 1 da sincronização é unidirecional
(Google Sheets → Flask → PostgreSQL), conforme
`docs/architecture/estrategia-sincronizacao.md`. A planilha de origem nunca é
modificada por este cliente, em nenhuma circunstância.

Garantias deste cliente (`GoogleSheetsClient`), no mesmo espírito do
`N8nClient` (`app/integrations/n8n_client.py`):

    - **Nunca propaga exceção bruta da biblioteca do Google**: qualquer falha
      (rede, credencial inválida, planilha/aba não encontrada, permissão
      insuficiente) é capturada, logada via `logging` padrão — **sem jamais
      logar o conteúdo do arquivo de credenciais da service account, nem
      qualquer segredo** — e relançada como `GoogleSheetsClientError`, um
      erro de domínio que o chamador (ex.: o serviço de importação) pode
      capturar e converter em mensagem amigável ao operador.
    - **Configuração via variáveis de ambiente**, seguindo o padrão de
      `app/config/settings.py`: o caminho do arquivo de credenciais vem de
      `settings.google_sheets_credentials_json`
      (env `GOOGLE_SHEETS_CREDENTIALS_JSON`) e o ID da planilha de
      `settings.google_sheets_spreadsheet_id`
      (env `GOOGLE_SHEETS_SPREADSHEET_ID`), ambos já documentados em
      `.env.example`. O acesso a esses atributos é feito de forma tolerante
      (`getattr`) para não acoplar este cliente à declaração exata desses
      campos em `Settings` — outro agente pode estar evoluindo esse módulo em
      paralelo; se os atributos não existirem ou estiverem vazios, o cliente
      levanta `GoogleSheetsClientError` com uma mensagem clara, em vez de
      `AttributeError`.
    - **Nome/posição da aba (sheet) a confirmar**: `settings.google_sheets_sheet_name`
      (título exato) ou `settings.google_sheets_sheet_gid` (o `sheetId`
      numérico da aba, visível na URL da planilha) podem ser configurados
      para apontar exatamente para a aba correta. Nenhum dos dois é exigido
      hoje em `.env.example`; **enquanto não forem confirmados, o cliente usa
      a primeira aba da planilha (por posição/`index`) como melhor suposição
      — isso é uma decisão temporária, a ser confirmada com a aba real na
      primeira execução real**, documentada também em
      `docs/architecture/estrategia-sincronizacao.md` (seção 10, item 1).
      O método público `list_sheet_tabs()` permite inspecionar todas as abas
      disponíveis (título, `sheetId`/GID, posição) para ajudar a confirmar
      essa configuração.
    - **Número patrimonial nunca é convertido para número**: a leitura usa
      `valueRenderOption="FORMATTED_VALUE"` na Sheets API (valor textual tal
      como exibido na célula), e nenhuma etapa deste módulo chama `int()`/
      `float()` sobre o valor de `PATRIMONIO` — preservando zeros à esquerda
      e evitando notação científica.
    - **Duas colunas `RESPONSAVEL`**: mapeadas por ORDEM de ocorrência no
      cabeçalho — a primeira para `responsavel_original` (pessoa física
      historicamente registrada) e a segunda para `responsavel_unidade`
      (unidade/setor responsável). **Esta é uma suposição pendente de
      confirmação institucional**, replicando exatamente a mesma suposição
      documentada em `docs/architecture/estrategia-sincronizacao.md`
      (seção 4.2) — não fundir, não trocar a ordem sem antes revisar aquele
      documento.
    - **Coluna `QT` nunca é interpretada**: o valor bruto é repassado tal
      como lido, em `raw_values["QT"]` e em `normalized_values["qt_raw"]`
      (como texto). Nenhuma regra de negócio, cálculo ou indicador deste
      módulo assume que `QT` significa "quantidade de equipamentos" — essa é
      exatamente a armadilha que `docs/architecture/estrategia-sincronizacao.md`
      (seção 4.3) pede para evitar.
    - **Convenção de célula vazia**: uma célula ausente (porque a Google
      Sheets API omite células finais vazias de uma linha) e uma célula
      presente, mas com string vazia ou composta só de espaços, são tratadas
      de forma IDÊNTICA — ambas se tornam `None`. Essa é a convenção
      escolhida para nunca misturar `None` com `""` de forma inconsistente.
      Fora isso, o valor bruto de uma célula não vazia é preservado
      exatamente como retornado pela API em `raw_values` (sem `strip()`);
      `normalized_values` aplica `strip()` (nunca upper()/lower() sobre
      conteúdo livre, como `DESCRICAO`).
    - **Entrada NÃO confiável (auditoria AppSec 2026-10-13)**: leitura
      limitada a `_DEFAULT_MAX_ROWS` linhas / `_DEFAULT_MAX_COLUMNS`
      colunas (excesso -> `GoogleSheetsClientError`, nada é gravado) e
      `_MAX_CELL_CHARS` por célula (excesso -> erro bloqueante na linha);
      timeout HTTP explícito; título da aba citado em notação A1;
      cabeçalhos comparados de forma canônica (NFC, sem BOM/zero-width,
      sem acento, case-insensitive); cabeçalho `ID`/`PATRIMONIO` duplicado
      -> erro bloqueante (coluna ambígua); NUL/surrogates substituídos por
      U+FFFD (não armazenáveis no PostgreSQL) com aviso; `PATRIMONIO`/`ID`
      validados como identificadores TEXTO (sem controle, sem float, sem
      notação científica, sem prefixo de fórmula `= + - @`). Conteúdo livre
      (ex.: `DESCRICAO`) NÃO é sanitizado de forma destrutiva — XSS/CSV
      injection são tratados na saída (React / `app.security.csv_safety`).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import re

import google_auth_httplib2
import googleapiclient.discovery
import httplib2
from google.oauth2 import service_account
from googleapiclient.errors import HttpError

from app.config.settings import Settings, get_settings
from app.security.sanitize import (
    canonical_header,
    has_control_chars,
    make_db_safe,
    normalize_free_text,
    normalize_identifier,
)

logger = logging.getLogger(__name__)

# Escopo somente leitura — este cliente nunca escreve na planilha.
_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Nomes de cabeçalho (após strip + upper) tratados de forma especial.
_HEADER_RESPONSAVEL = "RESPONSAVEL"
_HEADER_QT = "QT"
_HEADER_ID = "ID"
_HEADER_PATRIMONIO = "PATRIMONIO"

# --- Limites de consumo de recursos (OWASP API4:2023) -----------------------
# Podem ser sobrescritos via atributos opcionais de `settings`
# (`google_sheets_max_rows`, `google_sheets_max_columns`,
# `google_sheets_timeout_seconds`), lidos com `getattr` como os demais
# campos `google_sheets_*`.
_DEFAULT_MAX_ROWS = 20_000  # linhas de dados (exclui cabeçalho)
_DEFAULT_MAX_COLUMNS = 100
# Limite por célula. O próprio Google Sheets aceita até 50.000 caracteres;
# acima deste valor a linha vira INVALIDO e o valor armazenado é truncado
# (o tamanho original é registrado no erro).
_MAX_CELL_CHARS = 5_000
# Limite de tamanho de um número patrimonial/ID de origem.
_MAX_IDENTIFIER_CHARS = 64
# Timeout (s) de cada requisição HTTP à Sheets API.
_DEFAULT_HTTP_TIMEOUT_SECONDS = 30

# Número patrimonial que a planilha exibiu em notação científica (ex.:
# "1,23457E+11") — sinal de que a célula é NUMÉRICA e o valor original
# (com dígitos/zeros à esquerda) já foi perdido na própria planilha.
_SCIENTIFIC_NOTATION_RE = re.compile(r"^[0-9]+([.,][0-9]+)?[eE][+-]?[0-9]+$")
# Primeiros caracteres que nunca são válidos em um número patrimonial e
# indicam fórmula/valor inesperado (CWE-1236 na origem).
_PATRIMONY_FORBIDDEN_LEADING = ("=", "+", "-", "@")


def _column_letter(index_1_based: int) -> str:
    """Converte 1 -> A, 26 -> Z, 27 -> AA (notação A1)."""
    letters = ""
    n = index_1_based
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _quote_sheet_title(title: str) -> str:
    """Cita o título da aba para notação A1 (aspas simples duplicadas)."""
    return "'" + title.replace("'", "''") + "'"


class GoogleSheetsClientError(Exception):
    """Erro de domínio para qualquer falha na integração com a Google Sheets API.

    Substitui qualquer exceção bruta da biblioteca do Google
    (`googleapiclient`, `google.auth`) ou de rede antes de chegar ao
    chamador, para que o serviço de importação possa tratar este erro e
    convertê-lo em uma mensagem amigável (e em `sync_jobs.status = 'FAILED'`
    / `error_summary`), sem precisar conhecer detalhes de implementação desta
    integração.
    """


@dataclass(frozen=True)
class GoogleSheetsReadResult:
    """Resultado de uma leitura completa da aba de patrimônio da planilha.

    Attributes:
        rows: uma entrada por linha de dados (exclui o cabeçalho), cada uma
            um `dict` com as chaves `source_row_number` (posição 1-based da
            linha na planilha, útil para o operador localizar e corrigir a
            linha de origem), `raw_values` (dict, valores tal como lidos),
            `normalized_values` (dict, valores normalizados) e
            `validation_errors` (lista de strings, nunca interrompe a
            leitura das demais linhas).
        headers: os cabeçalhos exatamente como lidos na primeira linha da
            aba, na ordem original (pode conter nomes duplicados, ex.:
            `RESPONSAVEL` aparece duas vezes).
        sheet_title: o título da aba efetivamente lida, ou `None` se não foi
            possível determiná-lo.
        fetched_at: instante (UTC) em que a leitura foi concluída.
    """

    rows: list[dict[str, Any]]
    headers: list[str]
    sheet_title: str | None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def _has_error_for(validation_errors: list[str], key: str) -> bool:
    """True se já existe um erro bloqueante registrado para o campo `key`."""
    marker = f"campo {key} "
    return any(msg.startswith("erro:") and marker in msg for msg in validation_errors)


def _is_blank(value: Any) -> bool:
    """Convenção única de "célula vazia" usada em todo este módulo."""
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def _disambiguate_headers(headers: list[str]) -> list[str]:
    """Gera chaves de dicionário únicas para cabeçalhos duplicados.

    Cabeçalhos que aparecem apenas uma vez mantêm seu nome original. Um
    cabeçalho que se repete (ex.: as duas colunas `RESPONSAVEL`) recebe o
    sufixo `_1`, `_2`, ... na ordem de ocorrência, para que `raw_values`
    possa preservar ambos os valores lado a lado sem que um sobrescreva o
    outro — exatamente como descrito em
    `docs/architecture/estrategia-sincronizacao.md` (seção 3, item 1).
    """
    counts: dict[str, int] = {}
    for header in headers:
        counts[header] = counts.get(header, 0) + 1

    seen: dict[str, int] = {}
    disambiguated: list[str] = []
    used: set[str] = {header for header in headers if counts[header] == 1}
    for header in headers:
        if counts[header] > 1:
            # Garante unicidade mesmo se já existir um cabeçalho literal igual
            # ao sufixo gerado (ex.: "RESPONSAVEL_1" + 2x "RESPONSAVEL"), para
            # que nenhum valor sobrescreva outro em `raw_values`.
            while True:
                seen[header] = seen.get(header, 0) + 1
                candidate = f"{header}_{seen[header]}"
                if candidate not in used:
                    break
            used.add(candidate)
            disambiguated.append(candidate)
        else:
            disambiguated.append(header)
    return disambiguated


class GoogleSheetsClient:
    """Cliente de leitura (somente leitura) da planilha Google Sheets de origem.

    Ver docstring do módulo para as garantias de robustez, as suposições
    pendentes de confirmação institucional (colunas `RESPONSAVEL`, aba/GID
    alvo) e a convenção de célula vazia.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._service: Any | None = None

    # ------------------------------------------------------------------
    # Configuração
    # ------------------------------------------------------------------

    def _credentials_path(self) -> str:
        path = getattr(self._settings, "google_sheets_credentials_json", None)
        if not path:
            raise GoogleSheetsClientError(
                "GOOGLE_SHEETS_CREDENTIALS_JSON não configurado (caminho do "
                "arquivo de credenciais da service account)."
            )
        return path

    def _spreadsheet_id(self) -> str:
        spreadsheet_id = getattr(self._settings, "google_sheets_spreadsheet_id", None)
        if not spreadsheet_id:
            raise GoogleSheetsClientError(
                "GOOGLE_SHEETS_SPREADSHEET_ID não configurado (ID da planilha "
                "de origem)."
            )
        return spreadsheet_id

    # ------------------------------------------------------------------
    # Infraestrutura de chamada à API (autenticação, tratamento de erro)
    # ------------------------------------------------------------------

    def _get_service(self) -> Any:
        """Constrói (e cacheia) o recurso da Sheets API v4, autenticado via
        service account.

        Nunca loga o conteúdo do arquivo de credenciais (apenas o tipo da
        exceção, em caso de falha).
        """
        if self._service is not None:
            return self._service

        credentials_path = self._credentials_path()
        try:
            credentials = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=_SCOPES
            )
            # Timeout explícito em toda requisição HTTP (evita threads presas
            # indefinidamente se a API não responder — API4/A10).
            timeout = getattr(self._settings, "google_sheets_timeout_seconds", None)
            authorized_http = google_auth_httplib2.AuthorizedHttp(
                credentials,
                http=httplib2.Http(timeout=timeout or _DEFAULT_HTTP_TIMEOUT_SECONDS),
            )
            service = googleapiclient.discovery.build(
                "sheets", "v4", http=authorized_http, cache_discovery=False
            )
        except GoogleSheetsClientError:
            raise
        except HttpError as exc:
            raise self._wrap_error("autenticar com a Google Sheets API", exc) from exc
        except Exception as exc:  # noqa: BLE001 - convertido para erro de domínio
            raise self._wrap_error("autenticar com a Google Sheets API", exc) from exc

        self._service = service
        return service

    def _wrap_error(self, action: str, exc: Exception) -> GoogleSheetsClientError:
        """Loga (sem dados sensíveis) e converte qualquer exceção em
        `GoogleSheetsClientError`."""
        logger.error(
            "google_sheets_client: falha ao %s (%s)",
            action,
            type(exc).__name__,
        )
        return GoogleSheetsClientError(
            f"falha ao {action} na Google Sheets API ({type(exc).__name__})"
        )

    # ------------------------------------------------------------------
    # Descoberta de abas (sheet tabs)
    # ------------------------------------------------------------------

    def list_sheet_tabs(self) -> list[dict[str, Any]]:
        """Lista as abas da planilha configurada.

        Retorna uma lista de dicts com `title`, `sheetId` (GID) e `index`
        para cada aba, na ordem retornada pela API. Útil para confirmar,
        antes da primeira execução real, qual aba contém de fato os dados de
        patrimônio (ver docstring do módulo).
        """
        service = self._get_service()
        spreadsheet_id = self._spreadsheet_id()
        try:
            response = (
                service.spreadsheets()
                .get(
                    spreadsheetId=spreadsheet_id,
                    fields="sheets(properties(sheetId,title,index))",
                )
                .execute()
            )
        except GoogleSheetsClientError:
            raise
        except HttpError as exc:
            raise self._wrap_error("listar as abas da planilha", exc) from exc
        except Exception as exc:  # noqa: BLE001 - convertido para erro de domínio
            raise self._wrap_error("listar as abas da planilha", exc) from exc

        sheets = response.get("sheets", []) or []
        return [sheet.get("properties", {}) for sheet in sheets]

    def _resolve_sheet_title(self) -> str:
        """Determina o título da aba a ser lida.

        Ordem de prioridade: `settings.google_sheets_sheet_name` (título
        exato) > `settings.google_sheets_sheet_gid` (GID numérico) >
        primeira aba por posição (`index == 0`), como melhor suposição
        temporária — **a ser confirmado com a aba real na primeira execução
        real** (ver docstring do módulo).
        """
        configured_name = getattr(self._settings, "google_sheets_sheet_name", None)
        if configured_name:
            return configured_name

        tabs = self.list_sheet_tabs()
        if not tabs:
            raise GoogleSheetsClientError(
                "a planilha configurada não possui nenhuma aba visível para "
                "esta credencial."
            )

        configured_gid = getattr(self._settings, "google_sheets_sheet_gid", None)
        if configured_gid is not None:
            # `sheetId` vem como int da API; o GID configurado é str (env).
            for tab in tabs:
                if str(tab.get("sheetId")) == str(configured_gid).strip():
                    return tab.get("title", "")
            raise GoogleSheetsClientError(
                "nenhuma aba encontrada com o GID configurado em "
                "GOOGLE_SHEETS_SHEET_GID."
            )

        # Nenhuma aba/GID configurado: usa a primeira aba por posição.
        # Decisão temporária, pendente de confirmação institucional.
        first_tab = min(tabs, key=lambda tab: tab.get("index", 0))
        return first_tab.get("title", "")

    # ------------------------------------------------------------------
    # Leitura principal
    # ------------------------------------------------------------------

    def read_patrimony_rows(self) -> GoogleSheetsReadResult:
        """Lê a aba de patrimônio completa e retorna um `GoogleSheetsReadResult`.

        A primeira linha da aba é tratada como cabeçalho. Para cada linha
        subsequente, monta-se um dict cabeçalho→valor (ver docstring do
        módulo para o tratamento especial de `RESPONSAVEL` e `QT`, e para a
        convenção de célula vazia).

        Nunca lança a exceção original da biblioteca do Google: qualquer
        falha de rede, credencial ou planilha/aba inacessível é convertida em
        `GoogleSheetsClientError`.
        """
        service = self._get_service()
        spreadsheet_id = self._spreadsheet_id()
        sheet_title = self._resolve_sheet_title()
        max_rows = int(getattr(self._settings, "google_sheets_max_rows", None) or _DEFAULT_MAX_ROWS)
        max_columns = int(
            getattr(self._settings, "google_sheets_max_columns", None) or _DEFAULT_MAX_COLUMNS
        )

        try:
            response = (
                service.spreadsheets()
                .values()
                .get(
                    spreadsheetId=spreadsheet_id,
                    # Faixa LIMITADA (API4): cabeçalho + max_rows + 1 linha
                    # sentinela; max_columns + 1 coluna sentinela. Título
                    # citado com aspas simples duplicadas (notação A1).
                    range=(
                        f"{_quote_sheet_title(sheet_title)}!A1:"
                        f"{_column_letter(max_columns + 1)}{max_rows + 2}"
                    ),
                    # FORMATTED_VALUE (e não UNFORMATTED_VALUE): devolve o
                    # TEXTO exibido, preservando zeros à esquerda do número
                    # patrimonial; e (e não FORMULA): nunca devolve o texto
                    # de fórmulas, apenas o valor calculado.
                    valueRenderOption="FORMATTED_VALUE",
                )
                .execute()
            )
        except GoogleSheetsClientError:
            raise
        except HttpError as exc:
            raise self._wrap_error(
                f"ler os valores da aba '{sheet_title}'", exc
            ) from exc
        except Exception as exc:  # noqa: BLE001 - convertido para erro de domínio
            raise self._wrap_error(
                f"ler os valores da aba '{sheet_title}'", exc
            ) from exc

        values = (response.get("values") if isinstance(response, dict) else None) or []
        if not isinstance(values, list) or not all(isinstance(row, list) for row in values):
            # Resposta upstream fora do formato esperado (API10).
            logger.error("google_sheets_client: resposta com formato inesperado em 'values'.")
            raise GoogleSheetsClientError(
                "resposta inesperada da Google Sheets API (formato de 'values' inválido)."
            )
        fetched_at = datetime.now(timezone.utc)

        if not values:
            return GoogleSheetsReadResult(
                rows=[], headers=[], sheet_title=sheet_title, fetched_at=fetched_at
            )

        if len(values) - 1 > max_rows:
            logger.error("google_sheets_client: aba excede o limite de %d linhas.", max_rows)
            raise GoogleSheetsClientError(
                f"a planilha excede o limite de {max_rows} linhas de dados por importação."
            )
        if any(len(row) > max_columns for row in values):
            logger.error("google_sheets_client: aba excede o limite de %d colunas.", max_columns)
            raise GoogleSheetsClientError(
                f"a planilha excede o limite de {max_columns} colunas por importação."
            )

        # Cabeçalhos: NFC, sem BOM/zero-width, sem NUL, `strip()`.
        headers = [
            normalize_identifier(make_db_safe("" if header is None else str(header))[0])
            for header in values[0]
        ]
        disambiguated_headers = _disambiguate_headers(headers)

        rows: list[dict[str, Any]] = []
        for offset, raw_row in enumerate(values[1:], start=1):
            source_row_number = offset + 1  # linha 1 é o cabeçalho
            rows.append(
                self._build_row(
                    headers, disambiguated_headers, raw_row, source_row_number
                )
            )

        return GoogleSheetsReadResult(
            rows=rows, headers=headers, sheet_title=sheet_title, fetched_at=fetched_at
        )

    # ------------------------------------------------------------------
    # Parsing/normalização por linha
    # ------------------------------------------------------------------

    def _build_row(
        self,
        headers: list[str],
        disambiguated_headers: list[str],
        raw_row: list[Any],
        source_row_number: int,
    ) -> dict[str, Any]:
        """Monta `raw_values`, `normalized_values` e `validation_errors` de uma linha.

        - `raw_values`: valor exatamente como lido (sem `strip()`), chave
          por cabeçalho (desambiguado quando duplicado); célula vazia
          (ausente ou em branco) é `None`.
        - `normalized_values`: `strip()` aplicado a cada valor não nulo
          (nunca upper()/lower() sobre conteúdo livre); as duas colunas
          `RESPONSAVEL` são separadas em `responsavel_original`/
          `responsavel_unidade`; `QT` é repassado sem interpretação em
          `qt_raw`; `PATRIMONIO` nunca é convertido para número (permanece
          string, preservando zeros à esquerda).
        - `validation_errors`: `ID`/`PATRIMONIO` ausentes ou vazios geram
          entradas prefixadas com `"erro: "` (mas não interrompem a leitura
          das demais linhas); qualquer outro campo vazio gera uma entrada
          prefixada com `"aviso: "`.
        """
        validation_errors: list[str] = []
        cell_values: list[Any] = []
        raw_values: dict[str, Any] = {}
        for idx, header in enumerate(headers):
            cell = raw_row[idx] if idx < len(raw_row) else None
            cell = None if _is_blank(cell) else cell
            key = disambiguated_headers[idx]
            if isinstance(cell, str):
                # NUL/surrogates não são armazenáveis no PostgreSQL (text/
                # jsonb): substituídos por U+FFFD (único desvio do valor
                # bruto, registrado como aviso). Demais caracteres —
                # inclusive "<", "=", aspas — são preservados (sem
                # sanitização destrutiva; a defesa é feita na saída).
                cell, changed = make_db_safe(cell)
                if changed:
                    validation_errors.append(
                        f"aviso: campo {key} continha caracteres não armazenáveis "
                        "(NUL/surrogate), substituídos por U+FFFD"
                    )
                if len(cell) > _MAX_CELL_CHARS:
                    validation_errors.append(
                        f"erro: campo {key} excede {_MAX_CELL_CHARS} caracteres "
                        f"({len(cell)}); valor truncado no armazenamento"
                    )
                    cell = cell[:_MAX_CELL_CHARS]
            elif cell is not None and not isinstance(cell, (bool, int, float)):
                # Tipo inesperado vindo da API (API10): convertido para texto.
                cell = make_db_safe(str(cell))[0][:_MAX_CELL_CHARS]
            cell_values.append(cell)
            raw_values[key] = cell

        canonical_headers = [canonical_header(header) for header in headers]
        responsavel_indices = [
            idx for idx, header in enumerate(canonical_headers) if header == _HEADER_RESPONSAVEL
        ]
        qt_indices = [idx for idx, header in enumerate(canonical_headers) if header == _HEADER_QT]
        id_indices = [idx for idx, header in enumerate(canonical_headers) if header == _HEADER_ID]
        patrimonio_indices = [
            idx for idx, header in enumerate(canonical_headers) if header == _HEADER_PATRIMONIO
        ]

        normalized_values: dict[str, Any] = {}
        for idx, header in enumerate(headers):
            header_norm = canonical_headers[idx]
            if header_norm in (_HEADER_RESPONSAVEL, _HEADER_QT):
                # Tratados separadamente abaixo (chaves semânticas dedicadas,
                # para nunca colidir quando o cabeçalho se repete).
                continue
            key = disambiguated_headers[idx]
            value = cell_values[idx]
            if header_norm in (_HEADER_ID, _HEADER_PATRIMONIO):
                value = self._normalize_identifier_cell(
                    header_norm, key, value, validation_errors
                )
            elif isinstance(value, str):
                value = normalize_free_text(value) or None
            normalized_values[key] = value

        # RESPONSAVEL: mapeamento posicional, pendente de confirmação
        # institucional (ver docstring do módulo e seção 4.2 da estratégia).
        def _responsavel_value(position: int) -> str | None:
            if len(responsavel_indices) > position:
                raw = cell_values[responsavel_indices[position]]
                return (normalize_free_text(raw) or None) if isinstance(raw, str) else raw
            return None

        normalized_values["responsavel_original"] = _responsavel_value(0)
        normalized_values["responsavel_unidade"] = _responsavel_value(1)

        # QT: valor bruto repassado sem NENHUMA interpretação como quantidade.
        if qt_indices:
            qt_raw = cell_values[qt_indices[0]]
            normalized_values["qt_raw"] = qt_raw if isinstance(qt_raw, str) else qt_raw
        else:
            normalized_values["qt_raw"] = None

        if len(patrimonio_indices) > 1:
            validation_errors.append(
                "erro: cabeçalho PATRIMONIO duplicado na planilha (coluna ambígua)"
            )
        if len(id_indices) > 1:
            validation_errors.append("erro: cabeçalho ID duplicado na planilha (coluna ambígua)")

        if not patrimonio_indices or cell_values[patrimonio_indices[0]] is None:
            validation_errors.append("erro: campo PATRIMONIO ausente ou vazio")
        elif normalized_values.get(disambiguated_headers[patrimonio_indices[0]]) is None and not (
            _has_error_for(validation_errors, disambiguated_headers[patrimonio_indices[0]])
        ):
            # Ex.: célula composta apenas de caracteres invisíveis.
            validation_errors.append("erro: campo PATRIMONIO ausente ou vazio")
        if not id_indices or cell_values[id_indices[0]] is None:
            validation_errors.append("erro: campo ID ausente ou vazio")
        elif normalized_values.get(disambiguated_headers[id_indices[0]]) is None and not (
            _has_error_for(validation_errors, disambiguated_headers[id_indices[0]])
        ):
            validation_errors.append("erro: campo ID ausente ou vazio")

        for idx, header in enumerate(headers):
            header_norm = canonical_headers[idx]
            if header_norm in (_HEADER_ID, _HEADER_PATRIMONIO):
                continue  # já tratados como erro acima
            if cell_values[idx] is None:
                validation_errors.append(
                    f"aviso: campo {disambiguated_headers[idx]} vazio"
                )

        return {
            "source_row_number": source_row_number,
            "raw_values": raw_values,
            "normalized_values": normalized_values,
            "validation_errors": validation_errors,
        }

    @staticmethod
    def _normalize_identifier_cell(
        header_norm: str, key: str, value: Any, validation_errors: list[str]
    ) -> str | None:
        """Normaliza/valida `PATRIMONIO`/`ID` (identificadores sempre TEXTO).

        - NFC, remoção de zero-width/BOM, `strip()`; vazio vira `None`.
        - Inteiro nativo é convertido com `str()` (sem perda); `float` NUNCA
          é aceito (perderia zeros à esquerda/precisão) -> erro bloqueante.
        - Erro bloqueante também para: caracteres de controle/formatação,
          tamanho > `_MAX_IDENTIFIER_CHARS`; e, só para PATRIMONIO, notação
          científica e primeiro caractere `= + - @` (fórmula/valor
          inesperado). O valor bruto permanece intacto em `raw_values`.
        """
        if value is None:
            return None
        if isinstance(value, (bool, float)):
            validation_errors.append(
                f"erro: campo {key} veio como número de ponto flutuante; "
                "formate a coluna como texto na planilha"
            )
            return None
        text = normalize_identifier(str(value))
        if not text:
            return None
        if len(text) > _MAX_IDENTIFIER_CHARS:
            validation_errors.append(
                f"erro: campo {key} excede {_MAX_IDENTIFIER_CHARS} caracteres"
            )
            return None
        if has_control_chars(text):
            validation_errors.append(f"erro: campo {key} contém caracteres de controle")
            return None
        if header_norm == _HEADER_PATRIMONIO:
            if _SCIENTIFIC_NOTATION_RE.match(text):
                validation_errors.append(
                    f"erro: campo {key} em notação científica (célula numérica na "
                    "planilha; o valor original pode ter sido perdido)"
                )
                return None
            if text.startswith(_PATRIMONY_FORBIDDEN_LEADING):
                validation_errors.append(
                    f"erro: campo {key} com formato inesperado "
                    "(inicia com '=', '+', '-' ou '@')"
                )
                return None
        return text
