# Roteiro de implantação — ueato.revizzicar.com.br

Executado pelo responsável na VPS (Hostinger + CloudPanel + Cloudflare), uma
etapa por vez, conferindo a saída antes de seguir. Variáveis em
`ENV_PRODUCAO_ueato.md`. Checklist canônico: `docs/deployment/checklist-deploy-vps.md`.
Supabase é projeto ÚNICO (dev = prod). Nada aqui autoriza implantar sem
autorização explícita do responsável.

## Riscos a decidir antes de começar

**M1 — Cloudflare corta a prévia do Sheets aos 100 s (HTTP 524).** Com o DNS
proxied, o limite de leitura da Cloudflare (planos Free/Pro/Business) é 100 s.
Uma prévia entre 100 s e 180 s falha com 524 no navegador MESMO com nginx em
190 s e gunicorn em 180 s; o worker segue processando e uma repetição ocupa
outro dos 3 workers sync. Não há mudança de código nesta etapa. Opções (decisão
do responsável, registrar a escolhida):
1. Prévia assíncrona (Celery + polling): melhoria futura.
2. Rota de importação em subdomínio DNS-only (sem proxy), protegido por firewall.
3. Aceitar no início: ainda não há bens importados; monitorar o tempo da prévia
   e reavaliar se passar de ~90 s.
Decisão: ______________________  Data: __________

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
cd /opt/sispat && git pull --ff-only          # ou git clone na primeira vez
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

## 4. Subir
```
docker compose up -d                              # backend, frontend, redis
# se o worker for usado: docker compose --profile worker up -d --build worker
docker compose ps
curl -fsS http://127.0.0.1:8000/api/health
ss -ltnp | grep -E ':(80|443|8000|3000|6379)\b'   # 8000/3000 só em 127.0.0.1
```
Teste EXTERNO (de outra máquina, fora da VPS): `curl -m 5 http://<IP_VPS>:8000`
e `:3000` devem falhar (timeout/recusado); `curl -m 5 http://<IP_VPS>/` e
`https://<IP_VPS>/` direto (fora da Cloudflare) devem ser recusados pelo firewall.

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
