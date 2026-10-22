# APIs administrativas de leitura (`/api/v1/admin/...`)

Somente LEITURA (nenhum POST/PUT/PATCH/DELETE; `audit_logs` é append-only).
Todas: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission(...) -> rate_limit` (fail-closed). USER/RH recebem 403
(auditado); ADM com sessão AAL1 recebe 403 `AAL2_REQUIRED`. Parâmetro
desconhecido -> 400 auditado (`MASS_ASSIGNMENT_REJECTED` /
`PRIVILEGE_ESCALATION_ATTEMPT`); parâmetro repetido ou fora da allowlist -> 400
`validation_error` (valores nunca ecoados). Paginação: `page` (>=1),
`page_size` (50, 100 ou 200; padrão 50); listas devolvem
`{total, page, page_size, pages, items}`. Nenhuma migração foi criada.

| Rota | Permissão | Descrição |
|---|---|---|
| `GET /admin/audit-logs` | `audit.read` | Trilha paginada (itens resumidos). |
| `GET /admin/audit-logs/<uuid>` | `audit.read` | Detalhe com projeção segura. |
| `GET /admin/roles` | `roles.manage` | Perfis, permissões e usuários ativos por perfil. |
| `GET /admin/permissions` | `roles.manage` | Catálogo de permissões (com perfis que as concedem). |
| `GET /admin/unit-access` | `users.manage` | Usuário x unidades, paginado. |

Não há `roles.read`: a leitura de perfis reutiliza `roles.manage` (semeada em
`0002`, só ADM). `audit.read`, `roles.manage` e `users.manage` já existem no
seed; nenhuma permissão nova.

## Auditoria

Filtros (allowlist): `event_type` (= `operation`, `^[A-Z][A-Z0-9_]{1,63}$`),
`entity_type` (`^[a-z][a-z0-9_]{1,39}$`), `entity_id`
(`^[A-Za-z0-9_.:-]{1,100}$`), `actor_user_id` (UUID), `from`/`to`
(ISO-8601; sem fuso = UTC), `result` (`SUCESSO|FALHA`), `severity`
(`low|medium|high|critical`, só eventos de segurança), `sort`
(`occurred_at|-occurred_at`, padrão `-occurred_at`).

Janela: `to` padrão = agora; `from` padrão = `to` - 30 dias; `from <= to` e
`to - from <= 90 dias` (senão 400). A resposta traz `window:{from,to}`
resolvida.

Item de lista: `id, occurred_at, event_type, entity_type, entity_id,
actor_user_id, result, severity, request_id`. Detalhe acrescenta:
- segurança (`entity_type=security_event`): `target_type`,
  `request:{method, path, network}` (rede /24 IPv4 ou /48 IPv6, nunca o IP
  completo) e `details` (somente chaves `context, reason, required, operation,
  fields, unit_ids, from, to, removed_factors, detail`);
- negócio: `changes:{chave:{from,to}}` (somente chaves da allowlist
  `CHANGE_KEYS`) e `omitted_fields` (quantidade de chaves descartadas).

Projeção (`app/services/admin_audit_service.py`): `previous_values`,
`new_values` e `details` brutos NUNCA saem. Valores permitidos: `null`, bool,
inteiro, string curta sem espaços/`@` e sem cara de token (strings > 40
caracteres que não sejam UUID, ou iniciadas por `eyJ`/`sk-`/`sb_`/`bearer`,
viram `"[redacted]"`). O ator sai só como `actor_user_id` (sem nome/e-mail).

### Escopo de unidade (decisão)

`audit_logs` não tem coluna de unidade. O registro é visível se: (1) o autor
está vinculado (`user_unit_access`) a unidade do escopo do ADM; (2)
`entity_type='user'` e a entidade é usuário do escopo; ou (3)
`entity_type='unit'` e a unidade está no escopo. Registros sem autor (falhas de
autenticação anônimas, jobs) e de autores fora do escopo não aparecem
("auditoria irrestrita" segue como privilégio de sistema, ver matriz,
pendência 4). Detalhe alheio, inexistente ou malformado => o MESMO 404
`not_found` (evento `UNIT_SCOPE_DENIED` idêntico, mesmo número de consultas).
Limitação: eventos sobre bens praticados por autor sem unidade em comum não
aparecem.

### Auditoria do acesso

Toda consulta bem-sucedida (lista ou detalhe) grava `AUDIT_VIEWED`
(`record_security_event`, severidade `low`, resultado `SUCESSO`, ator = ADM,
`target_type=audit_log`, `target_id` só no detalhe), sem filtros nem payload.

## Perfis e permissões

`GET /admin/roles` -> `{roles:[{code,name,description,active,permissions:[{code,
description,resource,action}],active_users_count}], users_count_scope:
"actor_units"}` (ordem ADM, USER, RH). A contagem considera usuários ATIVOS
vinculados a unidades do ADM consultante. `GET /admin/permissions` ->
`{permissions:[{code,description,resource,action,roles:[...]}]}`. Sem
parâmetros (qualquer um -> 400). Sem e-mails.

## Vínculos de unidades

`GET /admin/unit-access` filtros: `unit_id` (UUID; alheia/inexistente => lista
vazia idêntica), `role` (`ADM|USER|RH`), `active` (`true|false`), `sort`
(`name|-name`). Item: `{user_id, name, role, active, units:[{id, code}]}`:
somente usuários vinculados ao escopo do ADM e somente unidades do escopo dele.
O SQL seleciona colunas (`users.id/name/active`): e-mail, telefone e
`auth_user_id` nem são lidos. A edição segue em `PATCH /api/v1/users/<id>`
(`users.assign_role`/`users.assign_unit`).
