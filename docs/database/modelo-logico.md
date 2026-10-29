# Modelo Lógico — SISPAT-AGU

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

**Justificativas:**
- **Sem coluna de senha.** O domínio exige "não armazenar senha em texto puro".
  Este modelo vai além: a tabela `users` **não possui nenhum campo de credencial**.
  `auth_user_id` é o vínculo com o provedor de autenticação (Supabase Auth, que
  mantém o hash de senha em `auth.users`, fora do schema de aplicação) — `users`
  guarda apenas o perfil de negócio do servidor. **Pendente de validação
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

**Justificativa — campo adicional `full_identifier`:** a especificação do
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
| `owner_unit_id` | `bigint` | NOT NULL, FK → `units(id)` ON DELETE RESTRICT |
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

**Constraints:**
- `CHECK (located IN ('SIM','NAO','DESCONHECIDO'))`
- `CHECK (version > 0)`
- `CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)` — garante rastreabilidade
  de quem excluiu logicamente o bem.
- `UNIQUE (source_system, source_record_id)` **parcial** `WHERE source_record_id
  IS NOT NULL` — necessária para idempotência da sincronização (ver
  `docs/architecture/estrategia-sincronizacao.md`): permite que o job de
  importação faça *upsert* determinístico por linha de origem sem depender do
  número patrimonial.

**Índices:**
- `btree(patrimony_number)` — **não** único (ver justificativa abaixo).
- `GIN(to_tsvector('portuguese', coalesce(description,'')))` — busca full-text em
  `description`, substituindo `LIKE '%...%'` que não usa índice.
- `btree(unit_id)`, `btree(owner_unit_id)`, `btree(room_id)`,
  `btree(location_id)`, `btree(responsible_person_id)`, `btree(assigned_user_id)`
  — todos os FKs.
- `btree(created_at)` parcial `WHERE deleted_at IS NULL` — suporta o filtro mais
  comum da aplicação (listar bens ativos) sem escanear registros excluídos.

**Justificativas centrais:**
- **`patrimony_number` é `TEXT`, nunca numérico.** Números patrimoniais podem ter
  zeros à esquerda significativos, podem conter prefixos/sufixos alfanuméricos e,
  se armazenados como ponto flutuante, sofrem perda de precisão e arredondamento
  silencioso (ex.: planilhas Excel/Sheets convertendo "0123456" para `123456` ou
  notação científica). `TEXT` preserva o valor exatamente como recebido da fonte.
- **`patrimony_number` não é `UNIQUE` nesta fase.** O acervo legado migrado da
  planilha pode conter duplicidade (erro de digitação histórico, bens
  reaproveitados, baixas não registradas). Forçar unicidade agora rejeitaria
  dados reais e impediria a carga inicial. **Pendente de validação
  institucional:** a política final de unicidade do número patrimonial (único
  por unidade proprietária? único globalmente? permite duplicidade documentada
  com justificativa?). Quando definida, a implementação recomendada é um índice
  único parcial (`WHERE deleted_at IS NULL`) sobre a(s) coluna(s) decidida(s),
  preservando o histórico de bens excluídos logicamente fora da restrição.
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
`btree(approved_by)`, `btree(origin_unit_id)`, `btree(destination_unit_id)`.

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

## Pontos explicitamente pendentes de validação institucional

1. Política final de unicidade do número patrimonial (`assets.patrimony_number`).
2. Natureza exata e obrigatoriedade futura de `units.full_identifier`.
3. Política de unicidade/obrigatoriedade de `responsible_people.institutional_identifier`.
4. Taxonomia completa de `asset_movements.movement_type`.
5. Decisão definitiva sobre o provedor de autenticação (Supabase Auth vs. Flask
   próprio) e, por consequência, onde fica armazenado o hash de senha.

## Hardening de segurança do banco (auditoria 2026-10-13)

Migração `0004_db_security_hardening` (Alembic) + espelho
`backend/migrations/sql/0006_db_security_hardening.sql` — **pendente de
aplicação mediante autorização explícita** (não aplicada em produção):

- `audit_logs` append-only: triggers `BEFORE UPDATE OR DELETE` e
  `BEFORE TRUNCATE` (função `public.sispat_block_mutation()`, `SECURITY
  INVOKER`, `search_path` vazio, SQLSTATE 42501) + `REVOKE UPDATE, DELETE,
  TRUNCATE` de `service_role`.
- DELETE/TRUNCATE físico bloqueado em `assets`, `asset_movements` e
  `raw_import_records` (neutraliza os FKs `ON DELETE CASCADE` que apagariam
  histórico). Consequência: `users` nunca é apagado fisicamente (o FK
  `audit_logs.actor_user_id ON DELETE SET NULL` seria bloqueado) — usar
  `users.active = false`.
- `REVOKE ALL` de `anon`/`authenticated` em tabelas/sequências do schema
  `public` e nos default privileges do role `postgres` (o navegador nunca
  acessa tabelas via Data API/PostgREST).
- `ENABLE ROW LEVEL SECURITY` versionado em todas as 24 tabelas de aplicação
  (inclusive `import_previews`, `import_preview_items`, `invites`,
  `invite_units`).
- `CHECK ck_assets_deleted_by_required (deleted_at IS NULL OR deleted_by IS
  NOT NULL)`.
- ORM: `Asset` usa `version_id_col` (controle otimista efetivo:
  `UPDATE ... WHERE version = :lido`, `StaleDataError` em conflito) e
  `Asset.movements` não tem mais cascade de delete.

Evidências e drift entre repositório e produção:
`docs/security/evidence/database.md`.
