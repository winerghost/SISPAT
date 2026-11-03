# Roteiro de implantação — ueato.revizzicar.com.br

Executado pelo responsável na VPS (Hostinger + CloudPanel + Cloudflare), uma
etapa por vez, conferindo a saída antes de seguir. Variáveis em
`ENV_PRODUCAO_ueato.md`. Checklist canônico: `docs/deployment/checklist-deploy-vps.md`.
Supabase é projeto ÚNICO (dev = prod). Nada aqui autoriza implantar sem
autorização explícita do responsável.

## Estado em 2026-10-29

- Aplicação no ar desde 2026-10-20, em `/opt/SISPAT`, com backend em
  `127.0.0.1:8110` e frontend em `127.0.0.1:3110`; Redis só na rede interna. O
  Compose não publica 80/443 — o Nginx do CloudPanel faz TLS e encaminha.
- Vhost em uso: `infra/cloudpanel/vhost.ueato-cloudpanel.conf` (ver seção 5).
- Rodadas implantadas depois da inicial: 2026-10-21 (Auditoria, Vínculos de
  Unidades e Relatórios) e 2026-10-29 (convite à prova de scanner,
  exclusão/anonimização de usuário, filtros de `/relatorios`, correções do
  `/ativar-conta` e logomarca sazonal do cabeçalho público — commits `be2a16c`
  e `6823803`).
- Banco: `alembic_version` = `0019_user_soft_delete`, igual ao head do código.
  As seções 0 a 5 abaixo descrevem a primeira subida; para as próximas
  rodadas, o ciclo é o da seção 8.
- **Aguardando validação do responsável** (não há evidência de validação
  funcional da rodada de 2026-10-29 em produção): login real de ADM com MFA,
  convite real com entrega por e-mail, exclusão de um usuário de teste e os
  filtros novos de `/relatorios`.

## Riscos a decidir antes de começar

**M1 — Cloudflare corta a prévia do Sheets aos 100 s (HTTP 524).** Com o DNS
proxied, o limite de leitura da Cloudflare (planos Free/Pro/Business) é 100 s.
Uma prévia entre 100 s e 180 s falha com 524 no navegador MESMO com nginx em
190 s e gunicorn em 180 s; o worker segue processando e uma repetição ocupa
outro dos 3 workers sync. Não há mudança de código nesta etapa. Opções (decisão
do responsável, registrar a escolhida):
1. Prévia assíncrona (Celery + polling): melhoria futura.
2. Rota de importação em subdomínio DNS-only (sem proxy), protegido por firewall.
3. Aceitar e monitorar o tempo da prévia, reavaliando se passar de ~90 s.
Decisão: na prática valeu a opção 3.  Data: registrado em 2026-11-01.
A importação dos 1.069 Bens rodou entre 2026-10-22 e 2026-10-29, com 24 prévias
confirmadas e nenhum 524. A opção 1 (prévia assíncrona) segue como melhoria
futura, para acervos maiores.

**Worker Celery.** Decidir e registrar: subir (`docker compose --profile worker
up -d --build worker`) ou não subir (hoje só há tarefa de IA, desligada).
Decisão: ______________________

## 0. Antes de tocar na VPS
- [ ] Pré-requisitos: pytest e Playwright verdes, working tree commitado.
- [ ] Antes do push: `gitleaks git` (histórico) limpo e `bash scripts/security-audit.sh --strict`.
- [ ] Contas de teste RH/USER desativadas (feito em 2026-10-19).
- [ ] Supabase Auth: Site URL, Redirect URLs (`/ativar-conta`), template de
      convite, SMTP próprio, proteção contra senhas vazadas, MFA do ADM ok.
      Remover as Redirect URLs `http://localhost...` assim que o dev local não
      precisar mais delas (projeto único: convites poderiam ir a localhost).
- [ ] Cloudflare: DNS `ueato` proxied, SSL/TLS Full (strict), "Always Use HTTPS"
      ligado, HSTS da Cloudflare DESLIGADO (o origin já emite).
- [ ] Certificado de origem válido para Full strict: Cloudflare Origin
      Certificate (instalado no CloudPanel) ou Let's Encrypt via DNS-01. O
      HTTP-01 não funciona com o DNS proxied.
- [ ] Firewall (ufw/Hostinger): 22 restrito por IP; 80/443 SOMENTE para as faixas
      da Cloudflare (cloudflare.com/ips); 8000/3000/6379 fechadas por fora.

## 1. Código e configuração
Repositório privado: use deploy key SOMENTE LEITURA (sem "allow write").
```
cd /opt/SISPAT && git pull --ff-only          # ou git clone na primeira vez
cp .env.example .env && chmod 600 .env        # preencher conforme ENV_PRODUCAO
sudo mkdir -p /etc/sispat-agu && sudo chmod 700 /etc/sispat-agu
# colocar o JSON do Google Sheets em /etc/sispat-agu/ (fora do repositório)
sudo chmod 0400 /etc/sispat-agu/google_sheets_credentials.json
sudo chown 10001 /etc/sispat-agu/google_sheets_credentials.json
# .env: GOOGLE_SHEETS_CREDENTIALS_HOST_PATH=/etc/sispat-agu/google_sheets_credentials.json
```
(Alternativa: `./secrets/` com 700; o `.env.example` aponta o padrão.)
Conferências sem exibir valores:
```
grep -c '^NEXT_PUBLIC_' .env                  # deve dar 3
grep -nE '^[^#]*<' .env                              # deve voltar VAZIA (sem placeholders)
grep -c '^REDIS_URL=redis://:' .env           # deve dar 1
```

## 2. Validar e construir
```
docker compose config --quiet && echo CONFIG_OK
docker compose build --no-cache backend frontend
```
- [ ] Bundle: confirmar que as `NEXT_PUBLIC_*` entraram, p. ex.
      `docker run --rm --entrypoint sh sispat-agu/frontend:latest -c "grep -rl 'ueato.revizzicar.com.br' /app/.next | head -3"`
      (ajuste o caminho ao Dockerfile) e que NENHUM segredo (service role, JWT
      secret) aparece no bundle.
- [ ] `trivy image` em backend e frontend (após o build); registrar achados
      HIGH/CRITICAL e decidir antes de subir.

## 3. Carimbo Alembic (sem DDL) — SOMENTE com pré-condições

> **Estado em 2026-10-29: não há carimbo nem migração pendente.**
> `alembic_version` = `0019_user_soft_delete`, que é o head do código
> (`backend/migrations/versions/0019_user_soft_delete.py`). A cadeia é linear
> 0001 → 0019 e os espelhos vão de `sql/0001` a `sql/0022` (a numeração dos
> `.sql` difere da do Alembic: compare por conteúdo, nunca por número). O
> histórico abaixo é da primeira subida (carimbo em
> `0011_dashboard_charts_prefs`, 2026-10-20) e fica como referência de
> procedimento.

O stamp marca o head sem executar migrações; se faltar algo no banco, o Alembic
passa a "mentir". A base Supabase é única (dev = prod). Exigir, nesta ordem:
- [ ] Backup/PITR do Supabase CONFIRMADO no painel (Database > Backups: ponto de
      restauração recente e PITR ativo, ou dump feito). Registrar data/hora.
- [ ] Conferência do esquema real contra `docs/deploy/PRONTIDAO_2026-10-19.md`,
      que registra que o conteúdo das migrações 0007-0010 JÁ EXISTE no banco
      (tabela `unit_aliases` e índices, `ai_settings`, `user_preferences`,
      colunas em `users`, permissões, RLS sem privilégios a anon/authenticated).
      ATENÇÃO: a numeração dos `.sql` (0007..0013) difere da do Alembic
      (0005..0010); compare por conteúdo, não por número. Registrar o resultado.
- [ ] Autorização explícita e janela combinada para o stamp.
```
docker compose run --rm --no-deps backend alembic current
docker compose run --rm --no-deps backend alembic stamp 0011_dashboard_charts_prefs
docker compose run --rm --no-deps backend alembic current
```
Esperado: `0006...` antes e `0011_dashboard_charts_prefs (head)` depois.
Nenhum `alembic upgrade`. Se o esquema divergir, PARE e não carimbe.

### Migrações posteriores (padrão do projeto, usado até a 0019)
Desde a 0012 o padrão é: o responsável executa o espelho `.sql` da migração no
SQL Editor do Supabase e depois carimba o `alembic_version` (nunca
`alembic upgrade` sobre um banco que já tem os objetos). Para cada migração,
antes de qualquer DDL:
```
pg_dump "$DATABASE_URL" --schema=public -Fc \
  -f backup-pre-<migracao>-$(date +%F-%H%M).dump      # ou PITR confirmado no painel
docker compose run --rm --no-deps backend alembic current
docker compose run --rm --no-deps backend alembic stamp <id_da_migracao>
docker compose run --rm --no-deps backend alembic current
```
Reversão, somente com autorização explícita (o `downgrade` apaga colunas e
dados): `docker compose run --rm --no-deps backend alembic downgrade <id_anterior>`
— para a 0019, `alembic downgrade 0018_equipment_classification`; o próprio
arquivo da migração traz o `DOWNGRADE_SQL` equivalente para o SQL Editor.
Ordem obrigatória: DDL ANTES de subir a imagem nova do backend (a 0019 adiciona
colunas que a consulta de autenticação já seleciona).
Em 2026-10-27 a `0018_equipment_classification` e em 2026-10-28 a
`0019_user_soft_delete` foram aplicadas por esse caminho e carimbadas; o
registro por migração fica em `docs/database/historico-migracoes.md`.

## 4. Subir
```
docker compose up -d                              # backend, frontend, redis
# se o worker for usado: docker compose --profile worker up -d --build worker
docker compose ps
curl -fsS http://127.0.0.1:${BACKEND_PORT:-8000}/api/health     # em produção, 8110
ss -ltnp | grep -E ':(80|443|8110|3110|6379)\b'   # 8110/3110 só em 127.0.0.1
```
Teste EXTERNO (de outra máquina, fora da VPS): `curl -m 5 http://<IP_VPS>:8110`
e `:3110` devem falhar (timeout/recusado); `curl -m 5 http://<IP_VPS>/` e
`https://<IP_VPS>/` direto (fora da Cloudflare) devem ser recusados pelo firewall.
(Com os padrões do `.env.example` as portas seriam 8000/3000; em produção são
`BACKEND_PORT=8110` e `FRONTEND_PORT=3110`.)

## 5. CloudPanel / Nginx
Antes de editar, faça BACKUP do vhost atual (rollback):
```
sudo cp /etc/nginx/sites-enabled/ueato.revizzicar.com.br.conf \
        /root/vhost-ueato.$(date +%F-%H%M).bak
```
(ou copie o conteúdo do editor do CloudPanel para um arquivo seguro).
Vhost a partir de `infra/cloudpanel/vhost.conf.example`: portas reais,
faixas `set_real_ip_from` baixadas na hora de cloudflare.com/ips, blocos de
proxy literais (sem `include`), zona `sispat_imports`. O Nginx NÃO emite
cabeçalhos de segurança (Next/Flask emitem; tabela no vhost).
BLOQUEANTE antes de recarregar: `grep -c '^[[:space:]]*set_real_ip_from' <vhost>`
deve dar > 0 (faixas IPv4 e IPv6 da Cloudflare). O `nginx -t` passa sem elas,
mas aí o rate limit vira um balde único (429 geral em convite/MFA) e a auditoria
grava o IP da Cloudflare.
```
sudo nginx -t && sudo systemctl reload nginx
```
Atenção: o CloudPanel pode regenerar o vhost; mantenha o conteúdo final salvo
fora do painel e reconfira após alterações no site.

### Como ficou na implantação de 2026-10-20 (vhost em uso)
Vhost aplicado: `infra/cloudpanel/vhost.ueato-cloudpanel.conf` (portas 8110/3110).
Diferenças em relação ao modelo, por causa do CloudPanel da Hostinger:
- O site usa **"Allow traffic from Cloudflare only"** (`include
  /etc/nginx/cloudflare/ips`, lista de `allow` terminando em `deny all`). Por
  isso o vhost NÃO usa `set_real_ip_from` das faixas da Cloudflare: com o
  `real_ip`, o `deny all` passaria a ver o IP do usuário e bloquearia todos. O
  IP real vem de `$http_cf_connecting_ip` (confiável, pois só a Cloudflare
  conecta) em `X-Forwarded-For`, `X-Real-IP` e nas zonas de rate limit. O
  bloqueante do `grep -c set_real_ip_from` acima não se aplica neste modo.
- O `nginx.conf` do CloudPanel tem `set_real_ip_from 0.0.0.0/0` (cabeçalho
  `X-Real-IP` aceito de qualquer origem, o que permite burlar o "Cloudflare
  only"). O vhost anula isso no site com `set_real_ip_from 127.0.0.1;`. Os
  outros sites da VPS continuam expostos (pendência do responsável).
- O modelo de proxy reverso do CloudPanel inclui `/etc/nginx/global_settings`
  (`Referrer-Policy same-origin`, `X-Frame-Options SAMEORIGIN`...) e
  `add_header Cache-Control no-transform`. Os dois foram REMOVIDOS do vhost
  (duplicavam os cabeçalhos do Next/Flask). Não editar o `global_settings`:
  ele é usado pelos outros sites.
- Regex com `{36}` precisa de aspas no `location` (sem elas, `nginx -t` falha).
- Copiar o vhost do terminal quebra espaços ("invalid number of arguments");
  copiar de um arquivo aberto no Bloco de Notas.
- Verificado de fora em 2026-10-20: `/api/health` -> `{"status":"ok"}`; em
  `/ativar-conta` e `/api/health`, cada cabeçalho de segurança aparece uma vez
  (`no-referrer` em `/ativar-conta`).
Rollback do vhost: restaurar o `.bak`, `sudo nginx -t && sudo systemctl reload nginx`.

## 6. Verificação pós-subida
- [ ] `https://ueato.revizzicar.com.br` abre; `/api/health` responde.
- [ ] Rota protegida sem token devolve 401.
- [ ] Cabeçalhos únicos (critério de aceitação M2), cada contagem = 1:
      `curl -sI https://ueato.revizzicar.com.br/ativar-conta | grep -ic '^referrer-policy'`
      e o valor é `no-referrer`; `... | grep -ic '^strict-transport-security'`
      idem; o mesmo para `/api/health`. CSP com nonce em `/login`.
- [ ] Login do ADM com MFA; Perfis e Permissões abre.
- [ ] Convite de teste: link só é consumido após o clique em Continuar.
- [ ] Logs sem segredos nem tokens:
      `docker compose logs --since 30m backend frontend redis | grep -iE 'token_hash|Bearer|eyJ|service_role|secret|password'`
      deve voltar vazia. Conferir também o access log do Nginx/CloudPanel por
      `token_hash` na query de `/ativar-conta` (ver B3: retenção curta).
- [ ] Prévia do Sheets: medir o tempo; se passar de ~90 s, ver risco M1.

## 7. Depois
Importação real a partir do Sheets; depois expurgar `import_previews` (PII) com
prazo definido e decidir a retenção da chave do Sheets (apagar a chave e reativar
`iam.disableServiceAccountKeyCreation`). Reversão: `docker compose down`
mantém os dados (o banco é o Supabase); imagens anteriores por tag; vhost pelo
`.bak` da seção 5; sem `alembic downgrade` sem autorização.

## 8. Ciclo das rodadas seguintes (atualização de versão)

Sempre com autorização explícita do responsável, e com o `.env` já conferido
(seção 1). Mudança só de backend, só de frontend ou das duas pontas:

```
cd /opt/SISPAT && git pull --ff-only
docker compose build backend frontend          # ou só o serviço que mudou
docker compose up -d backend frontend
docker compose ps                              # backend, frontend, redis healthy
curl -fsS http://127.0.0.1:8110/api/health
```

- Qualquer mudança em `NEXT_PUBLIC_*` ou em asset importado pelo código do
  frontend (ex.: a logomarca em `frontend/src/components/brand/agu-logo.tsx`)
  exige rebuild do **frontend**: essas coisas entram no bundle no build.
- Se recriar só o backend, rode `docker compose up -d` em seguida: o frontend
  tem `depends_on: backend` e cai quando o backend é recriado.
- Prova de que o código novo entrou na imagem: no build, a linha `COPY app ./app`
  **sem** `CACHED`. Em 2026-10-29 isso foi conferido assim, além da verificação
  dos módulos novos dentro das imagens.
- Se houver migração na rodada, aplique o DDL ANTES do `up -d` do backend
  (seção 3) e registre backup, carimbo e comando de reversão.

### Rodada de 2026-10-29 — validação pendente
Implantada (commits `be2a16c` e `6823803`): convite à prova de scanner,
exclusão/anonimização de usuário (migração `0019_user_soft_delete`, já aplicada
e carimbada), filtros de `/relatorios`, correções do `/ativar-conta` e logomarca
sazonal do cabeçalho público. Containers `healthy` na subida. Ainda **sem
validação funcional confirmada pelo responsável**; itens a executar:
- [ ] Login real do ADM com MFA (exercita a checagem de `deleted_at`).
- [ ] Convite real para um e-mail de teste: o link deve chegar como
      `/ativar-conta?token_hash=...&type=invite` e nenhum `verify` deve aparecer
      nos logs antes do clique.
- [x] Segundo ADM: já existem 2 ADMs ativos (consulta read-only em 2026-10-30).
- [ ] Exclusão de um usuário de teste (confirmação por e-mail digitado + TOTP) e
      conferência de que o `audit_logs` dele permanece.
- [ ] Os três selects novos em `/relatorios` e uma exportação CSV/XLSX.
- [ ] Logs sem segredos:
      `docker compose logs --since 30m backend frontend | grep -iE 'token_hash|Bearer|eyJ|service_role|secret|password'`
      deve voltar vazia.
