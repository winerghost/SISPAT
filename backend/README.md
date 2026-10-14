# SISPAT-AGU — Backend (Fase 1: banco de dados e permissionamento)

Esta fase contém **apenas a fundação de banco de dados** do SISPAT-AGU:
configuração, modelos SQLAlchemy 2.x, migrações Alembic e o schema inicial
(20 tabelas: RBAC, unidades, patrimônio, inventário, auditoria e
sincronização). A camada de API/Flask será adicionada em fase posterior.

## Estrutura

```
backend/
  requirements.txt
  alembic.ini
  app/
    config/settings.py     # Configuração via variáveis de ambiente
    database/session.py    # Engine, SessionLocal, Base declarativa
    models/                 # Modelos ORM (um arquivo por grupo de entidades)
  migrations/
    env.py, script.py.mako
    versions/                         # Cadeia Alembic (0001 ... 0005, head)
    sql/                              # Espelhos SQL puros + seeds manuais
```

### Cadeia Alembic

`0001_initial_schema` → `0002_import_previews` → `0003_invites` →
`0004_db_security_hardening` → `0005_settings_ai_users` (**head**).

### Alembic ↔ espelho SQL (`migrations/sql/`)

A numeração dos arquivos SQL é própria e **não** coincide com a do Alembic:

| Espelho SQL | Migração Alembic |
|---|---|
| `0001` | `0001_initial_schema` |
| `0003` | `0002_import_previews` |
| `0004` | `0003_invites` |
| `0006` | `0004_db_security_hardening` |
| `0007` | `0005_settings_ai_users` |

Os seeds SQL `0002` (roles/permissions) e `0005` (8 permissões de gestão de
usuários/segurança, atribuídas somente ao ADM) **não são migrações Alembic**:
são aplicados manualmente e são idempotentes (`ON CONFLICT DO NOTHING`).

## Rodando localmente (com Python + Alembic)

1. Criar e ativar um ambiente virtual:

   ```bash
   cd backend
   python -m venv .venv
   # Windows (PowerShell):
   .venv\Scripts\Activate.ps1
   # Linux/macOS:
   source .venv/bin/activate
   ```

2. Instalar as dependências:

   ```bash
   pip install -r requirements.txt
   ```

3. Criar um arquivo `.env` em `backend/` (não versionado) com, no mínimo:

   ```
   DATABASE_URL=postgresql+psycopg2://usuario:senha@host:5432/nome_do_banco
   SECRET_KEY=uma-chave-secreta-gerada-localmente
   ```

   Outras variáveis suportadas (todas opcionais, ver
   `app/config/settings.py`): `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_ECHO`,
   `FLASK_ENV`, `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

   **Nunca** commite o arquivo `.env` nem credenciais reais.

4. Aplicar as migrações:

   ```bash
   alembic upgrade head
   ```

5. Para reverter (apenas em desenvolvimento):

   ```bash
   alembic downgrade base
   ```

6. Para gerar uma nova migração a partir de alterações nos modelos:

   ```bash
   alembic revision --autogenerate -m "descrição da alteração"
   ```

## Aplicando o schema manualmente via Supabase (sem Python/Alembic)

Quando não houver conectividade Python → Postgres no ambiente, o schema
pode ser aplicado diretamente via **Supabase SQL Editor** (ou MCP do
Supabase), executando, nesta ordem:

1. `0001_initial_schema.sql` — extensões, tipo `asset_located_status` e as
   20 tabelas com índices e constraints.
2. `0002_seeds_roles_permissions.sql` — papéis `ADM`/`USER`/`RH`,
   permissions e `role_permissions` (idempotente, `ON CONFLICT DO NOTHING`).
3. Espelhos de schema na ordem: `0003`, `0004`, `0006`, `0007` (ver tabela
   acima). O seed `0005_seed_security_permissions.sql` (idempotente) exige
   apenas o `0002` e o `0004_invites.sql` já aplicados (pré-requisito
   declarado no cabeçalho do próprio arquivo); não depende do `0006`.

Cada espelho de schema é mantido **semanticamente idêntico** à migração
Alembic correspondente. Qualquer alteração de schema deve ser replicada nos
dois lugares.

**Nota operacional:** no SQL Editor do Supabase o `BEGIN`/`COMMIT` não foi
confiável; executar os `INSERT` dos seeds **sem transação explícita**
funcionou (os seeds são idempotentes, então reexecutar é seguro).
Nenhuma migração deve ser aplicada em produção sem autorização.

## Convenções do schema

- Schema `public`, identificadores em `snake_case` minúsculo.
- Todas as datas/horas são `timestamptz`, tratadas pela aplicação sempre em
  UTC.
- `assets` nunca é apagado fisicamente — exclusão é sempre lógica
  (`deleted_at`/`deleted_by`). As demais tabelas de histórico
  (`asset_movements`, `audit_logs`, `sync_jobs`, `sync_conflicts`,
  `raw_import_records`) também nunca são apagadas.
- `assets.version` é usado para controle otimista de concorrência (a
  aplicação deve verificar/incrementar este campo em cada `UPDATE`).
- `assets.patrimony_number` é sempre `TEXT`, nunca numérico/float.
- Autenticação (senha, MFA) é externa (Supabase Auth); nenhuma tabela de
  senha é criada neste schema. `users.auth_user_id` referencia o usuário no
  provedor de autenticação.
- O controle de acesso por unidade (`user_unit_access`) é aplicado pelo
  backend, não por Row Level Security neste momento — isso pode ser
  revisitado em fase posterior caso o banco passe a ser acessado
  diretamente por clientes (hoje é acessado apenas pelo backend, via
  conexão de serviço).

## Testes

```bash
pytest
```

(Nenhum teste de integração com banco real está incluído nesta fase —
apenas a fundação de schema/modelos.)
