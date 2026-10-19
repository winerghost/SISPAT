# Timeouts em cascata (gunicorn, banco, Google Sheets)

Incidente: `POST /api/v1/imports/google-sheets/preview` passou do
`--timeout 60`; o gunicorn matou o worker (`WORKER TIMEOUT`, SIGABRT) e o
cliente recebeu 500 sem corpo.

## Cadeia (do menor para o maior)

| Camada | Valor | Onde |
|---|---|---|
| Google Sheets, por requisição HTTP | 30 s (`GOOGLE_SHEETS_TIMEOUT_SECONDS`, 1-300) | `google_sheets_client.py` |
| Conexão ao banco | 10 s (`DB_CONNECT_TIMEOUT`) | `database/session.py` |
| Espera por conexão do pool | 30 s (`DB_POOL_TIMEOUT_SECONDS`) | `database/session.py` |
| Statement PostgreSQL | recomendado 120000 ms (`DB_STATEMENT_TIMEOUT_MS`) | `database/session.py` |
| gunicorn `--timeout` | 180 s (antes 60) | `backend/Dockerfile` |
| gunicorn `--graceful-timeout` | 30 s | `backend/Dockerfile` |

Regra: todo timeout interno deve ser MENOR que o do gunicorn, para a falha
ser tratada pelo Flask e não pelo SIGABRT do arbiter.

## Decisões

- Mantido worker `sync` (3 workers). `gthread` exigiria revisar o uso de
  sessões/estado por requisição e aumentaria memória (limite 768M); não
  compensa. Um preview pesado ocupa 1 de 3 workers por até 180 s: o ganho
  real vem da otimização do serviço (N+1), o timeout é só margem.
- Hardening intacto: `read_only`, `--worker-tmp-dir /dev/shm`, limites de
  request-line/fields. Proxy (Nginx/CloudPanel) deve ter `proxy_read_timeout`
  >= 190 s em `/api/` para não cortar antes do gunicorn.
- Ajuste sem rebuild possível via `GUNICORN_CMD_ARGS="--timeout 240"` no env.

## Tratamento de erro (`app/errors.py`)

| Causa | Status | `error.code` |
|---|---|---|
| `statement_timeout` (SQLSTATE 57014) ou `TimeoutError` | 504 | `request_timeout` |
| Pool esgotado / `OperationalError` / `InterfaceError` | 503 (`Retry-After: 5`) | `database_unavailable` |
| Demais | 500 | `internal_error` |

Corpo sempre `{"error":{"code","message"}}`, sem SQL nem detalhes do driver.

## Ativar o statement timeout

Opt-in, pois o pooler em modo transação do Supabase (porta 6543) pode
rejeitar `options`. Preferir, no banco: `ALTER ROLE <role_app> SET
statement_timeout = '120s';` (ação manual, não aplicada por este repositório),
ou `DB_STATEMENT_TIMEOUT_MS=120000` quando a conexão for direta/sessão.

## Aplicar

```
docker compose build backend && docker compose up -d backend
```
