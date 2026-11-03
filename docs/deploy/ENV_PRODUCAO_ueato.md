# Variáveis de produção — ueato.revizzicar.com.br

Guia para montar o `.env` da VPS (`chmod 600`, fora do git). Só valores NÃO
secretos estão preenchidos; segredos aparecem como `<PREENCHER>`. Domínio
registrado em 2026-10-19. Nada aqui implanta coisa alguma.

Lista conferida contra o `.env.example` do repositório em 2026-10-29 (o
`.env.example` continua sendo a referência completa; aqui ficam as decisões do
ambiente de produção). **Nunca escreva neste arquivo, em tickets ou em chats o
VALOR de qualquer chave, token, senha ou Service Role Key — somente o nome da
variável.**

## Valores dependentes do domínio

```
FLASK_ENV=production
CORS_ALLOWED_ORIGINS=https://ueato.revizzicar.com.br
INVITE_ALLOWED_REDIRECT_URLS=https://ueato.revizzicar.com.br/ativar-conta
PASSWORD_RESET_REDIRECT_URL=https://ueato.revizzicar.com.br/ativar-conta
TRUSTED_PROXY_IPS=127.0.0.1
NEXT_PUBLIC_API_URL=https://ueato.revizzicar.com.br/api
NEXT_PUBLIC_SUPABASE_URL=<URL do projeto Supabase>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON KEY (pública)>
```

- Em produção o backend NÃO inicia se `CORS_ALLOWED_ORIGINS` ou
  `INVITE_ALLOWED_REDIRECT_URLS` tiver item não-https.
- As três `NEXT_PUBLIC_*` são fixadas no BUILD do frontend: definir no `.env`
  ANTES de `docker compose build frontend`. Build sem elas "passa" e o login
  quebra em silêncio.

## Segredos (preencher só na VPS)

`SECRET_KEY` (>= 32), `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`SUPABASE_JWT_SECRET` (ou `SUPABASE_JWT_ALGORITHMS=ES256`; confirmar no painel),
`REDIS_PASSWORD`, `REDIS_URL` (host `redis`; no `.env.example` está comentada:
descomente como `redis://:<a mesma senha>@redis:6379/0`, sem `<` `>` literais).

Opcionais do JWT, com padrão do backend quando ausentes: `SUPABASE_JWKS_URL`,
`SUPABASE_JWKS_CACHE_SECONDS`, `SUPABASE_JWKS_TIMEOUT_SECONDS`,
`SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ISSUER`, `JWT_LEEWAY_SECONDS`.

## E-mail (`EMAIL_*`) — requisito do convite e do reset de senha

A entrega do convite e a do reset de senha são feitas pelo BACKEND
(`backend/app/services/invite_delivery.py` e
`backend/app/services/password_reset_delivery.py`). Desde a rodada implantada em
2026-10-29, `EMAIL_ENABLED=true` é requisito do convite: `POST /api/v1/users/invite`
aborta com 502 se a entrega falhar, em vez de criar o convite às cegas.

```
EMAIL_ENABLED=true
```

Demais nomes (valores só na VPS): `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`,
`EMAIL_PASSWORD`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_SECURITY`,
`EMAIL_TIMEOUT_SECONDS`, `EMAIL_ALLOWED_RECIPIENT_DOMAINS`, `EMAIL_MAX_PER_HOUR`.

## Banco (TLS) e Google Sheets

```
DB_SSLMODE=verify-full
DB_SSLROOTCERT=/run/secrets/supabase-ca.crt   # CA do Supabase montada no container
GOOGLE_SHEETS_CREDENTIALS_HOST_PATH=/etc/sispat-agu/google_sheets_credentials.json
GOOGLE_SHEETS_SPREADSHEET_ID=<ID real da planilha>
GOOGLE_SHEETS_SHEET_NAME=<título exato da aba de bens>   # OU GOOGLE_SHEETS_SHEET_GID
GOOGLE_SHEETS_UNITS_SHEET_NAME / _GID     # nome OU gid da aba de Unidades
GOOGLE_SHEETS_ROOMS_SHEET_NAME / _GID     # idem, Salas
GOOGLE_SHEETS_PEOPLE_SHEET_NAME / _GID    # idem, Pessoas
```

- `DB_SSLMODE=verify-full` exige `DB_SSLROOTCERT` apontando para arquivo que
  EXISTA no container (montagem de secret); sem a CA montada, deixe o padrão e
  registre a pendência. Não defina `DB_SSLMODE` sem o arquivo.
- `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` é caminho no HOST, fora do repositório,
  arquivo existente (0400, dono 10001). Se ausente, o Compose usa
  `./secrets/google_sheets_credentials.json`. Placeholder literal quebra o `up`.
- Aba: nome exato (prioridade) OU gid; abas de apoio sem valor fazem aquela
  importação recusar executar (nunca assume aba).
- Ajuste fino, todos opcionais: `GOOGLE_SHEETS_TIMEOUT_SECONDS` (1-300; o
  cliente usa 30 s quando ausente), `DB_CONNECT_TIMEOUT`,
  `DB_POOL_TIMEOUT_SECONDS`, `DB_POOL_RECYCLE_SECONDS` e
  `DB_STATEMENT_TIMEOUT_MS` — ver `docs/deployment/timeouts-gunicorn.md`.
- Conferência obrigatória antes do build: `grep -nE '^[^#]*<' .env` deve voltar VAZIA (ignora comentários)
  (nenhum placeholder `<...>` restante) e `grep -c '^REDIS_URL=redis://:' .env`
  deve dar 1.

## Valores usados na implantação (2026-10-20)

- `BACKEND_PORT=8110` e `FRONTEND_PORT=3110`: a VPS roda outros sistemas nas
  portas 3000/8000. Antes de escolher, confira com
  `sudo ss -ltnp | grep -E ':(8110|3110)\b'` (deve voltar vazio). As mesmas
  portas vão no vhost.
- `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH=/etc/google_sheets_credentials.json`
  e `GOOGLE_SHEETS_CREDENTIALS_JSON=/run/secrets/google_sheets_credentials.json`
  (caminho DENTRO do container; nunca um caminho do Windows).
- Erros comuns ao copiar o `.env` local para a VPS: caminhos `C:/...`, URLs
  `http://localhost`, variável repetida e espaço no fim da linha. Conferências:
  `grep -nE '^[^#]*(localhost|C:/)' .env` vazio,
  `grep -c '^INVITE_ALLOWED_REDIRECT_URLS=' .env` = 1,
  `grep -n ' $' .env` vazio (corrigir com `sed -i 's/[[:space:]]*$//' .env`).
- **Senha do Redis igual nas duas variáveis.** Em 2026-10-20 o `REDIS_URL`
  ficou com a senha antiga depois de gerar um `REDIS_PASSWORD` novo: o backend
  subiu "healthy", mas toda rota com rate limit respondeu 503 (log:
  `Redis indisponível (AuthenticationError)`), inclusive a prévia de
  importação. Conferência sem exibir a senha:
  `P=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2-); U=$(grep '^REDIS_URL=' .env | sed -E 's#^REDIS_URL=redis://:([^@]*)@.*#\1#'); [ "$P" = "$U" ] && echo IGUAIS || echo DIFERENTES`
  Correção: `sed -i "s#^REDIS_URL=.*#REDIS_URL=redis://:${P}@redis:6379/0#" .env`
  e `docker compose up -d` (sem `--build`).
- **Credencial do Sheets: enviar com `scp`, nunca colar no `nano`.** Em
  2026-10-20 o JSON colado perdeu a `}` final (2428 de 2430 bytes) e a prévia
  falhou com 502 (log: `JSONDecodeError`). Conferir o tamanho com o original e
  validar sem exibir a chave:
  `sudo python3 -c "import json;b=open('/etc/google_sheets_credentials.json','rb').read();print(len(b));json.loads(b);print('JSON OK')"`.
  Depois de substituir o arquivo, o container mantém o antigo:
  `docker compose up -d --force-recreate backend` e, em seguida,
  `docker compose up -d` (recriar o backend derruba o frontend, que depende dele).

## Conferência feita na implantação de 2026-10-29

Antes do rebuild das frentes de convite, exclusão de usuário, filtros de
relatório e logomarca do cabeçalho público, a pré-checagem de aspas sobrando no
valor do `NEXT_PUBLIC_SUPABASE_ANON_KEY` voltou 0 ocorrências — o Compose NÃO
remove aspas, e um valor entre aspas iria aspas-e-tudo para o bundle. Nenhuma
variável nova foi exigida por essa rodada. Conferência sem exibir o valor
(imprime apenas o primeiro caractere, que não deve ser aspa):

```
awk -F= '/^NEXT_PUBLIC_SUPABASE_ANON_KEY=/{print substr($2,1,1)}' .env
```

## Opcionais e limites de recursos

- Integrações desligadas por padrão: `AI_ENABLED=false` (com `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `AI_TIMEOUT_SECONDS`,
  `AI_MAX_TOKENS`, `AI_RATE_LIMIT_PER_USER`, `AI_RATE_LIMIT_PER_UNIT`,
  `AI_MONTHLY_TOKEN_CAP`, `AI_CIRCUIT_FAILURE_THRESHOLD` e
  `AI_CIRCUIT_OPEN_SECONDS` só quando for ligada) e
  `N8N_INTEGRATION_ENABLED=false` (com `N8N_BASE_URL`, `N8N_WEBHOOK_URL`,
  `N8N_API_KEY`, `N8N_REQUEST_TIMEOUT_SECONDS`). O n8n é EXTERNO: este projeto
  nunca instala nem constrói um n8n, e não há pendência de instalá-lo.
- Worker Celery (profile `worker`, opt-in): `CELERY_BROKER_URL`,
  `CELERY_RESULT_BACKEND` (padrão = `REDIS_URL`) e
  `CELERY_BEAT_SCHEDULE_FILENAME`.
- Alertas: `ALERTS_UNCHECKED_DAYS`, `ALERTS_NO_MOVEMENT_DAYS`,
  `ALERTS_SPIKE_BASELINE_WEEKS`, `ALERTS_SPIKE_SIGMA`, `ALERTS_SPIKE_MIN_COUNT`
  e `ALERTS_PATRIMONY_REGEX`.
- Outros: `TZ=America/Araguaina`, `MAX_CONTENT_LENGTH_BYTES` e
  `GUNICORN_CMD_ARGS` (ajusta o timeout do gunicorn sem rebuild).
- Limites por serviço: `BACKEND_CPUS` / `BACKEND_MEMORY`,
  `FRONTEND_CPUS` / `FRONTEND_MEMORY`, `WORKER_CPUS` / `WORKER_MEMORY`,
  `REDIS_CPUS` / `REDIS_MEMORY` (padrões no `docker-compose.yml`).
- `POSTGRES_DEV_USER`, `POSTGRES_DEV_PASSWORD`, `POSTGRES_DEV_PORT`,
  `POSTGRES_DEV_DB` e `DEBUGPY_PORT` existem só para o
  `docker-compose.dev.yml`: não entram no `.env` da VPS.

## Recomendados

`DB_STATEMENT_TIMEOUT_MS=120000`, `AI_ENABLED=false`,
`N8N_INTEGRATION_ENABLED=false`, `EMAIL_ENABLED=true` (requisito do convite e do
reset de senha; ver a seção `EMAIL_*`), com o bloco SMTP preenchido.

## Supabase Auth (painel, fora do repo)

- Site URL: `https://ueato.revizzicar.com.br`
- Redirect URLs: `https://ueato.revizzicar.com.br/ativar-conta`
- Template "Invite user": `docs/deploy/email-template-convite.md`
- Template de recuperação de senha: `docs/deploy/email-template-reset-senha.md`
- SMTP próprio, MFA TOTP e proteção contra senhas vazadas ligados.
- O projeto é ÚNICO (dev = prod): remover `http://localhost...` das Redirect
  URLs só quando o desenvolvimento local não precisar mais delas.

## Cloudflare / CloudPanel

- DNS `ueato` proxied; SSL/TLS em Full (strict).
- **Vhost em uso:** `infra/cloudpanel/vhost.ueato-cloudpanel.conf` (modo
  "Allow traffic from Cloudflare only", sem `set_real_ip_from` das faixas da
  Cloudflare; ver ROTEIRO, seção 5). O texto abaixo descreve o modelo genérico.
- Vhost a partir de `infra/cloudpanel/vhost.conf.example`: preencher
  `<BACKEND_PORT>`, `<FRONTEND_PORT>` e as faixas `set_real_ip_from` baixadas de
  cloudflare.com/ips. `nginx -t` antes de recarregar.
- Importação usa location própria (`proxy_read_timeout 190s`, zona de rate
  limit `sispat_imports`). Cloudflare corta aos 100 s (524): ver M1 no roteiro.
- Cabeçalhos de segurança: o Nginx NÃO emite nenhum (Next.js no frontend, Flask
  na API; tabela no vhost). Não ligar HSTS na Cloudflare.
- Certificado de origem: Cloudflare Origin Certificate ou Let's Encrypt DNS-01
  (o HTTP-01 falha com o DNS proxied e é necessário para Full strict).
