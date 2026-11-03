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
- Ajuste sem rebuild possível via `GUNICORN_CMD_ARGS="--timeout 240"` no env
  (basta recriar o container: `docker compose up -d backend`).

## Camada de borda em produção (2026-10-29)

O proxy em produção é o vhost do CloudPanel
(`infra/cloudpanel/vhost.ueato-cloudpanel.conf`):

| Rota | `proxy_read_timeout` |
|---|---|
| `^~ /api/v1/imports/` (prévia/importação do Sheets) | 190 s |
| `/api/` (demais rotas da API, inclusive exportação de `/relatorios`) | 60 s |
| `/` (frontend) | 60 s |

Dois limites ficam FORA do nginx e do gunicorn:

- **Cloudflare, 100 s** (planos Free/Pro/Business, com DNS proxied): uma
  resposta acima disso vira 524 no navegador mesmo com nginx em 190 s e
  gunicorn em 180 s, e o worker continua processando. É o risco M1 de
  `docs/deploy/ROTEIRO_VPS_ueato.md` e o item 3 de
  `docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`. A importação dos Bens já
  rodou (1.069 bens, entre 2026-10-22 e 2026-10-29, com 24 prévias confirmadas)
  **sem nenhum 524**: na prática valeu a opção "aceitar e monitorar". A
  pendência continua aberta para prévias maiores que o acervo atual, mas já não
  é um portão para importar.
- **Exportação de relatórios**: passa pela `location /api/`, com 60 s — menor
  que o gunicorn. Medir o tempo da primeira exportação real; se encostar no
  limite, tratar junto com o M1 em vez de aumentar só um dos valores.

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

Só com autorização explícita do responsável (vale também para um rebuild).

```
cd /opt/SISPAT
docker compose build backend && docker compose up -d backend
docker compose up -d        # o frontend depende do backend e cai na recriação
docker compose ps           # backend, frontend e redis healthy
curl -fsS http://127.0.0.1:8110/api/health
```

Mudança apenas no vhost (os `proxy_read_timeout` da tabela acima) não precisa de
rebuild: `sudo nginx -t && sudo systemctl reload nginx`, com backup do vhost
antes.
