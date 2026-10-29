# API de relatórios e exportações (`/api/v1/reports`)

Código: rotas `backend/app/api/v1/reports.py`, schemas `report_schemas.py`; serviço
`app/services/report_service.py`, repositório `report_repository.py`, catálogo
`report_catalog.py`, formatos `report_export.py`. Testes: `backend/tests/test_reports_api.py`.

## Segurança (resumo)
- `require_auth -> require_aal2_for_adm -> require_permission -> rate_limit`. ADM exige AAL2;
  USER/RH não (como as demais leituras compartilhadas). Catálogo = `reports.read`; arquivo =
  `exports.create` (ambas já semeadas para ADM, USER e RH; nenhuma migração).
- Escopo de unidade sempre no banco (ADM sem bypass). `unit_id`, `owner_unit_id`,
  `origin_unit_id`, `destination_unit_id`, `inventory_id`, `room_id` e `responsible_person_id`
  alheios, inexistentes ou malformados => a MESMA `404 not_found` (+ evento `UNIT_SCOPE_DENIED`);
  nenhum deles ecoa o valor recebido. `kind` desconhecido => mesma 404.
- Parâmetro não declarado => `400` (+ `MASS_ASSIGNMENT_REJECTED`; nomes privilegiados como `role`,
  `deleted_at`, `unit_ids` => `PRIVILEGE_ESCALATION_ATTEMPT`). Repetido/valor inválido => 400.
  Filtros e `sort` são allowlists; nada de SQL vindo do cliente; `q` usa LIKE escapado e, nos relatórios de patrimônios, a MESMA `asset_search_clause` da tela `/assets` (tokens AND; número, chave alfanumérica do número, descrição, `source_record_id`, nome do responsável e da sala via EXISTS correlacionado só a `assets`), garantindo paridade tela x exportação; o escopo de unidade continua aplicado antes e a neutralização de fórmulas (`csv_safety`) é inalterada.
- Bens com `deleted_at` ficam fora (também nas movimentações e itens de inventário).
  `include_deleted=true` é só ADM (os demais: `403` + `ACCESS_DENIED`); acrescenta a coluna
  "Excluído em (UTC)" nos patrimônios.
- Limite: `MAX_EXPORT_ROWS = 10000`. Acima disso `413 row_limit_exceeded` (nunca trunca).
  Cota: 30 exportações/usuário/hora; catálogo 600/h.
- RH não recebe texto livre (`notes`, `reason`, observações do item); a coluna nem é consultada.
  Nenhum e-mail, telefone, identificador institucional nem id de usuário é exportado; só o nome do
  responsável pelo bem. Dados da origem de uma movimentação (sala, responsável anterior, motivo)
  só aparecem a quem tem escopo na unidade de origem.
- Toda célula (cabeçalho incluído) passa por `app.security.csv_safety.escape_formula`.
  CSV: `;`, `QUOTE_ALL`, UTF-8 com BOM. XLSX: escritor mínimo próprio (zip + OOXML, sem
  dependência nova) com células `inlineStr`; nunca fórmula nem número. Número patrimonial é texto
  (zeros à esquerda preservados). Aviso: o Excel pode reinterpretar "00123" como número ao ABRIR
  um CSV; o XLSX preserva o texto.
- Timestamps em UTC ISO-8601 (`+00:00`); datas de cadastro `AAAA-MM-DD`. A UI converte para
  America/Araguaina.
- Auditoria na mesma transação: `audit_logs` `entity_type=report_export`, `entity_id=<kind>`,
  `operation=REPORT_EXPORTED`, `new_values={report, format, rows, sort, filters:[nomes], include_deleted}`
  (sem valores de filtro nem conteúdo).

## Contrato
### `GET /api/v1/reports`
Sem parâmetros. `200` (`Cache-Control: no-store`):
```json
{"generated_at": "ISO-UTC", "max_rows": 10000, "formats": ["csv","xlsx"],
 "reports": [{"id": "assets|movements|inventory-items", "title": "...", "description": "...",
   "export_path": "/api/v1/reports/<id>/export", "formats": ["csv","xlsx"],
   "columns": [{"key": "...", "label": "..."}],
   "filters": [{"name": "...", "type": "text|enum|uuid|unit|inventory|room|person|date", "options": [...], "max_length": 100}],
   "sorts": ["..."], "default_sort": "...", "include_deleted_allowed": false}]}
```
`columns` já reflete o perfil (RH sem texto livre). Os tipos de LOOKUP recebem um UUID e a tela
monta um `<select>` com a lista do cadastro correspondente, SEMPRE com escopo de unidade no backend:
`unit` -> `GET /api/v1/units/accessible`; `inventory` -> `GET /api/v1/inventories`;
`room` -> `GET /api/v1/rooms`; `person` -> `GET /api/v1/responsible-people`.

`filters[].options` de `bond_status` (vínculo) é DINÂMICO e por ATOR: os valores distintos
existentes nos bens do escopo (grafia mais frequente de cada grupo sem caixa, ordem alfabética
estável; bens excluídos fora) -- a MESMA fonte de `GET /api/v1/assets/bond-statuses` --, mais
`__none__` ("sem vínculo") no FIM da lista, só quando existe bem sem vínculo no escopo. Nada é
codificado à mão: o vínculo vem da planilha do Google Sheets e muda a cada importação; um `enum`
fixo envelheceria em silêncio. Escopo vazio => `options: []`. O catálogo é por usuário
(`Cache-Control: no-store`). O `<select>` é conveniência de interface: o backend revalida o valor
(um vínculo que saiu da lista continua aceito e simplesmente não casa nenhum bem).

### `GET /api/v1/reports/<kind>/export`
`kind`: `assets | movements | inventory-items`. Params comuns: `format=csv|xlsx` (padrão `csv`),
`sort`, `include_deleted=true|false` (ADM). Resposta `200`: corpo = arquivo;
`Content-Type` `text/csv; charset=utf-8` ou
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
`Content-Disposition: attachment; filename="sispat-<kind>-AAAAMMDDTHHMMSSZ.<ext>"`;
`Cache-Control: no-store`; `X-Content-Type-Options: nosniff`; `X-Report-Rows: <n>`.

**Seleção de colunas** (`columns`, opcional, <=512 caracteres): chaves do catálogo (`columns[].key` de
`GET /reports`) separadas por vírgula, ex.: `columns=patrimony_number,description,unit_name`.
Ausente => todas as colunas visíveis ao perfil (retrocompatível). O arquivo (CSV e XLSX) sempre segue a
ORDEM DO CATÁLOGO, não a da requisição; cabeçalho e linhas ficam alinhados. Lista vazia, token vazio,
chave duplicada, desconhecida ou fora do perfil (ex.: `notes`/`reason` para RH) => `400 invalid_columns`
(valor nunca ecoado; coluna vedada ao perfil também gera evento `ACCESS_DENIED`). A seleção só restringe:
nunca amplia o acesso. `deleted_at` sem `include_deleted=true` (ADM) é omitida. A auditoria
`REPORT_EXPORTED` registra `columns` (lista de chaves exportadas). Causa do defeito anterior: a rota
não declarava o parâmetro (a interface só listava as colunas) e o serviço exportava sempre todas.

| kind | filtros | sort (padrão) |
|---|---|---|
| `assets` | `q` (<=100), `unit_id`, `owner_unit_id`, `room_id`, `responsible_person_id` (UUID como texto; fora do escopo => 404), `located` (SIM/NAO/DESCONHECIDO), `bond_status` (opções do catálogo; `__none__` = sem vínculo) | `patrimony_number`, `description`, `created_at`, `updated_at`, `bond_status` (+ prefixo `-`); padrão `patrimony_number` |
| `movements` | `status`, `movement_type`, `origin_unit_id`, `destination_unit_id`, `created_from`, `created_to` (AAAA-MM-DD, UTC) | `created_at`, `status` (+ `-`); padrão `-created_at` |
| `inventory-items` | `inventory_id`, `unit_id`, `inventory_status`, `result` (ENCONTRADO/NAO_ENCONTRADO/DIVERGENTE), `checked_from`, `checked_to` | `checked_at`, `patrimony_number`, `result` (+ `-`); padrão `-checked_at` |

Erros (`{"error": {"code","message"}}`): `400 validation_error`/`invalid_columns`, `401`, `403 forbidden`/`AAL2_REQUIRED`,
`404 not_found`, `413 row_limit_exceeded`, `429`.
