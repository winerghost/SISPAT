# Variáveis de produção — ueato.revizzicar.com.br

Guia para montar o `.env` da VPS (`chmod 600`, fora do git). Só valores NÃO
secretos estão preenchidos; segredos aparecem como `<PREENCHER>`. Domínio
registrado em 2026-10-19. Nada aqui implanta coisa alguma.

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

`SECRET_KEY` (>= 32), `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_JWT_SECRET` (ou `SUPABASE_JWT_ALGORITHMS=ES256`; confirmar no painel),
`REDIS_PASSWORD`, `REDIS_URL` (host `redis`).

## Recomendados

`DB_STATEMENT_TIMEOUT_MS=120000`, `AI_ENABLED=false`,
`N8N_INTEGRATION_ENABLED=false`, `EMAIL_ENABLED` conforme SMTP.

## Supabase Auth (painel, fora do repo)

- Site URL: `https://ueato.revizzicar.com.br`
- Redirect URLs: `https://ueato.revizzicar.com.br/ativar-conta`
- Template "Invite user": `docs/deploy/email-template-convite.md`
- SMTP próprio, MFA TOTP e proteção contra senhas vazadas ligados.
- O projeto é ÚNICO (dev = prod): remover `http://localhost...` das Redirect
  URLs só quando o desenvolvimento local não precisar mais delas.

## Cloudflare / CloudPanel

- DNS `ueato` proxied; SSL/TLS em Full (strict).
- Vhost a partir de `infra/cloudpanel/vhost.conf.example`: preencher
  `<BACKEND_PORT>`, `<FRONTEND_PORT>` e as faixas `set_real_ip_from` baixadas de
  cloudflare.com/ips. `nginx -t` antes de recarregar.
- Importação usa location própria com `proxy_read_timeout 190s`.
