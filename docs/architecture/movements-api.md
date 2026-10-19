# API de movimentações (`/api/v1/movements`)

Transferências de bens entre unidades/salas/responsáveis com **histórico imutável**.
Código: `backend/app/api/v1/movements.py`, `movement_schemas.py`,
`backend/app/services/movement_service.py`. Tabela existente `asset_movements` (sem migração).

## Rotas

| Método e caminho | Permissão | Perfil / AAL2 |
|---|---|---|
| `GET /movements` | `assets.read` | ADM, USER, RH (AAL2 só ADM) |
| `GET /movements/<id>` | `assets.read` | idem |
| `POST /movements` (solicitar) | `movements.create` | ADM, USER (AAL2 só ADM) |
| `POST /movements/<id>/cancel` | `movements.create` | solicitante ou ADM |
| `POST /movements/<id>/approve` | `movements.approve` | só ADM + AAL2 |
| `POST /movements/<id>/reject` | `movements.approve` | só ADM + AAL2 |

Não existe `PUT`/`PATCH`/`DELETE` (405). Erros: `{"error": {"code", "message"}}`.
Alvo alheio, inexistente ou malformado: **404 idêntico** (`not_found`) com evento
`UNIT_SCOPE_DENIED`. Campo desconhecido/privilegiado no corpo: 400 `validation_error` + evento.

## Estados

`PENDENTE → APROVADA | REJEITADA | CANCELADA` (allowlist). Estados terminais não mudam.
`CONCLUIDA` existe no banco mas não é usado: a aprovação grava `approved_at` e `completed_at`
juntos. Dados da movimentação nunca mudam; só a transição única de estado (guardas ORM +
sem rotas de edição). Cancelar: solicitante ou ADM (outro USER do escopo: 403).

## Solicitar — `POST /movements`

```json
{ "asset_id": "uuid", "asset_version": 3, "destination_unit_id": "uuid",
  "destination_room_id": "uuid|null", "new_responsible_id": "uuid|null", "reason": "texto<=500" }
```

* Origem (unidade/sala/responsável atuais) e `movement_type` vêm do servidor
  (`TRANSFERENCIA_UNIDADE`, `MUDANCA_SALA`, `TROCA_RESPONSAVEL`); `status`, `requested_by` etc.
  nunca vêm do cliente.
* Destino: sala/responsável precisam ser da unidade de destino (`link_unit_mismatch` 409), ativos
  (`link_inactive` 409) e estar no escopo (senão 404). **Ausente** em unidade diferente =
  sem sala/responsável; **ausente** na mesma unidade = mantém; `null` explícito = limpa.
* Bem precisa estar no escopo do solicitante pela unidade atual e não excluído (senão 404);
  destino no escopo do solicitante (senão 404) e ativo (`unit_inactive` 409).
* 409: `version_conflict` (`asset_version` ≠ versão atual do bem), `movement_pending` (já há
  pendente para o bem), `no_change` (nada mudaria).
* 201 com o objeto de movimentação. O bem **não** é alterado nesta etapa.

## Aprovar — `POST /movements/<id>/approve` `{ "asset_version": 3 }`

Exige escopo sobre origem **e** destino (senão 403 `forbidden` + `ACCESS_DENIED`; sem nenhuma das
unidades: 404). Na mesma transação: confere `asset_version` e o instantâneo de origem gravado
(unidade/sala/responsável); se o bem mudou ou a versão difere: 409 `version_conflict`. Bem
excluído: 409 `asset_unavailable`. Revalida destino e vínculos. Aplica unidade/sala/responsável
no bem (local é limpo se ficar incoerente), `version + 1`, `updated_by`. Auditoria:
`MOVEMENT_APPROVED` (`asset_movement`) e `ASSET_MOVED` (`asset`, aparece em `/assets/<id>/history`).
Falha em qualquer passo = rollback total. Segunda aprovação: 409 `invalid_transition`, sem reaplicar.

## Rejeitar / cancelar — corpo opcional `{ "reason": "texto<=500" }`

Rejeitar grava `approved_by`/`approved_at` (decisão); cancelar só muda o estado. Fora de
`PENDENTE`: 409 `invalid_transition`. O motivo da decisão vai apenas para `audit_logs`.

## Leitura

`GET /movements?status=&asset_id=&origin_unit_id=&destination_unit_id=&created_from=&created_to=
&sort=&page=&page_size=` — `status` ∈ estados; datas `AAAA-MM-DD` (UTC, `created_to` inclusivo);
`sort` ∈ `created_at|-created_at|status|-status` (padrão `-created_at`); `page_size` ≤ 100.
Parâmetro desconhecido/repetido/inválido: 400. Escopo: origem **ou** destino no escopo do usuário.
Resposta: `{ total, page, page_size, movements: [...] }`.

Objeto: `id, asset_id, asset{id,patrimony_number,description,deleted}, movement_type, status,
origin_unit_id/origin_unit{id,code,name}, destination_unit_id/destination_unit, origin_room_id/
origin_room{id,name}, destination_room_id/destination_room, previous_responsible_id/
previous_responsible{id,name}, new_responsible_id/new_responsible, created_at, approved_at,
completed_at` e, para ADM/USER, `reason, requested_by, approved_by`. **RH não recebe**
`reason`, `requested_by` nem `approved_by`.

**Origem fora do escopo do leitor (SEC-MOV-01, decisão: omitir).** Quando a unidade de
origem não está no escopo de quem lê (ex.: escopo só no destino), as chaves
`origin_room_id`, `origin_room`, `previous_responsible_id`, `previous_responsible` e
`reason` **não existem** na resposta (nem como `null`). `origin_unit`/`destination_unit`,
`asset` e demais campos permanecem. O frontend deve tratar essas chaves como opcionais.
Decisão registrada (SEC-MOV-03, Info): ADM com escopo só no destino pode cancelar,
coerente com a leitura; mantido.

## Pendências institucionais

* Aprovação exige escopo de origem e destino (decisão provisória; matriz, item 3 em aberto).
* Não há `movements.read`: a leitura usa `assets.read` (RH inclusive).
