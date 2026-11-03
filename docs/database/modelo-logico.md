# Modelo Lógico — SISPAT-AGU

> **Como ler este documento (nota de 2026-10-29).** As seções 1 a 20 descrevem o
> modelo **projetado na Fase 1** e foram escritas antes/junto da migração
> `0001_initial_schema`. Em alguns pontos elas divergem do esquema realmente
> implantado — as divergências conferidas estão listadas em
> "0.6 Divergências entre este documento e o esquema implantado". A seção 21
> documenta o que as migrações `0011`-`0019` acrescentaram. A fonte de verdade do
> esquema é sempre `backend/migrations/versions/` (head
> `0019_user_soft_delete`; `alembic_version` de produção = `0019_user_soft_delete`,
> verificado em 2026-10-29) — ver `historico-migracoes.md`.
>
> Fase 1 — Banco de dados e permissionamento. PostgreSQL hospedado no Supabase
> (projeto `tocbtonqnahmtegfkrmn`). O Flask é a camada exclusiva de autorização;
> o RLS do Supabase **não** substitui essa validação — ver
> `docs/permissions/matriz-permissoes.md`.
>
> Convenção de nomes: tabelas e colunas em inglês, `snake_case`, sempre no plural
> para tabelas. Timestamps em `timestamptz`, armazenados em UTC (conversão para
> `America/Araguaina` é responsabilidade da camada de apresentação). Toda tabela
> que representa cadastro mestre possui `created_at`/`updated_at`; alterações via
> trigger `set_updated_at()` (não detalhado aqui — pertence à migração Alembic).

## 0. Decisões de modelagem transversais

### 0.1 Estratégia de chave primária

> **Correção (2026-10-29):** o texto abaixo é a proposta original da Fase 1. O
> esquema implantado **não** a seguiu: em `backend/migrations/sql/0001_initial_schema.sql`
> e nos modelos (`backend/app/models/*.py`), **todas** as tabelas de aplicação usam
> `uuid PRIMARY KEY DEFAULT gen_random_uuid()` — não existe `bigint generated always
> as identity` no esquema. Consequência prática: toda coluna de FK é `uuid`. Leia as
> colunas "Tipo" das seções 1 a 20 com essa ressalva; ver 0.6.

- **`users.id` e `assets.id` são `UUID`** (`default gen_random_uuid()`), por
  exigência explícita do domínio: `assets` é a tabela central sincronizada com
  sistema externo (Google Sheets) e pode precisar expor identificadores estáveis
  fora do banco (exportações, integrações, n8n); `users.id` é referenciado por
  praticamente todo o restante do modelo e se beneficia de não vazar informação
  sequencial sobre volume de usuários.
- **Todas as demais tabelas usam `bigint generated always as identity`** (IDENTITY,
  padrão SQL, sequencial). Chaves sequenciais têm melhor localidade de índice,
  menor fragmentação e menor custo de armazenamento do que UUID aleatório (UUIDv4),
  e essas tabelas não têm a mesma exigência de identificador externo estável.
- Qualquer coluna de chave estrangeira usa o mesmo tipo da chave primária
  referenciada (`uuid` para `users`/`assets`, `bigint` para as demais).

### 0.2 Tipos gerais

- `TEXT` em vez de `VARCHAR(n)`: performance idêntica no PostgreSQL, sem limite
  artificial que exigiria migração futura.
- `TIMESTAMPTZ` em todos os campos de data/hora que registram um instante de
  sistema; `DATE` apenas para campos de granularidade de dia vindos do negócio
  (`registration_date`, `start_date`, `end_date`).
- `JSONB` para estruturas semiestruturadas (filtros, payloads de auditoria,
  valores brutos de importação) — indexável via GIN quando necessário.
- Enumerações de domínio fechado e estável (ex.: `located`) usam `TEXT` com
  `CHECK`, não o tipo `ENUM` do PostgreSQL — `CHECK` é mais simples de alterar via
  migração do que um tipo `ENUM`, que exige `ALTER TYPE` fora de transação em
  versões antigas. Essa escolha é uma recomendação de implementação, não uma
  exigência; pode ser revisitada.

### 0.3 Exclusão lógica

- Conforme `CLAUDE.md`, exclusões de patrimônio são sempre lógicas. O padrão
  `deleted_at timestamptz null` + `deleted_by uuid null` é aplicado em `assets`.
  Para os cadastros mestres (`units`, `rooms`, `locations`, `responsible_people`,
  `roles`, `permissions`) o padrão de "exclusão lógica" é o campo `active
  boolean`, suficiente porque não exigem rastro de quem/quando removeu — se essa
  necessidade existir, a extensão para `deleted_at`/`deleted_by` é direta.
- **`users` também passou a ter exclusão lógica** (migração `0019_user_soft_delete`,
  2026-10-28): `deleted_at`/`deleted_by`/`anonymized_at`, com anonimização
  irreversível dos dados pessoais na mesma transação. Exclusão **física** de usuário
  continua impossível (FKs `RESTRICT` + gatilho append-only de `audit_logs`). Ver
  21.7.

### 0.4 Controle otimista

- `assets.version integer not null default 1`, incrementado pela aplicação (ou
  por trigger `before update`) a cada gravação. O Flask deve exigir a versão
  conhecida pelo cliente na requisição de atualização e rejeitar com conflito
  (HTTP 409) quando `version` não corresponder à versão atual em banco.

### 0.5 Índice em toda chave estrangeira

Por padrão do PostgreSQL, colunas de chave estrangeira **não** são indexadas
automaticamente. Todas as FKs listadas abaixo recebem índice próprio — necessário
tanto para performance de `JOIN` quanto para não bloquear a tabela referenciada em
operações de validação/cascade.

### 0.6 Divergências entre este documento e o esquema implantado (2026-10-29)

Conferido em `backend/migrations/sql/`, `backend/migrations/versions/` e
`backend/app/models/`:

| Seção | O que este documento diz | O que está implantado |
|---|---|---|
| 0.1 e tabelas 2-10, 12-20 | PK `bigint` IDENTITY | PK `uuid DEFAULT gen_random_uuid()` em **todas** as tabelas; FKs `uuid` |
| 4 `role_permissions` | PK composta `(role_id, permission_id)` | `id uuid` PK + `UNIQUE (role_id, permission_id)` (`uq_role_permissions_role_permission`) |
| 5 `user_roles` | PK composta `(user_id, role_id)` | `id uuid` PK + unicidade por constraint |
| 1 `users.auth_user_id` | `uuid NOT NULL UNIQUE` | `text` **NULL** UNIQUE (`uq_users_auth_user_id`); a anonimização da 0019 grava `NULL` nela |
| 6 `units.full_identifier` | coluna `text NULL UNIQUE` | **não existe**: nenhuma migração cria `units.full_identifier` (verificado por busca em `backend/migrations/`). A distinção "código curto × identificador completo" é atendida hoje por `unit_aliases` (migração `0007_unit_aliases`), não documentada neste arquivo |
| 0.2 e 11 `assets.located` | `text` + `CHECK` (decisão explícita de não usar `ENUM`) | tipo `ENUM` `asset_located_status` (`SIM`/`NAO`/`DESCONHECIDO`), criado na 0001 — a decisão registrada em 0.2 **não** foi seguida |
| 11 `assets.owner_unit_id` | `NOT NULL`, FK `ON DELETE RESTRICT` | **NULL** permitido, FK `ON DELETE SET NULL` |
| 11 `assets.source_system` | `NOT NULL DEFAULT 'GOOGLE_SHEETS'` | `text` sem `NOT NULL` e sem default |
| 11 `assets` — unicidade | `UNIQUE (source_system, source_record_id)` parcial | essa constraint não existe; o que existe é o índice **único** `uq_assets_patrimony_number_active` em `lower(btrim(patrimony_number)) WHERE deleted_at IS NULL` (migração `0009_uniq_idx_assets_movements`) |
| 11 `assets` — CHECK de versão | `CHECK (version > 0)` | `ck_assets_version_positive` (`version >= 1`) — mesmo efeito, nome diferente |
| 12 `asset_movements` | — | existe o índice único `uq_asset_movements_one_pending` em `(asset_id) WHERE status = 'PENDENTE'` (uma movimentação pendente por bem, `0009`), não descrito na seção 12 |
| escopo geral | "20 tabelas" | **28** tabelas de aplicação. Além das 20 daqui: `import_previews`, `import_preview_items` (0002), `invites`, `invite_units` (0003), `ai_settings`, `user_preferences` (0005), `unit_aliases` (0007) e `user_dashboard_preferences` (0017). Só as duas de preferências estão descritas aqui (21.5 e 21.6); as outras seis seguem **a documentar** |

Correções estruturais das seções 1-20 (reescrita das colunas de tipo) não foram
feitas nesta passagem: estão registradas acima para não deixar a afirmação falsa
sem contraditório.

---

## 1. `users`

Usuário do sistema (servidor com acesso operacional ao SISPAT-AGU).

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `auth_user_id` | `uuid` | NOT NULL, UNIQUE |
| `name` | `text` | NOT NULL |
| `email` | `text` | NOT NULL, UNIQUE |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `last_login_at` | `timestamptz` | NULL |

**Índices:** `UNIQUE(email)`, `UNIQUE(auth_user_id)`, `btree(active)` (filtragem de
usuários ativos).

**Colunas acrescentadas depois da 0001** (a tabela acima é a da `0001_initial_schema`):
`version`, `sessions_revoked_at`, `avatar_object_key`, `deactivated_at`,
`deactivated_by` (migração `0005_settings_ai_users`); `phone` + CHECK
`ck_users_phone_format` (`0008_catalog_source_ids_perms`); `deleted_at`,
`deleted_by`, `anonymized_at` + CHECK `ck_users_deleted_requires_anonymized`
(`0019_user_soft_delete`, ver 21.7).

**Justificativas:**
- **Sem coluna de senha.** O domínio exige "não armazenar senha em texto puro".
  Este modelo vai além: a tabela `users` **não possui nenhum campo de credencial**.
  `auth_user_id` é o vínculo com o provedor de autenticação (Supabase Auth, que
  mantém o hash de senha em `auth.users`, fora do schema de aplicação) — `users`
  guarda apenas o perfil de negócio do servidor. **Já decidido (2026-10-29):** a
  autenticação é 100% Supabase Auth; o parágrafo seguinte é o texto original de
  2026-10-13 e a dúvida que ele levanta não existe mais. **Pendente de validação
  institucional:** confirmar se a autenticação será 100% delegada ao Supabase Auth
  ou se o Flask manterá um provedor próprio (nesse segundo caso, a tabela de
  credenciais com hash — `bcrypt`/`argon2` — deve ficar isolada e nunca exposta em
  `SELECT *`, e este documento deve ser atualizado). Em qualquer cenário, a
  autorização (o que o usuário pode fazer) permanece 100% no Flask — autenticação
  (quem é o usuário) é uma decisão independente.
- `auth_user_id` separado de `id`: desacopla a identidade interna de negócio do
  identificador do provedor de autenticação, permitindo trocar/migrar provedor sem
  renumerar todas as FKs do sistema.
- `last_login_at` é escrita **somente** por `require_auth`
  (`backend/app/auth/supabase_auth.py` →
  `backend/app/services/login_tracking_service.py`), uma vez por sessão, com o
  instante do primeiro fator de autenticação (claim `amr` do JWT). É *último
  login*, não *última atividade*. `NULL` = nenhum login registrado desde
  2026-10-29, quando a gravação passou a existir (a coluna existe desde esta
  migração `0001`, mas antes nenhum ponto do backend a escrevia). A exclusão
  lógica de conta zera o valor junto com a anonimização
  (`backend/app/services/user_deletion_service.py`). Detalhes, semântica e
  pendência de LGPD: `docs/architecture/estrategia-auditoria.md`, seções 2.2.1,
  2.2.2 e 6.4.1.

---

## 2. `roles`

Perfil de acesso (RBAC).

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `code` | `text` | NOT NULL, UNIQUE |
| `name` | `text` | NOT NULL |
| `description` | `text` | NULL |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |

**Índices:** `UNIQUE(code)`.

**Seed inicial:** `ADM`, `USER`, `RH` (ver `docs/permissions/matriz-permissoes.md`).

**Justificativa:** `code` não recebe `CHECK IN ('ADM','USER','RH')` porque isso
impediria a criação de novos perfis sem migração — a extensibilidade de perfis é
responsabilidade da camada de aplicação/administração, não do schema. O conjunto
inicial de três perfis é um dado de seed, não uma restrição estrutural.

---

## 3. `permissions`

Permissão atômica do sistema.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `code` | `text` | NOT NULL, UNIQUE |
| `description` | `text` | NULL |
| `resource` | `text` | NOT NULL |
| `action` | `text` | NOT NULL |

**Constraints adicionais:** `CHECK (code = resource || '.' || action)` — garante
que `code` seja sempre a concatenação consistente de `resource`+`action`,
evitando divergência entre os três campos ao longo de manutenções manuais.

**Índices:** `UNIQUE(code)`, `btree(resource)`.

**Seed inicial (catálogo completo — Fase 1):**

`assets.read`, `assets.create`, `assets.update`, `assets.delete`, `assets.export`,
`units.read`, `units.create`, `rooms.manage`, `responsible.read`,
`responsible_link.manage`, `inventory.create`, `inventory.check`,
`movements.create`, `movements.approve`, `reports.read`, `exports.create`,
`imports.execute`, `sync.execute`, `audit.read`, `users.manage`, `roles.manage`,
`integrations.manage`, `system.manage`.

---

## 4. `role_permissions`

Associação perfil → permissões concedidas.

| Coluna | Tipo | Constraints |
|---|---|---|
| `role_id` | `bigint` | NOT NULL, FK → `roles(id)` ON DELETE CASCADE |
| `permission_id` | `bigint` | NOT NULL, FK → `permissions(id)` ON DELETE CASCADE |

**PK:** composta `(role_id, permission_id)` — atende à exigência de
unicidade composta sem necessidade de `id` próprio, já que a linha não tem
significado fora do par.

**Índices:** PK composta cobre `role_id`; índice adicional `btree(permission_id)`
para consultas "quais perfis têm esta permissão".

**Observação:** `ON DELETE CASCADE` é aceitável aqui porque remover um perfil ou
uma permissão do catálogo deve de fato remover a associação — isso não é exclusão
de dado patrimonial, é manutenção de configuração de acesso, e fica registrada em
`audit_logs` pela aplicação antes da remoção.

---

## 5. `user_roles`

Perfis atribuídos a cada usuário (um usuário pode acumular múltiplos perfis).

| Coluna | Tipo | Constraints |
|---|---|---|
| `user_id` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `role_id` | `bigint` | NOT NULL, FK → `roles(id)` ON DELETE RESTRICT |
| `assigned_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `assigned_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |

**PK:** composta `(user_id, role_id)`.

**Índices:** PK cobre `user_id`; `btree(role_id)`; `btree(assigned_by)`.

**Justificativa:** `ON DELETE RESTRICT` em `role_id` impede remover um perfil do
catálogo enquanto houver usuário vinculado a ele (força desvincular primeiro,
evitando usuários "sem perfil" por efeito colateral de uma exclusão de catálogo).

---

## 6. `units`

Unidade organizacional.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `code` | `text` | NOT NULL, UNIQUE |
| `full_identifier` | `text` | NULL, UNIQUE |
| `name` | `text` | NOT NULL |
| `description` | `text` | NULL |
| `address` | `text` | NULL |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

**Índices:** `UNIQUE(code)`, `UNIQUE(full_identifier)` (parcial, `WHERE
full_identifier IS NOT NULL`, pois nem toda unidade legada terá o identificador
completo preenchido no momento da migração).

> **Correção (2026-10-29): `units.full_identifier` NÃO existe no banco.** Nenhuma
> migração a cria (busca por `full_identifier` em `backend/migrations/` não retorna
> nada); a tabela real da 0001 é `id, code, name, description, address, active,
> created_at, updated_at` + `UNIQUE (code)`. A linha da tabela acima e o índice
> `UNIQUE(full_identifier)` são **proposta**, não esquema. O que está implantado
> para o mesmo problema é `unit_aliases` (migração `0007_unit_aliases`, espelho
> `sql/0010_unit_aliases.sql`), tabela **a documentar** aqui: `id`, `alias`
> (1..32 caracteres, `btrim`, **único case-insensitive** por
> `uq_unit_aliases_alias_lower`), `unit_id` (FK `RESTRICT`), `created_at`,
> `created_by`. O identificador numérico mora em `units.code` (seed
> `023401`..`023404`) e a sigla da planilha (`PF`, `PU`, `CJU`, `UEA`) em
> `unit_aliases.alias`.

**Justificativa — campo adicional `full_identifier`** (proposta, ver correção acima)**:** a especificação do
domínio exige "distinguir código curto (ex. `UEA`) de identificador completo (ex.
`023404`) — não presumir equivalência". Isso não pode ser atendido com uma única
coluna `code`; por isso o modelo lógico adiciona `full_identifier` como campo
próprio, nulo até confirmação, em vez de tentar derivar um valor do outro por
convenção. **Pendente de validação institucional:** a natureza exata do
`full_identifier` (é um código SIORG? um código interno da AGU? apenas um campo
legado da planilha?) e se ele deve ser obrigatório para novas unidades
cadastradas a partir da Fase 2.

---

## 7. `user_unit_access`

Escopo de unidades que um usuário pode operar, independente do seu perfil.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `user_id` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `created_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |

**Índices:** `UNIQUE(user_id, unit_id)`, `btree(unit_id)`.

**Justificativa:** esta tabela é o mecanismo central do escopo "por unidade"
citado em `CLAUDE.md` ("RBAC + escopo por unidade"). Nenhum perfil, incluindo
`ADM`, concede acesso implícito a todas as unidades — ver
`docs/permissions/matriz-permissoes.md`, seção sobre escopo do ADM.

---

## 8. `rooms`

Sala dentro de uma unidade.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `name` | `text` | NOT NULL |
| `description` | `text` | NULL |
| `floor` | `text` | NULL |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |

**Índices:** `btree(unit_id)`; `UNIQUE(unit_id, name)` (recomendado — evita duas
salas com mesmo nome na mesma unidade; não exigido explicitamente pela
especificação, flagado como decisão de implementação, não institucional).

**Justificativa — `floor` como `text`:** andares nem sempre são numéricos
("Térreo", "Subsolo", "2º andar") — `text` evita forçar uma convenção numérica
inexistente na origem dos dados.

---

## 9. `locations`

Local dentro de uma sala (ou diretamente na unidade, quando a sala é desconhecida).

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `room_id` | `bigint` | NULL, FK → `rooms(id)` ON DELETE RESTRICT |
| `name` | `text` | NOT NULL |
| `description` | `text` | NULL |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |

**Índices:** `btree(unit_id)`, `btree(room_id)`.

**Regra de consistência (não expressável em `CHECK` simples, aplicar no Flask ou
via trigger):** quando `room_id` não é nulo, a sala referenciada deve pertencer à
mesma `unit_id` do local. O PostgreSQL não permite `CHECK` que consulte outra
tabela; a validação deve ocorrer na camada de serviço do Flask antes do `INSERT`/
`UPDATE`, ou via trigger `BEFORE INSERT/UPDATE` dedicado caso se queira blindar o
banco contra gravações diretas.

---

## 10. `responsible_people`

Pessoa física responsável patrimonialmente por bens — não necessariamente um
usuário do sistema.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `name` | `text` | NOT NULL |
| `institutional_identifier` | `text` | NULL |
| `email` | `text` | NULL |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `active` | `boolean` | NOT NULL, DEFAULT `true` |

**Índices:** `btree(unit_id)`, `btree(institutional_identifier)`.

**Justificativa — sem CPF obrigatório:** a especificação exige explicitamente não
tornar CPF obrigatório. `institutional_identifier` (ex.: matrícula/SIAPE) é
opcional e não-único no schema, pois a qualidade desse dado na planilha de
origem é desconhecida. **Pendente de validação institucional:** política final
de unicidade de `institutional_identifier` (único por unidade? único
globalmente? pode repetir entre pessoas homônimas de unidades diferentes?) — não
presumida neste modelo.

---

## 11. `assets` (tabela central)

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `source_record_id` | `text` | NULL |
| `source_system` | `text` | NOT NULL, DEFAULT `'GOOGLE_SHEETS'` |
| `patrimony_number` | `text` | NOT NULL |
| `description` | `text` | NULL |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `owner_unit_id` | `bigint` | ~~NOT NULL, FK → `units(id)` ON DELETE RESTRICT~~ — implantado: **NULL** permitido, FK `ON DELETE SET NULL` |
| `responsible_person_id` | `bigint` | NULL, FK → `responsible_people(id)` ON DELETE SET NULL |
| `assigned_user_id` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `room_id` | `bigint` | NULL, FK → `rooms(id)` ON DELETE SET NULL |
| `location_id` | `bigint` | NULL, FK → `locations(id)` ON DELETE SET NULL |
| `located` | `text` | NOT NULL, DEFAULT `'DESCONHECIDO'` |
| `notes` | `text` | NULL |
| `registration_date` | `date` | NULL |
| `source_updated_at` | `timestamptz` | NULL |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `created_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `updated_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `deleted_at` | `timestamptz` | NULL |
| `deleted_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `version` | `integer` | NOT NULL, DEFAULT `1` |

**Colunas acrescentadas depois da 0001:** `bond_status` (`0012`, ver 21.1);
`asset_category`, `tech_type`, `operational_status` (`0015`, ver 21.2);
`equipment_family`, `equipment_category`, `classification_confidence`,
`classification_rule`, `classification_rules_version`, `category_override`
(`0018`, ver 21.3). **Não existe** coluna `search_key`: a busca por número
patrimonial usa função + índice funcional (`0016`, ver 21.4).

**Constraints** (com as correções conferidas em 2026-10-29; ver 0.6):
- `located` — no esquema implantado é o tipo `ENUM` `asset_located_status`
  (`SIM`/`NAO`/`DESCONHECIDO`), `NOT NULL DEFAULT 'DESCONHECIDO'`, e **não** um
  `text` + `CHECK` como propõe 0.2.
- `ck_assets_version_positive` (`version >= 1`) — o documento original dizia
  `CHECK (version > 0)`; é o mesmo efeito para inteiros.
- `ck_assets_deleted_by_required` (`deleted_at IS NULL OR deleted_by IS NOT
  NULL`) — garante rastreabilidade de quem excluiu logicamente o bem. **Vem da
  migração `0004_db_security_hardening`**, não da 0001.
- `uq_assets_patrimony_number_active` — índice **único** parcial em
  `lower(btrim(patrimony_number))` `WHERE deleted_at IS NULL` (migração
  `0009_uniq_idx_assets_movements`).
- `ck_assets_bond_status_len` (0012), `ck_assets_asset_category`,
  `ck_assets_tech_type`, `ck_assets_operational_status` (0015) e os seis CHECKs de
  classificação de equipamentos (0018) — ver 21.1 a 21.3.
- **Não existe** `UNIQUE (source_system, source_record_id)` (parcial ou não). O
  texto original a descrevia como necessária para a idempotência da
  sincronização; hoje a idempotência se apoia em `ix_assets_source_record_id`
  (índice **não** único, da 0001) mais a lógica do serviço de importação — ver
  `docs/architecture/estrategia-sincronizacao.md`. Se a unicidade por linha de
  origem for desejada, ela exige **nova** migração Alembic + espelho.

**Índices** (nomes reais da `0001_initial_schema`, conferidos em 2026-10-29):
- `ix_assets_patrimony_number` em `btree(patrimony_number)` — não único; a
  unicidade vem do índice parcial `uq_assets_patrimony_number_active` (0009).
- `ix_assets_description_trgm` — **GIN trigram** (`description gin_trgm_ops`),
  não `to_tsvector('portuguese', ...)` como dizia o texto original. É o que
  permite `LIKE '%...%'` com índice.
- `ix_assets_unit_id`, `ix_assets_owner_unit_id`, `ix_assets_room_id`,
  `ix_assets_location_id`, `ix_assets_responsible_person_id`,
  `ix_assets_assigned_user_id`, `ix_assets_created_by`, `ix_assets_updated_by`,
  `ix_assets_deleted_by`, `ix_assets_source_record_id` — todas as FKs e o id de
  origem.
- `ix_assets_active_unit` em `(unit_id)` parcial `WHERE deleted_at IS NULL` —
  suporta o filtro mais comum da aplicação ("bens ativos por unidade"). O
  documento original descrevia esse índice sobre `created_at`; o implantado é
  sobre `unit_id`.
- Índices das migrações posteriores: `ix_assets_bond_status_lower` (0012),
  `ix_assets_category_active` (0015), `ix_assets_patrimony_key_trgm` (0016) e
  `ix_assets_equipment_active` (0018) — ver 21.1 a 21.4.

**Justificativas centrais:**
- **`patrimony_number` é `TEXT`, nunca numérico.** Números patrimoniais podem ter
  zeros à esquerda significativos, podem conter prefixos/sufixos alfanuméricos e,
  se armazenados como ponto flutuante, sofrem perda de precisão e arredondamento
  silencioso (ex.: planilhas Excel/Sheets convertendo "0123456" para `123456` ou
  notação científica). `TEXT` preserva o valor exatamente como recebido da fonte.
- **`patrimony_number` passou a ser único entre os bens ativos.** O parágrafo a
  seguir é o texto original da Fase 1 e está **superado**: a migração
  `0009_uniq_idx_assets_movements` (espelho
  `sql/0012_unique_indexes_assets_movements.sql`) criou o índice único parcial
  `uq_assets_patrimony_number_active` sobre `lower(btrim(patrimony_number))`
  `WHERE deleted_at IS NULL` — unicidade **global** (não por unidade),
  case-insensitive e ignorando espaços nas pontas, com os bens excluídos
  logicamente fora da restrição. Texto original: *"`patrimony_number` não é
  `UNIQUE` nesta fase. O acervo legado migrado da planilha pode conter
  duplicidade (erro de digitação histórico, bens reaproveitados, baixas não
  registradas). Forçar unicidade agora rejeitaria dados reais e impediria a carga
  inicial."* A política final (único globalmente) é, portanto, a implementada;
  a mesma migração aborta (`SEC-AST-01`, só com a contagem, sem dados pessoais)
  se encontrar número duplicado entre bens ativos, em vez de criar o índice.
- **`located` aceita `DESCONHECIDO`.** Além de "sim" e "não", o domínio reconhece
  que, para boa parte do acervo migrado, a informação de localização
  simplesmente não existe ou não foi conferida — tratar a ausência de dado como
  "não localizado" distorceria indicadores de perda patrimonial. `DESCONHECIDO`
  é o valor padrão até a primeira conferência (inventário) do bem.
- **Exclusão é lógica (`deleted_at`/`deleted_by`).** Patrimônio público não pode
  simplesmente desaparecer do banco — toda remoção precisa ser auditável e
  reversível administrativamente. `ON DELETE RESTRICT` em `unit_id`/
  `owner_unit_id` reforça essa postura: nenhuma unidade pode ser removida
  enquanto houver bem vinculado a ela, nem que seja por exclusão em cascata
  acidental.
- **`version` para controle otimista.** Evita que duas edições concorrentes do
  mesmo bem (ex.: dois operadores atualizando a mesma linha) se sobrescrevam
  silenciosamente; o Flask deve recusar a gravação quando a versão enviada pelo
  cliente não corresponder à versão atual (HTTP 409).
- **`assigned_user_id` é distinto de `responsible_person_id`.** O primeiro é um
  usuário do sistema eventualmente vinculado operacionalmente ao bem (ex.: quem
  cadastrou/opera); o segundo é a pessoa física que responde patrimonialmente,
  podendo nunca ter tido conta no sistema. Fundir os dois conceitos impediria
  representar corretamente o acervo legado, onde o responsável patrimonial
  raramente coincide com um usuário cadastrado.
- **`room_id`/`location_id` com `ON DELETE SET NULL`:** diferentemente de
  `unit_id`/`owner_unit_id` (que nunca devem ficar nulos em um bem ativo), sala e
  local são informações de granularidade fina que podem ser desconhecidas sem
  comprometer a integridade do registro — por isso são opcionais e toleram
  nulificação se o cadastro físico for reorganizado.

---

## 12. `asset_movements`

Histórico de movimentação (unidade, sala e/ou responsável) de um bem.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `asset_id` | `uuid` | NOT NULL, FK → `assets(id)` ON DELETE RESTRICT |
| `origin_unit_id` | `bigint` | NULL, FK → `units(id)` ON DELETE RESTRICT |
| `destination_unit_id` | `bigint` | NULL, FK → `units(id)` ON DELETE RESTRICT |
| `origin_room_id` | `bigint` | NULL, FK → `rooms(id)` ON DELETE RESTRICT |
| `destination_room_id` | `bigint` | NULL, FK → `rooms(id)` ON DELETE RESTRICT |
| `previous_responsible_id` | `bigint` | NULL, FK → `responsible_people(id)` ON DELETE RESTRICT |
| `new_responsible_id` | `bigint` | NULL, FK → `responsible_people(id)` ON DELETE RESTRICT |
| `movement_type` | `text` | NOT NULL |
| `status` | `text` | NOT NULL, DEFAULT `'PENDENTE'` |
| `reason` | `text` | NULL |
| `requested_by` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE RESTRICT |
| `approved_by` | `uuid` | NULL, FK → `users(id)` ON DELETE RESTRICT |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `approved_at` | `timestamptz` | NULL |
| `completed_at` | `timestamptz` | NULL |

**Constraints:**
- `CHECK (status IN ('PENDENTE','APROVADO','REJEITADO','CONCLUIDO','CANCELADO'))`
- `CHECK (movement_type IN ('TRANSFERENCIA_UNIDADE','TRANSFERENCIA_SALA',
  'TROCA_RESPONSAVEL','BAIXA'))` — **pendente de validação institucional:** a
  taxonomia completa de tipos de movimentação usada operacionalmente pela AGU;
  este conjunto é uma proposta inicial cobrindo os casos descritos no domínio.
- `CHECK (destination_unit_id IS NOT NULL OR destination_room_id IS NOT NULL OR
  new_responsible_id IS NOT NULL)` — toda movimentação deve alterar ao menos uma
  dimensão (unidade, sala ou responsável); caso contrário não é uma movimentação.

**Índices:** `btree(asset_id)`, `btree(status)`, `btree(requested_by)`,
`btree(approved_by)`, `btree(origin_unit_id)`, `btree(destination_unit_id)`; mais
o índice **único** parcial `uq_asset_movements_one_pending` em `(asset_id)`
`WHERE status = 'PENDENTE'` (migração `0009_uniq_idx_assets_movements`): no
máximo uma movimentação pendente por bem. A migração aborta (`SEC-MOV-02`) se
houver bem com duas pendentes, em vez de criar o índice.

**Justificativa — `ON DELETE RESTRICT` generalizado:** nenhuma entidade
referenciada por uma movimentação histórica (unidade, sala, responsável, usuário)
pode ser removida fisicamente enquanto houver movimentação que a cite — o
histórico de movimentações é, por natureza, documento de auditoria patrimonial e
não pode perder integridade referencial.

---

## 13. `inventories`

Campanha de conferência física de bens de uma unidade.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `name` | `text` | NOT NULL |
| `unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
| `start_date` | `date` | NOT NULL |
| `end_date` | `date` | NULL |
| `status` | `text` | NOT NULL, DEFAULT `'PLANEJADO'` |
| `created_by` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE RESTRICT |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `closed_at` | `timestamptz` | NULL |

**Constraints:**
- `CHECK (status IN ('PLANEJADO','EM_ANDAMENTO','CONCLUIDO','CANCELADO'))`
- `CHECK (end_date IS NULL OR end_date >= start_date)`

**Índices:** `btree(unit_id)`, `btree(status)`.

---

## 14. `inventory_items`

Conferência de um bem específico dentro de um inventário.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `inventory_id` | `bigint` | NOT NULL, FK → `inventories(id)` ON DELETE CASCADE |
| `asset_id` | `uuid` | NOT NULL, FK → `assets(id)` ON DELETE RESTRICT |
| `found` | `boolean` | NULL |
| `observed_location_id` | `bigint` | NULL, FK → `locations(id)` ON DELETE SET NULL |
| `checked_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `checked_at` | `timestamptz` | NULL |
| `notes` | `text` | NULL |

**Constraints:** `UNIQUE (inventory_id, asset_id)`.

**Índices:** `btree(inventory_id)`, `btree(asset_id)`, `btree(observed_location_id)`.

**Justificativa — unicidade em vez de histórico:** a especificação admite duas
estratégias para evitar duplicidade de conferência final: unicidade simples ou
histórico controlado. A Fase 1 adota a **unicidade `(inventory_id, asset_id)`**
como decisão de implementação: cada bem tem, no máximo, um registro de
conferência por inventário; uma reconferência **atualiza** `found`,
`observed_location_id`, `checked_by`, `checked_at` e `notes` na mesma linha, e
cada atualização gera entrada em `audit_logs` com os valores anteriores — assim o
histórico de reconferências não se perde, apenas não vive em uma tabela própria
nesta fase. `found` é `NULL` até a primeira conferência (estado "ainda não
verificado"), `true`/`false` depois.

**Regra de consistência (aplicar no Flask):** `ON DELETE CASCADE` em
`inventory_id` é aceitável porque um item de inventário só tem sentido dentro do
inventário que o contém; excluir o inventário (administrativamente, não o bem)
remove suas conferências. Isso nunca exclui o bem em si (`assets` permanece
intacto, FK `RESTRICT`).

---

## 15. `audit_logs`

Registro imutável de operações relevantes sobre qualquer entidade.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `actor_user_id` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `entity_type` | `text` | NOT NULL |
| `entity_id` | `text` | NOT NULL |
| `operation` | `text` | NOT NULL |
| `previous_values` | `jsonb` | NULL |
| `new_values` | `jsonb` | NULL |
| `occurred_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `request_id` | `text` | NULL |
| `result` | `text` | NOT NULL, DEFAULT `'SUCCESS'` |

**Constraints:**
- `CHECK (result IN ('SUCCESS','FAILURE','DENIED'))`
- `operation` não recebe `CHECK` fechado — ver `docs/architecture/estrategia-auditoria.md`
  para o catálogo de operações auditadas, que deve permanecer extensível sem
  migração de schema.

**Índices:** `btree(entity_type, entity_id)` (consulta "histórico deste
registro"), `btree(actor_user_id)`, `btree(occurred_at)` (consultas por período e
rotina de retenção/expurgo).

**Justificativas:**
- **`entity_id` é `TEXT`, não `uuid` nem `bigint`.** `audit_logs` é polimórfica —
  referencia entidades com PK `uuid` (`assets`, `users`) e entidades com PK
  `bigint` (todas as demais). `TEXT` acomoda ambos sem exigir duas colunas de FK
  opcionais por tipo de entidade.
- **Sem FK física de `entity_id` para a entidade auditada.** Como o alvo varia
  por `entity_type`, uma FK tradicional não é possível; a integridade é garantida
  pela aplicação, não pelo schema — condição aceitável porque `audit_logs` é
  somente-inserção e não precisa de `CASCADE`.
- **Tabela projetada como append-only.** Recomenda-se revogar `UPDATE`/`DELETE`
  da role de aplicação sobre `audit_logs` (ou trigger que os bloqueie),
  garantindo que o rastro de auditoria não possa ser adulterado — detalhado em
  `docs/architecture/estrategia-auditoria.md`.

---

## 16. `sync_jobs`

Execução de uma rotina de sincronização a partir de uma fonte externa.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `source` | `text` | NOT NULL |
| `status` | `text` | NOT NULL, DEFAULT `'RUNNING'` |
| `started_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `finished_at` | `timestamptz` | NULL |
| `records_read` | `integer` | NOT NULL, DEFAULT `0` |
| `records_created` | `integer` | NOT NULL, DEFAULT `0` |
| `records_updated` | `integer` | NOT NULL, DEFAULT `0` |
| `records_failed` | `integer` | NOT NULL, DEFAULT `0` |
| `error_summary` | `text` | NULL |

**Constraints:**
- `CHECK (status IN ('RUNNING','SUCCESS','FAILED','PARTIAL'))`
- `CHECK (records_read >= 0 AND records_created >= 0 AND records_updated >= 0
  AND records_failed >= 0)`

**Índices:** `btree(source, started_at desc)`.

---

## 17. `sync_conflicts`

Divergência entre o valor de origem e o valor atual em banco para o mesmo bem.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `asset_id` | `uuid` | NULL, FK → `assets(id)` ON DELETE SET NULL |
| `source_record_id` | `text` | NOT NULL |
| `source_values` | `jsonb` | NOT NULL |
| `database_values` | `jsonb` | NULL |
| `status` | `text` | NOT NULL, DEFAULT `'PENDENTE'` |
| `detected_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `resolved_at` | `timestamptz` | NULL |
| `resolved_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |

**Constraints:** `CHECK (status IN ('PENDENTE','RESOLVIDO_MANTEM_BD',
'RESOLVIDO_APLICA_ORIGEM','IGNORADO'))`.

**Índices:** `btree(asset_id)`, `btree(status)`, `btree(source_record_id)`.

**Justificativa — `asset_id` nulo permitido:** um conflito pode surgir antes de o
bem existir no banco (ex.: ambiguidade de correspondência entre a linha da
planilha e um registro existente) — nesse caso não há `asset_id` para referenciar
até a resolução manual.

---

## 18. `saved_filters`

Critério de busca salvo por um usuário.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `user_id` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `name` | `text` | NOT NULL |
| `filter_definition` | `jsonb` | NOT NULL |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

**Constraints:** `UNIQUE (user_id, name)` (recomendado — evita dois filtros
homônimos do mesmo usuário; decisão de implementação).

**Índices:** `btree(user_id)`.

---

## 19. `export_jobs`

Solicitação de exportação de dados.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `requested_by` | `uuid` | NOT NULL, FK → `users(id)` ON DELETE RESTRICT |
| `format` | `text` | NOT NULL |
| `filters` | `jsonb` | NULL |
| `columns` | `jsonb` | NULL |
| `status` | `text` | NOT NULL, DEFAULT `'PENDENTE'` |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `expires_at` | `timestamptz` | NULL |

**Constraints:**
- `CHECK (format IN ('CSV','XLSX','PDF'))`
- `CHECK (status IN ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU','EXPIRADO'))`

**Índices:** `btree(requested_by)`, `btree(status)`, `btree(expires_at)`
(rotina de expurgo de arquivos expirados).

**Justificativa — `ON DELETE RESTRICT` em `requested_by`:** um job de exportação
é, em si, um artefato relevante para auditoria (quem exportou o quê); não deve
desaparecer silenciosamente se o usuário solicitante for removido.

---

## 20. `raw_import_records`

Linha original da planilha, preservada integralmente, associada a uma execução
de sincronização.

| Coluna | Tipo | Constraints |
|---|---|---|
| `id` | `bigint` | PK, IDENTITY |
| `sync_job_id` | `bigint` | NOT NULL, FK → `sync_jobs(id)` ON DELETE CASCADE |
| `source_record_id` | `text` | NULL |
| `source_row_number` | `integer` | NOT NULL |
| `raw_values` | `jsonb` | NOT NULL |
| `normalized_values` | `jsonb` | NULL |
| `validation_errors` | `jsonb` | NULL |
| `import_status` | `text` | NOT NULL, DEFAULT `'PENDENTE'` |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

**Constraints:** `CHECK (import_status IN ('PENDENTE','VALIDADO','IMPORTADO',
'REJEITADO','CONFLITO'))`, `CHECK (source_row_number > 0)`.

**Índices:** `btree(sync_job_id)`, `btree(source_record_id)`.

**Justificativa — preservação do dado bruto:** `raw_values` guarda a linha da
planilha **exatamente como recebida**, incluindo as duas colunas `RESPONSAVEL`
sem qualquer reinterpretação (ver
`docs/architecture/estrategia-sincronizacao.md` para o detalhamento de como
`responsavel_original` e `responsavel_unidade` são extraídas para
`normalized_values` sem perder o par original em `raw_values`). Isso garante que
qualquer erro de normalização possa ser corrigido reprocessando o dado original,
sem necessidade de reimportar a planilha.

---

---

## 21. Acréscimos das migrações 0011-0019

Esta seção cobre o que entrou no esquema **depois** do desenho original (seções 1
a 20). Cada subseção cita a migração Alembic, o espelho `.sql` e o estado
conferido em 2026-10-29; o detalhamento de aplicação, idempotência, downgrade e
backup está em `historico-migracoes.md`.

### 21.1 `assets.bond_status` — vínculo do bem (0012)

Migração `0012_asset_bond_status` / espelho `sql/0015_asset_bond_status.sql`.
Coluna conferida no banco em 2026-10-29.

| Coluna | Tipo | Constraints |
|---|---|---|
| `bond_status` | `text` | NULL, sem default |

- CHECK `ck_assets_bond_status_len`: `NULL` **ou** 1..64 caracteres sem espaços
  nas pontas (`btrim`).
- Índice `ix_assets_bond_status_lower` em `lower(bond_status)`
  `WHERE deleted_at IS NULL` (**a confirmar** no banco).

É o campo "Vínculo": o valor da **1ª** coluna `RESPONSAVEL` da planilha (ex.:
Servidor, Terceirizado, Ocioso), que antes só existia em
`raw_import_records.normalized_values->>'vinculo_situacao'`. O backfill da
migração lê o registro bruto `IMPORTADO` mais recente do mesmo
`source_record_id` (origem `google_sheets`), normaliza (espaços colapsados,
truncado em 64 caracteres), não grava vazio e **não** incrementa
`assets.version`. O valor de origem permanece em `raw_import_records` — nada se
perde se a coluna for revertida.

### 21.2 `assets` — classificação técnica (0015)

Migração `0015_asset_tech_classification` / espelho
`sql/0018_asset_tech_classification.sql`. As três colunas foram conferidas no
banco em 2026-10-29.

| Coluna | Tipo | Constraints |
|---|---|---|
| `asset_category` | `text` | NULL, CHECK `ck_assets_asset_category` |
| `tech_type` | `text` | NULL, CHECK `ck_assets_tech_type` |
| `operational_status` | `text` | NULL, CHECK `ck_assets_operational_status` |

- `asset_category` ∈ `TECNOLOGIA`, `MOBILIARIO`, `VEICULO`, `EQUIPAMENTO`,
  `OUTROS`;
- `tech_type` ∈ `COMPUTADOR`, `NOTEBOOK`, `MONITOR`, `IMPRESSORA`, `OUTRO_TI` e
  **somente** quando `asset_category = 'TECNOLOGIA'` (o CHECK amarra os dois
  campos);
- `operational_status` ∈ `EM_USO`, `ESTOQUE`, `MANUTENCAO`, `BAIXADO`;
- índice parcial `ix_assets_category_active` em
  `(asset_category, tech_type, unit_id) WHERE deleted_at IS NULL AND asset_category IS NOT NULL`
  (**a confirmar** no banco).

`NULL` significa **"não informado"**, nunca um valor presumido: não há default e
a migração não faz backfill. A classificação inicial é o comando
`flask classify-assets` (dry-run por padrão).

### 21.3 `assets` — classificação de equipamentos (0018)

Migração `0018_equipment_classification` / espelho
`sql/0021_equipment_classification.sql`, aplicada em 2026-10-27. Conferidas no
banco em 2026-10-29: `equipment_family`, `equipment_category`,
`classification_confidence` e o índice `ix_assets_equipment_active`; as outras
três colunas ficam **a confirmar**.

| Coluna | Tipo | Constraints |
|---|---|---|
| `equipment_family` | `text` | NULL, CHECK `ck_assets_equipment_family` |
| `equipment_category` | `text` | NULL, CHECK `ck_assets_equipment_category` |
| `classification_confidence` | `text` | NULL, CHECK `ck_assets_classification_confidence` |
| `classification_rule` | `text` | NULL, CHECK `ck_assets_classification_rule_len` |
| `classification_rules_version` | `text` | NULL, CHECK `ck_assets_classification_rules_version_len` |
| `category_override` | `text` | NULL, CHECK `ck_assets_category_override` |

- `equipment_family` ∈ `TI`, `MOBILIARIO`, `OUTROS`;
- `equipment_category` só aceita valor **da família correta** — `TI`:
  `COMPUTADOR`, `NOTEBOOK`, `MONITOR`, `IMPRESSORA`, `NOBREAK`, `ESTABILIZADOR`,
  `DOCKING`, `REDE`, `OUTRO_TI`; `MOBILIARIO`: `MESA`, `ARMARIO`, `GAVETEIRO`,
  `ESTACAO_TRABALHO`, `CADEIRA`, `POLTRONA`, `SOFA`, `ESTANTE`, `OUTRO_MOB`;
  `OUTROS`: `EQUIPAMENTO`, `OUTROS`;
- `classification_confidence` ∈ `ALTA`, `BAIXA`;
- `classification_rule` 1..64 caracteres sem espaços nas pontas — registra
  **qual** regra decidiu; `classification_rules_version` 1..16 caracteres;
- `category_override` aceita qualquer uma das **20** categorias (é a correção
  manual do ADM, que vence a regra automática);
- índice parcial `ix_assets_equipment_active` em
  `(equipment_family, equipment_category, unit_id) WHERE deleted_at IS NULL AND equipment_category IS NOT NULL`.

Os quatro primeiros CHECKs espelham as tuplas de
`backend/app/services/asset_classification.py`; a igualdade é garantida pelo teste
`backend/tests/test_asset_classification_migration.py`. **Para acrescentar uma
regra nova** (onde editar, a ordem de prioridade entre regras, o teste a criar e
como medir o impacto em dry-run antes de aplicar) siga
`docs/architecture/classificacao-patrimonial.md`: regra que reaproveite
família/categoria existente **não** exige migração; valor novo de família ou
categoria exige **nova** migração Alembic + espelho, porque estes CHECKs são
fechados.

Esta classificação **convive** com a da 21.2 (`asset_category`/`tech_type`), que
não foi removida nem migrada — as duas são colunas distintas e independentes.

### 21.4 Busca sem acento e chave alfanumérica (0014 e 0016)

Nenhuma coluna nova — apenas funções e um índice funcional.

- `0014_unaccent_search` / `sql/0017_unaccent_search.sql`: extensão `unaccent`
  (schema `extensions`) + função `public.sispat_unaccent(text)` (`IMMUTABLE`,
  `PARALLEL SAFE`, `STRICT`, `search_path = extensions, pg_catalog`). Usada por
  `backend/app/security/text_search.py`. Existência **a confirmar**
  diretamente (`SELECT proname FROM pg_proc WHERE proname = 'sispat_unaccent'`),
  embora implicada pela função da 0016.
- `0016_asset_search_key` / `sql/0019_asset_search_key.sql`: função
  `public.sispat_alnum_key(text)` (minúsculas, sem acento e sem
  pontuação/espaços) + índice **GIN trigram funcional**
  `ix_assets_patrimony_key_trgm` sobre `sispat_alnum_key(patrimony_number)`.
  Função e índice conferidos no banco em 2026-10-29.

**Não existe coluna `assets.search_key`.** A chave de busca é calculada pela
função no momento da consulta e o índice funcional é que a torna rápida: nada é
persistido em `assets`, e portanto não há valor a manter sincronizado. Efeito:
`GET /api/v1/assets?q=` casa `AGU-123`, `12.345`, `AB 123` com `AGU123`,
`12345`, `AB-123`. O índice `ix_assets_description_trgm` (GIN trigram sobre
`description`) vem da 0001 e também foi conferido.

Como o backend **chama** as duas funções, o DDL precisa existir antes do deploy.

### 21.5 `user_preferences` — preferências de aparência e de gráficos

Tabela criada pela `0005_settings_ai_users` (espelho
`sql/0007_settings_ai_users.sql`) e estendida pelas `0011` e `0013`; não constava
das seções 1-20.

| Coluna | Tipo | Constraints |
|---|---|---|
| `user_id` | `uuid` | PK, FK → `users(id)` ON DELETE CASCADE |
| `density` | `text` | NOT NULL, DEFAULT `'comfortable'`, CHECK `ck_user_preferences_density` (`comfortable`/`compact`) |
| `font_scale` | `smallint` | NOT NULL, DEFAULT `100`, CHECK `ck_user_preferences_font_scale` (100/112/125) |
| `dashboard_charts` | `jsonb` | NOT NULL, DEFAULT `'{}'` (migração `0011_dashboard_charts_prefs`, espelho `sql/0014`) |
| `dashboard_layout` | `jsonb` | NOT NULL, DEFAULT `'{}'::jsonb` (migração `0013_dashboard_layout_prefs`, espelho `sql/0016`) |
| `version` | `integer` | NOT NULL, DEFAULT `1`, CHECK `ck_user_preferences_version` (`>= 1`) |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

- `dashboard_charts`: CHECKs `ck_user_preferences_dashboard_charts_object`
  (`jsonb_typeof = 'object'`) e `..._size` (texto ≤ 512 bytes). Coluna conferida
  no banco em 2026-10-29.
- `dashboard_layout`: CHECKs `ck_user_preferences_dashboard_layout_object` e
  `..._size` (texto ≤ 1024 bytes). Conteúdo
  `{"order": [...], "hidden": [...]}` com ids de painel de uma **allowlist
  fechada**, validada no backend (`DashboardLayoutPatch` em
  `backend/app/api/v1/schemas.py`) — o CHECK garante só forma e tamanho. Coluna
  conferida no banco em 2026-10-29.
- Esta coluna foi **sucedida** pela tabela da 21.6 e permanece no esquema
  (a 0017 não a apaga).

### 21.6 `user_dashboard_preferences` — painéis do dashboard (0017)

Migração `0017_dashboard_panel_prefs` / espelho
`sql/0020_dashboard_panel_prefs.sql`, aplicada em 2026-10-27. Tabela conferida no
banco em 2026-10-29.

| Coluna | Tipo | Constraints |
|---|---|---|
| `user_id` | `uuid` | PK, FK → `users(id)` ON DELETE CASCADE |
| `panels` | `jsonb` | NOT NULL, DEFAULT `'[]'::jsonb` |
| `version` | `integer` | NOT NULL, DEFAULT `1` |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

**Constraints:** `ck_user_dashboard_preferences_panels_array`
(`jsonb_typeof(panels) = 'array'`), `..._panels_count`
(`jsonb_array_length(panels) <= 32`), `..._panels_size`
(`octet_length(panels::text) <= 2048`) e `..._version` (`version >= 1`).

`panels` é um **array JSONB ordenado** de objetos `{"id","visible","size"}` — a
ordem do array é a ordem de exibição; `[]` significa "layout padrão do perfil",
resolvido em tempo de leitura. O catálogo de ids de painel, as permissões por
perfil e os tamanhos admitidos (P/M/G) são validados **no backend**
(`backend/app/services/dashboard_panels_service.py`), nunca pelo cliente.

Segurança da tabela nova (padrão da `0004_db_security_hardening`): **RLS
habilitado sem nenhuma política** (deny-all para quem não tem `BYPASSRLS`) e
`REVOKE ALL` de `anon`/`authenticated`.

A migração também traduziu o layout legado de `user_preferences.dashboard_layout`
para esta tabela, aproveitando apenas os **cinco** ids com correspondente
(`kpis`, `tech_summary`, `tech_units`, `units`, `tech_category`) e descartando os
outros dez; o resultado registrado na aplicação foi **0 linhas inseridas**. O DDL
está **congelado**: não altere nome de tabela/coluna, tipo, nome ou expressão de
CHECK, nem o formato do JSONB `panels`.

### 21.7 `users` — exclusão lógica e anonimização (0019)

Migração `0019_user_soft_delete` (head) / espelho `sql/0022_user_soft_delete.sql`.
As três colunas foram conferidas no banco em 2026-10-29; o seed da permissão
`users.delete` fica **a confirmar**.

| Coluna | Tipo | Constraints |
|---|---|---|
| `deleted_at` | `timestamptz` | NULL |
| `deleted_by` | `uuid` | NULL, FK → `users(id)` ON DELETE SET NULL |
| `anonymized_at` | `timestamptz` | NULL |

**Constraint:** `ck_users_deleted_requires_anonymized`
(`deleted_at IS NULL OR anonymized_at IS NOT NULL`) — exclusão lógica sempre vem
acompanhada de anonimização. Deliberadamente **não** se usou CHECK sobre
`deleted_by`: aquela coluna pode virar `NULL` por `ON DELETE SET NULL`.

A migração também cria a permissão `users.delete`, vinculada **somente** ao papel
ADM (exigida por `POST /api/v1/users/<id>/delete`, que ainda pede AAL2 e
confirmação textual do e-mail).

Semântica (`backend/app/services/user_deletion_service.py`), na **mesma**
transação: grava `deleted_at`/`deleted_by`/`anonymized_at`, `active = false`,
`sessions_revoked_at = now`, apaga os vínculos de `user_roles` e
`user_unit_access`, supera convites pendentes e **anonimiza irreversivelmente**
`name`, `email`, `phone`, `avatar_object_key`, `auth_user_id` e `last_login_at`.
Nenhuma cópia do dado removido é guardada: `audit_logs` recebe apenas o e-mail
**mascarado**.

- `users.email` continua `NOT NULL UNIQUE`; a anonimização grava um endereço
  único e não roteável derivado do `id` (domínio `.invalid`, RFC 2606), o que
  libera o e-mail **original** para um convite futuro. Nenhuma unicidade foi
  alterada.
- `audit_logs` do usuário excluído permanece intacto, com `actor_user_id`
  **preservado** — é exatamente por isso que a linha de `users` tem de continuar
  existindo. Exclusão física segue impossível: `asset_movements.requested_by`,
  `import_previews.requested_by`, `inventories.created_by` e `invites.invited_by`
  são `RESTRICT`, e o gatilho append-only `trg_audit_logs_block_update_delete`
  (0004) recusa o `UPDATE` que o `ON DELETE SET NULL` de
  `audit_logs.actor_user_id` exigiria.
- Toda consulta de usuário passa a filtrar `deleted_at IS NULL`; `require_auth`
  responde 401 a JWT de usuário excluído.

Isto **substitui** a frase da seção "Hardening de segurança do banco" de que a
desativação de conta se faz apenas com `users.active = false`: hoje há exclusão
lógica própria, com anonimização.

---

## Resumo de relações (chaves estrangeiras)

| Tabela | Coluna FK | Referencia |
|---|---|---|
| `role_permissions` | `role_id` | `roles(id)` |
| `role_permissions` | `permission_id` | `permissions(id)` |
| `user_roles` | `user_id` | `users(id)` |
| `user_roles` | `role_id` | `roles(id)` |
| `user_roles` | `assigned_by` | `users(id)` |
| `user_unit_access` | `user_id` | `users(id)` |
| `user_unit_access` | `unit_id` | `units(id)` |
| `user_unit_access` | `created_by` | `users(id)` |
| `rooms` | `unit_id` | `units(id)` |
| `locations` | `unit_id` | `units(id)` |
| `locations` | `room_id` | `rooms(id)` |
| `responsible_people` | `unit_id` | `units(id)` |
| `assets` | `unit_id`, `owner_unit_id` | `units(id)` |
| `assets` | `responsible_person_id` | `responsible_people(id)` |
| `assets` | `assigned_user_id`, `created_by`, `updated_by`, `deleted_by` | `users(id)` |
| `assets` | `room_id` | `rooms(id)` |
| `assets` | `location_id` | `locations(id)` |
| `asset_movements` | `asset_id` | `assets(id)` |
| `asset_movements` | `origin_unit_id`, `destination_unit_id` | `units(id)` |
| `asset_movements` | `origin_room_id`, `destination_room_id` | `rooms(id)` |
| `asset_movements` | `previous_responsible_id`, `new_responsible_id` | `responsible_people(id)` |
| `asset_movements` | `requested_by`, `approved_by` | `users(id)` |
| `inventories` | `unit_id` | `units(id)` |
| `inventories` | `created_by` | `users(id)` |
| `inventory_items` | `inventory_id` | `inventories(id)` |
| `inventory_items` | `asset_id` | `assets(id)` |
| `inventory_items` | `observed_location_id` | `locations(id)` |
| `inventory_items` | `checked_by` | `users(id)` |
| `audit_logs` | `actor_user_id` | `users(id)` |
| `sync_conflicts` | `asset_id` | `assets(id)` |
| `sync_conflicts` | `resolved_by` | `users(id)` |
| `saved_filters` | `user_id` | `users(id)` |
| `export_jobs` | `requested_by` | `users(id)` |
| `raw_import_records` | `sync_job_id` | `sync_jobs(id)` |
| `users` | `deleted_by` (0019), `deactivated_by` (0005) | `users(id)` — `ON DELETE SET NULL` |
| `user_preferences` | `user_id` (0005) | `users(id)` — `ON DELETE CASCADE` |
| `user_dashboard_preferences` | `user_id` (0017) | `users(id)` — `ON DELETE CASCADE` |
| `ai_settings` | `deepseek_acknowledged_by`, `updated_by` (0005) | `users(id)` |

FKs das tabelas ainda **a documentar** (`import_previews`, `import_preview_items`,
`invites`, `invite_units`, `unit_aliases`) não estão nesta lista.

## Pontos explicitamente pendentes de validação institucional

1. ~~Política final de unicidade do número patrimonial
   (`assets.patrimony_number`)~~ — **resolvida** pela migração
   `0009_uniq_idx_assets_movements`: único globalmente entre bens ativos
   (`uq_assets_patrimony_number_active`), ver seção 11.
2. ~~Natureza exata e obrigatoriedade futura de `units.full_identifier`~~ — a
   coluna **não existe**; o tema passou a ser `units.code` + `unit_aliases`
   (seção 6). Segue pendente apenas a regra institucional de quais siglas são
   oficiais.
3. Política de unicidade/obrigatoriedade de `responsible_people.institutional_identifier`.
4. Taxonomia completa de `asset_movements.movement_type`.
5. ~~Decisão definitiva sobre o provedor de autenticação (Supabase Auth vs. Flask
   próprio)~~ — **decidido: Supabase Auth** (`CLAUDE.md`, seção "Autenticação";
   implementado em `backend/app/auth/supabase_auth.py`). Nenhuma senha ou hash é
   armazenado no schema `public`; `users.auth_user_id` (`text` NULL) é o vínculo
   com o provedor e a seção 1 deste documento deve ser lida com essa correção.

## Hardening de segurança do banco (auditoria 2026-10-13)

Migração `0004_db_security_hardening` (Alembic) + espelho
`backend/migrations/sql/0006_db_security_hardening.sql`. **Atualização de
2026-10-29:** o rótulo "pendente de aplicação", escrito em 2026-10-13, está
superado — o `alembic_version` de produção é `0019_user_soft_delete` e a cadeia é
linear, logo o Alembic considera a 0004 aplicada (a presença de cada objeto se
confere pelas consultas de `historico-migracoes.md`). O que a migração faz:

- `audit_logs` append-only: triggers `BEFORE UPDATE OR DELETE` e
  `BEFORE TRUNCATE` (função `public.sispat_block_mutation()`, `SECURITY
  INVOKER`, `search_path` vazio, SQLSTATE 42501) + `REVOKE UPDATE, DELETE,
  TRUNCATE` de `service_role`.
- DELETE/TRUNCATE físico bloqueado em `assets`, `asset_movements` e
  `raw_import_records` (neutraliza os FKs `ON DELETE CASCADE` que apagariam
  histórico). Consequência: `users` nunca é apagado fisicamente (o FK
  `audit_logs.actor_user_id ON DELETE SET NULL` seria bloqueado) — usar
  `users.active = false` (desde a `0019`, a exclusão de conta é a **exclusão
  lógica + anonimização** da 21.7, que também grava `active = false`).
- `REVOKE ALL` de `anon`/`authenticated` em tabelas/sequências do schema
  `public` e nos default privileges do role `postgres` (o navegador nunca
  acessa tabelas via Data API/PostgREST).
- `ENABLE ROW LEVEL SECURITY` versionado nas 24 tabelas de aplicação que existiam
  então (inclusive `import_previews`, `import_preview_items`, `invites`,
  `invite_units`). As tabelas criadas depois repetem o padrão na própria migração:
  `ai_settings` e `user_preferences` (0005), `unit_aliases` (0007) e
  `user_dashboard_preferences` (0017) — 28 tabelas hoje.
- `CHECK ck_assets_deleted_by_required (deleted_at IS NULL OR deleted_by IS
  NOT NULL)`.
- ORM: `Asset` usa `version_id_col` (controle otimista efetivo:
  `UPDATE ... WHERE version = :lido`, `StaleDataError` em conflito) e
  `Asset.movements` não tem mais cascade de delete.

Evidências e drift entre repositório e produção:
`docs/security/evidence/database.md`.
