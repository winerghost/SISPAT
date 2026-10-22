# API de inventários (`/api/v1/inventories`)

Campanhas de conferência física de bens POR UNIDADE. Tabelas existentes
`inventories` e `inventory_items` (sem migração). Código: `app/api/v1/inventories.py`,
`inventory_schemas.py`, `app/services/inventory_service.py`.

## Rotas

| Método | Caminho | Pilha | Permissão |
|---|---|---|---|
| GET | `/inventories` | auth, AAL2 se ADM, rate limit | `inventory.check` |
| GET | `/inventories/<id>`, `/summary`, `/items` | idem | `inventory.check` |
| POST | `/inventories/<id>/items` (conferir bem) | idem (AAL2 só ADM) | `inventory.check` |
| POST | `/inventories` | auth, ADM, AAL2 | `inventory.create` |
| POST | `/inventories/<id>/start`, `/close`, `/cancel` | auth, ADM, AAL2 | `inventory.create` |

Não há PUT/PATCH/DELETE (405). Não existe `inventory.read`: leituras usam
`inventory.check` (ADM e USER; RH = 403). O seed SQL concede `inventory.create` também a
`USER`, mas a rota exige o papel ADM (a matriz diz "USER não tem").

## Estados

`ABERTO -> EM_ANDAMENTO -> CONCLUIDO`; `ABERTO | EM_ANDAMENTO -> CANCELADO`. Outra
transição = 409 `invalid_transition`. `CONCLUIDO`/`CANCELADO` são terminais e imutáveis
(guardas ORM; `closed_at` e `end_date` gravados na transição). Corpo de start/close/cancel:
`{"reason"?: str<=500}` (só `has_reason` vai à auditoria).

## Contrato

- Criar: `{"name": 1..200, "unit_id": texto, "start_date"?: "AAAA-MM-DD"}` (padrão hoje UTC)
  -> 201. Unidade alheia/inexistente/malformada = 404 uniforme; inativa = 409 `unit_inactive`.
- Conferir: `{"asset_id", "found": bool, "observed_location_id"?, "notes"?<=500}` -> 201.
  `observed_location_id` só com `found=true`; deve ser local ATIVO da unidade do
  inventário (alheio/inexistente 404; inativo 409 `link_inactive`). Resultado derivado no
  servidor: `NAO_ENCONTRADO` (found=false), `DIVERGENTE` (found=true e local observado
  diferente do cadastrado no bem), senão `ENCONTRADO`.
- Política: 1 conferência por bem por inventário (`uq_inventory_items_inventory_asset`);
  repetir = 409 `already_checked` (inclusive em corrida). Inventário `ABERTO` = 409
  `inventory_not_started`; encerrado/cancelado = 409 `inventory_closed`. Bem de outra
  unidade, excluído logicamente, inexistente ou malformado = 404 uniforme.
- Conferidor (`checked_by`) e data são sempre do servidor. Campos como `status`,
  `created_by`, `checked_by`, `id`, `version`, `result` => 400 + evento de mass assignment.
- Resumo `GET /<id>/summary`: `total_assets` (bens não excluídos da unidade, no momento
  da consulta), `checked`, `pending`, `found`, `not_found`, `divergent`, `progress_percent`.
- Listas: paginadas; `sort`, `status`, `unit_id`, `q` (inventários) e `result`, `sort`
  (itens) por allowlist; parâmetro desconhecido/repetido = 400.

## Decisão pendente: `assets.located`

A matriz de permissões não define que o resultado da conferência atualiza `assets.located`
("USER não pode forçar `located` sem evidência de conferência"). Portanto NENHUM bem é
alterado: a conferência é apenas evidência registrada. Se a instituição decidir aplicar o
resultado (ex.: no encerramento, com `version` do bem), é uma mudança de contrato nova.

## Auditoria

`AuditLog` na mesma transação: `INVENTORY_CREATED|STARTED|CLOSED|CANCELLED` e
`INVENTORY_ITEM_CHECKED` (ids, estados, contagem de bens no encerramento, `has_notes`;
nunca o texto de observações/motivo). 404 de escopo gera `UNIT_SCOPE_DENIED`.

## Locais (`GET /api/v1/locations`)

Somente leitura, `units.read`, AAL2 só ADM, escopo de unidade. Filtros `unit_id`, `room_id`,
`active`, `q`; `sort` = `name|created_at|updated_at` (com `-`); `page`, `page_size` 50|100|200 (padrão 50).
`GET /locations/<id>`: inexistente, malformado ou alheio = 404 uniforme.
