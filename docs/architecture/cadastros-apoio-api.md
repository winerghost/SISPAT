# API dos cadastros de apoio (salas, pessoas responsáveis, unidades)

Contrato do CRUD backend (Etapa B do plano `plano-importacao-mconferencia.md`).
Código: rotas `backend/app/api/v1/{rooms,responsible_people,units}.py`,
schemas `catalog_schemas.py`, helpers `catalog_http.py`, regra
`backend/app/services/catalog_service.py`. Testes: `backend/tests/test_catalog_api.py`
e `test_sec_route_inventory.py`. **Depende das migrações 0007/0008 (pendentes de
aplicação):** antes delas, as consultas a `responsible_people` e `rooms`
falham (colunas `phone`/`source_record_id` ausentes).

## Decisões
- Só ADM cria, altera e inativa. "Excluir" = inativar (`active=false`); não há
  `DELETE` (405). Reativar é `POST .../activate`.
- Inativar sala/pessoa **em uso por bens é permitido**: a inativação só
  bloqueia NOVAS associações (importação e telas de vínculo devem filtrar
  `active=true`); vínculos existentes permanecem válidos e legíveis. Criar
  sala/pessoa em unidade inativa, ou reativá-la com a unidade inativa, é 409
  `unit_inactive`.
- Escopo de unidade em tudo (`apply_unit_scope`), inclusive ADM (matriz,
  princípio 3). Alvo alheio, inexistente ou malformado (inclusive `unit_id` do
  corpo) => o MESMO 404 `not_found`, com o mesmo número de consultas e um
  evento `UNIT_SCOPE_DENIED`.
- Pessoas responsáveis, leitura por perfil (SEC-CAT-06): **USER** vê SÓ
  pessoas referenciadas por `assets.responsible_person_id` de bens não
  excluídos do seu escopo, e só `{id, name, unit_id, active}` (sem e-mail,
  identificador, `source_record_id`, datas ou telefone). Nesse perfil `q`
  busca apenas o nome e `sort` aceita só `name`/`-name` (outro => 400
  `validation_error` + evento `ACCESS_DENIED`). Pessoa não vinculada, de bem
  excluído, alheia ou inexistente => o MESMO 404 de sempre. **RH** e **ADM**
  veem o cadastro completo (telefone só ADM). Risco residual: um ADM de
  escopo restrito pode inferir, via 409 genérico de unicidade, a existência
  de e-mail/identificador globais fora do seu escopo (só registro).
- `phone` é dado pessoal: só ADM lê e escreve. Para USER/RH a coluna nem é
  consultada (`defer`) e a chave não existe na resposta; escrita por não-ADM
  seria 400 + evento (as rotas de escrita já exigem ADM, é defesa em
  profundidade no serviço).

## Rotas
| Método | Caminho | Pilha / permissão |
|---|---|---|
| GET | `/api/v1/rooms`, `/api/v1/rooms/<id>` | `require_auth`, AAL2 se ADM, `units.read` |
| GET | `/api/v1/locations`, `/api/v1/locations/<id>` | idem (somente leitura; filtros `unit_id`, `room_id`, `active`, `q`; ordenação `name`/`created_at`/`updated_at`; 404 uniforme) |
| POST | `/api/v1/rooms` | auth, ADM, AAL2, `rooms.manage` |
| PATCH | `/api/v1/rooms/<id>` | idem |
| POST | `/api/v1/rooms/<id>/deactivate`, `/activate` | idem |
| GET | `/api/v1/responsible-people`, `.../<id>` | auth, AAL2 se ADM, `responsible.read` |
| POST/PATCH | `/api/v1/responsible-people`, `.../<id>` | auth, ADM, AAL2, `responsible.manage` |
| POST | `/api/v1/responsible-people/<id>/deactivate`, `/activate` | idem |
| GET | `/api/v1/units/catalog` | auth, ADM, AAL2, `units.update` (inclui inativas; `address`) |
| GET | `/api/v1/units/<id>` | auth, AAL2 se ADM, `units.read` (`address` só ADM) |
| PATCH | `/api/v1/units/<id>` | auth, ADM, AAL2, `units.update` |
| POST | `/api/v1/units/<id>/deactivate`, `/activate` | idem |

Escritas: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission -> rate_limit` (fail-closed; 120/h por ADM em
criar/editar, 60/h em ativar/inativar). A listagem de unidades do seletor
(`GET /api/v1/units`) permanece como estava (`users.manage`, só ativas,
`id/code/name`, nenhum parâmetro aceito).

### `GET /api/v1/units/catalog` (cadastro de unidades, para reativar)
Rota separada, e não parâmetros em `GET /units`, para não alterar o contrato
do seletor de usuários (permissão, filtro de ativas e rejeição de query).
`/catalog` não colide com `/<uuid:unit_id>` (conversor uuid). Consulta
(allowlist, `extra="forbid"`, desconhecido/repetido => 400): `q` (≤100; busca em
nome e código, curingas LIKE escapados), `active=true|false|all` (padrão
`all`), `sort` (`name`, `-name`, `code`, `-code`, `updated_at`, `-updated_at`;
desempate por `id`), `page`, `page_size` (50, 100 ou 200). Resposta `{total, page,
page_size, units: [{id, code, name, active, updated_at, source_record_id,
address}]}`. Decisão: o escopo de unidade (`apply_unit_scope`) vale também para
o ADM, como no resto do CRUD (ADM sem a unidade em `user_unit_access` não a
lista nem a reativa; 404 uniforme nas ações). Limite 1200/h por ADM.

## Corpo e consulta
- `extra="forbid"`: `id`, `source_record_id`, `created_at`, `updated_at`,
  `active`, `code`, `deleted_*` e `unit_id` (em PATCH) são recusados (400 +
  `PRIVILEGE_ESCALATION_ATTEMPT`/`MASS_ASSIGNMENT_REJECTED`). `unit_id` só existe
  na criação (sala/pessoa não trocam de unidade por esta API).
- Salas: `unit_id`, `name` (1–200), `description` (≤1000), `floor` (≤50).
  Pessoas: `unit_id`, `name`, `email` (minúsculo, ≤254), `phone` (aceita
  `() - . +` e espaços; guarda só dígitos, 10–13), `institutional_identifier`
  (≤64). Unidades (PATCH): `name`, `description`, `address` (≤500); `code` e
  `source_record_id` são imutáveis.
- Nomes: trim, espaços colapsados, sem caracteres de controle. PATCH exige ao
  menos um campo; `null` limpa campos opcionais; `name` não pode ser nulo.
- Listagens (`rooms`, `responsible-people`): `q` (≤100), `unit_id`,
  `active=true|false`, `sort` (allowlist: `name`, `-name`, `created_at`,
  `-created_at`, `updated_at`, `-updated_at`; pessoas também `email`, `-email`),
  `page`, `page_size` (50, 100 ou 200). Parâmetro desconhecido/repetido => 400.
  Resposta `{total, page, page_size, rooms|people: [...]}`.
- Ações `deactivate`/`activate`: corpo opcional `{reason?, expected_updated_at?}`;
  idempotentes (já no estado pedido => 200 sem auditoria).

## Erros
`400 validation_error`, `404 not_found`, `409 conflict` (violação de
unicidade — sala por unidade+nome, e-mail, identificador —, mensagem fixa,
sem dizer o campo nem expor o erro do banco), `409 version_conflict`,
`409 unit_inactive`, 401/403 (`AAL2_REQUIRED` quando falta MFA).

## Concorrência
Sem coluna `version` nessas tabelas: a linha é lida com `FOR UPDATE` e o cliente
pode enviar `expected_updated_at` (o `updated_at` lido) como pré-condição;
divergência => 409 `version_conflict`. A unicidade é checada antes e garantida
pelos índices únicos de `0008`.

## Auditoria
`AuditLog` na mesma transação (`entity_type` `room`, `responsible_person`,
`unit`; operações `*_CREATED/UPDATED/DEACTIVATED/ACTIVATED`). Para pessoas, e-mail,
telefone e identificador entram só como NOME do campo alterado, nunca o valor.
Acessos negados e mass assignment vão para `record_security_event`.

## Importação dos cadastros (prévia → confirmação)
Somente ADM + AAL2 (`require_auth → require_role("ADM") → require_aal2 →
permissão → rate_limit`). Código: `api/v1/catalog_imports.py`, schemas
`catalog_import_schemas.py`, projeção segura `services/catalog_import_view.py`.

| Método | Caminho | Permissão |
|---|---|---|
| POST | `/api/v1/catalog-imports/<kind>/preview` (`kind` ∈ units, rooms, people; sem corpo) | `units.update` / `rooms.manage` / `responsible.manage` |
| GET | `/api/v1/catalog-imports/<preview_id>/report` | a do tipo da prévia |
| GET | `/api/v1/catalog-imports/<preview_id>/items` (`status`, `search`, `sort` allowlist `label/classification/source_id` ± , `page`, `page_size` 50|100|200) | idem |
| POST | `/api/v1/catalog-imports/<preview_id>/confirm` `{item_ids: [uuid] (≤10.000), alias_item_ids?: [uuid] (≤10.000)}` | idem |
| GET | `/api/v1/imports/google-sheets/<preview_id>/pending` (bens) | `imports.execute` |

- O decorator estático exige ao menos UMA das três permissões; a específica do
  tipo é conferida na view (na prévia, pelo `kind` da URL: sem ela => 403; nas
  demais, pelo tipo GRAVADO na prévia).
- 404 uniforme (mesmo corpo) para id inexistente, malformado, de prévia de bens
  e de cadastro sem a permissão do tipo; `kind` inválido => 404. Negação
  auditada (`ACCESS_DENIED`).
- Erros: `CatalogSourceNotConfiguredError` => 409 (estado do sistema/configuração
  da aba, não erro do corpo); `CatalogSchemaError` => 422 (planilha com colunas
  inprocessáveis); `UpstreamSourceError` => 502; prévia expirada/já confirmada
  => 409 (a 2ª confirmação é no-op, idempotente). Mensagens fixas e genéricas.
- Rate limit por ADM/hora: prévia 10, confirmação 10, leituras 600 (Redis fora => 503).
- LGPD: relatório e itens usam allowlist. Telefone NUNCA sai (só `has_phone`);
  e-mail só mascarado (`c***@agu.gov.br`); `raw_values` nunca sai. A auditoria
  `CREATE_CATALOG_PREVIEW` guarda só `kind` e contadores; `CONFIRM_CATALOG_IMPORT`
  só contadores. Nada disso grava valores de pessoas em logs.
- `POST /imports/google-sheets/preview` (bens) ganhou `pending_counts` (contadores
  de pendências de vínculo); `summary` e demais campos não mudaram.


## Importação: escopo, autoria e alias (correção SEC-CAT-01..05)

- O escopo do ADM na importação é o mesmo do CRUD: `user_unit_access` (`get_accessible_unit_ids`). Salas e pessoas só resolvem siglas de unidades do escopo; fora dele a linha fica INVALIDO com a mesma mensagem de "sigla sem alias". O escopo é revalidado por item na confirmação.
- A prévia pertence ao autor (`requested_by`): relatório, itens e confirmação por outro ADM respondem o mesmo 404 de prévia inexistente.
- Texto: caracteres de controle/bidi/largura zero (Cc/Cf) tornam a linha INVALIDO; sigla `^[A-Za-z0-9._-]{1,32}$`; nome de unidade/sala/pessoa <= 200.
- Contrato novo: cada item de `units` traz `details.create_alias` (true = a confirmação PODE criar o alias da sigla). O alias só é criado para os itens listados em `alias_item_ids` (subconjunto de `item_ids`; ids desconhecidos são ignorados). Sem o campo, nenhum alias é criado.
- Resposta de `POST /catalog-imports/<id>/confirm` (schema `CatalogConfirmResponse`, `extra="forbid"`, com limites): `preview_id`, `kind`, `sync_job_id`, `status` (`CONCLUIDO|PARCIAL|FALHOU`, o do `SyncJob`), `created`, `updated`, `ignorados` (ids enviados não elegíveis), `inalterados` (EXISTENTE sem mudança), `nao_gravados` (`total`, `por_classificacao` {DUPLICADO,INVALIDO,CONFLITANTE}, `por_motivo` {código de pendência | `duplicado_na_origem` | `outro`}, `nao_selecionados`), `falhas_total` e `falhas` (<= 100 itens: `item_id`, `row`, `label`, `reason`). Só contadores e códigos; nenhum e-mail/telefone. HTTP 200 mesmo com `FALHOU`: o cliente deve olhar `status`/`created+updated`. A auditoria `CONFIRM_CATALOG_IMPORT` guarda `inalterados` e `job_status`.
- Resposta degradada (B-3, `app/api/v1/import_confirm_common.py`): a validação do corpo roda DEPOIS do commit do serviço. Se falhar, a rota responde **200** com `degraded=true` e só contadores mínimos válidos (`status`, `created`, `updated`, `ignorados`, `inalterados`, `falhas_total`; `falhas=[]`, `nao_gravados` zerado), nunca 500 falso (os dados já estão gravados e a prévia consumida). O log registra só o tipo do erro e os nomes de campo. `degraded` é `false` nas respostas normais.
- Confirmação de **bens** (`POST /api/v1/imports/google-sheets/confirm`, schema `AssetImportConfirmResponse`, `app/api/v1/import_confirm_schemas.py`): mesmo contrato (`sync_job_id`, `status`, `created`, `updated`, `ignorados`, `inalterados`, `nao_gravados`, `falhas_total`, `falhas` <= 100, `degraded`), mais `pendencias_vinculo` (código -> quantidade, só dos bens CRIADOS, resolução autoritativa da confirmação: `sala_nao_encontrada`, `pessoa_nao_encontrada`, `unidade_pertencente_nao_encontrada`...). Falha de bens: `item_id`, `row`, `patrimony_number` (TEXTO) e `reason` fixo (sem descrição). `por_motivo` de bens: código de pendência que bloqueou (`unidade_sem_alias`...), `duplicado_na_origem`, `patrimonio_conflitante` ou `dados_invalidos`. `inalterados`: EXISTENTE cuja planilha não difere do bem; nesse caso nada é gravado e `version` NÃO é incrementada (reimportar a mesma planilha é no-op). Todos rejeitados: HTTP 200 com `status=FALHOU` e a prévia é consumida (nova prévia). A auditoria `CONFIRM_IMPORT` guarda `inalterados` e `job_status`. Escopo (`imports.execute` global), idempotência (409) e advisory lock por patrimônio não mudaram.
- `GET /api/v1/imports/google-sheets/preview/<id>/items` só serve prévias de bens; prévia de cadastro ou inexistente -> 404 idêntico.
