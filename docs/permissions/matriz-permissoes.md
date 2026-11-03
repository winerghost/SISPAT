# Matriz de Permissões — SISPAT-AGU

> **Estado conferido em 2026-10-29.** Este documento deixou de ser a *proposta*
> da Fase 1: cada linha abaixo foi conferida contra o código (`backend/app`), os
> seeds (`backend/migrations/sql/*seed*` e as migrações Alembic que semeiam
> permissões) e o inventário de rotas × política de
> `backend/tests/test_sec_route_inventory.py`. Onde o código e a proposta
> original divergiam, **o código venceu** e a divergência está registrada.
>
> O Flask é a **única** camada que decide autorização em tempo de execução; o RLS
> do Supabase é deny-all e não substitui essa validação (`CLAUDE.md`). Toda
> alteração de usuários, perfis e permissões é registrada em `audit_logs`
> (`docs/architecture/estrategia-auditoria.md`).
>
> Modelo de dados: `roles`, `permissions`, `role_permissions`, `user_roles`,
> `user_unit_access` (`docs/database/modelo-logico.md`, seções 2–7).
>
> **Hoje não existe API de escrita de permissões — não confunda decisão com
> implementação.** `backend/app/api/v1/admin_access.py` expõe só
> `GET /api/v1/admin/roles`, `GET /api/v1/admin/permissions` e
> `GET /api/v1/admin/unit-access`: **somente leitura**. Não há rota de escrita em
> `role_permissions`, não há serviço de permissões de perfil e **não existe no
> código nenhum "teto de permissões concedíveis"** — isso é decisão registrada em
> 2026-10-27, ainda não construída (§6.5). A tela
> `frontend/src/app/(app)/administracao/perfis-permissoes/page.tsx` apenas exibe.
> A composição de `role_permissions` só muda por migração/seed autorizado (§3.4).
>
> O que **é** gravável é a **atribuição por usuário** (perfil e unidades):
> `PATCH /api/v1/users/<id>` com `users.assign_role` / `users.assign_unit`, mais
> as demais operações de conta em `backend/app/api/v1/users.py` (`invite`,
> `activate`, `deactivate`, `revoke`, `revoke-sessions`, `password-reset`,
> `mfa-reset`, `delete`, avatar).

## 0. Fontes de verdade e como reconferir

| O que | Onde |
|---|---|
| Decoradores de autorização | `backend/app/authorization/rbac.py` (`require_permission`, `require_role`, `require_aal2`, `require_unit_access`, `apply_unit_scope`, `has_unit_access`, `get_accessible_unit_ids`, `units_outside_scope`) |
| AAL2 condicional ao perfil | `backend/app/api/v1/catalog_http.py` (`require_aal2_for_adm`: exige MFA só quando `is_adm()`) |
| Resolução de papéis/permissões do JWT | `backend/app/auth/supabase_auth.py` (`user_roles → roles → role_permissions → permissions`; nunca vem do cliente) |
| Rota × política esperada | `backend/tests/test_sec_route_inventory.py` (`EXPECTED_POLICY`): rota nova sem política declarada **reprova a suíte** |
| Seeds de permissão | `backend/migrations/sql/0002_seeds_roles_permissions.sql`, `sql/0005_seed_security_permissions.sql` e as migrações Alembic `0005`, `0006`, `0008`, `0010`, `0019` (§3.4) |
| Estado do banco (carimbo e DDL conferido) | `docs/database/historico-migracoes.md` |

Reconferência rápida dos códigos exigidos pelo backend:

```bash
cd backend && grep -rn "require_permission(" app/api
```

## 1. Princípios de autorização

1. **Negar por padrão.** Uma operação só é permitida se existir permissão
   explícita concedida ao(s) perfil(is) do usuário **e** o escopo de unidade
   (`user_unit_access`) cobrir a unidade do recurso acessado. Escopo vazio
   resulta em consulta vazia, nunca em "sem filtro" (`apply_unit_scope`).
2. **RBAC + escopo por unidade e, quando aplicável, por campo** (`CLAUDE.md`).
   Uma permissão marcada com `*` nesta matriz não concede acesso irrestrito: seu
   efeito real é sempre filtrado por `user_unit_access` e, em alguns casos, por
   quais campos do recurso podem ser lidos/alterados.
3. **ADM não tem bypass de escopo de unidade.** `has_unit_access` e
   `get_accessible_unit_ids` não abrem exceção para `ADM`
   (`app/authorization/rbac.py`): um ADM "global" precisa ter todas as unidades
   explicitamente atribuídas em `user_unit_access`. As permissões sem unidade
   associada (`units.create`, `imports.execute`, `sync.execute`, `users.*`,
   `roles.manage`, `integrations.manage`, `system.manage`, `settings.*`,
   `security.*`) são as únicas tratadas como globais. **Pendente de validação
   institucional:** se deve existir um superusuário com bypass declarado (§6.1).
   Exceção já implementada e auditada: promoção/rebaixamento de ADM, desativação
   e reset de MFA exigem escopo **total** sobre o alvo (`_require_full_scope`,
   `app/services/user_admin_service.py`; achado UA-SCOPE-01).
4. **RH não acessa dados pessoais fora da finalidade patrimonial.** O perfil
   `RH` dá suporte à relação pessoa responsável ↔ bem. O schema não armazena
   dados funcionais, de remuneração ou de saúde; de `responsible_people` o RH vê
   `name`, `institutional_identifier`, `email` e `unit_id` — **telefone só ADM**
   (`app/services/catalog_service.py`, `_PERSONAL_FIELDS`/`_guard_phone`). RH não
   recebe `users.manage` nem qualquer permissão de escrita de bem. Textos livres
   (`assets.notes`, `asset_movements.reason`, colunas `internal=True` de
   `app/services/report_catalog.py`) não são sequer consultados para RH.
5. **Papel + permissão em rota administrativa crítica.** O padrão é
   `require_auth → require_role("ADM") → require_aal2 → require_permission(...)`
   → `rate_limit`: a permissão granular sozinha não basta (docstring de
   `app/authorization/rbac.py`).

## 2. Matriz de funcionalidades × perfil

Legenda: `✔` = concedido, `—` = não concedido, `✔*` = concedido com escopo
restrito (unidade e/ou campo — ver coluna "Escopo"). "Implementado" = existe rota
que exige a permissão; "sem rota" = permissão semeada e **sem consumidor** hoje
(§5.1).

| Funcionalidade | Código de permissão | ADM | USER | RH | Escopo / estado |
|---|---|---|---|---|---|
| Consultar bens patrimoniais | `assets.read` | `✔*` | `✔*` | `✔*` | **Implementado** (`GET /api/v1/assets`, `/<id>`, `/<id>/history`, `/bond-statuses`; `GET /api/v1/movements` e `/<id>` reusam esta permissão). Unidade: bem cujo `unit_id` ou `owner_unit_id` esteja em `user_unit_access` (`asset_scope_clause`). Campo: RH não carrega `notes` (`defer`) nem recebe `notes`, `assigned_user_id`, `source_*`, `created_by`, `updated_by`, `deleted_by`; `actor_user_id` do histórico só ADM/USER (SEC-AST-02). AAL2 só para ADM (`require_aal2_for_adm`). Excluídos só com `include_deleted=true` por ADM. Contrato: `docs/architecture/assets-api.md`. |
| Cadastrar bens | `assets.create` | `✔*` | `✔*` | `—` | **Implementado** (`POST /api/v1/assets`). Unidade do escopo; `owner_unit_id` e `located` só ADM na criação (`_ADM_ONLY_CREATE`, `app/services/asset_service.py`). |
| Editar bens | `assets.update` | `✔*` | `✔*` | `—` | **Implementado** (`PATCH /api/v1/assets/<id>`). `version` obrigatório (409 `version_conflict`). Campos só de ADM no PATCH: `owner_unit_id`, `located`, `patrimony_number` (`_ADM_ONLY_UPDATE`) — tentativa de USER = 400 + evento. `USER` edita `description`, `notes`, `room_id`, `location_id`, `responsible_person_id`, `registration_date` (lista **provisória**, §6.2). `unit_id` só na criação; `assigned_user_id`, `source_*`, `created_*`, `deleted_*`, `version` nunca vêm do cliente. Classificação legada (`asset_category`, `tech_type`, `operational_status`): ADM e USER, por allowlist, com auditoria `ASSET_CLASSIFICATION_UPDATED`; tipo de TI exige categoria TECNOLOGIA (422). |
| Corrigir manualmente a categoria de equipamento | `assets.update` (+ papel ADM + AAL2) | `✔*` | `—` | `—` | **Implementado** (`POST /api/v1/assets/<id>/category-override`, `app/services/dashboard_classification_service.override_category`): só ADM em AAL2, `version` obrigatório, auditado. Não existe permissão própria de classificação. |
| Excluir (logicamente) e restaurar bens | `assets.delete` | `✔*` | `—` | `—` | **Implementado** (`POST /api/v1/assets/<id>/delete` e `/restore`, ADM + AAL2, `version` obrigatório). Não existe rota `DELETE`. Exclusão sempre lógica (`deleted_at`/`deleted_by`). |
| Exportar lista de bens | `assets.export` | `✔` | `✔` | `✔` | **Sem rota.** Semeada em `sql/0002` para os três perfis, mas **nenhuma rota a exige**: as exportações usam `exports.create`. Candidata a limpeza (§6.8). |
| Consultar unidades, salas e locais | `units.read` | `✔*` | `✔*` | `✔*` | **Implementado**: `GET /api/v1/units/accessible` (`{units:[{id,code,name,active}]}`, sem `address`, sem parâmetros), `GET /api/v1/units/<id>`, `GET /api/v1/rooms[/<id>]`, `GET /api/v1/locations[/<id>]`. Unidade: só o escopo do usuário; AAL2 só para ADM. |
| Cadastrar unidades | `units.create` | `✔` | `—` | `—` | **Sem rota.** Não existe `POST /api/v1/units`: unidades nascem pela importação de cadastros (`POST /api/v1/catalog-imports/units/preview` + `/confirm`), que exige `units.update`. |
| Alterar/inativar unidades | `units.update` | `✔` | `—` | `—` | **Implementado** (`GET /api/v1/units/catalog`, `PATCH /api/v1/units/<id>`, `POST /<id>/deactivate`, `/activate`; ADM + AAL2) e é a permissão de `kind=units` da importação de cadastros (`KIND_PERMISSION`, `app/api/v1/catalog_import_schemas.py`). Semeada pela Alembic `0008` (espelho `sql/0011`). |
| Gerenciar salas | `rooms.manage` | `✔*` | `—` | `—` | **Implementado** (`POST /api/v1/rooms`, `PATCH /<id>`, `POST /<id>/deactivate`, `/activate`; ADM + AAL2) e `kind=rooms` da importação de cadastros. "Excluir" = inativar. **Removida do perfil `USER`** pela Alembic `0010` (espelho `sql/0013`) — o seed `0002` a havia concedido ao USER. Leitura de salas usa `units.read`. |
| Consultar pessoas responsáveis | `responsible.read` | `✔*` | `✔*` | `✔*` | **Implementado** (`GET /api/v1/responsible-people[/<id>]`). RH e ADM veem o cadastro (telefone só ADM); `USER` só vê pessoas referenciadas por bens não excluídos do seu escopo e apenas `id`, `name`, `unit_id`, `active` — sem e-mail, identificador, origem ou telefone (SEC-CAT-06; `q` só por nome, `sort` limitado a `name`/`-name`). |
| Gerenciar pessoas responsáveis | `responsible.manage` | `✔*` | `—` | `—` | **Implementado** (`POST /api/v1/responsible-people`, `PATCH /<id>`, `POST /<id>/deactivate`, `/activate`; ADM + AAL2) e `kind=people` da importação de cadastros. "Excluir" = inativar. Semeada pela Alembic `0008`. |
| Telefone (`phone`) de pessoas responsáveis | `responsible.manage` (escrita) / `responsible.read` (leitura) | `✔` | `—` | `—` | Dado pessoal (LGPD) restrito a ADM **por campo**: a coluna não é consultada para USER/RH (`defer`) e a chave é omitida da resposta; escrita por não-ADM = 400 auditado. Formato: só dígitos, 10 a 13 (CHECK da `0008`). |
| Telefone (`phone`) de usuários | — (nenhuma) | `—` | `—` | `—` | A coluna `users.phone` existe (`0008`) com CHECK de formato, mas **nenhuma rota a lê ou grava**: no modelo é `deferred` e o único código que a toca é a anonimização (`user_deletion_service.py` grava `NULL`). A versão anterior desta matriz citava uma permissão `users.update`, que **não existe** no catálogo. |
| Gerenciar vínculo responsável↔bem | `responsible_link.manage` | `✔` | `✔` | `✔` | **Sem rota.** Semeada em `sql/0002` para ADM, USER **e** RH (a `0010` não a removeu do USER). Na prática o vínculo é `assets.responsible_person_id`, alterado por `PATCH /api/v1/assets/<id>` sob `assets.update` — que **RH não tem**. Consequência: hoje **RH não consegue vincular pessoa a bem pela API**. Decisão pendente (§6.3). |
| Criar/iniciar/encerrar/cancelar inventário | `inventory.create` | `✔*` | `—` | `—` | **Implementado** (`POST /api/v1/inventories`, `/<id>/start|close|cancel`): papel ADM + AAL2 + permissão. **Removida do perfil `USER`** pela Alembic `0010`. |
| Consultar e conferir inventário | `inventory.check` | `✔*` | `✔*` | `—` | **Implementado** (`POST /api/v1/inventories/<id>/items`; as leituras `GET /inventories`, `/<id>`, `/summary`, `/items` usam a mesma permissão, pois não existe `inventory.read`). AAL2 só ADM; RH sem acesso. A conferência registra evidência e **não altera** `assets.located` (§6.7). Contrato: `docs/architecture/inventories-api.md`. |
| Solicitar/cancelar movimentação | `movements.create` | `✔*` | `✔*` | `—` | **Implementado** (`POST /api/v1/movements`, `POST /<id>/cancel` — solicitante ou ADM). Escopo na origem **e** no destino. |
| Aprovar/rejeitar movimentação | `movements.approve` | `✔*` | `—` | `—` | **Implementado** (`POST /<id>/approve`, `/reject`; ADM + AAL2). Decisão provisória: exige escopo em origem **e** destino (§6.4). Leitura usa `assets.read` (não há `movements.read`); RH não recebe motivo/autoria nem dados de origem fora do seu escopo (SEC-MOV-01). |
| Consultar relatórios e painéis do dashboard | `reports.read` | `✔*` | `✔*` | `✔*` | **Implementado**: catálogo `GET /api/v1/reports`; agregações `GET /api/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais,localizacao-por-unidade,por-vinculo,pendencias-cadastro,por-sala,inventario,tipos}`; painéis de Tecnologia `/dashboard/tecnologia/{resumo,por-categoria,por-unidade,por-status,sem-responsavel,tempo-registro}`; catálogo e preferências de painel `GET /dashboard/panels` e `PUT /dashboard/preferences`; dados e registros de painel `GET /dashboard/panels/<panel_id>/{data,records}` (a rota de registros vale **só** para `located_by_unit_chart`; `located_summary` e qualquer outro id devolvem o mesmo 404 de painel inexistente, por decisão de desenho). Escopo de unidade em todos os perfis (ADM sem bypass); só contagens/agregações, sem PII. AAL2 só ADM. Contrato: `docs/architecture/dashboard-api.md`. |
| Fila de revisão de classificação | `reports.read` (+ papel ADM + AAL2) | `✔*` | `—` | `—` | **Implementado** (`GET /api/v1/dashboard/classificacao/revisao`): mesma permissão, restrita ao papel ADM em AAL2. |
| Painéis visíveis por perfil | `reports.read` (catálogo no backend) | 14 | 11 | 9 | O catálogo é **fechado e vive no backend** (`PANEL_CATALOG`, `app/services/dashboard_panels_service.py`): 9 painéis para todos os perfis, `notebooks_without_docking` e `workstation_ratio` só ADM/USER, `unclassified_review`, `classification_overrides` e `sync_status` só ADM. O frontend nunca decide: painel fora do permitido no `PUT /dashboard/preferences` → 403 + `DASHBOARD_PANEL_FORBIDDEN` em `audit_logs`; já na LEITURA (`/panels/<id>/{data,records,export}`) painel proibido, inexistente ou malformado devolve o MESMO 404, sem distinguir os casos. O alvo das preferências é sempre o usuário do JWT (`user_id` nunca vem do cliente). |
| Solicitar exportações | `exports.create` | `✔*` | `✔*` | `✔*` | **Implementado**: `GET /api/v1/reports/<kind>/export` (CSV/XLSX de patrimônios, movimentações e itens de inventário), `GET /api/v1/dashboard/tecnologia/export`, `GET /api/v1/dashboard/panels/<panel_id>/export` e `GET /api/v1/dashboard/classificacao/revisao/export` (este só ADM + AAL2). Escopo de unidade sempre; RH sem colunas de texto livre; bens excluídos fora (`include_deleted` só ADM); teto de 10.000 linhas (413, nunca truncar em silêncio); `app.security.csv_safety` em toda célula; auditoria `REPORT_EXPORTED` / `DASHBOARD_TECH_EXPORTED`. Exportação **síncrona**: não usa `export_jobs`. Contrato: `docs/architecture/reports-api.md`. |
| Executar importação | `imports.execute` (Bens) / `units.update`, `rooms.manage`, `responsible.manage` (cadastros) | `✔` | `—` | `—` | **Implementado**: Bens em `POST /api/v1/imports/google-sheets/preview`, `/confirm`, `GET .../preview/<id>/items`, `/<id>/pending`, `/<id>/reconciliation` (ADM + AAL2 + `imports.execute`). Cadastros em `/api/v1/catalog-imports/<kind>/{preview,items,report,confirm}`: o decorador exige **ao menos uma** das três permissões de cadastro e a view confere a do `kind`; a prévia é do autor (outro ADM → 404 uniforme, SEC-CAT-02) e o escopo de unidade do ADM é respeitado (`get_accessible_unit_ids`). |
| Executar sincronização | `sync.execute` | `✔` | `—` | `—` | **Sem rota.** Não existe endpoint de sincronização; a importação do Sheets usa `imports.execute`. |
| Consultar auditoria | `audit.read` | `✔*` | `—` | `—` | **Implementado** (`GET /api/v1/admin/audit-logs[/<id>]` e `GET /api/v1/users/<id>/audit`; ADM + AAL2): escopo por autor/usuário/unidade vinculados ao ADM, projeção em allowlist (sem PII, segredos ou IP completo), janela máxima de 90 dias, consulta gera `AUDIT_VIEWED`. Contrato: `docs/architecture/admin-read-api.md`. |
| Listar/consultar usuários e vínculos de unidade | `users.manage` | `✔` | `—` | `—` | **Implementado** (`GET /api/v1/users`, `GET /api/v1/users/<id>`, `PATCH /api/v1/users/<id>`, `GET /api/v1/users/<id>/avatar-url`, `GET /api/v1/admin/unit-access`, `GET /api/v1/units`; ADM + AAL2). Sem e-mail/telefone nas respostas de `/admin/unit-access`. |
| Convidar usuário | `users.invite` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/invite`). O convite nunca concede ADM (só `USER`/`RH`, revalidado na ativação) e nunca alcança unidade fora do escopo do ADM convidante (`units_outside_scope`). Desde 2026-10-28 o link é gerado por `admin/generate_link` e entregue pelo backend, à prova de scanner de e-mail (`app/integrations/supabase_admin_client.generate_invite_token_hash` + `app/services/invite_delivery.py`). |
| Ativar / desativar conta | `users.activate` / `users.deactivate` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/activate` e `/deactivate`; ADM + AAL2). Desativação exige escopo total sobre o alvo. |
| Alterar perfil / unidades de um usuário | `users.assign_role` / `users.assign_unit` | `✔` | `—` | `—` | **Implementado por campo** em `PATCH /api/v1/users/<id>`: o decorador exige `users.manage`; enviar `role` sem `users.assign_role` ou `unit_ids` sem `users.assign_unit` é negado e auditado (`app/api/v1/users.py`, `_deny_missing_field_permission`). |
| Revogar acesso | `users.revoke_access` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/revoke`): remove papéis e vínculos de unidade e revoga convite pendente; alvo sem unidade em comum com o ADM → 404 idêntico ao inexistente (AUD-14-01); 10/h por ADM, fail-closed. |
| Encerrar sessões de um usuário | `users.revoke_sessions` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/revoke-sessions`). Semeada pela Alembic `0005`. |
| Disparar redefinição de senha | `users.reset_password` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/password-reset`). Desde 2026-10-27 o backend gera o `token_hash` e monta o e-mail (`app/services/password_reset_delivery.py`); corrigido e validado em produção em 2026-10-28 (`docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md`). Semeada pela Alembic `0005`. |
| Redefinir MFA de um usuário | `users.reset_mfa` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/mfa-reset`); exige escopo total sobre o alvo. Semeada pela Alembic `0005`. |
| Gerenciar foto de outro usuário | `users.avatar.manage` | `✔` | `—` | `—` | **Implementado** (`PUT`/`DELETE /api/v1/users/<id>/avatar`). A própria foto usa `/api/v1/me/avatar` (só autenticação). Semeada pela Alembic `0005`. |
| Excluir usuário (lógica + anonimização) | `users.delete` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/users/<id>/delete`; ADM + AAL2 + `version` + `confirm_text` igual ao e-mail exato do alvo + limite por ator e por alvo). Nunca há exclusão física (4 FKs RESTRICT e gatilho append-only de `audit_logs`); anonimiza `name`, `email`, `phone`, `avatar_object_key`, `auth_user_id`; `audit_logs.actor_user_id` é **preservado**; autoexclusão e último ADM ativo bloqueados. Semeada pela Alembic `0019` (espelho `sql/0022`), só ADM. Regra: `app/services/user_deletion_service.py`. |
| Gerenciar perfis e permissões | `roles.manage` | `✔` | `—` | `—` | **Implementado somente como LEITURA** (`GET /api/v1/admin/roles`, `GET /api/v1/admin/permissions`; não há `roles.read`). A contagem de usuários por perfil é restrita ao escopo do ADM. Não existe rota de escrita (§6.5). |
| Gerenciar/testar configuração de e-mail (SMTP) | `settings.email.manage` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/settings/email/test`): ADM + AAL2, 3 testes/h por ADM. Semeada pela Alembic `0006` (espelho `sql/0009`). |
| Gerenciar configuração de IA | `settings.ai.manage` | `✔` | `—` | `—` | **Implementado** (`GET`/`PATCH /api/v1/settings/ai`, `POST /api/v1/settings/ai/test`; ADM + AAL2). Nenhuma chave de API é armazenada no banco. Semeada pela Alembic `0005`. |
| Usar o assistente de IA | `ai.use` | `✔` | `—` | `—` | **Implementado** (`POST /api/v1/ai/ask`): exige AAL2 de **qualquer** perfil + flag `assistant`. Concedida só ao ADM (conferido em produção em 2026-10-29). Ler §5.3 antes de concedê-la a USER/RH. Semeada pela Alembic `0005`. |
| Gerenciar MFA de outro usuário | `security.manage_mfa` | `✔` | `—` | `—` | **Sem rota.** Não é exigida em `DELETE /api/v1/security/mfa/factors/<uuid>`, que é autosserviço (só o próprio fator, AAL2, rate limit, regra do último fator do ADM) — exigi-la impediria USER/RH de gerir o próprio fator (decisão AUD-14-03). O reset administrativo usa `users.reset_mfa`. |
| Consultar trilhas de autenticação | `security.view_auth_logs` | `✔` | `—` | `—` | **Sem rota.** Reservada; a consulta de auditoria usa `audit.read`. |
| Gerenciar integrações | `integrations.manage` | `✔` | `—` | `—` | **Sem rota.** Reservada (o n8n é externo; credenciais do Google Sheets ficam em variáveis de ambiente do backend). |
| Configurações de sistema | `system.manage` | `✔` | `—` | `—` | **Sem rota.** Reservada; as configurações existentes usam `settings.ai.manage` e `settings.email.manage`. |

## 3. Perfil → permissões: o que os seeds realmente concedem

As listas abaixo são o conteúdo dos seeds **e** o conteúdo real de
`role_permissions` em produção: ambos foram comparados por consulta
somente-leitura em **2026-10-30** e coincidem. Confirmado nessa consulta:
`permissions` tem **41** linhas; `ADM` = 41, `USER` = 11, `RH` = 6; existem
apenas os perfis `ADM`, `RH` e `USER`; `USER` **não** tem `rooms.manage` nem
`inventory.create` (o seed da Alembic `0010` rodou); `responsible_link.manage`
está nos três perfis; `settings.email.manage` está vinculada ao ADM;
`users.delete` está vinculada **somente** ao ADM (2026-10-28) e `ai.use`
**somente** ao ADM (2026-10-29); e **não existe** permissão `users.update`.
O carimbo `alembic_version` = `0019_user_soft_delete` foi verificado em
2026-10-29.

Consulta usada nessa verificação, e a reusar sempre que a composição mudar
(somente leitura):

```sql
SELECT r.code AS perfil, p.code AS permissao
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
ORDER BY r.code, p.code;
```

### 3.1 `ADM` — as 41 permissões do catálogo (conferido em produção, 2026-10-30)

O seed `sql/0002` faz `CROSS JOIN` de `ADM` com todas as `permissions`
existentes, e cada seed posterior vincula as novas exclusivamente ao `ADM`.
Catálogo completo por origem:

```
sql/0002 (23): assets.read, assets.create, assets.update, assets.delete,
               assets.export, units.read, units.create, rooms.manage,
               responsible.read, responsible_link.manage, inventory.create,
               inventory.check, movements.create, movements.approve,
               reports.read, exports.create, imports.execute, sync.execute,
               audit.read, users.manage, roles.manage, integrations.manage,
               system.manage
sql/0005  (8): users.invite, users.activate, users.deactivate,
               users.assign_role, users.assign_unit, users.revoke_access,
               security.manage_mfa, security.view_auth_logs
Alembic 0005 (6): settings.ai.manage, ai.use, users.reset_password,
               users.reset_mfa, users.revoke_sessions, users.avatar.manage
Alembic 0006 (1): settings.email.manage
Alembic 0008 (2): responsible.manage, units.update
Alembic 0019 (1): users.delete
```

Dessas, são **globais** (sem unidade associada, princípio 3): `units.create`,
`imports.execute`, `sync.execute`, todas as `users.*`, `roles.manage`,
`integrations.manage`, `system.manage`, `settings.*` e `security.*`. Todas as
demais têm efeito filtrado por `user_unit_access` do ADM em questão.

### 3.2 `USER` — 11 permissões (conferido em produção, 2026-10-30)

O seed `sql/0002` concedeu 13; a Alembic `0010` (espelho `sql/0013`) removeu
`rooms.manage` e `inventory.create` — e a remoção **está efetiva no banco**.
Conjunto resultante:

```
assets.read, assets.create, assets.update, assets.export,
units.read,
responsible.read, responsible_link.manage,
inventory.check,
movements.create,
reports.read, exports.create
```

Duas dessas **não têm rota consumidora**: `assets.export` e
`responsible_link.manage` (§5.1). `USER` não recebe `assets.delete`,
`movements.approve`, `inventory.create`, `rooms.manage`, `responsible.manage`,
`units.update` nem qualquer permissão administrativa, de integração, de
configuração ou de auditoria.

### 3.3 `RH` — 6 permissões (conferido em produção, 2026-10-30)

```
assets.read,
units.read,
responsible.read, responsible_link.manage,
reports.read, exports.create
```

Todas filtradas por `user_unit_access`. `responsible_link.manage` está no seed
mas não tem rota: na prática o RH **lê** bens e pessoas, consulta relatórios e
exporta, sem conseguir alterar o vínculo (§6.3). RH não recebe escrita de bem,
`users.*`, `roles.manage`, `movements.approve`, `inventory.*`, `audit.read`,
`imports.execute`, `sync.execute`, `integrations.manage`, `system.manage`,
`settings.*` nem `security.*`.

### 3.4 Migrações que criam ou alteram permissões

Detalhes de DDL, estado conferido e ordem de aplicação:
`docs/database/historico-migracoes.md`. **Backup obrigatório antes de reaplicar
ou reverter qualquer uma delas** (sem credenciais no comando; a URL vem de
variável de ambiente local, nunca versionada):

```bash
pg_dump "$SUPABASE_DB_URL" --schema=public --format=custom \
  --file=sispat_public_$(date -u +%Y%m%dT%H%M%SZ).dump
```

| Migração | O que faz com permissões | Espelho `.sql` | Reversão |
|---|---|---|---|
| `sql/0002_seeds_roles_permissions.sql` | cria os 3 perfis e as 23 permissões base; vincula ADM (todas), USER (13) e RH (6) | é o próprio espelho — **não há migração Alembic equivalente** (aplicado à mão, idempotente) | sem reversão versionada; reverter exige `DELETE` manual autorizado |
| `sql/0005_seed_security_permissions.sql` | cria as 8 permissões de gestão de usuários/segurança, só ADM | é o próprio espelho — **sem migração Alembic equivalente** | idem acima |
| `0005_settings_ai_users` | cria `settings.ai.manage`, `ai.use`, `users.reset_password`, `users.reset_mfa`, `users.revoke_sessions`, `users.avatar.manage` (só ADM), além das tabelas `ai_settings`/`user_preferences` e das colunas de gestão de `users` | `sql/0007_settings_ai_users.sql` | `alembic downgrade 0004_db_security_hardening` — remove tabelas e colunas e **mantém** as permissões semeadas (decisão da própria migração) |
| `0006_email_settings_permission` | cria `settings.email.manage` (só ADM) | `sql/0009_email_settings_permission.sql` | `alembic downgrade 0005_settings_ai_users` (ou o `DOWNGRADE_SQL` da migração) |
| `0008_catalog_source_ids_permissions` | cria `responsible.manage` e `units.update` (só ADM); também `users.phone`, `responsible_people.phone`, IDs de origem dos cadastros e CHECKs | `sql/0011_catalog_source_ids_permissions.sql` | `alembic downgrade 0007_unit_aliases` |
| `0010_seed_permission_corrections` | **remove** de `USER` as permissões `rooms.manage` e `inventory.create` (menor privilégio; as rotas já exigiam papel ADM, então não muda a API) | `sql/0013_seed_permission_corrections.sql` | `alembic downgrade 0009_unique_indexes_assets_movements` (reconcede ao USER) |
| `0019_user_soft_delete` | cria `users.delete` (só ADM); também `users.deleted_at`/`deleted_by`/`anonymized_at` e o CHECK `ck_users_deleted_requires_anonymized` | `sql/0022_user_soft_delete.sql` | `alembic downgrade 0018_equipment_classification` |

Neste projeto **dev = prod** (Supabase `tocbtonqnahmtegfkrmn`): o padrão é o
responsável executar o espelho `.sql` no SQL Editor e só então carimbar
(`alembic stamp <revisão>`, **sem** `upgrade`). Nenhum agente aplica DDL.
Observação de rastreabilidade: os cabeçalhos de várias migrações ainda dizem
"PENDENTE DE APLICAÇÃO … NÃO aplicada em banco algum" — é o texto do dia em que
foram escritas e está **superado** pelo carimbo atual; a referência de estado é
`docs/database/historico-migracoes.md`.

## 4. Múltiplos perfis por usuário

`user_roles` permite acumular perfis; o conjunto efetivo de permissões é a
**união** das permissões dos perfis ativos (`app/auth/supabase_auth.py`), e o
escopo de unidade permanece único por usuário (`user_unit_access` é por usuário,
não por perfil). Acumular perfis amplia o *quê*, nunca o *onde*. Atenção: as
restrições por campo olham o papel presente — `is_adm()` e as projeções de RH
(`catalog_service`, `report_catalog`, `asset_service`) tratam "RH **e não** ADM"
como o caso restrito, de modo que um usuário ADM+RH vê como ADM.

## 5. Responsabilidades do Flask na aplicação desta matriz

- Toda rota protegida verifica, nesta ordem: (1) usuário autenticado, ativo e
  não excluído (`deleted_at IS NULL`; JWT de excluído → 401); (2) papel, quando
  a rota exige; (3) AAL2, quando a rota exige (sempre, ou só para ADM); (4)
  permissão granular; (5) escopo de unidade do recurso; (6) filtragem por campo
  conforme o perfil. Por último, `rate_limit` (fail-closed).
- Nunca confiar em perfil/permissão enviados pelo cliente: a checagem é sempre
  resolvida no backend a partir do usuário autenticado.
- Toda negação gera evento em `audit_logs` (`ACCESS_DENIED`,
  `UNIT_SCOPE_DENIED`, `AAL2_REQUIRED`, `PRIVILEGE_ESCALATION_ATTEMPT`,
  `DASHBOARD_PANEL_FORBIDDEN`), sem expor detalhes internos ao usuário final.
- IDs inválidos, inexistentes ou alheios produzem a **mesma** resposta, sem
  oráculo de existência.

### 5.1 Permissões semeadas sem rota consumidora (atualiza AUD-14-03)

Conferido em 2026-10-29 com `grep -rn "require_permission(" backend/app/api`.
São **8**:

| Permissão | Situação |
|---|---|
| `assets.export` | concedida a ADM, USER e RH no seed `0002`; as exportações usam `exports.create`. |
| `responsible_link.manage` | concedida a ADM, USER e RH; o vínculo é alterado por `assets.update` (§6.3). |
| `units.create` | não há `POST /units`; unidades nascem pela importação de cadastros (`units.update`). |
| `sync.execute` | não há endpoint de sincronização. |
| `integrations.manage` | reservada (n8n externo). |
| `system.manage` | reservada. |
| `security.manage_mfa` | decisão AUD-14-03: não exigida no autosserviço de MFA; o reset administrativo usa `users.reset_mfa`. |
| `security.view_auth_logs` | reservada; a consulta de auditoria usa `audit.read`. |

**Saíram desta lista desde a redação original** (passaram a ter consumidor):
`users.activate`, `users.deactivate` (`POST /users/<id>/activate` e
`/deactivate`) e `users.assign_role`, `users.assign_unit` (checagem **por campo**
em `PATCH /users/<id>`). A antiga previsão de rotas
`/api/v1/admin/users/<id>/activate` não se concretizou com esse caminho: as
rotas reais estão sob `/api/v1/users/<id>/...`.

### 5.2 Rotas sem permissão granular (só autenticação)

Declaradas em `EXPECTED_POLICY` e, por isso, cobertas pelo teste-guarda:

| Rota | Política | Observação |
|---|---|---|
| `GET /api/v1/me` | autenticado | informa papéis, permissões, `current_aal`, `mfa_required` e `last_login_at` do PRÓPRIO usuário; **não autoriza nada**. |
| `POST /api/v1/users/activate-invite` | autenticado | ativação de convite; o papel vem do convite no banco, nunca do cliente. |
| `POST /api/v1/security/mfa/factor-added-notice` | autenticado | notificação do próprio cadastro de fator. |
| `PUT`/`DELETE /api/v1/me/avatar`, `GET /api/v1/me/avatar-url` | autenticado | própria foto (a de outro usuário exige `users.avatar.manage`). |
| `GET`/`PATCH /api/v1/me/preferences` | autenticado | aparência do próprio usuário (densidade, escala, layout legado). |
| `GET /api/v1/ai/insights` | autenticado | só lê cache; escopo = unidades do usuário; IA desligada → `unavailable`. |
| `GET /api/v1/dashboard/alerts` | autenticado | alertas limitados no banco por `apply_unit_scope`; sem AAL2 e sem permissão granular. |
| `DELETE /api/v1/security/mfa/factors/<uuid>` | autenticado + **AAL2** | autosserviço: só o próprio fator; ADM não remove o último. |
| `GET /api/health`, `GET /api/v1/health` | **públicas** | única allowlist pública (`PUBLIC_ALLOWLIST`); resposta fixa, sem dados. |

### 5.3 MFA/AAL2 por perfil (estado real, 2026-10-29)

- `mfa_required` em `GET /api/v1/me` é `true` **somente** quando o papel ADM
  está presente (`app/api/v1/me.py`, `_ROLE_REQUIRING_MFA = "ADM"`).
- Dois decoradores coexistem: `require_aal2` (exige MFA de qualquer perfil) e
  `require_aal2_for_adm` (só exige se `is_adm()`). Contagem por `grep` nos
  arquivos de `backend/app/api` nesta data: **59** ocorrências do primeiro e
  **47** do segundo (ocorrências do decorador, não rotas). O uso diário (bens,
  dashboard, inventários, relatórios, cadastros) está sob o segundo — ou seja,
  **RH e USER operam o sistema sem MFA**, por projeto.
- Armadilha registrada: AAL2 é propriedade da **sessão**. Como o login só
  apresenta o desafio quando `mfa_required` é `true`, um RH/USER com TOTP
  verificado permanece em `aal1` e não tem como alcançar `aal2` pela interface.
  Hoje é inócuo porque as únicas rotas `require_aal2` não restritas a ADM são
  `POST /ai/ask` (permissão `ai.use`, concedida só ao ADM) e o autosserviço de
  remoção de fator. **Antes de conceder `ai.use` a USER/RH**, resolver a
  armadilha: a pessoa receberia `403 AAL2_REQUIRED` permanente, sem saída pela
  interface. Decisão do responsável em 2026-10-29: manter como está.

## 6. Pontos explicitamente pendentes de validação institucional

1. **Superusuário.** Se deve existir um nível com bypass declarado de escopo de
   unidade para as permissões administrativas globais, e quem pode concedê-lo.
   Hoje não existe bypass no código; ADM amplo = todas as unidades em
   `user_unit_access`. Relacionado: UA-SCOPE-01 (ações sobre ADM exigem escopo
   total).
2. **Campos de `assets` editáveis por `USER`.** A lista de §2 é a adotada
   provisoriamente no código (`_ADM_ONLY_CREATE`/`_ADM_ONLY_UPDATE`); falta
   ratificação da lista fechada.
3. **`responsible_link.manage` do RH.** O perfil tem a permissão no seed **e no
   banco** (conferido em produção em 2026-10-30, nos três perfis), mas nenhuma
   rota a consome e o vínculo depende de `assets.update`, que o RH não tem. Decidir entre (a) criar rota dedicada de vínculo exigindo
   `responsible_link.manage` (restaura a finalidade do perfil RH), (b) conceder
   `assets.update` ao RH com allowlist de **um** campo, ou (c) remover a
   permissão do catálogo e assumir que o vínculo é operação de ADM/USER. Nada
   deve ser implementado antes da decisão.
4. **`movements.approve`.** Escopo exigido quando origem e destino diferem: a
   implementação atual exige **ambas**.
5. **Gestão de permissões por tela — DECISÃO, NÃO IMPLEMENTAÇÃO.** A decisão
   registrada em 2026-10-27 previu gestão gravável por perfil com **teto
   rígido** (nunca conceder a RH/USER:
   `users.*`, `roles.manage`, `system.manage`, `security.*`, `settings.*`,
   `integrations.manage`, `sync.execute`, `imports.execute`, `audit.read`,
   `assets.delete`, `units.create`/`units.update`; perfil ADM não editável pela
   API). **Nada disso está implementado** (conferido no código em 2026-10-29):
   não existe rota de escrita em `role_permissions`, não existe serviço de
   permissões de perfil e não existe constante alguma de teto de concessão.
   Confundir essa decisão com uma funcionalidade pronta é o erro a evitar: até
   que seja construída, a composição de `role_permissions` só muda por
   seed/migração autorizada, e o que um ADM consegue mudar pela API é **a quem**
   um perfil é atribuído (`users.assign_role`) e **em que unidades**
   (`users.assign_unit`), nunca **o que** o perfil pode fazer.
6. **`audit.read` do ADM** sempre escopado por unidade ou privilégio de sistema
   separado (hoje: escopado).
7. **Conferência de inventário × `assets.located`.** A conferência registra
   evidência e não altera `located`.
8. **Limpeza do catálogo.** Decidir o destino de `assets.export`,
   `units.create`, `sync.execute`, `integrations.manage`, `system.manage` e
   `security.view_auth_logs` (sem rota): manter como reserva documentada ou
   remover por seed autorizado.

## 7. Como adicionar uma permissão nova (ordem obrigatória)

1. **Decida o código** no padrão `<recurso>.<ação>` e registre a linha nesta
   matriz (§2) **antes** de escrever código, incluindo perfis, escopo e se é
   global ou escopada por unidade.
2. **Crie uma migração Alembic nova** (nunca edite uma existente) com
   `INSERT ... ON CONFLICT DO NOTHING` em `permissions` e em `role_permissions`,
   mais o espelho `.sql` correspondente (a numeração do espelho é deslocada em
   +3) e o `DOWNGRADE_SQL`. `backend/tests/test_db_static.py` compara migração e
   espelho bloco a bloco.
3. **Exija a permissão na rota**, na ordem
   `require_auth → require_role(...) → require_aal2`/`require_aal2_for_adm`
   `→ require_permission("<código>") → rate_limit`, e aplique o escopo de
   unidade no banco (`apply_unit_scope`/`require_unit_access`), nunca em memória.
4. **Declare a rota em `EXPECTED_POLICY`** (`backend/tests/test_sec_route_inventory.py`)
   e acrescente o código a `ALL_PERMISSIONS`. Sem isso a suíte reprova — é o
   mecanismo que impede rota nova sem política declarada.
5. **Crie os testes**: 401 sem credencial; 403 para cada perfil sem a permissão;
   403 `AAL2_REQUIRED` para ADM em `aal1`; IDOR (objeto de outra unidade → mesma
   resposta de inexistente); e, havendo campo sensível, ausência dele na resposta
   do perfil restrito. Padrão em `backend/tests/test_sec_authz.py`.
6. **Meça o impacto antes de aplicar**: rode a consulta de §3 (somente leitura)
   para saber quantos usuários de cada perfil passariam a ter a permissão, faça o
   `pg_dump` de §3.4 e só então aplique o espelho com autorização explícita do
   responsável, carimbando a revisão.

Regras de **classificação de equipamento** não são permissões: são código puro
(`backend/app/services/asset_classification.py`, lista `TERM_RULES` ordenada por
prioridade, com os estágios 1 e 2 em torno das regras de MESA e GABINETE). O
procedimento completo para acrescentar uma regra — onde encaixar na prioridade,
qual teste criar e como medir o impacto em dry-run antes de aplicar — está em
`docs/architecture/classificacao-patrimonial.md`. Pelo lado da autorização, só
interessa isto: alterar a regra exige migração/deploy (não é dado editável), a
correção manual de categoria exige ADM + AAL2 (`assets.update` em
`POST /assets/<id>/category-override`) e a reclassificação em lote
(`flask classify-equipment --apply`) é operação de servidor autorizada, auditada
como `ASSETS_EQUIPMENT_CLASSIFIED`.
