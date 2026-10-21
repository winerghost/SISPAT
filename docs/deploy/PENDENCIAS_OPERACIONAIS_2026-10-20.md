# Pendências operacionais pós-implantação (2026-10-20)

Aplicação no ar em `https://ueato.revizzicar.com.br` desde 2026-10-20.
VPS Hostinger, projeto em `/opt/SISPAT`, CloudPanel ("Allow traffic from
Cloudflare only"), Cloudflare proxied. Backend `127.0.0.1:8110`, frontend
`127.0.0.1:3110`, Redis interno. Vhost: `infra/cloudpanel/vhost.ueato-cloudpanel.conf`.
Roteiro: `docs/deploy/ROTEIRO_VPS_ueato.md`. Checklist: `docs/deployment/checklist-deploy-vps.md`.

Regras para todos os itens:

- O responsável executa cada passo. Nada aqui autoriza mudança em produção
  sem a decisão dele.
- Os comandos de VPS partem de `cd /opt/SISPAT`.
- Nunca cole senhas, tokens ou chaves em chats, tickets ou neste repositório.

| # | Pendência | Onde | Prioridade |
|---|---|---|---|
| 1 | Supabase Auth (template, SMTP, senhas vazadas, URLs) | Painel do Supabase | Alta (antes do 1º convite real) |
| 2 | gitleaks e trivy | VPS | Alta |
| 3 | Limite de 100 s da Cloudflare (524) na importação | VPS / decisão | Alta (antes de importar os bens) |
| 4 | Worker Celery | VPS / decisão | Baixa (não é necessário hoje) |
| 5 | `set_real_ip_from 0.0.0.0/0` no nginx global | VPS | Média (afeta os OUTROS sites) |
| 6 | Expurgo de `import_previews` | VPS (após a importação real) | Média (LGPD) |

---

## 1. Supabase Auth (painel, feito pelo responsável)

### O que é

Cinco ajustes no painel do projeto Supabase (`tocbtonqnahmtegfkrmn`). O
repositório não altera o painel. O projeto é ÚNICO (dev = prod): tudo o que
mudar aqui vale para o ambiente local também.

### Risco se não fizer

- Template padrão: o link `{{ .ConfirmationURL }}` é gasto pelo antivírus do
  e-mail antes do clique. O convidado vê `otp_expired`.
- SMTP embutido: limite muito baixo de envios por hora (`429 email rate limit
  exceeded`). Convites e recuperação de senha param de chegar.
- Sem proteção de senhas vazadas: aceita senhas que já circulam em vazamentos.
- Redirect URLs com `localhost`: um convite pode ser emitido para
  `http://localhost...` e o link não funciona (ou aponta para a máquina de
  quem abrir).

### Como o link de convite é montado (código atual)

1. O backend (`backend/app/services/invite_service.py`) chama a API Admin do
   Supabase com `redirect_to` = 1º item de `INVITE_ALLOWED_REDIRECT_URLS`.
   Ele recusa o convite se esse item não for `https://` (em produção) ou se o
   caminho não for `/ativar-conta`.
2. No `.env` da VPS: `INVITE_ALLOWED_REDIRECT_URLS=https://ueato.revizzicar.com.br/ativar-conta`.
3. O Supabase coloca esse valor em `{{ .RedirectTo }}` no template.
4. A página `/ativar-conta` (`frontend/src/app/(publico)/ativar-conta/page.tsx`)
   lê `?token_hash=...&type=invite`, limpa a URL e só chama
   `verifyOtp({ token_hash, type: "invite" })` depois do clique em
   "Continuar". Ela aceita `type=invite` (convite) e, desde 2026-10-21,
   `type=recovery` (redefinição de senha, ver 1.2b); qualquer outro `type` é
   recusado.

Por isso o link do template deve ser exatamente:

```
{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite
```

Não use `{{ .ConfirmationURL }}` no template "Invite user".

### Passo a passo

**1.1 Site URL e Redirect URLs** — Authentication › URL Configuration.

1. Site URL: `https://ueato.revizzicar.com.br` (sem barra no final).
2. Redirect URLs: deixe SOMENTE `https://ueato.revizzicar.com.br/ativar-conta`.
   Sem curinga (`*`/`**`).
3. Remova todas as entradas `http://localhost...` e `http://127.0.0.1...`.
4. Salve.

Efeito colateral: convites disparados por um backend local deixam de
funcionar. Isso é desejado (projeto único). Se um dia precisar testar
convite localmente, adicione a URL local por pouco tempo e remova depois.

**1.2 Template "Invite user"** — Authentication › Emails › Templates › Invite user.

1. Assunto: `Convite de acesso ao SISPAT-AGU`.
2. Corpo: copie o HTML de `docs/deploy/email-template-convite.md`
   (seção "HTML do template"). Ele já usa o link acima.
3. Se no e-mail de teste o link vier sem domínio (`{{ .RedirectTo }}` vazio),
   troque `{{ .RedirectTo }}` por `{{ .SiteURL }}/ativar-conta` nas duas
   ocorrências.
4. Salve.

**1.2b Template "Reset Password"** — Authentication › Emails › Templates ›
Reset Password. **Só depois do rebuild do frontend com a correção de
2026-10-21** (a página `/ativar-conta` passou a aceitar `type=recovery`).

1. Assunto: `Redefinição de senha do SISPAT-AGU`.
2. No corpo, troque o link `{{ .ConfirmationURL }}` por exatamente:

   ```
   {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
   ```

   (mesmo motivo do convite: o antivírus do e-mail não consegue gastar o
   link; o token só é usado quando a pessoa clica em "Continuar").
3. Confirme no `.env` da VPS que `PASSWORD_RESET_REDIRECT_URL` é
   `https://ueato.revizzicar.com.br/ativar-conta` (a mesma URL única das
   Redirect URLs). Se no e-mail de teste o link vier sem domínio, use
   `{{ .SiteURL }}/ativar-conta?token_hash={{ .TokenHash }}&type=recovery`.
4. Salve.

Enquanto o frontend antigo estiver no ar, mantenha `{{ .ConfirmationURL }}`
(a página antiga recusaria `type=recovery`). O link legado também funciona
na página nova, mas continua sujeito ao antivírus.

**1.3 SMTP próprio** — Authentication › Emails › SMTP Settings
(em versões antigas: Project Settings › Authentication › SMTP Settings).

1. Ligue "Enable custom SMTP".
2. Preencha (valores do seu provedor; não registre aqui):
   - Sender email (ex.: um endereço `no-reply@` do seu domínio)
   - Sender name: `SISPAT-AGU`
   - Host
   - Port: `587` (STARTTLS) ou `465` (TLS)
   - Username
   - Password
   - Minimum interval between emails (mantenha o padrão)
3. Salve.
4. No DNS do domínio remetente: SPF, DKIM e DMARC conforme o provedor.
5. Authentication › Rate Limits: confira o limite de envio de e-mails por
   hora (suba só o necessário).

**1.4 Proteção de senhas vazadas** — Authentication › Attack Protection
(em versões antigas: Authentication › Providers › Email › "Prevent use of
leaked passwords").

1. Ligue "Leaked password protection" (checa senhas no HaveIBeenPwned).
2. Na mesma área, defina tamanho mínimo de senha (sugestão: 12) e exija
   letras e números.
3. Salve. Atenção: este recurso exige plano pago (Pro ou superior). Se a
   opção estiver bloqueada, registre a decisão.

**1.5 Conferência final** — Authentication › URL Configuration de novo.
Confirme a Site URL e a única Redirect URL.

### Como verificar

1. Na tela de Usuários, convide um e-mail de teste que você controla.
2. No e-mail, passe o mouse no botão. O link deve ser
   `https://ueato.revizzicar.com.br/ativar-conta?token_hash=...&type=invite`.
3. Remetente = o do SMTP próprio (não `noreply@mail.app.supabase.io`).
4. Em Authentication › Logs: NÃO deve haver `verify` antes do seu clique.
5. Clique em "Continuar", defina a senha. Deve concluir a ativação.
6. Abra o mesmo link de novo: deve mostrar erro amigável (já usado).
7. Teste de senha vazada: na ativação de um convite de teste, tente uma
   senha conhecida (ex.: `password123456`). Deve ser recusada.
8. Desative o usuário de teste depois.

### Observação (para o time de desenvolvimento)

**Corrigido em 2026-10-21 (frontend; precisa de rebuild do frontend).** A
recuperação de senha (`PASSWORD_RESET_REDIRECT_URL`) aponta para
`/ativar-conta`, que agora diferencia o `type` do link: com `type=recovery`
(ou o legado `#...&type=recovery`) ela valida com
`verifyOtp({ type: "recovery" })`, troca a senha e **não** chama
`POST /api/v1/users/activate-invite` (antes dava 404 para usuário já ativo);
encerra a sessão local, mostra "Senha redefinida" e leva ao login. Convite
(`type=invite`) segue igual. Testes: `frontend/e2e/activate-invite-functional.spec.ts`.

Rebuild na VPS: `cd /opt/SISPAT && docker compose build frontend && docker compose up -d frontend`
(ajuste ao comando de compose usado no roteiro `docs/deploy/ROTEIRO_VPS_ueato.md`).

Como verificar: em Usuários, peça "Redefinir senha" para um usuário de teste
ativo; o link do e-mail deve ser
`https://ueato.revizzicar.com.br/ativar-conta?token_hash=...&type=recovery`;
clique em "Continuar", defina a nova senha: deve aparecer "Senha redefinida"
(sem erro) e o login com a senha nova deve funcionar.

Limite conhecido: um ADM com TOTP ativo entra na recuperação com sessão AAL1;
se o Supabase exigir AAL2 para trocar a senha, a página mostra "Não foi
possível redefinir a senha agora". Teste com um ADM de teste antes de
depender disso (para ADM, o caminho previsto é o reset de MFA + senha por
outro ADM).

---

## 2. gitleaks e trivy na VPS

### O que é

Duas varreduras que ainda não rodaram em lugar nenhum (ver
`docs/security/REVISAO_PRE_DEPLOY_2026-10-19.md`, B2):

- **gitleaks**: procura segredos no histórico git e nos arquivos.
- **trivy**: procura vulnerabilidades conhecidas (CVE) nas dependências e
  nas imagens Docker, e erros de configuração em Dockerfile/compose.

### Risco se não fizer

Um segredo versionado ou uma CVE grave na imagem passa despercebido.

### Como rodar (script novo)

`scripts/security-scan-docker.sh` usa as imagens oficiais com versão fixa
(`zricethebat/gitleaks:v8.28.0` e `aquasec/trivy:0.65.0`). Nada é instalado
na VPS.

O que ele garante:

- Repositório montado somente leitura.
- gitleaks sem rede (`--network none`) e com `--redact`: o relatório mostra
  o arquivo e a linha, não o segredo.
- trivy só BAIXA a base de vulnerabilidades. A varredura roda sem rede.
- Imagens lidas por `docker save` (o socket do Docker não é montado).
- Relatórios fora do repositório: `~/sispat-security-scans/<data UTC>/`,
  pasta `chmod 700`.

Passo a passo:

```
cd /opt/SISPAT
git pull --ff-only                      # traz o script novo
bash scripts/security-scan-docker.sh
```

Opções: `--no-images` (sem varrer imagens), `--no-gitleaks`, `--no-trivy`,
`--offline` (não baixa a base; usa o cache em `~/.cache/sispat-trivy`).
Para trocar a versão: `TRIVY_IMAGE=aquasec/trivy:<versão> bash scripts/security-scan-docker.sh`.
Antes de trocar, confira a versão na página oficial de releases.

Para fixar por digest (mais seguro que tag):

```
docker pull aquasec/trivy:0.65.0
docker inspect --format '{{index .RepoDigests 0}}' aquasec/trivy:0.65.0
# use o resultado: TRIVY_IMAGE=aquasec/trivy@sha256:... bash scripts/security-scan-docker.sh
```

### Comandos equivalentes (sem o script)

```
OUT=~/sispat-security-scans/manual && mkdir -p "$OUT" && chmod 700 "$OUT"

# gitleaks: histórico git (o que foi versionado)
docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -v /opt/SISPAT:/repo:ro -v "$OUT":/out zricethebat/gitleaks:v8.28.0 \
  git /repo --config /repo/.gitleaks.toml --redact --no-banner -f json -r /out/gitleaks-git.json

# trivy: base (download) e imagem do backend (sem rede)
mkdir -p ~/.cache/sispat-trivy
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e TRIVY_CACHE_DIR=/cache \
  -v ~/.cache/sispat-trivy:/cache aquasec/trivy:0.65.0 image --download-db-only
docker save sispat-agu/backend:latest -o /tmp/backend.tar && chmod 644 /tmp/backend.tar
docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -e TRIVY_CACHE_DIR=/cache \
  -v ~/.cache/sispat-trivy:/cache -v /tmp/backend.tar:/in/backend.tar:ro \
  aquasec/trivy:0.65.0 image --skip-db-update --offline-scan --input /in/backend.tar \
  --scanners vuln,secret --severity HIGH,CRITICAL
rm -f /tmp/backend.tar
```

### Como ler o resultado

Ao final o script imprime um resumo (`summary.txt`). Código de saída:
`0` = limpo, `1` = achados, `2` = erro de execução.

| Linha | Esperado | Se der ACHADOS |
|---|---|---|
| `gitleaks-git` | OK | Segredo no histórico. Trate como vazado: troque a credencial no provedor (Supabase, Google, Redis...). Apagar o arquivo não basta. |
| `gitleaks-dir` | ACHADOS só em `.env` e `secrets/` | Normal: são os segredos reais da VPS, não versionados. Qualquer OUTRO arquivo na lista é problema. |
| `trivy-fs` | OK | Dependência com CVE HIGH/CRITICAL em `requirements.lock` ou `package-lock.json`. Veja a coluna "Fixed Version" e atualize no repositório. |
| `trivy-config` | OK | Erro de configuração no Dockerfile/compose. Leia o ID (ex.: `DS002`) e a explicação. |
| `img:sispat-agu/...` | OK | CVE no sistema da imagem ou segredo embutido. CVE sem "Fixed Version" não tem correção ainda: registre e acompanhe. Segredo embutido: bloqueante. |

Registre data, versões e resultado em `docs/security/` (ex.: anexo à revisão
de pré-deploy). Não copie trechos de segredos para lá.

Alinhamento: `scripts/security-audit.sh` roda gitleaks/trivy com os mesmos
filtros quando há binários no PATH (`GITLEAKS_BIN`/`TRIVY_BIN`). Na VPS use o
script Docker; na máquina local, o `security-audit.sh`.

---

## 3. Limite de 100 s da Cloudflare (erro 524) na importação

### O que é

Com o DNS proxied, a Cloudflare encerra a requisição se o servidor não
responder em 100 s (planos Free/Pro/Business; não é configurável fora do
Enterprise). O navegador recebe HTTP 524. O resto da cadeia aguenta mais:
nginx 190 s em `/api/v1/imports/`, gunicorn 180 s (`backend/Dockerfile`).

Importante: após um 524 o backend CONTINUA trabalhando. O worker do
gunicorn termina a operação e grava no banco. Só o navegador desiste.

### Análise do código

**Prévia** (`POST /api/v1/imports/google-sheets/preview`,
`ImportService.create_preview`):

- 1 leitura do Google Sheets (timeout 30 s por requisição).
- Bens já existentes: 1 consulta por lote de 500 patrimônios.
- Unidades, salas e pessoas: 4 consultas, uma vez só.
- Gravação dos itens em lote (`add_all` + 1 `flush`).
- Total: cerca de 10 idas ao banco, quase fixo. Para os ~471 bens previstos,
  estimativa de 5 a 20 s. **Risco baixo.** O incidente antigo (> 60 s) foi
  antes da pré-carga em lote.

**Confirmação** (`POST /api/v1/imports/google-sheets/confirm`,
`ImportService.confirm_preview`): **é aqui que está o risco real.** Para cada
item selecionado:

- advisory lock (1 ida ao banco), SAVEPOINT (1), busca do bem (1),
  INSERT/UPDATE do bem (1), RELEASE SAVEPOINT (1), INSERT em
  `raw_import_records` (1).
- Cerca de 6 idas ao banco por item.
- 471 itens ≈ 2.800 idas. Tempo ≈ 2.800 × latência VPS↔Supabase.

| Latência média (RTT) | Tempo estimado da confirmação (471 itens) |
|---|---|
| 10 ms | ~30 s |
| 20 ms | ~60 s |
| 35 ms | ~100 s (limite Cloudflare) |
| 60 ms | ~170 s (perto do limite do gunicorn) |

Acima de ~180 s o gunicorn mata o worker: a transação é desfeita e NADA é
importado (seguro, mas a importação não acontece).

Entre 100 s e 180 s: 524 no navegador, mas a importação é gravada. Uma
segunda tentativa de confirmar a mesma prévia é recusada (status
`CONFIRMADA`), então não duplica.

Prévias de cadastros (`/api/v1/catalog-imports/...`: unidades, salas,
pessoas) têm poucas linhas. Risco baixo.

### Passo 1 — medir a latência (VPS, só leitura)

```
cd /opt/SISPAT
docker compose exec -T backend python - <<'EOF'
import time
from sqlalchemy import text
from app.database.session import engine
with engine.connect() as c:
    c.execute(text("select 1"))
    t = time.perf_counter()
    for _ in range(30):
        c.execute(text("select 1"))
    print("RTT medio: %.1f ms" % ((time.perf_counter() - t) / 30 * 1000))
EOF
```

Regra prática: itens por confirmação ≤ `90000 / (6 × RTT_ms)`.
Ex.: RTT 20 ms → até ~750 itens; RTT 40 ms → até ~375 itens.

### Passo 2 — medir a prévia real

Depois de gerar uma prévia pela tela:

```
docker compose logs --since 2h backend | grep 'create_preview: linhas='
```

A linha mostra `leitura=`, `prefetch=`, `classificacao=`, `persistencia=` e
`total=` em segundos. Se `total` passar de ~70 s, trate como risco alto.

### Mitigação imediata (recomendada)

1. Meça o RTT (passo 1) antes de importar os bens.
2. Se o limite calculado for menor que o total de itens, confirme em lotes:
   na tela de revisão selecione só parte dos itens NOVO (dentro do limite) e
   confirme. Gere uma nova prévia: os já importados aparecem como EXISTENTE;
   desmarque-os e selecione o próximo lote.
3. Se aparecer 524 na confirmação: NÃO repita às pressas. Espere 3 minutos,
   gere uma nova prévia e confira se os itens viraram EXISTENTE. Também dá
   para conferir no log: `docker compose logs --since 10m backend | grep -E 'confirm|POST /api/v1/imports'`.
4. Importe fora do horário de uso (cada confirmação longa ocupa 1 dos 3
   workers do gunicorn).

Alternativas avaliadas e **não recomendadas**:

- **Subdomínio "DNS only" (nuvem cinza) para a importação.** Expõe o IP real
  da VPS, que é compartilhado com os outros sites (todos perdem a proteção
  da Cloudflare). Exige abrir 443 para a internet no firewall e desligar o
  "Cloudflare only" nesse site, novo certificado, e mudanças de CORS/CSP e de
  `NEXT_PUBLIC_API_URL` (código + rebuild). O rate limit do vhost usa
  `CF-Connecting-IP`, que seria forjável nesse host. O custo de segurança é
  maior que o ganho.
- **Túnel SSH até 127.0.0.1:3110.** O frontend chama a API pelo domínio
  público (`NEXT_PUBLIC_API_URL` embutido no build), então a chamada passa
  pela Cloudflare de qualquer jeito.
- **Comando `flask` para gerar a prévia no terminal.** Não existe hoje (só
  as rotas HTTP). Seria código novo e ainda exigiria a tela para revisar e
  confirmar.

### Solução definitiva (não implementada)

Prévia e confirmação como **tarefas assíncronas** (Celery + polling):

1. `POST .../preview` cria a prévia com status `PROCESSANDO` (o status já
   existe na tabela) e enfileira uma task; responde `202` com `preview_id`.
2. A task roda `create_preview` no worker e muda o status para `CONCLUIDA`
   ou `FALHOU` (mensagem genérica, sem detalhe interno).
3. `GET .../preview/<id>` devolve o status (mesma autorização e escopo da
   rota atual; prévia alheia = 404).
4. O frontend consulta a cada 3–5 s (o vhost limita `/api/v1/imports/` a
   30 req/min por IP; 2 s estoura).
5. Confirmação: mesmo padrão, com o `sync_jobs.status` (`EM_EXECUCAO`) já
   existente. Provavelmente uma migração pequena para ligar a prévia ao
   `sync_job`.
6. Task com limite próprio (ex.: 600 s; o padrão do Celery no projeto é
   120 s) e trava contra enfileiramento duplicado.
7. O worker passa a ser obrigatório (ver item 4).

Estimativa: backend 1,5–2 dias, frontend 1 dia, testes (pytest, Playwright)
e revisão de segurança 1 dia. **Total: 3 a 4 dias úteis.**

Melhoria intermediária possível (também não implementada): reduzir as idas
ao banco na confirmação (pré-carga dos bens, locks em lote, savepoint só
quando necessário). Pode cortar o tempo em 3 a 4 vezes. ~1 dia.

Registre a decisão no `ROTEIRO_VPS_ueato.md` (risco M1).

---

## 4. Worker Celery

### O que é

Serviço `worker` do `docker-compose.yml` (perfil `worker`, opt-in). Roda
`celery -A app.celery_app worker -B` (com o agendador "beat" embutido). Usa
o Redis já existente. Hoje está **desligado**.

### É necessário hoje?

**Não.** O código só tem tasks de IA (`backend/app/tasks/ai_tasks.py`):

| Task | Agenda (UTC) | Para que serve |
|---|---|---|
| `sispat.ai.alerts_priority` | a cada 6 h | prioriza alertas no dashboard |
| `sispat.ai.executive_summary` | 09:00 (06:00 Araguaína) | resumo executivo |
| `sispat.ai.quality_suggestions` | 09:30 | sugestões de qualidade de dados |
| `sispat.ai.ping_provider` | sob demanda | teste do provedor de IA |

Nenhuma rota da API enfileira tarefas (não há `.delay()` em `app/api`).
Importação, convites, MFA e dashboard funcionam sem o worker.

### O que deixa de funcionar sem ele

- Os "insights" de IA do dashboard (`GET /api/v1/ai/insights`) ficam vazios,
  pois são gerados pelas tasks agendadas e lidos do Redis.
- Hoje isso não muda nada: `AI_ENABLED=false` e as tasks só agem com a
  funcionalidade ligada.
- Passa a ser obrigatório se a importação assíncrona (item 3) for feita.

### Como habilitar (quando decidir)

Pré-requisitos: `REDIS_URL` no `.env` (já existe) e memória livre (limite do
worker: 768 MB, `WORKER_MEMORY`).

```
cd /opt/SISPAT
free -m                                           # confira memória livre
docker compose --profile worker up -d worker      # usa a mesma imagem do backend
docker compose --profile worker ps worker         # deve ficar "healthy"
docker compose --profile worker logs --since 5m worker
docker compose --profile worker exec worker celery -A app.celery_app inspect ping -t 5
```

Se o backend acabou de ser reconstruído, a imagem já está atualizada. Se não,
use `docker compose --profile worker up -d --build worker`.

Regras:

- Só UM worker (o beat embutido duplicaria tarefas com dois). Não use
  `--scale`.
- Com o worker ligado, use sempre `--profile worker` nos comandos
  `docker compose` (`up`, `down`, `ps`, `logs`), senão ele fica de fora.

### Como desligar

```
docker compose --profile worker stop worker
docker compose --profile worker rm -f worker
```

### Como verificar

- `docker compose --profile worker ps` mostra `sispat-agu-worker` `healthy`.
- O `inspect ping` responde `pong`.
- Os logs não mostram erro de conexão com o Redis.

Registre a decisão no `ROTEIRO_VPS_ueato.md` (seção "Worker Celery").

---

## 5. `set_real_ip_from 0.0.0.0/0` no nginx global do CloudPanel

### O que é

O `/etc/nginx/nginx.conf` do CloudPanel confia em QUALQUER origem para
informar o IP do cliente (`set_real_ip_from 0.0.0.0/0` com
`real_ip_header X-Real-IP`). Quem mandar o cabeçalho `X-Real-IP: <qualquer IP>`
passa a "ser" esse IP para o nginx.

### Risco

**O SISPAT já está protegido.** O vhost dele tem `set_real_ip_from 127.0.0.1;`,
que substitui a lista global neste site. Nada a fazer no vhost do SISPAT.

O risco é para os **outros sites da VPS**:

- Sites com "Allow traffic from Cloudflare only": um atacante que chegue
  direto ao IP da VPS manda `X-Real-IP: <um IP da Cloudflare>` e passa pelo
  `allow`/`deny`. A proteção vira enfeite.
- Bloqueios por IP, rate limit e fail2ban podem ser burlados.
- Logs e aplicações registram um IP falso.

O firewall que libera 80/443 só para as faixas da Cloudflare reduz o risco
(o atacante não chega direto). Mas a camada do nginx não deve depender só
dele.

### Correção recomendada

Confiar só no próprio servidor (127.0.0.1 e ::1). O tráfego legítimo não
muda: a Cloudflare não envia `X-Real-IP`, e o Varnish do CloudPanel (se
algum site usar) fala com o nginx por 127.0.0.1.

Por que NÃO trocar por "faixas da Cloudflare + `real_ip_header CF-Connecting-IP`"
no arquivo global: nos sites com "Cloudflare only", o nginx passaria a ver o
IP do visitante e o `deny all` bloquearia todo mundo (mesmo problema
registrado no ROTEIRO, seção 5). Essa troca só serve por site, em sites SEM
"Cloudflare only".

Passo a passo:

```
# 1) Backup
sudo cp -a /etc/nginx/nginx.conf /root/nginx.conf.$(date +%F-%H%M).bak
ls -l /root/nginx.conf.*.bak

# 2) Ver as linhas atuais (anote o resultado)
sudo grep -n 'set_real_ip_from\|real_ip_header\|real_ip_recursive' /etc/nginx/nginx.conf

# 3) Ver quais sites têm lista própria (esses não são afetados pela troca)
sudo grep -ln 'set_real_ip_from' /etc/nginx/sites-enabled/*

# 4) Trocar 0.0.0.0/0 por 127.0.0.1 e ::1
sudo sed -i 's|^\([[:space:]]*\)set_real_ip_from[[:space:]]\+0\.0\.0\.0/0;|\1set_real_ip_from 127.0.0.1;\n\1set_real_ip_from ::1;|' /etc/nginx/nginx.conf

# 5) Se o passo 2 mostrou também "set_real_ip_from ::/0;", comente essa linha
sudo sed -i 's|^\([[:space:]]*\)set_real_ip_from[[:space:]]\+::/0;|\1# removido: set_real_ip_from ::/0;|' /etc/nginx/nginx.conf

# 6) Conferir, testar e recarregar
sudo grep -n 'set_real_ip_from\|real_ip_header' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx
```

Esperado no passo 6: `set_real_ip_from 127.0.0.1;` e `set_real_ip_from ::1;`,
nenhum `0.0.0.0/0` ativo, `nginx -t` com "syntax is ok" e "test is successful".
Se `nginx -t` falhar, NÃO recarregue: faça a reversão abaixo.

### Como verificar

1. SISPAT continua no ar: `curl -s https://ueato.revizzicar.com.br/api/health`
   → `{"status":"ok"}`.
2. Abra cada um dos outros sites no navegador.
3. Teste do bypass, DE OUTRA MÁQUINA (troque `outro.site` por um site com
   "Cloudflare only" e `IP_DA_VPS` pelo IP):
   ```
   curl -sk -m 10 -o /dev/null -w '%{http_code}\n' --resolve outro.site:443:IP_DA_VPS \
     -H 'X-Real-IP: 173.245.48.1' https://outro.site/
   ```
   Depois da correção: `403` (ou timeout, se o firewall já bloqueia). Antes
   da correção, um `200` aqui confirmava o problema.
4. O CloudPanel pode reescrever o `nginx.conf` em atualizações. Depois de
   cada atualização do painel, repita o passo 2.

### Como reverter

```
sudo cp -a /root/nginx.conf.AAAA-MM-DD-HHMM.bak /etc/nginx/nginx.conf   # use o nome do seu backup
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6. Expurgo de `import_previews`

### O que é

Cada prévia guarda uma cópia das linhas da planilha em `import_previews` e
`import_preview_items` (há nomes e e-mails: dado pessoal). Depois da
importação, essas cópias não têm mais uso. Hoje há prévias antigas com PII
guardadas.

Um comando novo está sendo criado no backend:
`flask purge-import-previews --older-than-days N [--dry-run]`. Ele só existe
na VPS depois do próximo deploy do backend
(`docker compose build backend && docker compose up -d backend`). Confira as
opções finais com `--help`.

O que o expurgo apaga e o que NÃO apaga:

- Apaga: prévias antigas e seus itens (`import_preview_items` cai junto, por
  `ON DELETE CASCADE`).
- **Nunca apaga `raw_import_records`.** Essa tabela guarda os valores
  originais do Google Sheets de cada importação confirmada (regra do
  projeto: preservar IDs e valores originais). Ela é ligada a `sync_jobs`,
  não às prévias.
- Não toca em `assets`, `sync_jobs` nem `audit_logs`.

### Risco se não fizer

Dado pessoal guardado sem finalidade (LGPD). Tabela crescendo à toa.

### Passo a passo (VPS)

Faça só DEPOIS de concluir a importação real (unidades → salas → pessoas →
bens).

```
cd /opt/SISPAT
docker compose exec backend flask purge-import-previews --help
# 1) Simulação: mostra o que seria apagado, sem apagar
docker compose exec backend flask purge-import-previews --older-than-days 30 --dry-run
# 2) Execução real (depois de conferir a simulação)
docker compose exec backend flask purge-import-previews --older-than-days 30
```

Se aparecer "Could not locate a Flask application", use
`flask --app 'app:create_app()' purge-import-previews ...`.

Prazo sugerido: 30 dias (dá tempo de revisar a importação). Para limpar já
as prévias de teste de outubro, rode com um número menor (ex.: `1`), sempre
com `--dry-run` primeiro.

### Agendamento (cron no host, opcional)

```
command -v docker          # confirme o caminho (normalmente /usr/bin/docker)
sudo tee /etc/cron.d/sispat-purge-import-previews >/dev/null <<'EOF'
# SISPAT-AGU: expurgo semanal de prévias de importação (domingo 04:30, horário do host)
30 4 * * 0 root cd /opt/SISPAT && /usr/bin/docker compose exec -T backend flask purge-import-previews --older-than-days 30 >> /var/log/sispat-purge-import-previews.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/sispat-purge-import-previews
timedatectl | grep 'Time zone'   # o horário do cron é o do host
```

`-T` é obrigatório no cron (não há terminal). Para desligar:
`sudo rm /etc/cron.d/sispat-purge-import-previews`.

### Como verificar

1. A simulação e a execução mostram a mesma quantidade.
2. No SQL Editor do Supabase (só leitura), antes e depois:
   ```
   select status, count(*) from import_previews group by status;
   select count(*) from raw_import_records;
   ```
   `import_previews` diminui. `raw_import_records` fica **igual**.
3. Com o cron: `sudo tail -n 20 /var/log/sispat-purge-import-previews.log`
   depois da primeira execução.

Registre data e quantidade apagada no histórico de operações.
