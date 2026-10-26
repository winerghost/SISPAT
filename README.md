# SISPAT-AGU

Sistema de Gestão Patrimonial da **Advocacia-Geral da União (AGU)** — unidade
**Palmas/TO**.

> **Status atual: Fase 1 — banco de dados, modelagem e permissionamento em
> andamento.** Frontend e demais fases ainda não foram iniciados
> [Documentação local](#documentação-local-não-versionada)).

## Visão geral

O SISPAT-AGU controla o inventário patrimonial da unidade, com:

- **Backend:** Python, Flask, SQLAlchemy 2.x e Alembic (migrações
  versionadas). Toda regra de negócio e validação crítica vive aqui.
- **Frontend:** Next.js, React e TypeScript (fase futura — ainda não
  implementado; o frontend é camada de apresentação, nunca mecanismo de
  segurança).
- **Banco de dados:** Supabase/PostgreSQL remoto e gerenciado é a fonte
  operacional de verdade. Não há banco de produção local neste repositório.
- **Credencial do Google Sheets no Docker:** o JSON da service account fica
  FORA do repositório; defina `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` no `.env`
  (caminho do host) e o Compose o monta como secret somente leitura em
  `/run/secrets/google_sheets_credentials.json` (backend e worker), sobrepondo
  `GOOGLE_SHEETS_CREDENTIALS_JSON` no container. Fora do Docker, use essa
  última com o caminho do host. Ver `docs/deployment/checklist-deploy-vps.md`.
- **Integrações:** Google Sheets API (importação inicial, unidirecional:
  Sheets → Flask → PostgreSQL) e n8n **externo** (instância já existente,
  administrada fora deste repositório — este projeto não instala nem roda
  n8n localmente; o backend apenas consome essa instância via HTTP, sempre
  por APIs autenticadas, e nunca substitui as regras do backend).
- **Infraestrutura:** Docker Compose, com `backend`/`worker`/`redis`
  segregados em rede interna. Não há reverse-proxy público neste
  repositório — na VPS (Hostinger), o CloudPanel (com seu próprio Nginx)
  assume esse papel, incluindo terminação TLS (ver
  `infra/cloudpanel/vhost.conf.example`).
- **Permissões:** RBAC com perfis `ADM`, `USER` e `RH`, com escopo por
  unidade e, quando aplicável, por campo. O backend valida autorização em
  toda operação; nega por padrão.

**Estes dois arquivos são documentos de governança imutáveis: não devem ser
substituídos, recriados ou modificados sem autorização explícita.** Qualquer
alteração de infraestrutura ou código deve respeitar o que está definido
neles. Ambos são mantidos localmente, fora do repositório (ver
[Documentação local](#documentação-local-não-versionada)).

## Documentação local (não versionada)

Os itens abaixo ficam **somente na máquina do desenvolvedor** (estão no
`.gitignore`):

- `CLAUDE.md`, `DESIGN.md` e a pasta `.claude/` (agentes, skills e settings
  locais do Claude Code), além de `.agents/skills/` — guias de trabalho do
  desenvolvedor.
- `docs/security/SECURITY_AUDIT.md`, `docs/security/evidence/` e
  `docs/security-audit/` — relatórios de segurança com detalhes de
  vulnerabilidades (inclusive pendentes de correção), PoCs e caminhos de
  exploração.

Consequência prática: quem clonar o repositório (inclusive a VPS, atualizada
via `git pull`) **não terá esses arquivos**. A consulta à auditoria de
segurança exigida antes de implantar é feita **na máquina do desenvolvedor**,
não na VPS.

## Como subir o ambiente de desenvolvimento

Pré-requisitos: Docker Desktop (ou Docker Engine + Compose v2.24+) instalado.

### Windows / PowerShell

```powershell
.\scripts\init.ps1
```

### Linux / macOS / Git Bash

```bash
./scripts/init.sh
```

O script copia `.env.example` para `.env` (se ainda não existir) e sobe os
containers combinando `docker-compose.yml` (base) com `docker-compose.dev.yml`
(overrides de desenvolvimento: hot-reload, bind mounts, portas de debug em
localhost). **Edite o `.env` com as credenciais reais antes de usar** — o
arquivo nunca deve ser versionado.

Para verificar o status/healthcheck dos serviços:

```powershell
.\scripts\verify.ps1      # Windows
```

```bash
./scripts/verify.sh       # Linux/macOS/Git Bash
```

> O banco de dados de desenvolvimento local (`postgres-dev`, no
> `docker-compose.dev.yml`) é **opcional** e serve apenas para testar
> migrations isoladamente, sem tocar o Supabase remoto. Ele **não é** a
> fonte de verdade do sistema e só é iniciado com
> `--profile dev-db`.

> Este projeto **não** instala nem inicializa um n8n local — não há
> serviço `n8n` nos composes nem pasta de workflows no repositório. O
> backend consome a instância de n8n **externa** já existente via HTTP
> (`backend/app/integrations/n8n_client.py`; ver `.env.example` para as
> variáveis `N8N_*`).

## Acesso em produção (VPS + CloudPanel)

Em produção (VPS Hostinger), este `docker-compose.yml` **não** publica
nenhuma porta pública diretamente — `backend` e `frontend` publicam suas
portas (`BACKEND_PORT`/`FRONTEND_PORT`, padrões 8000/3000) somente em
`127.0.0.1`, na mesma VPS. O **CloudPanel** (com seu próprio Nginx) é quem
recebe o tráfego público nas portas 80/443, termina TLS e encaminha para
essas portas locais. Veja o modelo de configuração do vhost em
[`infra/cloudpanel/vhost.conf.example`](./infra/cloudpanel/vhost.conf.example)
— um exemplo de referência para quando o site for cadastrado no CloudPanel,
**não** uma configuração real de servidor.

### Preparo de implantação (domínio `ueato.revizzicar.com.br`, 2026-10-19)

Implantação feita pelo responsável, passo a passo; nada é implantado sem
autorização explícita. Documentos:

- [`docs/deploy/ROTEIRO_VPS_ueato.md`](./docs/deploy/ROTEIRO_VPS_ueato.md) —
  comandos em ordem, verificações pós-subida e rollback.
- [`docs/deploy/ENV_PRODUCAO_ueato.md`](./docs/deploy/ENV_PRODUCAO_ueato.md) —
  variáveis de produção (só nomes; em produção CORS e redirects de convite
  precisam ser `https://`, senão o backend não inicia).
- [`docs/deployment/checklist-deploy-vps.md`](./docs/deployment/checklist-deploy-vps.md) —
  checklist canônico.
- Revisões: `docs/security/REVISAO_AUTHZ_2026-10-19.md`,
  `REVISAO_INFRA_2026-10-19.md` e `REVISAO_POS_CORRECOES_2026-10-19.md`.

Nginx não emite cabeçalhos de segurança (Next.js e Flask emitem; tabela no
vhost).

### Implantado (2026-10-20)

- Em produção em `https://ueato.revizzicar.com.br` (VPS Hostinger, CloudPanel,
  Cloudflare com "Allow traffic from Cloudflare only"). Containers `backend`,
  `frontend` e `redis` saudáveis; portas `127.0.0.1:8110` (API) e
  `127.0.0.1:3110` (site).
- Vhost em uso: [`infra/cloudpanel/vhost.ueato-cloudpanel.conf`](./infra/cloudpanel/vhost.ueato-cloudpanel.conf);
  as diferenças em relação ao modelo estão no roteiro (seção 5).
- Alembic carimbado em `0011_dashboard_charts_prefs` (IDs encurtados para
  caber em `varchar(32)`; ver `docs/database/historico-migracoes.md`).
- Verificado de fora: `/api/health` ok e cada cabeçalho de segurança emitido
  uma única vez.
- Pendências: teste completo no navegador (login ADM com MFA, dashboard);
  Supabase Auth (template de convite, SMTP próprio, senhas vazadas, remover
  Redirect URLs de localhost); trivy; limite de 100 s da Cloudflare na prévia
  do Sheets; worker Celery; `set_real_ip_from 0.0.0.0/0` global do CloudPanel
  (afeta os outros sites da VPS).

### Dashboard: gráficos personalizáveis (2026-10-20)

- Gráficos com **Nivo 0.99** (`@nivo/bar`, `@nivo/pie`, `@nivo/line`), que
  substituiu o Recharts. O Tremor foi avaliado e descartado porque exige React 18.
  O tema único fica em `frontend/src/components/dashboard/chart-theme.ts`
  (cores do DESIGN.md), com `animate={false}`.
- Cada usuário escolhe o tipo de cada painel (unidades: agrupado/empilhado/
  horizontal; situação: pizza/rosca/barras; mensal: linha/área/barras). A
  escolha fica em `user_preferences.dashboard_charts` (`GET`/`PATCH
  /api/v1/me/preferences`), validada no backend. Detalhes em
  `docs/ux/DASHBOARD_GRAFICOS.md`.
- Migração Alembic `0011_dashboard_charts_prefs` (espelho
  `sql/0014`) aplicada no Supabase e carimbada no deploy de 2026-10-20.
- Revisão: `docs/security/REVISAO_DASHBOARD_NIVO_2026-10-20.md` (L-1 corrigido;
  L-2 e `npm dedupe` ficaram para depois do deploy).

### Vínculo do bem e filtros do dashboard (2026-10-20)

- **Vínculo** (`assets.bond_status`): recebe o valor da 1ª coluna
  `RESPONSAVEL` da planilha (ex.: "Ocioso", "Servidor"); a 2ª coluna é a
  pessoa responsável. Só é lido quando a planilha tem exatamente 2 colunas
  `RESPONSAVEL` (senão a prévia mostra um aviso). Filtro, ordenação e coluna em
  Patrimônios; `GET /api/v1/assets/bond-statuses`. Migração
  `0012_asset_bond_status` (espelho `sql/0015`) já aplicada no Supabase; no
  deploy basta `alembic stamp 0012_asset_bond_status`.
- **Dashboard personalizável:** cada usuário exibe o que é do seu interesse.
  Filtros na URL (unidade, unidade dona, sala, responsável, localizado S/N,
  vínculo, tipo, período de registro, inventário, com/sem sala, com/sem
  responsável, movimentação pendente) valem para todos os painéis e para o
  relatório imprimível, que lista os filtros no cabeçalho. Painéis novos:
  localização por unidade, vínculo, pendências de cadastro, por sala,
  inventário e tipos. Detalhes em `docs/ux/DASHBOARD_PERSONALIZACAO.md` e
  `docs/architecture/dashboard-api.md`.
- Revisão: `docs/security/REVISAO_VINCULO_FILTROS_2026-10-20.md` (SEC-VF-01
  corrigido; SEC-VF-02 pendente; `certifi` 2026.10.19 aplicado em 2026-10-21).
- **Importação de Bens:** só depois do deploy desta versão.

### Painéis de Tecnologia no dashboard (2026-10-22)

- Seis painéis novos (`/dashboard/tecnologia/*`: indicadores, categoria, por unidade,
  situação operacional, sem responsável e tempo desde o registro) + exportação
  CSV/XLSX agregada (`csv_safety`, auditada). Só contagens (RH sem dados pessoais).
  Contrato: `docs/architecture/dashboard-api.md`; UX: `docs/ux/DASHBOARD_PERSONALIZACAO.md`.
- Migração `0015_asset_tech_classification` (espelho `backend/migrations/sql/0018_*.sql`):
  **PENDENTE, NÃO aplicada** (Supabase único: dev = prod). Só com autorização: executar
  o espelho no SQL Editor e depois `alembic stamp 0015_asset_tech_classification`.
- Classificação inicial: `flask classify-assets` (dry-run por padrão; `--apply` grava;
  `--list-unclassified` só lê e lista id + descrição truncada dos bens sem regra).
  Correção manual: PATCH `/assets/<id>` (ADM/USER, escopo, `version`) e tela de
  edição do bem (categoria, tipo de TI, situação operacional).
  A importação preenche categoria/tipo só quando nulos. Não há garantia nem idade do
  equipamento: "tempo desde o registro" usa a data de cadastro do bem.
- Rebuild: backend + frontend.

### Painéis personalizáveis, recuperação de senha e expurgo (2026-10-21)

- **Personalizar painéis:** cada usuário mostra/oculta e reordena os painéis
  do dashboard (`user_preferences.dashboard_layout`, migração
  `0013_dashboard_layout_prefs`, espelho `sql/0016`, aplicada no Supabase em
  2026-10-21; no deploy, `alembic stamp 0013_dashboard_layout_prefs`). O
  relatório imprimível segue a mesma ordem.
- Tipo de gráfico também em localização, vínculo e salas; clicar num item do
  gráfico aplica o filtro na URL (de novo, remove); no celular a barra de
  filtros é recolhível.
- **Recuperação de senha:** `/ativar-conta` com `type=recovery` só redefine a
  senha (não chama `activate-invite`), encerra a sessão e leva ao login. Trocar
  o template "Reset Password" do Supabase só depois do rebuild do frontend
  (ver `docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`).
- **Expurgo de prévias:** `flask purge-import-previews --older-than-days N
  [--dry-run]` apaga prévias antigas e seus itens (nunca `raw_import_records`)
  e grava `IMPORT_PREVIEWS_PURGED` com origem `cli`.
- `certifi` atualizado para 2026.10.19 (PYSEC-2026-4320). Revisão de
  segurança: `docs/security/SECURITY_AUDIT.md`, seção 17.

## Estrutura de pastas

```
SISPAT-AGU/
├── backend/                 # API Flask (modelos, rotas, serviços, migrações)
│   └── Dockerfile
├── frontend/                 # Next.js (fase futura — esqueleto mínimo)
│   ├── Dockerfile
│   └── src/{app,components,features,lib}/
│                              # app/(publico): /login e /ativar-conta (tela
│                              # autônoma, sem menu); app/(app): shell + rotas
│                              # autenticadas (URLs inalteradas)
├── infra/
│   └── cloudpanel/           # Modelo de vhost Nginx para o CloudPanel
│                              # (infra/cloudpanel/vhost.conf.example)
├── scripts/                  # init/verify (.sh e .ps1)
├── docs/                     # Documentação complementar do projeto
├── docker-compose.yml        # Serviços base (produção)
├── docker-compose.dev.yml    # Overrides de desenvolvimento
├── .env.example               # Modelo de variáveis de ambiente (sem valores reais)
└── README.md
```

> `DESIGN.md`, `CLAUDE.md` e `.claude/` existem apenas na máquina local do
> desenvolvedor e não aparecem em um clone do repositório.

## Segurança

- Nenhuma credencial real é versionada; tudo via `.env` (gitignored).
- Nenhuma porta de banco de dados é exposta publicamente pelos composes.
- `SUPABASE_SERVICE_ROLE_KEY` nunca deve chegar ao frontend/navegador.
- As variáveis `N8N_*` (instância externa) nunca devem chegar ao
  frontend/navegador — uso exclusivo do backend, e com
  `N8N_INTEGRATION_ENABLED=false` por padrão.
- `backend` e `frontend` publicam porta própria somente em `127.0.0.1` (ver
  `BACKEND_PORT`/`FRONTEND_PORT` em `.env.example`) — nunca em `0.0.0.0`.
  TLS/HTTPS real e o roteamento público são responsabilidade do CloudPanel
  (Nginx próprio) na VPS, fora deste repositório (ver
  `infra/cloudpanel/vhost.conf.example`).
- `REDIS_PASSWORD` é obrigatório; o worker Celery só sobe com `--profile worker`.

### Auditoria e verificações (2026-10-13)

Relatório completo: `docs/security/SECURITY_AUDIT.md`, com evidências por
frente em `docs/security/evidence/` — ambos mantidos localmente, fora do
repositório (ver [Documentação local](#documentação-local-não-versionada)).
Scripts (Git Bash/Linux):

| Script                                 | O que faz                                                  |
| -------------------------------------- | ---------------------------------------------------------- |
| `scripts/test-backend.sh [--venv]`     | pytest + cobertura (use `--venv` para um ambiente isolado) |
| `scripts/test-frontend.sh`             | lint, typecheck e build do Next                            |
| `scripts/test-responsive.sh`           | Playwright: 9 resoluções + axe (WCAG 2.2 AA)               |
| `npx playwright test --project=scroll` | rolagem única da página (ver `docs/ux/LAYOUT_ROLAGEM.md`)  |
| `scripts/security-audit.sh [--strict]` | bandit, pip-audit, npm audit, gitleaks, semgrep, trivy fs  |
| `scripts/check-dependencies.sh`        | dependências desatualizadas/vulneráveis                    |

Dependências Python: `backend/requirements.txt` (pins exatos), `backend/requirements.lock`
(hashes, usado no Docker) e `backend/requirements-dev.txt` (testes/ferramentas). Para
regenerar o lock: `scripts/check-dependencies.sh --lock`.
CI: `.github/workflows/ci.yml` (sem deploy) + `.github/dependabot.yml`.

Next.js está em `15.5.28` (corrige GHSA-2464-fhr4-w9xw e GHSA-p3m5-59mp-jv5r); histórico em
`docs/security/HISTORICO_DEPENDENCIAS.md`.

### Estado do banco de produção (Supabase `tocbtonqnahmtegfkrmn`, 2026-10-14)

- Alembic aplicado até `0005_settings_ai_users` (verificado em 2026-10-14:
  colunas novas de `users`, `ai_settings`/`user_preferences` com RLS e sem grants
  para `anon`/`authenticated`, IA desligada).
- `migrations/sql/0008_storage_avatars.sql` (bucket privado `avatars` do Storage)
  **NÃO aplicado**; requer autorização. Sem ele, as rotas de foto respondem 503
  `storage_unavailable` e o resto do sistema segue normal.
- Seeds SQL `0002` (roles/permissions) e `0005` (permissões de gestão de
  usuários/segurança) aplicados.
- Primeiro ADM criado por bootstrap (Supabase Auth + `users` + `user_roles` +
  `user_unit_access` + `audit_logs` com `BOOTSTRAP_FIRST_ADMIN`), sem expor
  dados pessoais além do necessário.
- 4 unidades: 023401 PF, 023402 PU, 023403 CJU, 023404 UEA.

Cadeia e mapeamento Alembic ↔ SQL: `backend/README.md`. Notas sobre os dois
históricos de migração: `docs/database/historico-migracoes.md`.

### Bootstrap do primeiro ADM (passos genéricos)

1. Criar o usuário no Supabase Auth (painel/API de admin, com a Service Role
   Key apenas no backend), sem senha em log ou repositório.
2. Inserir o registro em `users` com `auth_user_id` do Auth.
3. Vincular o papel ADM em `user_roles` e as unidades em `user_unit_access`.
4. Registrar o evento `BOOTSTRAP_FIRST_ADMIN` em `audit_logs`.
5. No primeiro login, cadastrar o MFA (TOTP); rotas administrativas exigem AAL2.
   A própria tela de login tem a etapa **"enroll"**: se o usuário exige MFA e
   não tem fator verificado, exibe QR code e chave manual, pede o código de 6
   dígitos e só então segue para o painel (aal2 confirmado pelo `/me`). O
   segredo/QR ficam apenas em memória; "Voltar" remove o fator pendente e
   encerra a sessão parcial. A decisão de acesso continua no backend.

### Tela de login

Tela única em `app/(publico)/login` (sem sidebar/header), com logo da AGU
centralizada sobre o painel claro do Design System, etapas
credenciais → MFA (ou cadastro do primeiro fator) e rodapé "Acesso apenas por
convite" (sem cadastro público nem "esqueci a senha").

### Subida local (desenvolvimento)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

- Abra sempre por `http://127.0.0.1:3000` (não `localhost`).
- `FRONTEND_MEMORY=2G` é somente para dev; **nunca** em produção.

## Gestão de usuários

Cadastros de apoio (CRUD de salas, pessoas responsáveis e edição de unidades; só ADM escreve, "excluir" = inativar): [`docs/architecture/cadastros-apoio-api.md`](./docs/architecture/cadastros-apoio-api.md). Listagem de cadastro de unidades (ativas e inativas, ADM + AAL2 + `units.update`): `GET /api/v1/units/catalog` (`q`, `active=true|false|all`, `sort`, `page`, `page_size`); `GET /api/v1/units` (seletor) não mudou.

Patrimônios (`/api/v1/assets`: listagem/detalhe/histórico, criação, edição com `version`, exclusão lógica `POST /<id>/delete` e `/restore`, com escopo de unidade e campos por perfil; RH nunca recebe `notes`): [`docs/architecture/assets-api.md`](./docs/architecture/assets-api.md). `GET /api/v1/units/accessible` lista as unidades do escopo do usuário (qualquer perfil com `units.read`) para os seletores.

Movimentações (`/api/v1/movements`: solicitar, aprovar/rejeitar só ADM+AAL2, cancelar, listar/detalhar; histórico imutável, aprovação atômica com `version` do bem): [`docs/architecture/movements-api.md`](./docs/architecture/movements-api.md).

APIs administrativas de leitura (ADM + AAL2, sem escrita): `GET /api/v1/admin/audit-logs[/<id>]` (`audit.read`; projeção em allowlist, sem PII/segredos, escopo de unidade, janela máx. 90 dias, grava `AUDIT_VIEWED`), `GET /api/v1/admin/roles` e `/permissions` (`roles.manage`), `GET /api/v1/admin/unit-access` (`users.manage`): [`docs/architecture/admin-read-api.md`](./docs/architecture/admin-read-api.md).

Relatórios e exportações (`GET /api/v1/reports` catálogo; `GET /api/v1/reports/<assets|movements|inventory-items>/export?format=csv|xlsx`, permissões `reports.read`/`exports.create`, escopo de unidade, bens excluídos fora, máx. 10 000 linhas, células à prova de formula injection e número patrimonial sempre texto, auditoria `REPORT_EXPORTED`; XLSX sem dependência nova): [`docs/architecture/reports-api.md`](./docs/architecture/reports-api.md).

Inventários (`/api/v1/inventories`: campanhas de conferência por unidade; criar/iniciar/encerrar/cancelar só ADM+AAL2, conferir bens ADM/USER, resumo calculado no servidor; encerramento imutável; não altera `assets.located`) e locais (`GET /api/v1/locations`, somente leitura): [`docs/architecture/inventories-api.md`](./docs/architecture/inventories-api.md).

Tela **Administração → Usuários** (ADM com MFA/AAL2) e **Configurações → Perfil**
(qualquer usuário). Contrato em
[`docs/architecture/modulo-configuracoes.md`](./docs/architecture/modulo-configuracoes.md)
(Etapa 2).

- **Lista:** busca por nome/e-mail, filtros de perfil, unidade e situação, ordenação
  por allowlist e paginação. O ADM só vê usuários das suas unidades (e contas sem
  unidade); alvo alheio, inexistente ou malformado → mesmo 404.
- **Detalhe:** perfil e unidades (checkboxes), conta (desativar/reativar, encerrar
  sessões, e-mail de redefinição de senha, reset de MFA), foto e histórico de auditoria.
- **Regras no backend:** controle otimista (`version`), sem auto-alteração, nunca
  remove o último ADM, promover/rebaixar ADM exige confirmação. Mudanças de privilégio,
  desativar ADM e reset de MFA exigem que **todas** as unidades do alvo estejam no
  escopo de quem executa (`target_out_of_scope`).
- **Sessões:** "encerrar sessões", desativar e reset de MFA gravam
  `users.sessions_revoked_at`; o backend recusa JWTs emitidos antes disso.
- **Reset de MFA:** exige que o ADM tenha confirmado o TOTP há no máximo 5 minutos
  (claim `amr`; validar o formato num projeto de homologação).
- **Redefinição de senha:** `PASSWORD_RESET_REDIRECT_URL` deve estar em
  `INVITE_ALLOWED_REDIRECT_URLS`; o ADM nunca vê link nem senha.
- **Foto:** até 2 MiB, JPEG/PNG/WebP validados pelos bytes, recodificada para WebP
  512×512 sem metadados (Pillow), guardada no bucket privado `avatars` e exibida por
  URL assinada de 5 min. No Nginx, só as rotas de foto aceitam `client_max_body_size 3m`
  (`infra/cloudpanel/vhost.conf.example`).

## Inteligência Artificial (opcional, desligada por padrão)

A IA é **consultiva e somente leitura**: nunca altera dados nem executa ações. Contrato da API em
[`docs/architecture/modulo-configuracoes.md`](./docs/architecture/modulo-configuracoes.md).

- **Provedores:** OpenAI, Anthropic e DeepSeek, via HTTPS direto do backend
  (`backend/app/services/ai/`), sem SDKs. Os modelos aceitos são uma allowlist em
  `services/ai/models.py`. O DeepSeek exige aceite explícito do ADM sobre transferência
  internacional de dados (LGPD), registrado em auditoria.
- **Chaves:** só no `.env` do backend (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `DEEPSEEK_API_KEY`). Nunca vão para banco, API, log ou frontend; a tela mostra apenas
  "Configurada"/"Não configurada".
- **Interruptor geral:** `AI_ENABLED=false` (padrão) desliga tudo, independentemente do que
  estiver salvo no banco. Limites: `AI_TIMEOUT_SECONDS`, `AI_MAX_TOKENS`,
  `AI_RATE_LIMIT_PER_USER`, `AI_RATE_LIMIT_PER_UNIT`, `AI_MONTHLY_TOKEN_CAP`,
  `AI_CIRCUIT_FAILURE_THRESHOLD`, `AI_CIRCUIT_OPEN_SECONDS` (ver `.env.example`).
- **Degradação graciosa:** sem chave, chave inválida, timeout, cota esgotada, Redis fora ou
  provedor fora do ar → o `NullProvider` assume e o sistema segue normalmente.
- **Privacidade:** só dados agregados e patrimoniais são enviados; uma varredura bloqueia o
  envio se encontrar CPF, e-mail, telefone ou tokens. Dados importados vão delimitados como
  dados, nunca como instruções.
- **Tela:** Configurações → Inteligência Artificial (somente ADM com MFA/AAL2).
- **Worker:** tarefas de IA rodam no Celery (`app/celery_app.py`), com agendador embutido
  (`worker -B`); suba com `--profile worker`.

## Estado da interface e pendências (2026-10-21)

- **Home** sem selo "Fase 1", com atalho (`DashboardShortcut`) para `/dashboard`.
- **Menu:** selo "Em breve" (campo `comingSoon`) em Integrações e Configurações do Sistema.
- **Telas reais novas:** `/administracao/auditoria` (`GET /admin/audit-logs`),
  `/administracao/vinculos-unidades` (`GET /admin/unit-access`, somente leitura) e
  `/relatorios` (exportação CSV/XLSX via `/api/v1/reports` e `/reports/<kind>/export`;
  `requestFile` em `api-client.ts`). API: `docs/architecture/reports-api.md`.
- **Filtros de data:** `created_from/created_to` (movimentações e relatórios) e
  `checked_from/checked_to` (itens de inventário) são dia civil em America/Araguaina,
  convertido para UTC (`app/services/local_dates.py`); `GET /movements` ganhou `movement_type`.
- **Verificado sem mudança:** cancelar movimentação existe; inventários não usam `version`
  nas transições.
- **Pendências:**
  - Rebuild: `docker compose build backend frontend && docker compose up -d backend frontend`.
  - `test-responsive.sh --all` e build de produção ainda não rodados em ambiente ocioso.
  - Stubs sem API: Integrações e Configurações do Sistema.
  - Exportação ainda não está nos menus Patrimônios/Movimentações/Inventários (só em Relatórios).
  - AUD-14-01: decisão de negócio pendente.
  - Checklist operacional de convite: templates Supabase, SMTP, redirect URLs,
    `INVITE_ALLOWED_REDIRECT_URLS`, MFA, certifi (`docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`).
  - Importação de Bens bloqueada por: stamp da migração 0013, limite de 100 s da Cloudflare
    e SEC-1021-01.

## Fases do projeto

1. **Fase 1 (concluída):** banco de dados, modelagem e permissionamento.
2. **Em andamento:** importação do Google Sheets, MFA/convite, UX e o módulo de
   Configurações (IA, Aparência, Gestão de Usuários) — ver `CLAUDE.md` (mantido localmente).
   Etapas 1 (IA), 2 (usuários) e 3 (Aparência: `/me/preferences`, cookie `sispat-ui`,
   `/configuracoes/aparencia`) e 4 (alertas determinísticos `/dashboard/alerts`, insights
   `/ai/insights` e assistente `/ai/ask`, ADM + AAL2) concluídas. Evidências em
   `docs/security/evidence/settings-module-etapa*.md`.
   API de importação dos cadastros (`/api/v1/catalog-imports`, ADM + AAL2) e `GET
/imports/google-sheets/<id>/pending`: ver `docs/architecture/cadastros-apoio-api.md`. A confirmação de bens (`POST /imports/google-sheets/confirm`) segue o mesmo contrato dos cadastros (status CONCLUIDO/PARCIAL/FALHOU, inalterados, não gravados, falhas_total, resposta degradada pós-commit com `degraded=true`).

### Contrato de paginação (todas as listagens da API v1)

`page` ≥ 1 (padrão 1) e `page_size` SOMENTE 50, 100 ou 200 (padrão 50); qualquer outro valor (25, 0, 500...) => 400. Resposta: `{total, page, page_size, pages, <itens>}` (`pages` = ceil(total/page_size), 0 se vazio). Definição única em `backend/app/services/pagination.py`; ordenação sempre com desempate por `id`. A busca (`q`/`search`) é sem caixa e sem acento (`app/security/text_search.py`: `sispat_unaccent(coluna) ILIKE :padrão`, escape de `%`/`_`). Exige a migração `0014_unaccent_search` (espelho `backend/migrations/sql/0017_unaccent_search.sql`; extensão no schema `extensions` e wrapper `SECURITY INVOKER` com `search_path = extensions, pg_catalog` e chamada qualificada `extensions.unaccent`), NÃO aplicada em produção: aplicar ANTES do deploy do backend.

### Busca de bens (`GET /api/v1/assets?q=`)

O termo é dividido em tokens (qualquer espaço, inclusive NBSP; máx. 8; tokens só de pontuação são ignorados, exceto se todos forem). Todos os tokens devem casar (AND, qualquer ordem); cada token casa (OR) em número patrimonial, descrição, `source_record_id`, nome do responsável e nome da sala (estes dois via `EXISTS`, sem JOIN, só para bens já no escopo do usuário; vínculos nulos nunca casam). Sem caixa e sem acento nos DOIS lados (`sispat_unaccent` aplicado também ao termo, no banco), com `%`, `_` e `\` literais. Tokens com dígito também casam pela chave alfanumérica do número (`sispat_alnum_key`: minúsculas, sem acento/pontuação/espaços/NBSP): `AGU-123`, `12.345`, `AB 123` encontram `AGU123`, `12345`, `AB-123`. Índice trigram funcional `ix_assets_patrimony_key_trgm` na migração 0016 (espelho `backend/migrations/sql/0019_asset_search_key.sql`, PENDENTE DE APLICAÇÃO; aplicar antes do deploy do backend). O filtro `unit_id` é a unidade alocadora (`Asset.unit_id`; `owner_unit_id` tem filtro próprio), enquanto o escopo de acesso é unit OU owner. A ordenação por `patrimony_number` é lexicográfica (texto): `"10"` vem antes de `"9"`. Testes: `backend/tests/test_assets_search.py`.

### Importação de bens: lotes e reconciliação
`POST /imports/google-sheets/confirm` aceita `select_all_eligible` e `excluded_item_ids`
(seleção no servidor) e grava em lotes de 100; `GET /imports/google-sheets/<id>/reconciliation`
(ADM, AAL2, só leitura) lista os itens da prévia que não viraram bem, com motivo. Ver
`docs/architecture/cadastros-apoio-api.md`.
