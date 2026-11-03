# SISPAT-AGU

Sistema de Gestão Patrimonial da **Advocacia-Geral da União (AGU)** — unidade
**Palmas/TO**.

> **Status atual (2026-10-29): Fase 1 (banco, modelagem e permissionamento)
> concluída.** O sistema está em produção em `https://ueato.revizzicar.com.br`,
> com a imagem implantada em **2026-10-29** (commits `be2a16c` e `6823803`):
> convite à prova de scanner, exclusão lógica + anonimização de usuário, filtros
> de relatório por sala/responsável/vínculo, correções do `/ativar-conta` e
> logomarca do cabeçalho público. **A validação funcional pelo responsável ainda
> NÃO está confirmada.**
>
> Banco: `alembic_version` = `0019_user_soft_delete`, igual à head do código
> (cadeia linear 0001→0019) — ver
> [Estado do banco de produção](#estado-do-banco-de-produção-supabase-tocbtonqnahmtegfkrmn-2026-10-29).
> Em andamento: MFA/convite e UX. A importação do Google Sheets **já foi
> executada**: 1.069 Bens em produção, última sincronização em 2026-10-29 com
> 0 novos e 1.069 existentes — ver
> [Acervo importado](#acervo-importado-conferido-em-2026-11-01).
>
> As seções datadas abaixo são **histórico por onda** e foram preservadas como
> tal: o estado de hoje é o deste bloco somado à seção de banco. Nada é
> implantado em produção sem autorização explícita
> ([Documentação local](#documentação-local-não-versionada)).

## Visão geral

O SISPAT-AGU controla o inventário patrimonial da unidade, com:

- **Backend:** Python, Flask, SQLAlchemy 2.x e Alembic (migrações
  versionadas). Toda regra de negócio e validação crítica vive aqui.
- **Frontend:** Next.js, React e TypeScript (implementado em `frontend/`; é
  camada de apresentação, nunca mecanismo de segurança).
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

**`CLAUDE.md` e `DESIGN.md` são documentos de governança imutáveis: não devem
ser substituídos, recriados ou modificados sem autorização explícita.** Qualquer
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

### Implantado (2026-10-29) — estado atual

Implantação feita pelo responsável, com autorização explícita. A `main` foi
levada até `6823803`; o lote entregou:

- **Convite à prova de scanner** (`backend/app/services/invite_delivery.py` +
  `generate_invite_token_hash` em `app/integrations/supabase_admin_client.py`):
  o backend monta e envia o e-mail com `?token_hash=...&type=invite` apontando
  para `/ativar-conta`, em vez de usar o `POST /auth/v1/invite` (cujo link de
  uso único era consumido por scanner de antivírus de e-mail). Mesmo desenho já
  validado no reset de senha. Motivo e evidência:
  [`docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`](./docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md).
- **Exclusão lógica + anonimização de usuário:**
  `POST /api/v1/users/<id>/delete` (ADM + AAL2 + `users.delete`, corpo
  `{version, confirm_text}` com `extra="forbid"`), em
  `app/services/user_deletion_service.py`. A linha de `users` nunca é removida;
  `name`/`email`/`phone`/`avatar_object_key`/`auth_user_id` são anonimizados
  (e-mail substituído por endereço único e não roteável em `.invalid`) e
  `audit_logs` continua intacto, com `actor_user_id` preservado. Recusa
  autoexclusão, último ADM, conflito de `version` e alvo fora do escopo; alvo
  inexistente, malformado, de outra unidade ou já excluído devolvem o **mesmo**
  404. Tela: `Administração → Usuários` (diálogo que exige digitar o e-mail do
  alvo).
- **Filtros de relatório:** `room_id`, `responsible_person_id` e `bond_status`
  deixaram de ser campo livre no catálogo (`app/services/report_catalog.py`
  declara `type` `room`, `person` e `enum`), então `/relatorios` monta `<select>`
  com as listas já limitadas ao escopo. Causa e correção:
  [`docs/deploy/PLANO_ACAO_FILTROS_RELATORIOS_2026-10-28.md`](./docs/deploy/PLANO_ACAO_FILTROS_RELATORIOS_2026-10-28.md).
- **Correções do `/ativar-conta`** (leitura pura do link em
  `frontend/src/lib/activation-link.ts`; o token só é consumido no clique).
- **Logomarca do cabeçalho público** (`frontend/src/components/brand/agu-logo.tsx`):
  troca sazonal temporária, direto sobre o canvas. O ativo oficial
  (`src/assets/brand/agu-logo.png`) seguiu intacto e continuou sendo o usado
  pela rota `/og`. **Revertida em 2026-11-01**: o cabeçalho público voltou à
  logomarca oficial e o ativo temporário foi apagado — ver a seção da logomarca
  em [`docs/deploy/CHECKLIST.md`](./docs/deploy/CHECKLIST.md). A reversão
  precisa de rebuild do frontend para valer em produção.
- Rebuild usado nesta entrega:
  `docker compose build backend frontend && docker compose up -d backend frontend`.
- **Validação funcional pelo responsável: ainda NÃO confirmada.** Também não
  foram reexecutados nesta data `scripts/test-backend.sh`,
  `scripts/test-responsive.sh` nem `scripts/security-audit.sh`.

### Implantado (2026-10-20) — histórico

- Em produção em `https://ueato.revizzicar.com.br` (VPS Hostinger, CloudPanel,
  Cloudflare com "Allow traffic from Cloudflare only"). Containers `backend`,
  `frontend` e `redis` saudáveis; portas `127.0.0.1:8110` (API) e
  `127.0.0.1:3110` (site).
- Vhost em uso: [`infra/cloudpanel/vhost.ueato-cloudpanel.conf`](./infra/cloudpanel/vhost.ueato-cloudpanel.conf);
  as diferenças em relação ao modelo estão no roteiro (seção 5).
- Alembic carimbado, **naquela data**, em `0011_dashboard_charts_prefs` (IDs
  encurtados para caber em `varchar(32)`; ver
  `docs/database/historico-migracoes.md`). Hoje o carimbo é
  `0019_user_soft_delete`.
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
  `0012_asset_bond_status` (espelho `sql/0015`) aplicada no Supabase e hoje
  coberta pelo carimbo `0019_user_soft_delete` (a coluna `assets.bond_status`
  foi conferida no banco em 2026-10-29).
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
- **Importação de Bens:** executada depois deste deploy — 1.069 bens, entre
  2026-10-22 e 2026-10-29.

### Catálogo de painéis do dashboard por perfil (2026-10-27)

- **Catálogo novo de painéis** (`app/services/dashboard_panels_service.py`; eram 12
  nesta data e hoje são 14, ver as seções da Onda D e de 2026-11-01 abaixo),
  com permissão por perfil **no backend** (na época ADM 12, USER 9, RH 7), rótulo,
  tamanhos admitidos `P`/`M`/`G` e tamanho padrão. Substitui a allowlist
  antiga de 15 ids de `user_preferences.dashboard_layout`.
- Rotas: `GET /api/v1/dashboard/panels` (catálogo do perfil + layout padrão +
  preferências salvas, `no-store`) e `PUT /api/v1/dashboard/preferences`
  (visibilidade, ordem, tamanho, `restore_default`; `extra="forbid"`,
  controle otimista -> 409; painel proibido ao perfil -> 403 auditado).
  Contrato completo: `docs/architecture/dashboard-api.md`.
- Tabela `user_dashboard_preferences` (migração `0017_dashboard_panel_prefs`,
  espelho `backend/migrations/sql/0020_dashboard_panel_prefs.sql`): **DDL
  aplicado à mão no Supabase em 2026-10-27, com autorização explícita** (RLS
  sem políticas, sem grants para `anon`/`authenticated`, 0 linhas). A tabela
  existe no banco (conferido em 2026-10-29) e o `alembic_version` hoje é
  `0019_user_soft_delete`, que sucede esta revisão na cadeia linear — não rodar
  `alembic upgrade` sobre este banco.
- As escolhas antigas são traduzidas (`kpis`->`kpi_workstations`,
  `units`->`equipment_by_unit_chart`, `tech_summary`->`kpi_infrastructure`,
  `tech_category`->`category_distribution`, `tech_units`->
  `equipment_by_unit_table`); os outros dez ids são descartados. A linha de
  `user_preferences` não é apagada e `PATCH /api/v1/me/preferences` continua
  aceitando `dashboard_layout` durante a transição.
- Rebuild: backend (frontend só quando a tela nova consumir as rotas).

### Classificação patrimonial e painéis do dashboard (Onda 5, 2026-10-27)

- **Classificação:** 3 famílias (TI, MOBILIARIO, OUTROS) e 20 categorias, motor
  determinístico e puro em `backend/app/services/asset_classification.py`
  (confiança ALTA/BAIXA, regra e versão gravadas por bem; `category_override` do
  ADM prevalece). Regras, listas de contexto e **como adicionar uma regra nova**
  (onde, ordem de prioridade, teste, medir o impacto com `flask classify-equipment`
  em dry-run): `docs/architecture/classificacao-patrimonial.md`.
- **14 painéis** com permissão por perfil no backend (ADM 14, USER 11, RH 9), tela
  "Personalizar painéis" e dados em `/api/v1/dashboard/panels/<id>/data`; fila de
  revisão `/dashboard/classificacao` e `POST /assets/<id>/category-override` (ADM +
  AAL2). Contrato, mapa de migração dos 15 painéis antigos e limitações
  (`notebooks_without_docking` é ESTIMATIVA; `sync_status` é global; não existe
  remoção de override): `docs/architecture/dashboard-api.md`.
- **Banco:** migrações `0016_asset_search_key`, `0017_dashboard_panel_prefs` e
  `0018_equipment_classification` (espelhos `sql/0019`, `sql/0020`, `sql/0021`), DDL
  aplicado à mão no Supabase. Em 2026-10-29 as três estão no banco (função
  `sispat_alnum_key` e índices `ix_assets_patrimony_key_trgm`,
  `ix_assets_description_trgm`, `ix_assets_equipment_active`; tabela
  `user_dashboard_preferences`; colunas `equipment_family`,
  `equipment_category`, `classification_confidence`) e o `alembic_version` é
  `0019_user_soft_delete`. **Nunca rodar `alembic upgrade` sobre este banco.**
  Rollbacks, backup e verificação: `docs/database/historico-migracoes.md`.
- **Backfill (decisão do responsável):** quando esta onda foi escrita as colunas de
  classificação estavam NULL. Rodar `flask classify-equipment` (dry-run por padrão)
  e decidir entre `--apply` (só com autorização) antes da 1ª importação ou aceitar
  que a 1ª importação conte os bens como atualizados (`version`+1). **Se o
  `--apply` já foi executado, não foi reconferido nesta data.** As medidas de
  acervo citadas em 2026-10-27 vinham do dry-run do protótipo daquela data
  (MOBILIARIO 630, TI 403, OUTROS 36; ALTA 1.068, BAIXA 1; sem impressoras) e não
  foram refeitas.
- **Segurança (Onda 4):** `docs/security/REVISAO_QA_ONDA4_2026-10-27.md` —
  backend 14344 passed/64 skipped/4 xfailed/0 failed em Python 3.10 e SQLite;
  gitleaks e trivy não executados, pip-audit inconclusivo; **não validado em
  PostgreSQL nem em Python 3.11+**.
- Rebuild: backend + frontend (`docker compose build backend frontend && docker
  compose up -d backend frontend`), somente com autorização de implantação.

### Painel do quantitativo global por situação de localização (2026-11-01)

- **14º painel do catálogo**, `located_summary` (`tipo = grafico`): total GLOBAL de bens
  localizados x não localizados x não informado, o irmão agregado de
  `located_by_unit_chart`. Catálogo agora: **ADM 14, USER 11, RH 9**. Posição padrão: logo
  após `located_by_unit_chart`; tamanhos P/M/G, padrão **M**; sem exportação e sem rota de
  registros (as duas devolvem o mesmo 404 de painel inexistente).
- Dados em `GET /api/v1/dashboard/panels/located_summary/data` (rota genérica já existente,
  `reports.read` + AAL2 para ADM): as TRÊS séries saem sempre, na ordem
  `SIM`/`NAO`/`DESCONHECIDO`, inclusive com `value: 0`; `total` é a soma exata no escopo de
  unidade do ator e nos filtros (`unit_id`/`familia`/`categoria`); `percentual` é
  `round(value*100/total, 1)` — série vazia com acervo não vazio devolve `0.0`, e `null`
  aparece só quando `total = 0` (200, nunca erro). Diferente do endpoint legado
  `GET /dashboard/por-situacao`, que **descarta** as situações com zero.
- **Tela** (`frontend/src/components/features/dashboard/located-summary-view.tsx`): rosca com
  as três séries por cor + textura (verde liso, laranja listrado, cinza pontilhado), legenda
  com o valor de cada série (inclusive a de 0), cartão com o total do servidor e tabela
  `Situação | Bens | % do total` com rodapé de total — o total mostra "—" na coluna de
  percentual, nunca 100%. Abaixo de `lg`, cartões em vez da tabela. O painel **não abre lista
  de bens**: `/patrimonios` não aceita a situação como parâmetro de URL, então ele orienta a
  usar o filtro "Localizado" e linka `/patrimonios` sem filtro. UX:
  `docs/ux/DASHBOARD.md` §1.
- Quem já salvou preferências recebe o painel ao fim da lista, visível, tamanho M.
  **Sem migração** e sem rota nova. Contrato e testes:
  `docs/architecture/dashboard-api.md` ("Painel `located_summary`"),
  `backend/tests/test_dashboard_located_summary.py`,
  `backend/tests/test_dashboard_panels_located_summary.py`,
  `frontend/e2e/dashboard-located-summary-functional.spec.ts` (não reexecutados nesta data).
- Na mesma frente, a tabela do painel `located_by_unit_chart` ganhou **linha de totais**
  (`located-chart-view.tsx`): total geral verbatim do servidor e, por situação, a soma das
  linhas que o servidor mandou (inclusive "Outras"); se os dois não fecharem, os **dois**
  números são exibidos num aviso, nunca escondidos.
- Rebuild: backend + frontend
  (`docker compose build backend frontend && docker compose up -d backend frontend`), somente
  com autorização de implantação. Este trabalho é posterior à imagem implantada em
  2026-10-29, portanto **não está em produção**.

### Painel de localização dos bens por unidade (Onda D, 2026-10-29)

- **13º painel do catálogo**, `located_by_unit_chart` (gráfico de barras agrupadas
  localizados / não localizados / não informado por unidade, top 15 + "Outras" com soma
  exata). Catálogo então: **ADM 13, USER 10, RH 8** (hoje 14/11/9, ver abaixo). Posição padrão: logo após
  `equipment_by_unit_chart`. Quem já salvou preferências o recebe ao fim da lista,
  visível, tamanho G.
- O clique numa barra (ou nos botões da tabela de dados, para teclado) abre a lista de bens
  via `GET /api/v1/dashboard/panels/located_by_unit_chart/records` (somente leitura, sem
  dado pessoal, escopo de unidade, paginação 50/100/200). Não há link ao detalhe do bem
  (não existe rota de detalhe de patrimônio; ideia futura).
- O instantâneo de 12 painéis da migração 0017 e o mapa dos 15 ids antigos continuam como
  histórico. Contrato completo: `docs/architecture/dashboard-api.md`.
- **Deploy:** sem migração, sem DDL, sem backfill. Rebuild de backend e frontend
  (`docker compose build backend frontend && docker compose up -d backend frontend`),
  somente com autorização explícita. Esta onda está em commit anterior ao lote
  implantado em 2026-10-29 (ver "Implantado (2026-10-29)"), logo faz parte da
  imagem em produção; a **validação funcional pelo responsável ainda não está
  confirmada**.

### Painéis de Tecnologia no dashboard (2026-10-22)

- Seis painéis novos (`/dashboard/tecnologia/*`: indicadores, categoria, por unidade,
  situação operacional, sem responsável e tempo desde o registro) + exportação
  CSV/XLSX agregada (`csv_safety`, auditada). Só contagens (RH sem dados pessoais).
  Contrato: `docs/architecture/dashboard-api.md`; UX: `docs/ux/DASHBOARD_PERSONALIZACAO.md`.
- Migração `0015_asset_tech_classification` (espelho
  `backend/migrations/sql/0018_asset_tech_classification.sql`): **aplicada** — as
  colunas `assets.asset_category`, `assets.tech_type` e
  `assets.operational_status` existem no banco (conferido em 2026-10-29) e a
  revisão está coberta pelo carimbo `0019_user_soft_delete`. O texto
  "PENDENTE" desta seção era o estado de 2026-10-22.
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
  2026-10-21; a coluna `user_preferences.dashboard_layout` foi conferida no
  banco em 2026-10-29 e o carimbo já passou deste ponto). O relatório
  imprimível segue a mesma ordem.
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
├── backend/                 # API Flask (rotas em app/api/v1, serviços,
│   │                         # modelos, autorização, migrações Alembic)
│   └── Dockerfile
├── frontend/                 # Next.js (31 telas, testes Playwright em e2e/)
│   ├── Dockerfile
│   └── src/{app,assets,components,hooks,lib}/
│                              # app/(publico): /login e /ativar-conta (tela
│                              # autônoma, sem menu); app/(app): shell + rotas
│                              # autenticadas (URLs inalteradas). Os módulos de
│                              # domínio ficam em src/components/features/
│                              # (src/features/ existe só com .gitkeep)
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

### Estado do banco de produção (Supabase `tocbtonqnahmtegfkrmn`, 2026-10-29)

Conferido em **2026-10-29** por consulta somente leitura ao banco. Supabase é
único: **dev = prod**. Nenhuma migração é aplicada aqui sem autorização
explícita, e o padrão do projeto é o responsável executar o espelho `.sql` no
SQL Editor e só então carimbar o Alembic (`alembic stamp`, nunca `upgrade`).

- `alembic_version` = **`0019_user_soft_delete`** — igual à head do código. A
  cadeia é linear (`0001` → `0019`), então o carimbo declara toda a cadeia
  aplicada. Mapeamento revisão ↔ espelho `.sql` (até `sql/0022`), comando de
  `downgrade` e `pg_dump` de backup: [`backend/README.md`](./backend/README.md).
- Objetos conferidos diretamente nesta data:
  - `users.deleted_at`, `users.deleted_by`, `users.anonymized_at` (0019);
  - `assets.bond_status` (0012); `assets.asset_category`, `assets.tech_type`,
    `assets.operational_status` (0015); `assets.equipment_family`,
    `assets.equipment_category`, `assets.classification_confidence` (0018);
  - função `public.sispat_unaccent` (0014) e função `public.sispat_alnum_key`
    com o índice funcional `ix_assets_patrimony_key_trgm` (0016);
  - índices `ix_assets_description_trgm`, `ix_assets_equipment_active`,
    `ix_assets_bond_status_lower`, `ix_assets_category_active` e o único
    `uq_assets_patrimony_number_active`;
  - `user_preferences.dashboard_charts` (0011) e
    `user_preferences.dashboard_layout` (0013);
  - tabela `user_dashboard_preferences` (0017).
- **Não existe coluna `assets.search_key`.** A busca por número patrimonial usa
  a função `sispat_alnum_key` e o índice funcional
  `ix_assets_patrimony_key_trgm`, criados pela 0016.
- Os cabeçalhos de alguns arquivos de migração/espelho (0016, 0019) ainda dizem
  "PENDENTE DE APLICAÇÃO": é o texto de quando foram escritos, não o estado do
  banco.
- Outros fatos conferidos: `assets.located` é o enum `asset_located_status`,
  `users.auth_user_id` é `text`, as chaves primárias são `uuid`, a permissão
  `users.delete` está semeada e vinculada **só** ao ADM, o schema `public` tem
  28 tabelas de aplicação (+ `alembic_version`) e **não** existem
  `units.full_identifier` nem o índice `ix_invites_revoked_by` (este último
  segue como proposta em `docs/database/historico-migracoes.md`).
- Não reconferidos nesta data: seeds de permissões de catálogo e bucket
  `avatars` do Storage. As contagens de linhas estão na seção seguinte.

### Acervo importado (conferido em 2026-11-01)

Consulta somente leitura e **agregada** ao banco de produção (nenhuma linha de
bem foi lida individualmente):

- **1.069 bens** em `assets`, todos ativos (nenhum `deleted_at`), todos com
  número patrimonial distinto e `source_system` = `google_sheets`.
- Criados em 2026-10-22 (187), 2026-10-23 (42) e 2026-10-26 (840).
- A importação está **completa e idempotente**: a última prévia confirmada
  (2026-10-29 21:06 UTC, a 24ª de `google_sheets`) trouxe 1.069 linhas com
  **0 novo / 1.069 existente / 0 duplicado / 0 inválido / 0 conflitante**.
- `raw_import_records`: 17.181 linhas em 40 jobs de sincronização, todas
  `IMPORTADO`, com 1.196 `source_record_id` distintos. O último job tem
  exatamente os 1.069 que existem como bem; os outros 127 são resíduo de
  sincronizações anteriores (linhas que saíram da planilha ou foram
  re-chaveadas), o que é o papel da zona de pouso append-only — **não** são
  bens faltando.
- Classificação: 100% com `equipment_family` e `classification_rules_version`
  = `"2"`; 36 em OUTROS, 1 com confiança BAIXA, 0 com `category_override`.
  Chegou pela confirmação de importação de 2026-10-27, não pelo backfill
  auditado — ver `docs/architecture/classificacao-patrimonial.md`.
- Vínculo (`bond_status`): Servidor 733, Terceirizado 70, Ocioso 32,
  Estagiario 11 e 223 bens sem vínculo. `located`: SIM 840, NAO 229.
- Preenchimento: 846 bens com responsável, 697 com sala, 4 unidades com bens.
- `import_previews`: **101 prévias guardadas**, 40 delas confirmadas. O
  expurgo LGPD (item 6 de
  `docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`) estava condicionado à
  importação real e, portanto, **está vencido**.

### Estado do banco de produção (Supabase `tocbtonqnahmtegfkrmn`, 2026-10-14) — histórico

- Alembic aplicado até `0005_settings_ai_users` (verificado em 2026-10-14:
  colunas novas de `users`, `ai_settings`/`user_preferences` com RLS e sem grants
  para `anon`/`authenticated`, IA desligada).
- `migrations/sql/0008_storage_avatars.sql` (bucket privado `avatars` do Storage)
  registrado como **NÃO aplicado** naquela data; requer autorização e **não foi
  reconferido em 2026-10-29**. Sem ele, as rotas de foto respondem 503
  `storage_unavailable` e o resto do sistema segue normal.
- Seeds SQL `0002` (roles/permissions) e `0005` (permissões de gestão de
  usuários/segurança) aplicados.
- Primeiro ADM criado por bootstrap (Supabase Auth + `users` + `user_roles` +
  `user_unit_access` + `audit_logs` com `BOOTSTRAP_FIRST_ADMIN`), sem expor
  dados pessoais além do necessário.
- 4 unidades: 023401 PF, 023402 PU, 023403 CJU, 023404 UEA (levantamento de
  2026-10-14; não reconferido nesta data).

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

Relatórios e exportações (`GET /api/v1/reports` catálogo; `GET /api/v1/reports/<assets|movements|inventory-items>/export?format=csv|xlsx`, permissões `reports.read`/`exports.create`, escopo de unidade, bens excluídos fora, máx. 10 000 linhas, células à prova de formula injection e número patrimonial sempre texto, auditoria `REPORT_EXPORTED`; XLSX sem dependência nova; o catálogo declara os filtros de lookup `unit`/`inventory`/`room`/`person` -- a tela monta `<select>` com as listas já limitadas ao escopo -- e as opções de `bond_status` saem dos valores distintos existentes no escopo do ator mais `__none__` para "sem vínculo", nunca de uma lista fixa): [`docs/architecture/reports-api.md`](./docs/architecture/reports-api.md).

Inventários (`/api/v1/inventories`: campanhas de conferência por unidade; criar/iniciar/encerrar/cancelar só ADM+AAL2, conferir bens ADM/USER, resumo calculado no servidor; encerramento imutável; não altera `assets.located`) e locais (`GET /api/v1/locations`, somente leitura): [`docs/architecture/inventories-api.md`](./docs/architecture/inventories-api.md).

Convite (2026-10-29): o e-mail de convite é montado e enviado pelo **próprio backend**
(`app/services/invite_delivery.py`, via `POST /auth/v1/admin/generate_link` com
`type=invite`, que não envia e-mail), com link `?token_hash=...&type=invite` para
`/ativar-conta`. O `POST /auth/v1/invite` do painel não é mais usado porque seu link de
uso único era consumido por scanners de antivírus de e-mail antes do clique da pessoa
(diagnóstico em `docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`). O
`token_hash` e a URL montada nunca são logados, auditados nem devolvidos ao chamador, e
o `redirect_to` é validado contra `INVITE_ALLOWED_REDIRECT_URLS` antes de qualquer rede.

Tela **Administração → Usuários** (ADM com MFA/AAL2) e **Configurações → Perfil**
(qualquer usuário). Contrato em
[`docs/architecture/modulo-configuracoes.md`](./docs/architecture/modulo-configuracoes.md)
(Etapa 2).

- **Lista:** busca por nome/e-mail, filtros de perfil, unidade e situação, ordenação
  por allowlist e paginação. O ADM só vê usuários das suas unidades (e contas sem
  unidade); alvo alheio, inexistente ou malformado → mesmo 404.
- **Detalhe:** perfil e unidades (checkboxes), conta (desativar/reativar, encerrar
  sessões, e-mail de redefinição de senha, reset de MFA, excluir), foto e histórico de
  auditoria.
- **Permissões — o que é gravável:** o que o ADM altera é a **atribuição** de perfil e
  de unidades de cada usuário, por `PATCH /api/v1/users/<id>`; o backend exige
  `users.manage` no decorator e checa `users.assign_role` (campo `role`) e
  `users.assign_unit` (campo `unit_ids`) **antes** de tocar o banco, auditando a
  negação. Já a **matriz perfil × permissão** é hoje somente leitura: a tela
  `/administracao/perfis-permissoes` consome apenas `GET /api/v1/admin/roles` e
  `GET /api/v1/admin/permissions` (ADM + AAL2 + `roles.manage`); não existe rota de
  escrita de `role_permissions` — mudar o que um perfil pode fazer continua sendo
  migração Alembic + espelho `.sql` (ver `docs/permissions/matriz-permissoes.md` e
  `docs/ux/PERFIS_PERMISSOES.md`).
- **Exclusão de usuário (2026-10-29): lógica + anonimização, irreversível.**
  `POST /api/v1/users/<id>/delete` (ADM + AAL2 + permissão `users.delete`, criada pela
  migração `0019_user_soft_delete` e vinculada só ao ADM). Corpo
  `{"version": <int>, "confirm_text": "<e-mail exato do alvo>"}` com `extra="forbid"`;
  a tela exige digitar o e-mail. Serviço:
  `backend/app/services/user_deletion_service.py`.
  - A linha de `users` **nunca** é removida (4 FKs `RESTRICT` e o gatilho append-only
    de `audit_logs` dependem dela); `name`, `email`, `phone`, `avatar_object_key` e
    `auth_user_id` são anonimizados, com o e-mail trocado por um endereço único e não
    roteável em `.invalid` — o que libera o e-mail original para um convite futuro.
  - `audit_logs` permanece intacto, com `actor_user_id` preservado; o evento gravado
    leva o e-mail apenas **mascarado** e nenhuma cópia do dado removido é guardada.
  - Recusa: autoexclusão (`self_change_forbidden`), último ADM (`last_admin`),
    conflito de `version`, `confirmation_mismatch` e `target_out_of_scope`. Alvo
    inexistente, malformado, de outra unidade ou já excluído devolvem o **mesmo** 404,
    com a negação auditada. JWT de usuário excluído recebe 401.
  - Eventos de segurança `USER_DELETED` (HIGH) e, se o Auth não acompanhar,
    `USER_PROVIDER_SYNC_FAILED`.
  - Rebuild desta entrega:
    `docker compose build backend frontend && docker compose up -d backend frontend`
    (somente com autorização). A migração `0019` precisa estar aplicada **antes** da
    imagem nova do backend: o modelo `User` declara as três colunas e a consulta de
    autenticação as seleciona.
- **Redefinição de senha:** o e-mail é montado e enviado pelo **próprio backend**
  (`app/services/password_reset_delivery.py`), com link `?token_hash=...&type=recovery`
  para `/ativar-conta`; o `POST /auth/v1/recover` não é usado porque o link do template
  do Supabase é consumido por scanners de antivírus de e-mail antes do clique da pessoa
  (diagnóstico e evidência em `docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md`).
  Exige `EMAIL_ENABLED=true` com SMTP configurado; o ADM nunca vê link nem senha.
- **Regras no backend:** controle otimista (`version`), sem auto-alteração, nunca
  remove o último ADM, promover/rebaixar ADM exige confirmação. Mudanças de privilégio,
  desativar ADM e reset de MFA exigem que **todas** as unidades do alvo estejam no
  escopo de quem executa (`target_out_of_scope`).
- **Sessões:** "encerrar sessões", desativar e reset de MFA gravam
  `users.sessions_revoked_at`; o backend recusa JWTs emitidos antes disso.
- **Último acesso (2026-10-29):** a coluna "Último acesso" da lista e o campo
  `last_login_at` de `GET /api/v1/me` passaram a ser alimentados de fato —
  `require_auth` grava `users.last_login_at` **uma vez por sessão** (instante do
  primeiro fator de autenticação, lido do claim `amr`) e insere uma linha `LOGIN`
  em `audit_logs` na mesma transação. É *último login*, não *última atividade*;
  gravar é melhor-esforço e nunca derruba a autenticação. **Sem migração** (a
  coluna existe desde a `0001`, só ninguém a escrevia). Antes disso a trilha
  registrava apenas falhas de autenticação (`AUTH_FAILED`) e nenhum acesso
  bem-sucedido. Não houve backfill a partir do Supabase Auth — os
  `last_sign_in_at` existentes vinham do scanner de antivírus de e-mail, não de
  pessoas (ver `docs/architecture/estrategia-auditoria.md`, seções 2.2.1 e 2.2.2);
  logo, contas antigas seguem como "Nunca" até o próximo login real.
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

## Telas (2026-10-29)

São **31 telas** em `frontend/src/app` (contagem por arquivos `page.tsx`,
2026-10-29), em dois grupos de rota que não alteram as URLs:

- `(publico)/` — `/login` e `/ativar-conta` (sem shell, sem `AuthGuard`).
- `(app)/` — shell + `AuthGuard`: `/`, `/dashboard`, `/dashboard/relatorio`,
  `/dashboard/classificacao` (fila de revisão da classificação, ADM),
  `/patrimonios`, `/movimentacoes`, `/inventarios`, `/relatorios`, `/unidades`,
  `/salas-localizacoes`, `/responsaveis`, `/importacoes`,
  `/administracao` (+ `/usuarios`, `/perfis-permissoes`, `/auditoria`,
  `/vinculos-unidades`, `/salas`, `/responsaveis`, `/unidades`,
  `/importacao/cadastros`, `/importacao/google-sheets`, `/integracoes`,
  `/configuracoes-sistema`) e `/configuracoes` (+ `/perfil`, `/seguranca`,
  `/aparencia`, `/inteligencia-artificial`).

Detalhes por tela, estados e testes: [`frontend/README.md`](./frontend/README.md)
e `docs/ux/`.

## Estado da interface e pendências (2026-10-21) — histórico

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
  - Importação de Bens: o bloqueio pelo carimbo da migração 0013 **não existe
    mais** (o `alembic_version` está em `0019_user_soft_delete`). Seguem
    pendentes o limite de 100 s da Cloudflare na prévia do Sheets e o
    SEC-1021-01.

## Fases do projeto

1. **Fase 1 (concluída):** banco de dados, modelagem e permissionamento.
2. **Em andamento:** importação do Google Sheets (Bens importados: 1.069), MFA/convite,
   UX e o módulo de Configurações (IA, Aparência, Gestão de Usuários) — ver `CLAUDE.md`
   (mantido localmente).
   Dashboard de equipamentos (classificação patrimonial, 14 painéis, fila de revisão):
   Ondas 1-5 de 2026-10-27 e Onda D de 2026-10-29, já no commit implantado em 2026-10-29
   (validação funcional não confirmada). O **backfill** da classificação
   (`flask classify-equipment --apply`) segue dependendo de decisão e autorização.
   Etapas 1 (IA), 2 (usuários) e 3 (Aparência: `/me/preferences`, cookie `sispat-ui`,
   `/configuracoes/aparencia`) e 4 (alertas determinísticos `/dashboard/alerts`, insights
   `/ai/insights` e assistente `/ai/ask`, ADM + AAL2) concluídas. Evidências em
   `docs/security/evidence/settings-module-etapa*.md`.
   API de importação dos cadastros (`/api/v1/catalog-imports`, ADM + AAL2) e `GET
/imports/google-sheets/<id>/pending`: ver `docs/architecture/cadastros-apoio-api.md`. A confirmação de bens (`POST /imports/google-sheets/confirm`) segue o mesmo contrato dos cadastros (status CONCLUIDO/PARCIAL/FALHOU, inalterados, não gravados, falhas_total, resposta degradada pós-commit com `degraded=true`).

### Contrato de paginação (todas as listagens da API v1)

`page` ≥ 1 (padrão 1) e `page_size` SOMENTE 50, 100 ou 200 (padrão 50); qualquer outro valor (25, 0, 500...) => 400. Resposta: `{total, page, page_size, pages, <itens>}` (`pages` = ceil(total/page_size), 0 se vazio). Definição única em `backend/app/services/pagination.py`; ordenação sempre com desempate por `id`. A busca (`q`/`search`) é sem caixa e sem acento (`app/security/text_search.py`: `sispat_unaccent(coluna) ILIKE :padrão`, escape de `%`/`_`). Exige a migração `0014_unaccent_search` (espelho `backend/migrations/sql/0017_unaccent_search.sql`; extensão no schema `extensions` e wrapper `SECURITY INVOKER` com `search_path = extensions, pg_catalog` e chamada qualificada `extensions.unaccent`), aplicada: a função `public.sispat_unaccent` existe no banco de produção (conferido em 2026-10-29) e a revisão está coberta pelo carimbo `0019_user_soft_delete`.

### Busca de bens (`GET /api/v1/assets?q=`)

O termo é dividido em tokens (qualquer espaço, inclusive NBSP; máx. 8; tokens só de pontuação são ignorados, exceto se todos forem). Todos os tokens devem casar (AND, qualquer ordem); cada token casa (OR) em número patrimonial, descrição, `source_record_id`, nome do responsável e nome da sala (estes dois via `EXISTS`, sem JOIN, só para bens já no escopo do usuário; vínculos nulos nunca casam). Sem caixa e sem acento nos DOIS lados (`sispat_unaccent` aplicado também ao termo, no banco), com `%`, `_` e `\` literais. Tokens com dígito também casam pela chave alfanumérica do número (`sispat_alnum_key`: minúsculas, sem acento/pontuação/espaços/NBSP): `AGU-123`, `12.345`, `AB 123` encontram `AGU123`, `12345`, `AB-123`. A chave é **função + índice funcional**, não coluna: **não existe `assets.search_key`**. A migração 0016 (espelho `backend/migrations/sql/0019_asset_search_key.sql`) cria a função `sispat_alnum_key` e o índice trigram funcional `ix_assets_patrimony_key_trgm`, ambos **existentes no banco de produção** (conferido em 2026-10-29; o cabeçalho do arquivo da migração ainda diz "PENDENTE", texto de quando foi escrito). O filtro `unit_id` é a unidade alocadora (`Asset.unit_id`; `owner_unit_id` tem filtro próprio), enquanto o escopo de acesso é unit OU owner. A ordenação por `patrimony_number` é lexicográfica (texto): `"10"` vem antes de `"9"`. Testes: `backend/tests/test_assets_search.py`.

### Importação de bens: lotes e reconciliação
`POST /imports/google-sheets/confirm` aceita `select_all_eligible` e `excluded_item_ids`
(seleção no servidor) e grava em lotes de 100; `GET /imports/google-sheets/<id>/reconciliation`
(ADM, AAL2, só leitura) lista os itens da prévia que não viraram bem, com motivo. Ver
`docs/architecture/cadastros-apoio-api.md`.

### Detalhes e edição de bem (`/patrimonios`)
O painel de detalhes mostra o número patrimonial em destaque com selos de status, seções em cards
(Identificação, Localização e responsável, Classificação técnica, Vínculo, Registro) e barra de
ações fixa. O diálogo "Editar bem" agrupa os campos nas mesmas seções, marca os campos alterados,
resume "Campo: antigo → novo" (o mesmo cálculo do PATCH, só campos alterados + `version`) e pede
confirmação ao fechar com alterações. No conflito de versão (409) o rascunho é preservado e cada
campo divergente mostra "no servidor: X". Mensagens de erro vêm de `asset-labels.ts`, nunca do
backend. Só frontend; contrato da API inalterado. Testes: `frontend/e2e/assets-edit-redesign-functional.spec.ts`.
