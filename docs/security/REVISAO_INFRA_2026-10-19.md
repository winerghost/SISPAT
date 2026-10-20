# Revisão de infraestrutura — deploy ueato.revizzicar.com.br (2026-10-19)

Escopo: revisão estática, somente leitura (sem pytest/Playwright/security-audit,
sem git). Arquivos: docker-compose.yml, backend/Dockerfile, frontend/Dockerfile,
infra/cloudpanel/vhost.conf.example, .env.example, frontend/next.config.ts,
frontend/src/middleware.ts, frontend/src/lib/csp.ts, backend/app/__init__.py,
docs/deploy/ENV_PRODUCAO_ueato.md e ROTEIRO_VPS_ueato.md.
Nada foi executado contra servidor ou banco. Este relatório não atesta ausência
de vulnerabilidades; só registra o que foi lido.

Pontos conferidos e OK: portas 8000/3000 publicadas só em `127.0.0.1`
(compose:106, :246), Redis sem porta e em rede `internal`; hardening
(read_only, cap_drop ALL, no-new-privileges, limites); imagens por digest;
nenhum segredo em ARG/ENV/camadas (frontend só `NEXT_PUBLIC_*`, sem `env_file`);
secret do Sheets montado só em backend/worker; usuário 10001 não-root;
nginx 190 s > gunicorn 180 s > statement timeout 120 s; CORS/convite https-only
em produção; CSP com nonce sem `unsafe-inline` em script; `/ativar-conta` com
`no-referrer` por rota; ProxyFix confia no último hop sem checar peer (a
limitação está documentada em app/__init__.py:141 e mitigada por loopback).

## Média

**M1 — Cloudflare corta a importação aos 100 s (HTTP 524).**
vhost.conf.example:127-141 e gunicorn `--timeout 180` (Dockerfile:94). Com o DNS
proxied (ENV_PRODUCAO:48), o proxy da Cloudflare tem limite de leitura de 100 s
nos planos Free/Pro/Business; o 190 s do Nginx nunca é atingido. Cenário: prévia
do Sheets entre 100 e 180 s -> o navegador recebe 524 enquanto o worker continua;
o ADM repete a operação e ocupa outro worker (só há 3, sync). Correção: tornar a
prévia assíncrona (Celery, que já existe) com polling, ou manter a rota < 90 s;
ou, só para esse caminho, subdomínio sem proxy (DNS-only) com WAF/firewall;
documentar o limite no roteiro.

**M2 — Cabeçalhos duplicados e conflitantes (Referrer-Policy, HSTS, outros).**
- Frontend: o server do vhost (vhost:90-95) adiciona HSTS, nosniff, XFO,
  Referrer-Policy, Permissions-Policy e COOP; `location /` (vhost:197) não
  declara `add_header`, então os herda, e o Next (next.config.ts:19-35) emite os
  mesmos. Em `/ativar-conta` resultam DOIS Referrer-Policy:
  `strict-origin-when-cross-origin` (Nginx) e `no-referrer` (Next). O navegador
  usa o último valor reconhecido; a ordem depende do proxy, então a proteção do
  `token_hash` na URL fica à mercê da ordem. O ajuste por rota em next.config.ts:50
  é anulado.
- API: Flask (app/__init__.py:26-34, :65) já envia nosniff, XFO,
  Referrer-Policy `no-referrer`, CSP, COOP, Permissions-Policy e HSTS
  (31536000); o Nginx (vhost:185-191) soma Referrer-Policy
  `strict-origin-when-cross-origin`, HSTS 63072000 e CSP duplicados. Mesmo
  problema, valores divergentes.
Correção: um único emissor por cabeçalho. Opção mais simples: em `location /` e
`location /api/` adicionar `proxy_hide_header` para
Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options,
Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy,
Content-Security-Policy (a CSP do Next não pode ser sobrescrita no Nginx), e
deixar o Nginx como dono só do HSTS. Remover Referrer-Policy do Nginx na
`location /`. Teste de aceitação: `curl -sI https://.../ativar-conta` com
exatamente um Referrer-Policy (`no-referrer`) e um HSTS.

**M3 — `alembic stamp` na base única (dev = prod).**
ROTEIRO:31-37. O stamp marca o head 0010 sem executar 0007-0010 (o próprio
roteiro espera `0006` antes). Se alguma coluna, índice, trigger ou política
dessas migrações faltar no Supabase, o Alembic passa a mentir e futuras
migrações falham ou o app roda sem as proteções de 0004/0009. Adicionalmente,
`alembic_version` da base compartilhada muda para o ambiente local. Correção:
antes do stamp, comparar o esquema real com 0007-0010 (diff de
`information_schema`/`pg_indexes`/RLS), registrar o resultado e fazer backup
(PITR/dump) do Supabase. Conferir também se há migrações além de 0010 já
aplicadas (a memória do projeto cita 0012/0013, mas o repositório só tem até
0010).

**M4 — Roteiro: `.env` copiado do exemplo tem placeholders que quebram o deploy.**
ROTEIRO:17 + .env.example:92,118,121. `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH=<caminho...>`
faz `docker compose config`/`up` falhar (arquivo inexistente); `REDIS_URL` contém
`<REDIS_PASSWORD>` literal (backend sobe e o Redis rejeita auth);
`GOOGLE_SHEETS_SPREADSHEET_ID` placeholder. ENV_PRODUCAO não lista
`GOOGLE_SHEETS_CREDENTIALS_HOST_PATH`, `GOOGLE_SHEETS_SPREADSHEET_ID`, abas nem
`DB_SSLMODE`. Correção: acrescentar ao ENV_PRODUCAO e ao roteiro uma verificação
de placeholders (`grep -n '<' .env` deve ser vazio) e recomendar
`DB_SSLMODE=verify-full` + `DB_SSLROOTCERT` (secret montado) em vez de deixar o
TLS do Postgres no padrão.

## Baixa

**B1 — `include /etc/nginx/snippets/sispat-api-proxy.conf` (vhost:108,118).**
O arquivo não existe por padrão; `nginx -t` falha, e o editor do CloudPanel pode
não aceitar o include. Se criado conforme o rodapé (vhost:221-236), as rotas
sensíveis e de avatar perdem Referrer-Policy/Permissions-Policy (add_header no
location substitui os do server) e usam `proxy_read_timeout 60s` (aceitável).
Correção: duplicar o bloco literal, como o próprio comentário sugere, e testar
`nginx -t`.

**B2 — Rate limit da importação (vhost:129).** `sispat_sensitive` = 10 req/min,
burst 5, para GET e POST. Fluxo de prévia com polling/paginação de prévia pode
tomar 429. Não há rate limit na aplicação (não encontrei limiter em
`backend/app`), então o Nginx é a única barreira; ele também é contornado se a
origem for acessada direto. Correção: zona própria para `imports` (por exemplo
30r/m, burst 10) e firewall liberando 80/443 só às faixas da Cloudflare.

**B3 — `token_hash` em query string (ativar-conta/page.tsx:21-29).** Fica no
access log do Nginx/CloudPanel e nos logs da Cloudflare. É de uso único e só
consumido após clique, então o risco é baixo. Correção: `log_format` que omita
`$args` em `/ativar-conta`, ou `access_log off` nessa location; retenção curta.

**B4 — Worker sync único para tarefa de até 180 s.** Dockerfile:94 (3 workers
sync). Um ADM (ou 3 requisições simultâneas de importação) esgota o pool e o
healthcheck (timeout 5 s) marca `unhealthy`; `restart: unless-stopped` não
reinicia por unhealthy. Correção: concorrência de 1 importação (lock Redis) ou
fila Celery (ver M1); considerar `--threads`/worker `gthread`.

**B5 — Frontend e backend na mesma `edge-net` (compose:233, :90).** Um frontend
comprometido alcança o backend sem passar pelo Nginx e pode forjar
X-Forwarded-For (ProxyFix confia sem checar peer). Correção: rede dedicada
frontend<->nada, ou aceitar o risco (frontend não faz chamadas servidor a
servidor hoje). Só se o SSR passar a chamar a API.

**B6 — `env_file: .env` expõe todos os segredos via `docker inspect`
(compose:79,132).** Quem estiver no grupo `docker` na VPS lê service role,
SECRET_KEY, etc. Correção: restringir o grupo `docker`, `chmod 600 .env`
(já no roteiro) e, quando viável, migrar segredos críticos para Docker secrets.

## Informativa / gaps do roteiro

- Permissões do secret do Sheets (ROTEIRO:18-21): `secrets/` 700 + arquivo 0400 +
  `chown 10001` está correto para o bind mount de secret do Compose (a posse do
  host é preservada) e o container lê como uid 10001. Falta: `chown` do diretório
  não é necessário (Compose lê como root), mas confirme com
  `docker compose run --rm --no-deps backend ls -ln /run/secrets/` e com um teste
  de leitura. `secrets/` está no .gitignore (:109). A alternativa fora do repo
  (`/etc/sispat-agu/`, .env.example:116) é preferível a `/opt/sispat/secrets`.
- Faltam no roteiro: (a) `set_real_ip_from` já é pré-requisito, mas também o
  firewall (ufw/Hostinger) restringindo 80/443 às faixas da Cloudflare e
  fechando 8000/3000 externamente (verificar com `ss` já existe, falta teste
  externo); (b) emissão do certificado Let's Encrypt com DNS proxied (usar
  DNS-01 ou Origin Certificate, necessário para Full strict); (c) comando do
  worker (`--profile worker`) ou decisão explícita de não subir; (d) redirecionar
  HTTP->HTTPS e "Always Use HTTPS" na Cloudflare; (e) verificação de que
  `NEXT_PUBLIC_*` foram embutidas no bundle (`docker compose build --no-cache
  frontend` e inspeção do bundle); (f) `docker compose logs` já está no item 6,
  incluir busca por `token_hash`, `Bearer`, `eyJ`; (g) clone em repositório
  privado exige deploy key somente leitura; (h) passo de rollback do Nginx
  (cópia do vhost anterior).
- ProxyFix: `TRUSTED_PROXY_IPS=127.0.0.1` é documentação, não filtro
  (app/__init__.py:161-171); o peer real visto pelo container é o gateway da
  bridge, não 127.0.0.1. Não gera falha hoje, mas o valor não tem efeito.
- CSP do Next (csp.ts): `style-src 'unsafe-inline'` justificado no código;
  `connect-src` inclui a origem da API e do Supabase; sem `upgrade-insecure-requests`
  (recomendado em produção, pois HSTS cobre só depois da primeira visita).
- Redis: ACL gerada em tmpfs, comandos admin bloqueados, mas `+@all` mantém
  `CONFIG`/`DEBUG`? `-@admin` cobre CONFIG; confirmar `DEBUG` (está em `@dangerous`)
  com `ACL GETUSER default` antes de produção. Baixo.

## Risco de Supabase único (dev = prod)

Alto em conjunto, classificado como risco de processo (não de código):
1. Qualquer `.env` local com `DATABASE_URL`/service role aponta para produção:
   testes de integração, `alembic downgrade`, seeds e scripts de dev operam em
   dados reais. Correção: projeto/branch Supabase separado para dev, ou no
   mínimo role de banco distinto e somente-leitura no dev, e `.env` de dev sem
   service role.
2. Redirect URLs `http://localhost...` mantidas no Supabase Auth (ENV_PRODUCAO:43)
   permitem que convites/recuperação sejam entregues a localhost; e e-mails de
   convite reais podem ser disparados a partir do ambiente local. Remover
   assim que possível; o backend em produção já só aceita https.
3. Mesma base significa mesmo `auth.users`: contas de teste (já desativadas) e o
   MFA do ADM são compartilhados; JWT emitido em dev vale em prod (mesmo `aud` e
   issuer). Correção: mesmos controles acima, e rotação de chaves se o
   `.env` de dev vazar.
4. Antes do M3 (stamp) e de qualquer migração: backup/PITR confirmado e janela
   combinada.
5. Dados de `import_previews` (PII) permanecem na base: o roteiro já prevê
   expurgo (item 7); deixar com prazo.

## Parecer

Sem bloqueio crítico/alto no código de infra lido. Corrigir antes do deploy:
M1 (decisão de arquitetura da importação), M2 (cabeçalhos duplicados,
especialmente Referrer-Policy em `/ativar-conta`), M3 e M4. Os demais podem
seguir como pendências rastreadas. Não verifiquei o estado real da VPS,
do Supabase nem executei os testes.
