# API de patrimônios (`/api/v1/assets`)

Contrato para o frontend. Código: rotas `backend/app/api/v1/assets.py`, schemas
`asset_schemas.py`, regra `backend/app/services/asset_service.py`; unidades do
escopo em `services/unit_scope_service.py` + `api/v1/units.py`. Testes:
`backend/tests/test_assets_api.py`, `test_assets_bond_status.py` e
`test_sec_route_inventory.py`. Usa as tabelas existentes (`assets`, `rooms`,
`locations`, `responsible_people`); o campo `bond_status` depende da migração
`0012_asset_bond_status` (espelho `sql/0015`).

## Rotas
| Método | Caminho | Pilha / permissão |
|---|---|---|
| GET | `/assets`, `/assets/<id>`, `/assets/<id>/history`, `/assets/bond-statuses` | auth, AAL2 se ADM, `assets.read` |
| POST | `/assets` | auth, AAL2 se ADM, `assets.create` (ADM e USER) |
| PATCH | `/assets/<id>` | auth, AAL2 se ADM, `assets.update` (ADM e USER) |
| POST | `/assets/<id>/delete`, `/assets/<id>/restore` | auth, ADM, AAL2, `assets.delete` |
| GET | `/units/accessible` | auth, AAL2 se ADM, `units.read` |

Não existe `DELETE` (405). Rate limit por usuário/hora: 1200 (lista), 600
(detalhe/histórico/units/bond-statuses), 120 (criar/editar), 60 (excluir/restaurar). Erros:
`{"error": {"code", "message"}}`.

## Regras transversais
- **Escopo**: o bem é visível/editável se `unit_id` OU `owner_unit_id` estiver em
  `user_unit_access` do usuário (ADM inclusive). Alheio, inexistente, malformado
  ou excluído (sem `include_deleted`) => o MESMO 404 `not_found` + evento
  `UNIT_SCOPE_DENIED`. Escopo vazio => lista vazia.
- **Excluídos**: só aparecem para ADM com `include_deleted=true` (lista, detalhe e
  histórico). USER/RH com `include_deleted=true` => 403 `forbidden` + `ACCESS_DENIED`.
- **Mass assignment**: schemas `extra="forbid"`. `id`, `version` (na criação),
  `created_*`, `updated_*`, `deleted_*`, `source_*`, `assigned_user_id`,
  `bond_status` (vínculo; só a importação grava) e
  `unit_id` (em PATCH) nunca vêm do cliente: 400 `validation_error` + evento
  (`PRIVILEGE_ESCALATION_ATTEMPT` ou `MASS_ASSIGNMENT_REJECTED`).
- **Campos por perfil** (lista provisória, pendente de validação institucional):
  - ADM: todos os campos editáveis.
  - USER: `description`, `notes`, `room_id`, `location_id`,
    `responsible_person_id`, `registration_date`. Enviar `owner_unit_id`,
    `located` (criação ou edição) ou `patrimony_number` (só edição) => 400 +
    evento. Na criação USER fica com `located="DESCONHECIDO"` e sem `owner_unit_id`.
  - RH: somente leitura, sem `notes` (a coluna nem é consultada).
- **Número patrimonial**: texto (zeros à esquerda preservados), 1–64 caracteres,
  trim + espaços colapsados. Único entre bens NÃO excluídos, sem distinguir
  caixa, entre todas as unidades; violação => 409 `conflict` genérico (não diz
  o campo). Restaurar com número em uso => 409. Serializado por advisory lock no
  PostgreSQL com chave ÚNICA compartilhada com a importação
  (`app/services/patrimony_lock.py`, `lower(btrim)`); a importação também compara
  o número sem caixa/espaços (SEC-AST-01, parte de código); **não há índice único no banco** (recomendado como migração futura:
  índice único parcial em `lower(btrim(patrimony_number)) WHERE deleted_at IS NULL`).
- **Controle otimista**: PATCH, delete e restore exigem `version` (inteiro >= 1)
  no corpo; divergente => 409 `version_conflict` (recarregue). Cada alteração
  efetiva incrementa `version`; PATCH sem mudança real => 200 sem auditoria.
- **Vínculos** (`room_id`, `location_id`, `responsible_person_id`): precisam
  estar no escopo (senão 404 uniforme) e na MESMA unidade do bem (409
  `link_unit_mismatch`; também quando o local pertence a outra sala que a do
  bem). Inativos só se já eram o vínculo atual (409 `link_inactive`). `null`
  limpa. `owner_unit_id` (ADM) deve estar no escopo e ativa.
  Criação em unidade inativa => 409 `unit_inactive`.
- **Auditoria** (`audit_logs`, `entity_type="asset"`, mesma transação):
  `ASSET_CREATED`, `ASSET_UPDATED`, `ASSET_DELETED`, `ASSET_RESTORED`. Sem PII:
  `notes` entra só como nome do campo em `changed_fields`.

## Listagem `GET /assets`
Consulta (allowlist; desconhecido/repetido => 400): `q` (≤100; patrimônio e
descrição, curingas LIKE escapados), `unit_id`, `owner_unit_id`, `room_id`,
`responsible_person_id` (UUID), `located=SIM|NAO|DESCONHECIDO`,
`bond_status` (1–64, sem caracteres de controle; igualdade EXATA sem caixa,
`lower(bond_status) = lower(valor)`, usa `ix_assets_bond_status_lower`; valor
especial `__none__` = bens sem vínculo; >64/vazio => 400),
`include_deleted=true|false` (só ADM), `sort` (`patrimony_number` padrão,
`description`, `created_at`, `updated_at`, `bond_status` (sem caixa; sem vínculo
primeiro), cada um com prefixo `-` p/ decrescente;
desempate por `id`), `page` (≥1), `page_size` (50, 100 ou 200; padrão 50).
Resposta: `{total, page, page_size, pages, assets: [Asset]}`.

## Opções do filtro de vínculo `GET /assets/bond-statuses`
Sem parâmetros (qualquer um => 400). Mesma pilha e mesmo escopo da listagem
(`unit_id` OU `owner_unit_id` acessíveis), só bens NÃO excluídos e com vínculo.
Resposta `{"items": [{"value": "Ocioso", "count": 12}, ...]}`: agrupado por
`lower(bond_status)`; `value` = grafia mais frequente do grupo (desempate
alfabético); ordenado por `value` (sem caixa); no máximo 100 grupos. Escopo
vazio => `{"items": []}`. Contagens de outras unidades nunca aparecem.

## Objeto `Asset`
```
id, patrimony_number, description,
unit_id, unit {id, code, name},
owner_unit_id|null, owner_unit {id, code, name}|null,
responsible_person_id|null, responsible_person {id, name}|null,
room_id|null, room {id, name}|null, location_id|null, location {id, name}|null,
located, bond_status|null, registration_date (AAAA-MM-DD)|null,
created_at, updated_at, deleted_at|null, version
```
`bond_status` ("Vínculo": Servidor, Terceirizado, Ocioso...) vem da 1ª coluna
`RESPONSAVEL` da planilha (migração 0012); todos os perfis com acesso ao bem o
recebem (não é dado pessoal); não editável pela API.
ADM e USER recebem ainda: `notes`, `assigned_user_id`, `source_record_id`,
`source_system`, `source_updated_at`, `created_by`, `updated_by`; só ADM:
`deleted_by`. RH não recebe nenhuma dessas chaves.

## Escrita
- `POST /assets` (201) corpo: `unit_id`, `patrimony_number` (obrigatórios);
  opcionais `description`/`notes` (≤2000), `responsible_person_id`, `room_id`,
  `location_id`, `registration_date`; ADM também `owner_unit_id`, `located`.
  `unit_id` malformado/inexistente/alheio => 404 uniforme.
- `PATCH /assets/<id>` (200, devolve o bem): `version` + ao menos um campo
  editável. `patrimony_number` e `located` não aceitam `null`.
- **Classificação manual** (2026-10-23): `asset_category`, `tech_type` e
  `operational_status` (vocabulário fechado = CHECKs da migração 0015, ver
  `app/services/asset_classification.py`) aparecem na leitura (todos os perfis) e
  são editáveis SOMENTE no `PATCH` por quem já tem `assets.update` (ADM e USER, dentro
  do escopo de unidade; RH segue sem editar). Não são campos privilegiados, mas valem:
  valor fora da allowlist => 400 `validation_error`; `null` = "não informado"/limpa;
  `tech_type` exige categoria `TECNOLOGIA` (efetiva após o pedido) => 422
  `classification_inconsistent` (nada é limpo em silêncio: ao sair de TECNOLOGIA envie
  `tech_type: null`); `version` obrigatório (409 `version_conflict`); bem alheio/
  inexistente => 404 uniforme. `POST` continua rejeitando os três (400). Auditoria:
  `ASSET_CLASSIFICATION_UPDATED` (só os 3 campos, antes/depois, sem PII) ou
  `ASSET_UPDATED` quando misturada a outros campos.
- `POST /assets/<id>/delete` e `/restore` (200, devolve o bem): `{version, reason?}`
  (`reason` ≤500). Excluir bem já excluído e restaurar bem ativo => 404.

## `GET /assets/<id>/history`
`{total, page, page_size, entries: [{id, operation, occurred_at, actor_user_id,
result, previous_values, new_values}]}`, mais recentes primeiro. Quem pode ler o
bem pode ler o histórico (inclusive RH); somente leitura; `actor_user_id` é só o
identificador (sem nome/e-mail) e **só é enviado a ADM/USER**: para RH a chave não
existe (SEC-AST-02, mesmo critério de `created_by`/`updated_by`).

## `GET /units/accessible`
`{units: [{id, code, name, active}]}` das unidades em `user_unit_access` do
usuário, ordenadas por `code`; qualquer parâmetro => 400. Não retorna `address`
nem ids de origem. `GET /units` e `GET /units/catalog` não mudaram.
