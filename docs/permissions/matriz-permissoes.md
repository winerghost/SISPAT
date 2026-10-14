# Matriz de Permissões — SISPAT-AGU

> Fase 1 — Banco de dados e permissionamento. O Flask é a **única** camada que
> decide autorização em tempo de execução; o RLS do Supabase não substitui essa
> validação (`CLAUDE.md`). Toda alteração de usuários, perfis e permissões deve
> ser registrada em `audit_logs` (ver `docs/architecture/estrategia-auditoria.md`).
>
> Modelo de dados de referência: `roles`, `permissions`, `role_permissions`,
> `user_roles`, `user_unit_access` (`docs/database/modelo-logico.md`, seções 2–7).

## 1. Princípios de autorização

1. **Negar por padrão.** Uma operação só é permitida se existir permissão
   explícita concedida ao(s) perfil(is) do usuário **e** o escopo de unidade
   (`user_unit_access`) cobrir a unidade do recurso acessado.
2. **RBAC + escopo por unidade e, quando aplicável, por campo** (`CLAUDE.md`).
   Uma permissão marcada com `*` nesta matriz não concede acesso irrestrito: seu
   efeito real é sempre filtrado por `user_unit_access` (escopo de unidade) e,
   em alguns casos, por quais campos do recurso podem ser lidos/alterados
   (escopo de campo).
3. **ADM não tem acesso irrestrito presumido sobre todas as unidades.** Um
   usuário com perfil `ADM` só opera sobre as unidades listadas em
   `user_unit_access` para aquele usuário — da mesma forma que `USER` e `RH`. Um
   ADM "global" (todas as unidades da AGU/Palmas-TO) precisa ter *todas* as
   unidades explicitamente atribuídas em `user_unit_access`; isso é uma decisão
   operacional de provisionamento, não um privilégio automático do perfil.
   **Pendente de validação institucional:** se deve existir um nível adicional
   de superusuário com bypass de escopo de unidade para administração de
   sistema (`users.manage`, `roles.manage`, `integrations.manage`,
   `system.manage`) — a proposta desta matriz (seção 3) assume que essas quatro
   permissões são as únicas tratadas como globais, por não possuírem, em si,
   uma unidade associada; todas as demais permanecem escopadas.
4. **RH não acessa dados pessoais fora da finalidade patrimonial.** O perfil
   `RH` existe para dar suporte à vinculação entre pessoa responsável e bem
   patrimonial (`responsible_people`, `responsible_link.manage`), não para
   administrar dados de recursos humanos em sentido amplo. O schema do
   SISPAT-AGU não armazena dados de RH sensíveis (remuneração, dados
   funcionais, saúde, etc.) — apenas `name`, `institutional_identifier`, `email`
   e `unit_id` de `responsible_people`, estritamente para fins de
   responsabilização patrimonial. RH não recebe `users.manage` (administração de
   contas de sistema é distinta de administração de responsáveis patrimoniais).

## 2. Matriz de funcionalidades × perfil

Legenda: `✔` = concedido, `—` = não concedido, `✔*` = concedido com escopo
restrito (unidade e/ou campo — ver coluna "Escopo").

| Funcionalidade | Código de permissão | ADM | USER | RH | Escopo (quando `✔*`) |
|---|---|---|---|---|---|
| Consultar bens patrimoniais | `assets.read` | `✔*` | `✔*` | `✔*` | Unidade: apenas bens cujo `unit_id` ou `owner_unit_id` esteja em `user_unit_access`. RH: campos restritos a identificação do bem e do responsável — sem necessidade de ver notas internas (`notes`) irrelevantes à vinculação. |
| Cadastrar bens | `assets.create` | `✔*` | `✔*` | `—` | Unidade: só pode cadastrar bem vinculado a unidade dentro do escopo do usuário. |
| Editar bens | `assets.update` | `✔*` | `✔*` | `—` | Unidade: idem acima. Campo: `USER` não deve poder alterar `owner_unit_id` (reclassificação de propriedade patrimonial) nem forçar `located` sem evidência de conferência — **pendente de validação institucional** a lista fechada de campos editáveis por `USER` versus `ADM`. |
| Excluir (logicamente) bens | `assets.delete` | `✔*` | `—` | `—` | Unidade: escopo do usuário. Exclusão é sempre lógica (`deleted_at`/`deleted_by`), nunca física. |
| Exportar lista de bens | `assets.export` | `✔*` | `✔*` | `✔*` | Unidade: exportação restrita aos bens visíveis no escopo do usuário; gera `export_jobs` e entrada em `audit_logs`. |
| Consultar unidades | `units.read` | `✔` | `✔*` | `✔*` | `USER`/`RH`: apenas unidades do próprio escopo (`user_unit_access`); metadados básicos (nome, código), não endereço administrativo completo se considerado sensível. |
| Cadastrar unidades | `units.create` | `✔` | `—` | `—` | Operação de catálogo organizacional — tratada como global (não há "unidade" para escopar antes da unidade existir). |
| Gerenciar salas e locais | `rooms.manage` | `✔*` | `—` | `—` | Unidade: escopo do usuário. |
| Consultar pessoas responsáveis | `responsible.read` | `✔*` | `✔*` | `✔*` | Unidade: escopo do usuário. RH enxerga o cadastro completo (dentro da finalidade patrimonial); `USER` enxerga apenas o vínculo com os bens que já consulta. |
| Gerenciar vínculo responsável↔bem | `responsible_link.manage` | `✔*` | `—` | `✔*` | Unidade: escopo do usuário. Esta é a operação central do perfil `RH`: associar/desassociar `responsible_people` a `assets`, sem acesso a administração de contas de sistema. |
| Criar inventário | `inventory.create` | `✔*` | `—` | `—` | Unidade: escopo do usuário. |
| Realizar conferência de inventário | `inventory.check` | `✔*` | `✔*` | `—` | Unidade: escopo do usuário; a conferência é a atividade operacional central do perfil `USER` em campo. |
| Solicitar movimentação de bem | `movements.create` | `✔*` | `✔*` | `—` | Unidade: escopo do usuário (origem). |
| Aprovar movimentação de bem | `movements.approve` | `✔*` | `—` | `—` | Unidade: escopo do usuário; **pendente de validação institucional** se a aprovação exige escopo sobre unidade de origem, de destino, ou ambas. |
| Consultar relatórios | `reports.read` | `✔*` | `✔*` | `✔*` | Unidade: escopo do usuário em todos os perfis. |
| Solicitar exportações | `exports.create` | `✔*` | `✔*` | `✔*` | Unidade: idem `assets.export`; mesmo mecanismo (`export_jobs`). |
| Executar importação manual | `imports.execute` | `✔` | `—` | `—` | Tratada como global — a importação (Google Sheets) não é fracionável por unidade na execução, ainda que os registros resultantes sejam escopados. |
| Executar sincronização | `sync.execute` | `✔` | `—` | `—` | Global, mesma razão de `imports.execute`. |
| Consultar auditoria | `audit.read` | `✔*` | `—` | `—` | Unidade: por padrão, ADM só vê auditoria de entidades dentro do seu escopo de unidade; auditoria irrestrita (todas as unidades) é tratada como privilégio de sistema — ver princípio 3. |
| Gerenciar usuários | `users.manage` | `✔` | `—` | `—` | Global — administração de contas de sistema. |
| Gerenciar perfis e permissões | `roles.manage` | `✔` | `—` | `—` | Global. |
| Gerenciar integrações | `integrations.manage` | `✔` | `—` | `—` | Global (n8n, credenciais de integração com Google Sheets). |
| Configurações de sistema | `system.manage` | `✔` | `—` | `—` | Global. |

## 3. Mapeamento perfil → permissões (seed inicial de `role_permissions`)

A tabela abaixo define o conjunto inicial de códigos de `permissions` concedidos
a cada `role` no momento do *seed* do banco. Reflete a matriz da seção 2.

### 3.1 `ADM`

```
assets.read, assets.create, assets.update, assets.delete, assets.export,
units.read, units.create,
rooms.manage,
responsible.read, responsible_link.manage,
inventory.create, inventory.check,
movements.create, movements.approve,
reports.read, exports.create,
imports.execute, sync.execute,
audit.read,
users.manage, roles.manage,
integrations.manage, system.manage
```

Todas as permissões acima — exceto `units.create`, `imports.execute`,
`sync.execute`, `users.manage`, `roles.manage`, `integrations.manage` e
`system.manage` (tratadas como globais, princípio 3) — têm seu efeito filtrado
por `user_unit_access` do usuário ADM em questão.

### 3.2 `USER`

```
assets.read, assets.create, assets.update,
assets.export,
units.read,
responsible.read,
inventory.check,
movements.create,
reports.read, exports.create
```

Todas filtradas por `user_unit_access`. `USER` não recebe `assets.delete`,
`movements.approve`, `rooms.manage`, `inventory.create`, `responsible_link.manage`
nem qualquer permissão administrativa/de integração/auditoria.

### 3.3 `RH`

```
assets.read,
units.read,
responsible.read, responsible_link.manage,
reports.read, exports.create
```

Todas filtradas por `user_unit_access`. RH não recebe permissões de escrita
sobre o bem em si (`assets.create/update/delete`), nem `users.manage`,
`roles.manage`, `movements.approve`, `inventory.create/check`, `audit.read`,
`imports.execute`, `sync.execute`, `integrations.manage` ou `system.manage` —
seu papel é estritamente a vinculação pessoa-responsável↔bem e a consulta
necessária para essa finalidade.

## 4. Múltiplos perfis por usuário

`user_roles` permite que um usuário acumule mais de um perfil (ex.: um usuário
`ADM` que também exerce função de `RH` em uma unidade pequena). Quando isso
ocorre, o conjunto efetivo de permissões do usuário é a **união** das
permissões de todos os seus perfis ativos, e o escopo de unidade permanece
único por usuário (`user_unit_access` não é por perfil, é por usuário) — ou
seja, acumular perfis amplia o *quê* o usuário pode fazer, nunca *onde* ele pode
agir; o *onde* é sempre governado por `user_unit_access`.

## 5. Responsabilidades do Flask na aplicação desta matriz

- Toda rota protegida deve verificar, nesta ordem: (1) usuário autenticado e
  ativo; (2) usuário possui, entre seus perfis, ao menos um que conceda a
  permissão exigida pela rota; (3) o recurso acessado pertence a uma unidade
  presente em `user_unit_access` do usuário (quando a permissão é escopada por
  unidade); (4) quando a permissão também é escopada por campo, os campos
  retornados/aceitos na requisição são filtrados conforme o perfil.
- Nunca confiar em perfil/permissão enviados pelo cliente (`CLAUDE.md`) — a
  checagem é sempre resolvida no backend a partir do usuário autenticado.
- Toda negação de acesso deve gerar entrada em `audit_logs` com
  `result = 'DENIED'`, suficiente para detectar tentativas de acesso indevido
  sem expor detalhes internos ao usuário final.

### 5.1 Permissões do seed 0005 sem consumidor (AUD-14-03)

Das 8 permissões do seed `0005_seed_security_permissions`, apenas
`users.invite` e `users.revoke_access` têm rota consumidora hoje. As demais
são **reservadas, sem rota ainda** (nenhuma rota foi inventada; todas
vinculadas só ao `ADM`):

| Permissão | Uso previsto |
|---|---|
| `users.activate` | Rota futura de ativação de conta de usuário convidado (`/api/v1/admin/users/<id>/activate`). |
| `users.deactivate` | Rota futura de desativação de conta (`/api/v1/admin/users/<id>/deactivate`). |
| `users.assign_role` | Rota/campo futuro de alteração de perfil de usuário (edição administrativa). |
| `users.assign_unit` | Rota/campo futuro de concessão/revogação de acesso a unidades. |
| `security.manage_mfa` | Rota administrativa futura de recuperação assistida de MFA de OUTRO usuário. |
| `security.view_auth_logs` | Rota futura de consulta de trilhas de autenticação/segurança. |

`security.manage_mfa` **não** é exigida em
`DELETE /api/v1/security/mfa/factors/<uuid>`: a rota é autosserviço (só o
próprio fator, AAL2, rate limit, regra do último fator do ADM) e a permissão
é exclusiva do ADM; exigi-la impediria USER/RH de gerir o próprio fator. O
cadastro do primeiro fator ocorre direto no Supabase Auth (frontend) e não
passa por essa rota. Decisão sujeita à confirmação institucional.

## 6. Pontos explicitamente pendentes de validação institucional

1. Se deve existir um nível de superusuário com bypass de escopo de unidade
   para as permissões administrativas globais, e quem pode concedê-lo.
2. Lista fechada de campos de `assets` editáveis por `USER` versus `ADM`
   (hoje, `USER` tem `assets.update` sem restrição de campo formalmente
   definida no backend).
3. Se `movements.approve` exige escopo sobre a unidade de origem, destino, ou
   ambas, quando origem e destino diferem.
4. Se `audit.read` para `ADM` deve ser sempre escopado por unidade ou se
   auditoria irrestrita é um privilégio de sistema separado.
