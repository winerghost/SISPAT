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
    versions/0001_initial_schema.py   # Migração Alembic inicial
    sql/0001_initial_schema.sql       # Espelho em SQL puro da migração
    sql/0002_seeds_roles_permissions.sql  # Seeds de roles/permissions
```

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

1. `migrations/sql/0001_initial_schema.sql` — cria extensões, o tipo
   `asset_located_status` e as 20 tabelas com seus índices e constraints.
2. `migrations/sql/0002_seeds_roles_permissions.sql` — insere os papéis
   `ADM`/`USER`/`RH`, as permissions e os vínculos `role_permissions`
   (idempotente: pode ser reexecutado sem duplicar dados).

Os dois arquivos `.sql` são mantidos **semanticamente idênticos** à
migração Alembic `versions/0001_initial_schema.py`. Qualquer alteração de
schema deve ser replicada nos dois lugares.

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
