# Implantação em Produção — VPS Hostinger + CloudPanel + Cloudflare

> **AVISO:** toda implantação em produção exige **autorização explícita** do
> responsável — inclusive um rebuild de imagem. Este guia descreve a
> arquitetura e as decisões de borda; os comandos e as conferências do dia a
> dia estão em `docs/deployment/checklist-deploy-vps.md` (canônico) e em
> `docs/deploy/ROTEIRO_VPS_ueato.md` (roteiro do domínio).

> **Estado em 2026-10-29.** A arquitetura descrita aqui **já está em
> produção** desde 2026-10-20: VPS Hostinger com CloudPanel, Cloudflare
> proxied, projeto em `/opt/SISPAT`, backend publicado em `127.0.0.1:8110` e
> frontend em `127.0.0.1:3110` (o Compose nunca ocupa 80/443). O vhost em uso é
> `infra/cloudpanel/vhost.ueato-cloudpanel.conf`. Rodadas posteriores
> implantadas: 2026-10-21 e 2026-10-29 (commits `be2a16c` e `6823803`); a
> validação funcional da última está aguardando o responsável. O banco está em
> `0019_user_soft_delete`, head do código. O n8n continua EXTERNO: este projeto
> nunca instala nem constrói um n8n.

## Arquitetura de implantação (visão geral)

```
Internet
   │
   ▼
Cloudflare (DNS + proxy "nuvem laranja" + TLS edge, modo Full Strict)
   │  HTTPS
   ▼
VPS Hostinger
   │
   ├─ CloudPanel (Nginx do host, porta 80/443, certificado de origem válido
   │   para Full Strict) — único ponto de entrada público na VPS
   │       │
   │       └─ um site/vhost para o domínio, roteando por caminho:
   │             location /api/  ──▶ 127.0.0.1:${BACKEND_PORT}
   │             location /      ──▶ 127.0.0.1:${FRONTEND_PORT}
   │
   └─ Docker Compose (sem porta pública própria)
           ├─ frontend (Next.js)  — publica apenas em 127.0.0.1:${FRONTEND_PORT}
           ├─ backend  (Flask)    — publica apenas em 127.0.0.1:${BACKEND_PORT}
           ├─ redis / worker      — somente rede interna, sem publicação de porta
           └─ (sem serviço de banco de dados; sem serviço n8n local)

Serviços externos ao Docker Compose desta VPS (ou a outra VPS/ambiente):
   - Supabase/PostgreSQL (banco de dados gerenciado, remoto)
   - n8n (instalação externa já existente na VPS do usuário, fora deste
     Compose) — o backend fala com ele via HTTPS/API/webhooks autenticados
```

Esta arquitetura substitui, na camada de borda pública, o `reverse-proxy`
referenciado em versões anteriores do `docker-compose.yml`: em produção, o
Nginx do **CloudPanel** é quem termina TLS e expõe as portas 80/443 da VPS;
o Compose não publica porta pública nenhuma — apenas `127.0.0.1`.

---

## 1. Requisitos da VPS

Recomendações mínimas para rodar CloudPanel + Docker Compose (backend,
frontend, redis/worker) de forma estável, sem o banco de dados local (que é
remoto, no Supabase):

- **CPU:** 2 vCPUs (mínimo); 4 vCPUs recomendado se o worker de sincronização
  (Google Sheets) rodar em paralelo com tráfego web.
- **RAM:** 4 GB mínimo (2 GB é insuficiente com CloudPanel + Docker + Node.js
  + Flask/Gunicorn + Redis rodando simultaneamente); 8 GB recomendado para
  margem de folga em picos de importação/sincronização.
- **Disco:** 40 GB SSD mínimo (imagens Docker, logs de containers, volume do
  Redis, cache de build do Next.js); 80 GB recomendado para folga de logs e
  backups locais temporários antes de envio a armazenamento externo.
- **Sistema operacional:** Linux compatível com os requisitos do CloudPanel
  (ex.: Ubuntu/Debian LTS suportado pela documentação oficial do CloudPanel).
- **Docker Engine + Docker Compose v2.24+** (suporte a `configs.*.content` e
  sintaxe atual de `docker compose`), instalados conforme a documentação
  oficial — sem conflitar com o Nginx gerido pelo CloudPanel.
- **Nginx:** já incluso na instalação do CloudPanel — não é necessário (nem
  recomendado) instalar outro Nginx no host para servir como proxy público;
  o CloudPanel assume esse papel (ver seções 6–9).
- **Acesso SSH:** obrigatório, com autenticação por chave (desabilitar login
  de senha root quando possível) para administração da VPS, instalação do
  CloudPanel, deploy via `docker compose` e operações de manutenção.
- **Portas de firewall:** 22 (SSH, idealmente restrito por IP), 80 e 443
  (CloudPanel/Cloudflare) abertas; nenhuma porta de aplicação (backend,
  frontend, redis) exposta publicamente (ver seção 10).

## 2. Estrutura Docker Compose

Em produção, `docker compose up -d --build` (usando a imagem base de
produção, sem o override de desenvolvimento `docker-compose.dev.yml`) sobe
apenas os serviços da aplicação, sem banco de dados e sem proxy público
próprio:

- **`backend`** (Flask/Gunicorn): expõe sua porta apenas internamente
  (`127.0.0.1:${BACKEND_PORT}` no host, mapeada para a porta interna do
  container) — é o CloudPanel, não o Compose, quem encaminha tráfego público
  até ela.
- **`frontend`** (Next.js): mesma lógica, publicado em
  `127.0.0.1:${FRONTEND_PORT}`.
- **`redis`**: cache/broker do worker, acessível apenas pela rede interna do
  Compose — nunca publicado em porta de host.
- **`worker`** (profile `worker`, opt-in; **não** está em uso em produção —
  hoje só há tarefa de IA, desligada): processamento assíncrono com Celery e
  beat embutido (`celery -A app.celery_app worker -B`), mesma imagem do
  backend, sem porta publicada — comunica-se com `redis` só pela rede interna.
  Para subir, quando decidido:
  `docker compose --profile worker up -d --build worker`.

**Por que não há serviço de banco de dados aqui:** o banco operacional é o
Supabase/PostgreSQL remoto e gerenciado (ver seção 4); o Compose de produção
nunca declara um serviço de Postgres como fonte de verdade — ele só existiria,
opcionalmente, em `docker-compose.dev.yml` para testes locais de migração,
nunca em produção.

**Por que não há serviço de proxy público aqui:** a função de terminar TLS e
expor 80/443 ao mundo passou a ser do CloudPanel (que já traz seu próprio
Nginx gerenciado pela interface administrativa). Manter um segundo proxy
público dentro do Compose seria redundante e geraria conflito de porta com o
CloudPanel na mesma VPS — por isso backend e frontend publicam apenas em
`127.0.0.1`, e é o CloudPanel que encaminha para essas portas de loopback (ver
seções 6–7).

A definição exata dos serviços, variáveis e healthchecks está em
`docker-compose.yml` — consulte sempre o arquivo vigente antes de uma
implantação real. O que ele já traz hoje, e que este guia pressupõe:

- `docker compose config --services` devolve `backend`, `worker` (profile
  `worker`, opt-in), `redis` e `frontend`; `docker compose up -d` sem profile
  sobe apenas backend, frontend e redis.
- Endurecimento por serviço: `read_only: true`, `no-new-privileges`,
  `cap_drop: ALL`, `init: true`, limites de CPU/memória/PIDs por variável
  (`BACKEND_CPUS`, `BACKEND_MEMORY`, ...) e rotação de log json-file
  (10 MB x 5).
- Três redes: `edge-net` (portas publicadas em loopback), `backend-net`
  (`internal: true`, onde fica o Redis) e `egress-net` (saída para Supabase,
  Google Sheets e n8n externo) — o Redis não participa da saída.
- Credencial do Google Sheets entra como **secret** de arquivo
  (`GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` no host → `/run/secrets/
  google_sheets_credentials.json` só no backend e no worker; o frontend não
  recebe).
- O `frontend` **não** usa `env_file`: recebe apenas as três `NEXT_PUBLIC_*`,
  como build args e como variáveis de execução. Segredos de backend nunca
  chegam a ele.
- O Redis exige `REDIS_PASSWORD` (o Compose recusa subir sem ela), gera a ACL
  em tmpfs e bloqueia comandos administrativos.

## 3. Variáveis de ambiente

Variáveis relevantes para produção (sem valores reais — preencher apenas em
`.env` local/seguro, nunca versionado; ver `.env.example` para o modelo
completo e atualizado):

| Variável | Finalidade em produção |
|---|---|
| `DATABASE_URL` | String de conexão do SQLAlchemy/Alembic com o Supabase/PostgreSQL remoto. Deve usar a connection string de produção do projeto Supabase (ver seção 4), com credenciais dedicadas ao ambiente de produção. |
| `SUPABASE_URL` | URL do projeto Supabase (ex.: `https://<ref>.supabase.co`), usada por backend e, na variante pública, pelo frontend. |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave privilegiada do Supabase, uso **exclusivo do backend**, para operações que exigem bypass de RLS. Nunca deve ser lida pelo frontend/navegador, nem logada. |
| `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave pública/anônima; mesmo sendo "segura" para exposição no cliente, qualquer acesso que ela habilite ainda deve ser validado pelo backend — RLS não substitui a autorização do Flask (`CLAUDE.md`). |
| `SECRET_KEY` | Chave secreta do Flask (sessões, assinatura de tokens). Deve ser gerada de forma forte e aleatória, exclusiva do ambiente de produção, nunca reaproveitada de desenvolvimento. |
| `REDIS_PASSWORD` | Senha do Redis interno. O Compose **recusa subir** sem ela (`${REDIS_PASSWORD:?}`), e ela precisa ser idêntica à que está embutida em `REDIS_URL`. |
| `REDIS_URL` | Endereço do Redis interno ao Compose, **com senha**: `redis://:<REDIS_PASSWORD>@redis:6379/0` (host `redis`, nunca `localhost`) — broker/cache do backend e do worker; não deve ser exposto fora da rede interna. Senha divergente entre as duas variáveis faz toda rota com rate limit responder 503. |
| `INVITE_ALLOWED_REDIRECT_URLS` / `PASSWORD_RESET_REDIRECT_URL` | Allow-list do destino dos links de convite e de recuperação de senha (`https://<dominio>/ativar-conta`). Em produção o backend não inicia com item não-https. |
| `EMAIL_ENABLED` e bloco `EMAIL_*` | SMTP usado pelo próprio backend para entregar convite e recuperação de senha (`app/services/invite_delivery.py`, `app/services/password_reset_delivery.py`). Com a entrega desligada, o convite falha com 502 em vez de ser criado sem e-mail. |
| `BACKEND_PORT` | Porta em que o container `backend` é publicado em `127.0.0.1` no host, para o CloudPanel encaminhar requisições `/api/*` (ver seções 6–7). |
| `FRONTEND_PORT` | Porta em que o container `frontend` é publicado em `127.0.0.1` no host, para o CloudPanel encaminhar as demais rotas (ver seções 6–7). |
| `N8N_BASE_URL` | URL HTTPS pública (ou endereço interno/VPN, conforme topologia) da instalação **externa** de n8n que o backend deve chamar para disparar workflows. |
| `N8N_WEBHOOK_URL` | URL de webhook específica do n8n externo usada pelo backend para notificações/eventos de integração (ex.: alertas de `sync_jobs`/`sync_conflicts`). |
| `N8N_API_KEY` | Credencial de autenticação do backend junto à API do n8n externo. Segredo exclusivo do backend — nunca exposto ao frontend (ver seção 5). |
| `N8N_INTEGRATION_ENABLED` | Chave de ativação/desativação da integração com o n8n externo em tempo de execução, sem exigir redeploy (ver seção 5). |
| `CORS_ALLOWED_ORIGINS` | Lista (separada por vírgula) das origens autorizadas a chamar a API Flask — em produção, deve conter apenas o(s) domínio(s) públicos reais do frontend, nunca `*` nem `localhost`. |
| `TZ` | Fuso horário operacional da unidade (`America/Araguaina`). O banco permanece sempre em UTC; a conversão para este fuso ocorre na camada de aplicação/UI (`CLAUDE.md`). |
| `TRUSTED_PROXY_IPS` | Lista de IPs/faixas confiáveis para o backend aceitar cabeçalhos de proxy (`X-Forwarded-For`, `X-Forwarded-Proto`) como legítimos — em produção, deve corresponder ao(s) IP(s) de loopback/interno do CloudPanel, nunca `0.0.0.0/0` ou um valor que aceite qualquer origem (ver seção 7). |

Variáveis adicionais específicas de Google Sheets e de desenvolvimento
(`POSTGRES_DEV_*`, `DEBUGPY_PORT`, usados só pelo `docker-compose.dev.yml`)
seguem documentadas em `.env.example`; a lista comentada variável por variável
do ambiente em produção está em `docs/deploy/ENV_PRODUCAO_ueato.md`. Não existe
n8n local: as `N8N_*` apontam sempre para a instalação EXTERNA.

## 4. Integração com Supabase

- **Connection string de produção:** obter em
  `Project Settings → Database` no painel do Supabase, usando o pooler
  recomendado para a carga esperada (ex.: modo transaction/session do
  Supavisor/PgBouncer, conforme orientação do próprio painel) em vez da
  conexão direta, para suportar múltiplas conexões simultâneas do
  backend/worker sem esgotar o limite de conexões do Postgres. Usar uma
  credencial de banco **dedicada ao ambiente de produção**, distinta da usada
  em desenvolvimento/homologação.
- **Chave anônima (`SUPABASE_ANON_KEY`) vs. service role
  (`SUPABASE_SERVICE_ROLE_KEY`):** a chave anônima respeita as políticas de
  Row Level Security (RLS) configuradas no projeto e é a única que deveria,
  em tese, circular perto do cliente; a service role **ignora RLS** e tem
  privilégio total sobre o banco — por isso seu uso é estritamente do backend
  Flask, para as operações que exigem esse privilégio, e nunca deve ser
  passada ao frontend, incluída em variáveis `NEXT_PUBLIC_*`, logada ou
  versionada.
- **Nunca expor a service role no frontend:** reforçando o princípio já
  registrado em `CLAUDE.md`/`README.md` — nenhuma tabela patrimonial é
  acessada diretamente do navegador/Supabase; toda leitura/escrita passa pelo
  backend Flask, que decide quando (e se) usar a service role internamente.
- RLS no Supabase, quando configurado, é uma camada defensiva adicional — não
  substitui a autorização aplicada pelo Flask (matriz de permissões em
  `docs/permissions/matriz-permissoes.md`).

## 5. Integração com n8n externo

A instalação de n8n já existe **fora** deste projeto, na VPS do usuário (outra
instalação, fora do `docker-compose.yml` do SISPAT-AGU). Este projeto nunca
instala, constrói ou reinicia essa instância — apenas consome sua API/webhooks
via HTTPS, autenticado.

- **Obter/gerar a API key no n8n já existente:** no painel do n8n externo,
  em `Settings → API` (ou equivalente da versão instalada), gerar uma API key
  dedicada à integração com o SISPAT-AGU (evitar reutilizar uma chave de outro
  propósito/sistema). Armazenar o valor gerado apenas em `.env`
  (`N8N_API_KEY`), nunca versionado, nunca exposto ao frontend.
- **Testar conectividade HTTPS:** antes de habilitar a integração em
  produção, validar manualmente (ex.: `curl` autenticado a partir do próprio
  host/rede do backend) que `N8N_BASE_URL`/`N8N_WEBHOOK_URL` respondem via
  HTTPS com a `N8N_API_KEY` configurada, incluindo verificação de certificado
  válido — nunca desabilitar validação de TLS para "contornar" erro de
  conectividade.
- **Comportamento esperado quando a integração está desligada ou
  indisponível:** com `N8N_INTEGRATION_ENABLED=false`, o backend não deve
  tentar nenhuma chamada ao n8n — a funcionalidade correspondente (ex.:
  disparo de notificação) é simplesmente ignorada/registrada como não
  aplicável. Mesmo com a integração habilitada, se o n8n externo estiver
  indisponível, lento ou retornar erro, o backend deve tratar a falha com
  timeout, não propagar exceção não tratada, e registrar o evento (idealmente
  em `audit_logs`, conforme `docs/architecture/estrategia-auditoria.md`) —
  **nunca bloquear uma operação patrimonial essencial** (cadastro, edição,
  movimentação, inventário, sincronização) por causa de uma falha de
  integração acessória como o n8n (`CLAUDE.md`).

## 6. Configuração de domínio no CloudPanel

- **Decisão em uso desde 2026-10-20:** um ÚNICO site no CloudPanel, do tipo
  **Reverse Proxy**, para o domínio, roteando por caminho dentro do mesmo
  vhost — `location /api/` para `127.0.0.1:${BACKEND_PORT}` e `location /`
  para `127.0.0.1:${FRONTEND_PORT}` (ver seção 7). Não há subdomínio separado
  para a API.
- Modelo genérico de vhost: `infra/cloudpanel/vhost.conf.example` (preencher
  `<BACKEND_PORT>`, `<FRONTEND_PORT>` e as faixas `set_real_ip_from` baixadas
  de cloudflare.com/ips).
- Vhost **realmente aplicado** na VPS:
  `infra/cloudpanel/vhost.ueato-cloudpanel.conf`, adaptado ao CloudPanel da
  Hostinger no modo "Allow traffic from Cloudflare only" (lista de `allow` +
  `deny all`): nesse modo não se usa `set_real_ip_from` das faixas da
  Cloudflare — o IP real vem de `$http_cf_connecting_ip`, e
  `set_real_ip_from 127.0.0.1` anula o `0.0.0.0/0` do `nginx.conf` global do
  painel. As diferenças e as armadilhas (regex com `{36}` precisa de aspas,
  colar do terminal quebra espaços) estão na seção 5 de
  `docs/deploy/ROTEIRO_VPS_ueato.md`.
- Faça backup do vhost antes de editar e rode `sudo nginx -t` antes de
  `sudo systemctl reload nginx`. O CloudPanel pode regenerar o vhost: mantenha
  a versão final guardada fora do painel.
- O site criado no CloudPanel é o local onde se instala o certificado de
  origem (ver seção 9) e onde se configuram as regras de acesso adicionais
  (ver seção 10), incluindo o "Allow traffic from Cloudflare only".

## 7. Encaminhamento de requisições ao Next.js e Flask

Regra geral de roteamento, independentemente de backend e frontend
estarem no mesmo domínio (por caminho) ou em domínios/subdomínios separados:

- **`/api/*` → backend Flask** (`127.0.0.1:${BACKEND_PORT}`): toda rota de
  API, autenticação e regra de negócio.
- **Demais rotas → frontend Next.js** (`127.0.0.1:${FRONTEND_PORT}`):
  páginas, assets estáticos, rotas de interface.
- **Cabeçalhos de proxy confiáveis:** a configuração do CloudPanel (vhost)
  deve repassar `Host`, `X-Real-IP`, `X-Forwarded-For` e `X-Forwarded-Proto`
  corretamente ao backend/frontend, da mesma forma que o antigo proxy interno
  do Compose fazia — para que o Flask veja o IP real do cliente e o esquema
  (`https`) correto, e não o IP/esquema internos do loopback.
- O backend deve confiar nesses cabeçalhos **somente** quando a origem da
  requisição é o próprio CloudPanel (loopback/interno) — daí a variável
  `TRUSTED_PROXY_IPS` (seção 3): sem essa restrição, um cabeçalho
  `X-Forwarded-For` poderia ser forjado por um cliente malicioso caso a
  requisição alcançasse o backend por outro caminho que não o proxy
  confiável.
- Suporte a WebSocket/upgrade de conexão (se necessário por alguma rota do
  frontend) deve ser preservado na configuração de vhost, replicando o padrão
  já usado no proxy interno do Compose (`Upgrade`/`Connection`).
- **Locations específicas do vhost em uso** (`vhost.ueato-cloudpanel.conf`),
  além de `/api/` e `/`: `^/api/v1/(users/invite|users/activate-invite|security/mfa/)`
  e a de avatar, com rate limit próprio; `^~ /api/v1/imports/` com
  `proxy_read_timeout 190s` e a zona `sispat_imports`; `^~ /.well-known` e o
  bloqueio de arquivos ocultos. As demais rotas da API usam
  `proxy_read_timeout 60s` — considere isso ao medir exportações grandes de
  `/relatorios` (o gunicorn vai a 180 s; ver `timeouts-gunicorn.md`).
- O Nginx **não** emite cabeçalhos de segurança: quem emite é o Next.js
  (frontend) e o Flask (API). Não duplicar HSTS na Cloudflare nem incluir o
  `global_settings` do CloudPanel neste site.

## 8. Configuração de DNS no Cloudflare

- Criar um registro **A** apontando o domínio/subdomínio do frontend (e, se
  em subdomínio separado, do backend) para o **IP público da VPS Hostinger**;
  alternativamente, um registro **CNAME** quando o domínio apontar para outro
  nome gerenciado, conforme a topologia de DNS adotada.
- Manter o **proxy do Cloudflare habilitado ("nuvem laranja")** nesses
  registros — isso é o que entrega DNS, proxy reverso de borda, mitigação de
  DDoS e terminação TLS de borda antes do tráfego alcançar a VPS.
- **Nunca desabilitar a validação de certificado** na comunicação entre
  Cloudflare e a origem (ver seção 9) apenas para "simplificar" a configuração
  — isso quebraria a garantia de ponta a ponta de criptografia que o modo Full
  Strict (seção 9) existe para proteger.

## 9. Configuração HTTPS

- **Na origem (VPS/CloudPanel):** instalar um certificado válido no site antes
  de habilitar o Full Strict. Com o DNS **proxied** na Cloudflare, o desafio
  HTTP-01 do Let's Encrypt **falha**: use um **Cloudflare Origin Certificate**
  (instalado no CloudPanel) ou Let's Encrypt via **DNS-01**. Sem certificado
  válido na origem, o Full Strict rejeita a conexão.
- **No Cloudflare:** configurar o modo SSL/TLS do domínio como **Full
  (Strict)** — Cloudflare só aceita a conexão com a origem se o certificado
  apresentado pela VPS for válido (emitido por uma CA confiável, não expirado,
  correspondente ao domínio).
- **Redirecionamento HTTP → HTTPS:** habilitar no Cloudflare (regra de
  "Always Use HTTPS" ou equivalente) e, complementarmente, garantir que o
  CloudPanel também redirecione HTTP para HTTPS na origem — dupla camada de
  redirecionamento, sem depender de apenas uma delas.
- **HSTS da Cloudflare DESLIGADO:** o `Strict-Transport-Security` já é emitido
  pela aplicação (Next.js/Flask); ligar na borda duplicaria o cabeçalho, o que
  a verificação pós-subida trata como falha (critério "cabeçalho único").
- **Nunca usar o modo "Flexible"** do Cloudflare: esse modo aceita HTTP
  simples entre Cloudflare e a origem, criando uma falsa sensação de HTTPS
  ponta a ponta (o navegador vê HTTPS até o Cloudflare, mas o tráfego segue em
  texto claro até a VPS) — inadequado para um sistema que trata dados
  patrimoniais e, potencialmente, dados pessoais sob LGPD
  (`docs/architecture/estrategia-auditoria.md`).

## 10. Boas práticas de segurança

- **Rate limiting no Cloudflare:** configurar regras de limitação de taxa
  (WAF/Rate Limiting Rules) para rotas sensíveis, especialmente endpoints de
  autenticação (`/api/auth/...` ou equivalente) e de exportação de dados, para
  mitigar força bruta e scraping.
- **Regras de acesso para rotas administrativas:** restringir, via regras do
  Cloudflare (Access/Firewall Rules) e/ou configuração do CloudPanel, o
  acesso a rotas administrativas (gestão de usuários, perfis, permissões,
  integrações — ver `docs/permissions/matriz-permissoes.md`) por IP, país ou
  outro critério adicional, sempre como camada complementar à autorização já
  obrigatória no backend — nunca como substituto dela.
- **Firewall da VPS:** manter um firewall (ex.: `ufw`/`iptables`/firewall do
  provedor) habilitado na Hostinger, liberando apenas as portas estritamente
  necessárias (22 restrito, 80/443 para o CloudPanel) e bloqueando qualquer
  tentativa de acesso direto às portas internas do Compose
  (`127.0.0.1:${BACKEND_PORT}`/`127.0.0.1:${FRONTEND_PORT}` já não são
  alcançáveis externamente por estarem em loopback, mas o firewall é uma
  camada defensiva adicional).
- **Usuários não-root nos containers:** backend, frontend e worker devem
  executar com usuário não privilegiado dentro da imagem (consistente com o
  padrão já adotado para Redis e demais imagens oficiais no
  `docker-compose.yml`), reduzindo o impacto de uma eventual execução de
  código arbitrário dentro de um container.
- **Segredos via `.env` nunca versionado:** reforçar o que já está em
  `CLAUDE.md`/`README.md`/`.gitignore` — nenhuma credencial real (banco,
  Supabase, `SECRET_KEY`, n8n) é commitada; o `.env` de produção vive apenas
  na VPS, com permissões de arquivo restritas ao usuário de deploy.
- **Cabeçalhos de segurança, com UM emissor só:** `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options`/`frame-ancestors`,
  `Content-Security-Policy` (com nonce) e `Referrer-Policy` são emitidos pela
  **aplicação** — Next.js no frontend e Flask na API. O vhost do CloudPanel
  **não** emite nenhum deles e o HSTS da Cloudflare fica desligado: a
  verificação pós-subida exige contagem 1 para cada cabeçalho, logo duplicar na
  borda é defeito, não camada extra.

## 11. Backups

- **Banco de dados:** o Supabase é o responsável pelo backup do PostgreSQL —
  utilizar os recursos gerenciados do plano contratado (backups diários e,
  quando disponível no plano, **Point-in-Time Recovery — PITR**) em vez de
  implementar rotina própria de `pg_dump` como mecanismo primário. Confirmar,
  junto ao painel do Supabase, a janela de retenção efetivamente contratada
  antes de depender dela operacionalmente.
- **Antes de cada migração:** além do backup gerenciado, vale um dump
  explícito, guardado fora do repositório:
  `pg_dump "$DATABASE_URL" --schema=public -Fc -f backup-pre-<migracao>-$(date +%F-%H%M).dump`.
  Registrar data, hora e o comando de reversão da migração
  (`alembic downgrade <id_anterior>`) junto da autorização.
- **Volumes Docker locais:** os únicos dados persistentes relevantes no
  Compose desta VPS são os volumes internos (ex.: dados do Redis, se
  configurado para persistência) — por natureza, dados de cache/fila, não a
  fonte de verdade do sistema; ainda assim, recomenda-se backup periódico
  simples (snapshot do volume ou `docker run --rm -v ... tar` para um destino
  externo) caso haja dependência operacional relevante neles.
- **Frequência recomendada:** backups gerenciados do Supabase conforme o
  plano (tipicamente diário, com PITR contínuo nos planos que o oferecem);
  snapshot dos volumes Docker locais ao menos semanalmente, ou antes de cada
  atualização relevante (ver seção 13).
- **Teste de restauração:** realizar periodicamente (ex.: semestral, ou antes
  de mudanças estruturais relevantes no schema) um teste de restauração do
  backup do Supabase em um projeto/branch de teste, validando que os dados
  restaurados são íntegros e que o procedimento documentado funciona na
  prática — nunca presumir que um backup é válido sem testá-lo.

## 12. Monitoramento

- **Logs dos containers:** `docker compose logs -f <serviço>` (ou
  centralização via `docker logs`/driver de log configurado) para
  `backend`, `frontend`, `worker` e `redis`; revisar periodicamente por
  erros recorrentes, especialmente falhas de conectividade com Supabase ou
  com o n8n externo (seção 5).
- **Healthchecks:** os healthchecks já definidos no `docker-compose.yml`
  (ex.: `GET /api/health` do backend, verificação HTTP do frontend, `redis-cli
  ping`) devem ser observados via `docker compose ps`/`docker inspect` como
  primeiro sinal de degradação de um serviço.
- **Supabase Advisors/logs:** revisar periodicamente os *Advisors* de
  segurança e performance do painel Supabase, além do Logs Explorer do
  projeto, para identificar consultas lentas, políticas de RLS problemáticas
  ou alertas de segurança do banco.
- **Uptime externo:** recomenda-se configurar um serviço externo de
  monitoramento de disponibilidade (uptime check) apontando para os domínios
  públicos (frontend e, se em subdomínio separado, backend), para detectar
  indisponibilidade mesmo quando os healthchecks internos não capturam falhas
  na camada de borda (Cloudflare/CloudPanel/DNS).

## 13. Atualizações

Processo recomendado para deploy de uma nova versão em produção (sob
autorização explícita, nunca como rotina automática sem supervisão nesta
fase do projeto):

1. `cd /opt/SISPAT && git pull --ff-only` da branch/tag autorizada para deploy.
2. Revisar `docker-compose.yml`/`.env.example` vigentes contra o `.env` de
   produção, aplicando eventuais novas variáveis exigidas (conferências em
   `docs/deploy/ENV_PRODUCAO_ueato.md`).
3. Aplicar o DDL da migração, se houver, **antes** de subir a imagem nova do
   backend — nunca depois, para o código novo não rodar contra um schema
   desatualizado. No padrão deste projeto o responsável executa o espelho
   `.sql` no SQL Editor do Supabase e carimba (`alembic stamp <id>`); quando o
   banco não tiver os objetos, `alembic upgrade head`. Sempre com backup/PITR
   confirmado (ou `pg_dump "$DATABASE_URL" --schema=public -Fc -f <arquivo>.dump`)
   e com autorização explícita. Detalhe na seção 3 de
   `docs/deployment/checklist-deploy-vps.md`.
4. Reconstruir e recriar só o que mudou:
   `docker compose build backend frontend && docker compose up -d backend frontend`
   (só backend: `docker compose build backend && docker compose up -d backend` e
   depois `docker compose up -d`, porque o frontend depende do backend e cai na
   recriação). Qualquer mudança em `NEXT_PUBLIC_*` ou em asset importado pelo
   código do frontend exige rebuild do frontend.
5. Conferir `docker compose ps` (backend, frontend e redis `healthy`) e
   `curl -fsS http://127.0.0.1:8110/api/health` antes de considerar a subida
   concluída; depois rodar a verificação pelo domínio (seção 5 do checklist).
6. **Rolling/zero-downtime básico:** como o Compose roda uma única réplica de
   cada serviço nesta fase, uma atualização de `backend`/`frontend` implica
   uma breve indisponibilidade durante a recriação do container; para reduzir
   o impacto, validar a imagem nova (build e smoke test) antes de substituir o
   container em produção, e monitorar o healthcheck imediatamente após o
   `up -d` para confirmar que o novo container ficou saudável antes de
   considerar o deploy concluído. Uma estratégia de múltiplas réplicas atrás
   de um balanceador é uma evolução possível, não adotada nesta fase.
7. **Versionamento de imagem:** marcar/tagar as imagens construídas (ex.:
   `sispat-agu/backend:<versão>`, além de `:latest`) para que a versão
   anterior permaneça disponível localmente e sirva de base ao rollback
   (seção 14).

## 14. Procedimento de rollback

1. **Manter a imagem/tag anterior disponível** localmente na VPS (não
   remover a imagem antiga da versão anterior imediatamente após um deploy —
   ver versionamento na seção 13) antes de iniciar qualquer atualização.
2. Em caso de necessidade de rollback, `docker compose down` **apenas do(s)
   serviço(s) afetado(s)** (ex.: `backend` ou `frontend`), evitando derrubar
   todo o ambiente (Redis/worker) sem necessidade.
3. Subir novamente o container com a tag de imagem anterior conhecida como
   estável (ex.: `docker compose up -d --no-build` após ajustar a referência
   de imagem/tag para a versão anterior), validando o healthcheck antes de
   considerar o rollback concluído.
4. **Rollback de migração Alembic apenas com autorização explícita e análise
   de impacto prévia:** uma migração já aplicada pode ter sido acompanhada de
   escritas de dados reais; `alembic downgrade` deve ser avaliado quanto a
   perda de dados, campos removidos/renomeados e impacto em `audit_logs`
   antes de ser executado — nunca como primeira reação automática a um
   problema de deploy. Nenhuma migração destrutiva ocorre sem autorização
   explícita (`CLAUDE.md`).
5. **Nunca executar rollback destrutivo sem backup confirmado:** antes de
   qualquer rollback que possa descartar dados (downgrade de schema,
   restauração de backup), confirmar a existência e a integridade de um
   backup recente e testável (ver seção 11) — rollback não é substituto de
   backup, e a ausência de um backup válido é motivo para **não** prosseguir
   com o rollback até que a situação seja esclarecida com autorização
   explícita.

---

## Referências internas

- `CLAUDE.md` — regras de arquitetura, segurança e implantação (governança).
- `README.md` — visão geral do projeto e estrutura de pastas.
- `docker-compose.yml` / `docker-compose.dev.yml` — definição dos serviços.
- `.env.example` — modelo de variáveis de ambiente (sem valores reais).
- `infra/cloudpanel/vhost.conf.example` — modelo genérico de vhost para o
  CloudPanel.
- `infra/cloudpanel/vhost.ueato-cloudpanel.conf` — vhost efetivamente aplicado
  na VPS (modo "Allow traffic from Cloudflare only").
- `docs/deployment/checklist-deploy-vps.md` — checklist canônico de deploy.
- `docs/deployment/timeouts-gunicorn.md` — cadeia de timeouts (proxy, gunicorn,
  banco, Google Sheets).
- `docs/deploy/ROTEIRO_VPS_ueato.md` — roteiro operacional do domínio.
- `docs/deploy/ENV_PRODUCAO_ueato.md` — variáveis do ambiente de produção (só
  nomes e descrições; nenhum valor secreto).
- `docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md` — pendências operacionais
  abertas, com o passo a passo de cada uma.
- `docs/architecture/estrategia-auditoria.md` — base para os eventos de
  auditoria referenciados nas seções de segurança/monitoramento.
- `docs/permissions/matriz-permissoes.md` — base para as regras de acesso a
  rotas administrativas referenciadas na seção de segurança.
