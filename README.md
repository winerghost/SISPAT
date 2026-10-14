# SISPAT-AGU

Sistema de Gestão Patrimonial da **Advocacia-Geral da União (AGU)** — unidade
**Palmas/TO**.

> **Status atual: Fase 1 — banco de dados, modelagem e permissionamento em
> andamento.** Frontend e demais fases ainda não foram iniciados (ver
> `CLAUDE.md`).

## Visão geral

O SISPAT-AGU controla o inventário patrimonial da unidade, com:

- **Backend:** Python, Flask, SQLAlchemy 2.x e Alembic (migrações
  versionadas). Toda regra de negócio e validação crítica vive aqui.
- **Frontend:** Next.js, React e TypeScript (fase futura — ainda não
  implementado; o frontend é camada de apresentação, nunca mecanismo de
  segurança).
- **Banco de dados:** Supabase/PostgreSQL remoto e gerenciado é a fonte
  operacional de verdade. Não há banco de produção local neste repositório.
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

## Documentos de governança

- [`DESIGN.md`](./DESIGN.md) — fonte oficial do Design System ("Factory",
  tema dark) para quando o frontend for implementado.
- [`CLAUDE.md`](./CLAUDE.md) — regras de arquitetura, segurança, permissões
  e fases do projeto.

**Estes dois arquivos são documentos de governança imutáveis: não devem ser
substituídos, recriados ou modificados sem autorização explícita.** Qualquer
alteração de infraestrutura ou código deve respeitar o que está definido
neles.

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

## Estrutura de pastas

```
SISPAT-AGU/
├── backend/                 # API Flask (modelos, rotas, serviços, migrações)
│   └── Dockerfile
├── frontend/                 # Next.js (fase futura — esqueleto mínimo)
│   ├── Dockerfile
│   └── src/{app,components,features,lib}/
├── infra/
│   └── cloudpanel/           # Modelo de vhost Nginx para o CloudPanel
│                              # (infra/cloudpanel/vhost.conf.example)
├── scripts/                  # init/verify (.sh e .ps1)
├── docs/                     # Documentação complementar do projeto
├── docker-compose.yml        # Serviços base (produção)
├── docker-compose.dev.yml    # Overrides de desenvolvimento
├── .env.example               # Modelo de variáveis de ambiente (sem valores reais)
├── DESIGN.md                  # Design System — imutável sem autorização
├── CLAUDE.md                  # Regras de arquitetura/governança — imutável sem autorização
└── README.md
```

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

Relatório completo: [`docs/security/SECURITY_AUDIT.md`](docs/security/SECURITY_AUDIT.md)
(evidências por frente em `docs/security/evidence/`). Scripts (Git Bash/Linux):

| Script | O que faz |
|---|---|
| `scripts/test-backend.sh [--venv]` | pytest + cobertura (use `--venv` para um ambiente isolado) |
| `scripts/test-frontend.sh` | lint, typecheck e build do Next |
| `scripts/test-responsive.sh` | Playwright: 9 resoluções + axe (WCAG 2.2 AA) |
| `scripts/security-audit.sh [--strict]` | bandit, pip-audit, npm audit, gitleaks, semgrep, trivy fs |
| `scripts/check-dependencies.sh` | dependências desatualizadas/vulneráveis |

Dependências Python: `backend/requirements.txt` (pins exatos), `backend/requirements.lock`
(hashes, usado no Docker) e `backend/requirements-dev.txt` (testes/ferramentas). Para
regenerar o lock: `scripts/check-dependencies.sh --lock`.
CI: `.github/workflows/ci.yml` (sem deploy) + `.github/dependabot.yml`.

**Impedimento à homologação:** a migração `0004_db_security_hardening` e as migrações
0002/0003/0005 **não estão aplicadas em produção** (ver §11 do relatório).

## Fases do projeto

1. **Fase 1 (atual):** banco de dados, modelagem e permissionamento.
2. Fases seguintes (frontend, integrações completas, etc.) só começam após
   a Fase 1 ser validada — ver `CLAUDE.md`.
