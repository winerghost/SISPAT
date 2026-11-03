# SISPAT-AGU — Frontend

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind CSS. Camada de
apresentação do SISPAT-AGU — nunca mecanismo de segurança (toda regra de negócio,
validação e autorização vive no backend Flask; ver `../CLAUDE.md`).

Versões fixadas em `package.json` (2026-10-29): `next` 15.5.28, `react`/`react-dom`
19.3.0, `typescript` 5.6.3, `tailwindcss` 3.4.19, `@playwright/test` 1.63.0,
`@axe-core/playwright` 4.13.0, `@tanstack/react-query` 5.104.2,
`@supabase/supabase-js` 2.117.3, `motion` 13.4.4, `embla-carousel-react` 8.6.0 e
`@nivo/{core,bar,line,pie}` 0.99.0.

## Instalação

```bash
npm install
```

## Desenvolvimento

```bash
npm run dev
```

Abre em `http://localhost:3000`. Defina `NEXT_PUBLIC_API_URL` (ver
`../.env.example`) para apontar para o backend Flask local.

## Build de produção

```bash
npm run build
npm run start
```

`next.config.ts` usa `output: "standalone"`, exigido pelo `Dockerfile` desta
pasta (estágio `runtime` copia `.next/standalone`).

Em VPS, qualquer alteração aqui só chega ao ar com rebuild da imagem — e
**somente com autorização explícita de implantação**:

```bash
docker compose build backend frontend && docker compose up -d backend frontend
```

## Scripts disponíveis (`package.json`)

| Script | O que faz |
|---|---|
| `npm run dev` | `next dev` |
| `npm run build` | `next build` |
| `npm run start` | `next start` |
| `npm run lint` | `next lint` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:e2e` | `playwright test` (todos os projetos) |
| `npm run test:responsive` | projeto `responsive` |
| `npm run test:a11y` | projeto `a11y` |

Não há script de teste unitário próprio: os testes "de unidade" (helper `cn`,
tokens e paginação) rodam no projeto Playwright `unit`, sem navegador.

## Animações

Sistema de animação reutilizável (Motion + Embla) dentro dos limites do DESIGN.md
(150–200 ms, sem spring/parallax), com suporte a `prefers-reduced-motion`. Use
`@/components/animations` e `@/lib/motion/tokens`, sempre com `m.*` (nunca `motion.*`).
Guia completo: [`../docs/ux/ANIMACOES.md`](../docs/ux/ANIMACOES.md). Testes: `npx playwright test --project=motion`.

## Testes E2E, responsividade e acessibilidade (Playwright + axe)

```bash
npx playwright install chromium   # uma vez
npm run test:e2e          # todos os projetos
npm run test:responsive   # 9 resoluções: 320 → 1920 px
npm run test:a11y         # axe-core, WCAG 2.2 AA
```

Projetos declarados em `playwright.config.ts`:

| Projeto | Arquivos |
|---|---|
| `unit` | `cn.spec.ts`, `pagination.spec.ts` (sem navegador) |
| `responsive` | `responsive.spec.ts` (matriz de `e2e/support/screens.ts`) |
| `a11y` | `a11y.spec.ts` (axe-core, WCAG 2.2 AA) |
| `e2e` | todos os `*functional.spec.ts` |
| `dashboard` | `dashboard.spec.ts` |
| `scroll` | `page-scroll.spec.ts` (a janela nunca rola; só o `<main>`) |
| `motion` | `motion-*.spec.ts` |

O Playwright sobe o **bundle de produção** na porta 3100 (`next build &&
next start`, desde 2026-11-02) com variáveis **sintéticas**;
Supabase Auth e API Flask são mockados (`e2e/support/mocks.ts`) e qualquer
requisição fora de localhost é abortada. Nunca aponte estes testes para
Supabase/VPS reais. Evidências (screenshots) ficam em `test-results/`.

A primeira execução paga o `next build` (~37 s) antes do primeiro teste. Em
troca, nenhuma rota compila sob demanda: era a compilação inicial que estourava
o `FIRST_COMPILE_TIMEOUT` (45 s) dentro do timeout de 60 s quando vários workers
disputavam um único `next dev`, derrubando testes em `responsive.spec.ts`,
`a11y.spec.ts` e `dashboard-charts-functional.spec.ts` sem nenhum defeito de UI.
Os `NEXT_PUBLIC_*` sintéticos também passam a ser embutidos no bundle, como na
imagem Docker. Para aliviar contenção de CPU/memória, `E2E_WORKERS=2`.
Execuções não foram reexecutadas nesta data; os números por onda ficam nas
revisões de QA em `../docs/security/`.

## Telas (31 em `src/app`)

Contagem por arquivos `page.tsx` em 2026-10-29. Dois grupos de rota, que **não**
alteram as URLs:

- `(publico)/` — `/login` e `/ativar-conta`.
- `(app)/` — `/`, `/dashboard`, `/dashboard/relatorio`, `/dashboard/classificacao`,
  `/patrimonios`, `/movimentacoes`, `/inventarios`, `/relatorios`, `/unidades`,
  `/salas-localizacoes`, `/responsaveis`, `/importacoes`, `/administracao`
  (+ `/usuarios`, `/perfis-permissoes`, `/auditoria`, `/vinculos-unidades`,
  `/salas`, `/responsaveis`, `/unidades`, `/importacao/cadastros`,
  `/importacao/google-sheets`, `/integracoes`, `/configuracoes-sistema`) e
  `/configuracoes` (+ `/perfil`, `/seguranca`, `/aparencia`,
  `/inteligencia-artificial`).

## Segurança do cliente

- CSP com nonce por requisição em `src/middleware.ts` (`src/lib/csp.ts`).
- Sessão Supabase em `sessionStorage` (chave `sispat-auth`, em
  `src/lib/supabase-client.ts`), nunca em `localStorage` (regra de lint). Plano de
  migração para cookies HttpOnly em `../docs/security/SECURITY_AUDIT.md` (mantido
  fora do repositório).
- O `Authorization: Bearer <token>` é anexado por `src/lib/api-client.ts` apenas
  quando a URL final tem a origem conferida; o token nunca vai para log, URL ou
  storage persistente.
- Itens de menu restritos são filtrados por `filterNavItems` (`components/layout/nav-items.ts`):
  perfil desconhecido nega o item. Ocultar é **UX**; quem autoriza é o backend.
- O frontend não toma decisões de segurança: toda autorização é do backend.

## Configurações

- Menu "Configurações" é um grupo: **Perfil** e **Segurança** (todos),
  **Aparência** (todos) e **Inteligência Artificial** (só ADM — ocultar é UX; o
  backend exige ADM + AAL2).
- `/configuracoes` lista as subseções do perfil (fonte: `nav-items.ts`).
- `/configuracoes/aparencia` usa `src/lib/ui-preferences.ts` +
  `src/lib/use-my-preferences.ts` (`GET`/`PATCH /api/v1/me/preferences`) e o
  cookie `sispat-ui`.
- `/configuracoes/inteligencia-artificial` usa `src/lib/ai-settings-api.ts`
  (contrato em `../docs/architecture/modulo-configuracoes.md`): estado geral,
  chaves só como "Configurada"/"Não configurada", provedor/modelo em `<select>`
  nativo (modelos só da allowlist do backend), switches nativos
  (`components/ui/switch.tsx`, `role="switch"`), teto mensal, `version` no
  PATCH (409 recarrega e avisa), aviso LGPD obrigatório para DeepSeek e
  "Testar conexão".

## Dashboard de indicadores e relatório imprimível

Rotas `/dashboard` e `/dashboard/relatorio` (item "Dashboard" no menu, logo após Home;
todos os perfis). Detalhes de contrato, estados e decisões em `../docs/ux/DASHBOARD.md`,
`../docs/ux/DASHBOARD_GRAFICOS.md` e `../docs/ux/DASHBOARD_PERSONALIZACAO.md`.

- Dados: `src/lib/dashboard-api.ts` (apiClient + type guards por allowlist + hooks
  react-query) para `/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais}`
  e os painéis complementares (`localizacao-por-unidade`, `por-vinculo`,
  `pendencias-cadastro`, `por-sala`, `inventario`, `tipos`, `tecnologia/*`).
  `valor_total`, `em_manutencao` e `baixas_ano` são sempre `null` (o cadastro não tem esses
  campos): a tela mostra "Indicadores indisponíveis" e nunca um número.
- Gráficos: **Nivo 0.99** (`@nivo/bar`, `@nivo/pie`, `@nivo/line`), que substituiu o
  Recharts, em `src/components/dashboard/` (`nivo-bar-charts.tsx`,
  `nivo-pie-chart.tsx`, `nivo-line-charts.tsx`, `animated-chart.tsx`,
  `chart-shell.tsx`), com import dinâmico `ssr:false` e `animate={false}`.
  **Paleta e tema ficam só em `src/components/dashboard/chart-theme.ts`** (tokens
  Factory); para trocar cores, edite apenas esse arquivo.
- Painéis personalizáveis: catálogo por perfil vindo de `GET /v1/dashboard/panels`
  e preferências em `PUT /v1/dashboard/preferences`
  (`features/dashboard/use-dashboard-panel-prefs.ts`,
  `dashboard-layout-dialog.tsx`); tipo de gráfico por painel em
  `use-dashboard-chart-prefs.ts` (`/v1/me/preferences`). Filtros na URL em
  `use-dashboard-url-filters.ts`.
- Equipamentos/classificação: `src/lib/dashboard-equipment-api.ts`
  (`/v1/dashboard/panels/<id>/{data,records,export}`) e a fila de revisão
  `/dashboard/classificacao` (`/v1/dashboard/classificacao/revisao`, ADM), com
  override do ADM por `POST /v1/assets/<id>/category-override`. Componentes em
  `src/components/features/dashboard/` (`equipment-panels.tsx`,
  `classification-review.tsx`, `located-chart-view.tsx`,
  `located-records-sheet.tsx`).
- Composição: `src/components/features/dashboard/dashboard-panels.tsx` (blocos com skeleton,
  erro com "Tentar novamente" e vazio honesto) e `dashboard-transform.ts` (funções puras).
- Relatório: folha clara (`theme="paper"`), `@media print` (sem sidebar/header, sem rolagem
  interna, quebras de página evitadas dentro dos blocos), botão "Imprimir / Salvar PDF".
- Testes: `e2e/dashboard.spec.ts` (projeto `dashboard`), `dashboard-*-functional.spec.ts`
  (charts, filtros, layout, tecnologia, equipamentos, localizados, QA), telas
  `dashboard-painel*` e `dashboard-relatorio` em `e2e/support/screens.ts`
  (responsivo 320–1920 + axe) e mocks em `e2e/support/dashboard-mocks.ts`.

## Cadastros de apoio (salas, pessoas responsáveis, unidades)

Telas de administração (menu **Administração**, só ADM — ocultar é UX; o backend
exige ADM + AAL2 para escrever): `/administracao/salas`,
`/administracao/responsaveis` e `/administracao/unidades`. Contrato:
`../docs/architecture/cadastros-apoio-api.md`; detalhes de UX em
`../docs/ux/CADASTROS_APOIO.md`.

- Cliente: `src/lib/catalog-api.ts`; componentes em
  `src/components/features/catalog/` (tabelas, diálogos de criar/editar,
  inativar/reativar, filtros). Reaproveita `Table`, `Dialog`, `FormField`,
  `ConfirmActionDialog` e as animações de `@/components/animations`.
- **Sem exclusão**: "Excluir" = **Inativar** (POST `.../deactivate`), com
  confirmação que diz que o registro é preservado; reativar em `.../activate`.
- **Unidades** usam `GET /api/v1/units/catalog` (`listUnitsCatalog`): ativas e
  inativas, busca/situação/ordenação/paginação no servidor, reativar/inativar
  na linha. O seletor de unidades das outras telas segue em `GET /api/v1/units`.
- Edição não troca unidade nem `code`/`source_record_id` (somente leitura); o
  PATCH leva só os campos alterados e `expected_updated_at` (409
  `version_conflict` recarrega e avisa).
- LGPD: o campo/coluna **telefone** só existe se a chave `phone` veio do
  backend (ADM); na lista aparece mascarado (`(••) •••••-4567`); nunca vai para
  URL, storage ou log. `address` (unidades) segue a mesma regra.
- Erros: mensagens fixas por status/código (duplicado, unidade inativa,
  conflito de versão, 403/404 genéricos) — nunca o texto cru da API.
- Testes: `e2e/catalog-functional.spec.ts`, `e2e/catalog-search-functional.spec.ts`,
  mocks em `e2e/support/catalog-mocks.ts` e telas `salas*`, `responsaveis*`,
  `unidades*` em `e2e/support/screens.ts` (responsivo 320–1920 + axe WCAG 2.2 AA).

## Administração de usuários, perfis e permissões

Telas só ADM (ocultar é UX; o backend exige ADM + AAL2). Contrato:
`../docs/architecture/modulo-configuracoes.md` e
`../docs/architecture/admin-read-api.md`.

- **`/administracao/usuarios`** — lista (busca, filtros de perfil/unidade/situação,
  ordenação por allowlist, paginação) e painel de detalhe. Cliente:
  `src/lib/users-api.ts`; componentes em `src/components/features/users/`
  (`users-table.tsx`, `user-detail-sheet.tsx`, `user-access-form.tsx`,
  `user-account-actions.tsx`, `invite-user-dialog.tsx`, `avatar-manager.tsx`,
  `unit-checkbox-list.tsx`, `user-audit-list.tsx`).
  - **Gravável:** convidar (`POST /users/invite`), perfil e unidades
    (`PATCH /users/<id>`), desativar/reativar, encerrar sessões, enviar
    redefinição de senha, resetar MFA e **excluir**.
  - **Excluir usuário** (`POST /users/<id>/delete`, entrega de 2026-10-29): o
    diálogo exige digitar o **e-mail exato** do alvo, exibe as consequências
    (dados pessoais anonimizados; histórico de auditoria preservado, com rótulo
    anonimizado no lugar do nome/e-mail) e envia `{version, confirm_text}`. É
    irreversível e não tem desfazer; a tela nunca mostra link, senha ou token.
    Se o backend responder 403 pedindo reautenticação, o diálogo abre a etapa
    "Confirme sua identidade" e pede o código do autenticador (mesmo tratamento
    do reset de MFA); quem decide é sempre o backend (ADM + AAL2 +
    `users.delete`). Testes: `e2e/users-delete-functional.spec.ts` e
    `e2e/security-users-functional.spec.ts`.
- **`/administracao/perfis-permissoes`** — **somente leitura**: abas "Perfis" e
  "Matriz", a partir de `GET /api/v1/admin/roles` e `GET /api/v1/admin/permissions`
  (`src/lib/admin-access-api.ts`, componentes `features/admin-access/roles-panel.tsx`
  e `matrix-panel.tsx`). **Não existe tela nem rota para gravar a matriz perfil ×
  permissão**: o que o ADM altera é a atribuição de perfil/unidades de cada usuário,
  em `/administracao/usuarios`. UX detalhada: `../docs/ux/PERFIS_PERMISSOES.md`.
- **`/administracao/auditoria`** — `GET /api/v1/admin/audit-logs` (filtros e janela
  máx. 90 dias validados no backend). Código em `src/components/features/audit/`,
  `src/lib/audit-api.ts` e `src/lib/audit-filters.ts`; testes em
  `e2e/audit-admin-functional.spec.ts` e `e2e/support/audit-mocks.ts`.
- **`/administracao/vinculos-unidades`** — `GET /api/v1/admin/unit-access`, somente
  leitura (vínculos se alteram em Usuários). Código em
  `features/admin-access/unit-access-view.tsx` e `src/lib/unit-access-api.ts`;
  testes em `e2e/unit-access-functional.spec.ts`,
  `e2e/admin-access-functional.spec.ts` e `e2e/support/unit-access-mocks.ts`.

## Menu sem 404: consultas e módulos em preparação

Nenhum item do menu leva a 404 (status por módulo em `../docs/ux/MENU_MODULOS.md`):

- **Consulta (todos os perfis, só leitura):** `/unidades` (`GET /api/v1/units/accessible`,
  contrato `{units:[{id,code,name,active}]}`; busca/ordem/paginação locais, pois o
  contrato devolve a lista do escopo), `/salas-localizacoes` (`GET /rooms`) e
  `/responsaveis` (`GET /responsible-people`; colunas só se a chave veio — USER
  recebe `id,name,unit_id,active`; telefone só mascarado). ADM vê um atalho para o
  cadastro em `/administracao/...`. Código em `src/components/features/lookup/`.
- **Rotas pai:** `/administracao` (ADM → `/administracao/usuarios`) e `/importacoes`
  (ADM → `/administracao/importacao/cadastros`); demais perfis veem acesso
  restrito (`features/modules/admin-redirect.tsx`).
- **Patrimônios:** `/patrimonios` — lista, detalhe, histórico, criar/editar
  (campos por perfil, `version`) e exclusão/restauração lógicas (ADM) contra
  `/api/v1/assets`; ver `../docs/ux/PATRIMONIOS.md`. Código em
  `src/components/features/assets/` e `src/lib/assets-api.ts`; testes em
  `e2e/assets-functional.spec.ts`, `e2e/assets-states-functional.spec.ts`,
  `e2e/assets-classification-functional.spec.ts`,
  `e2e/assets-edit-redesign-functional.spec.ts`, mock `e2e/support/asset-mocks.ts`
  e telas `patrimonios-*` de `e2e/support/screens.ts`.
- **Movimentações:** `/movimentacoes` — lista com filtros (estado, bem,
  origem/destino, período), detalhe (origem → destino), solicitar (ADM/USER), aprovar e
  rejeitar (só ADM, com `ConfirmActionDialog`) e cancelar (solicitante ou ADM) contra
  `/api/v1/movements`; histórico imutável (sem editar/excluir). Ver
  `../docs/ux/MOVIMENTACOES.md`. Código em `src/components/features/movements/` e
  `src/lib/movements-api.ts`; testes em `e2e/movements-functional.spec.ts`, mock
  `e2e/support/movement-mocks.ts` e telas `movimentacoes-*` de `e2e/support/screens.ts`.
- **Inventários:** `/inventarios` — lista (estado, unidade, busca por nome,
  ordenação, paginação), detalhe em painel lateral com resumo calculado no servidor
  (total, conferidos, pendentes, encontrados, não encontrados, divergentes,
  `progress_percent`), itens conferidos (`/items`) e bens da unidade; ADM cria, inicia,
  encerra (definitivo e imutável) e cancela com `ConfirmActionDialog`; ADM e USER
  conferem bens (`found`, local observado via `GET /api/v1/locations`, notas) em
  inventários EM_ANDAMENTO; RH é negado com mensagem fixa. A conferência não altera
  `assets.located`. Ver `../docs/ux/INVENTARIOS.md`. Código em
  `src/components/features/inventories/` e `src/lib/inventories-api.ts`; testes em
  `e2e/inventories-functional.spec.ts`, mock `e2e/support/inventory-mocks.ts` e telas
  `inventarios-*` de `e2e/support/screens.ts`.
- **Relatórios (todos os perfis conforme `reports.read`/`exports.create`):** `/relatorios`
  — catálogo `GET /api/v1/reports` e exportação CSV/XLSX em
  `GET /api/v1/reports/<kind>/export` (contrato em `../docs/architecture/reports-api.md`).
  O download usa `requestFile` de `src/lib/api-client.ts`; API em `src/lib/reports-api.ts`;
  testes em `e2e/reports-functional.spec.ts` e `e2e/support/reports-mocks.ts`. A
  exportação ainda não está nos menus de Patrimônios, Movimentações e Inventários.
  "Colunas do arquivo" é uma seleção real (`features/reports/column-picker.tsx`: fieldset +
  checkboxes nativos, "Marcar todas"/"Limpar", contador "n de N selecionadas", Exportar
  desabilitado com aviso em região viva quando 0). Estado só em memória; volta a "todas" ao
  trocar de relatório. Vai em `columns=<chaves separadas por vírgula>` na ordem do catálogo,
  omitido quando todas estão marcadas; 400 `invalid_columns` => mensagem própria.
  Os filtros são GERADOS pelo `type` de cada item do catálogo
  (`features/reports/report-filters.tsx`): os quatro tipos de LOOKUP (`unit`,
  `inventory`, `room`, `person`) compartilham um único ramo — `<select>` nativo com a
  lista carregada da API (`/units/accessible`, `/inventories`, `/rooms`,
  `/responsible-people`), opção "Todas as…", "Carregando…", aviso no `hint` quando a
  lista falha (campo desabilitado, resto da tela intacto) e "Selecionado anteriormente"
  para valor fora da lista. Desde 2026-10-29 o backend declara `room_id`/`responsible_person_id`
  como `room`/`person` e `bond_status` como `enum`, então **Sala**, **Responsável** e
  **Vínculo** deixaram de ser campo de texto livre
  (`../docs/deploy/PLANO_ACAO_FILTROS_RELATORIOS_2026-10-28.md`). `enum` (e qualquer
  filtro com `options`, como `bond_status`, cujas opções são dinâmicas por usuário, com
  `__none__` = "Sem vínculo") vira `<select>` de opções fixas; `date` e `text`/`uuid`
  seguem em campo livre — se o catálogo voltar a declarar sala/responsável como `uuid`,
  a tela degrada para input sem quebrar. Valor fora da lista NUNCA bloqueia a
  exportação: quem valida é o backend.
- **Home (`/`):** sem selo "Fase 1"; traz o atalho `DashboardShortcut`
  (`features/dashboard/dashboard-shortcut.tsx`) para `/dashboard`.
- **Busca global do header:** o `<input>` de `components/layout/header.tsx` envia
  (Enter) para `/patrimonios` com o termo na URL; testes em
  `e2e/global-search-functional.spec.ts`.
- **Menu:** itens sem API usam o campo `comingSoon` de `nav-items.ts` e mostram o selo
  "Em breve" (Integrações e Configurações do Sistema).
- **Ainda sem backend (stubs):** só ADM, `/administracao/{integracoes,
  configuracoes-sistema}` usam `ModuleStatePanel` ("Módulo em preparação": o que
  fará, próxima entrega, link de volta; nenhum número/tabela). Textos em
  `features/modules/module-catalog.ts`.
- Testes: `e2e/menu-modules-functional.spec.ts` (menu por perfil, nenhuma rota 404,
  somente leitura, negação por padrão) e telas `consulta-*`, `modulo-*`,
  `importacoes-restrito`, `administracao-restrito` em `e2e/support/screens.ts`.

## Importação dos cadastros de apoio e pendências de bens

Tela `/administracao/importacao/cadastros` (menu **Administração → Importação
de Dados → Cadastros de apoio**, só ADM — ocultar é UX; o backend exige ADM +
AAL2 + a permissão do tipo). Abas **Unidades / Salas / Pessoas responsáveis**,
cada uma um fluxo independente: gerar prévia
(`POST /catalog-imports/<kind>/preview`) → resumo por classificação (reuso de
`PreviewSummaryCards`) → relatório (pendências por código, IDs repetidos, nomes
suspeitos, prováveis duplicatas) → tabela de itens (`GET .../items`: filtro de
classificação, busca, ordenação por allowlist, paginação) → seleção e
`ConfirmActionDialog` ("gravação em massa, idempotente") → resultado com falhas
por item. Detalhes: `../docs/ux/IMPORTACAO_CADASTROS.md`.

- Cliente: `src/lib/catalog-imports-api.ts`; componentes em
  `src/components/features/imports/` (`catalog-import-*`, `pending-counts-panel`).
- Os `item_ids` da confirmação são coletados paginando `GET /items` (NOVO e
  EXISTENTE, 100 por página) e aplicando a seleção local — cobre todas as páginas.
- Unidades (SEC-CAT-04): `details.create_alias=true` habilita o opt-in "Criar
  sigla de atalho para esta unidade" (desmarcado por padrão; só em memória). A
  confirmação envia `alias_item_ids` (subconjunto de `item_ids`) apenas com os
  itens optados e omite o campo se vazio; o diálogo mostra "Siglas de atalho a
  criar: N". Sem opt-in nenhum alias é criado. Salas/pessoas não mudam.
- LGPD: telefone nunca aparece (só `has_phone`); e-mail só mascarado; nada em
  storage/URL/console (o cache do TanStack Query é só memória).
- Erros: mensagens fixas (409 aba não configurada / prévia expirada ou já
  confirmada, 422, 502, 429, 403/404 genéricos, exigência de MFA).
- Tela de bens (`/administracao/importacao/google-sheets`): prévia do Google
  Sheets com `pending_counts`, botão "Carregar relatório de pendências"
  (`GET /imports/google-sheets/<id>/pending`) e relatório de reconciliação
  (`GET /imports/google-sheets/<id>/reconciliation`; testes em
  `e2e/imports-reconciliation-functional.spec.ts`). Só contadores — não bloqueiam
  a confirmação. **A importação de Bens já foi executada** (1.069 bens; na última
  sincronização, em 2026-10-29, a prévia veio com 0 novos e 1.069 existentes).
- Testes: `e2e/catalog-import-functional.spec.ts`, mocks em
  `e2e/support/catalog-import-mocks.ts` e telas `cadastros-*` /
  `importacao-pendencias` em `e2e/support/screens.ts` (responsivo 320–1920 + axe).

## Tema

O tema visual segue **estritamente** `../DESIGN.md` ("Factory" — terminal war
room, dark-only). Não altere cores, tipografia, raios ou espaçamentos sem
atualizar `DESIGN.md` primeiro — ele é a fonte oficial e imutável do Design
System. Os tokens estão traduzidos em `tailwind.config.ts` e
`src/app/globals.css`.

Ativo de marca: `components/brand/agu-logo.tsx` exibe a logomarca no cabeçalho
público (`/login` e `/ativar-conta`), **direto sobre o canvas #101010**, sem
painel claro e com `priority` para o LCP. O arquivo em uso é o ativo **oficial**
`src/assets/brand/agu-logo.png` (640×381, PNG RGBA transparente) — o único
`.png` em `src/assets/brand/` e o mesmo que a rota `/og` lê. É dimensionado por
LARGURA (`h-auto w-36 brightness-125 sm:w-44`, ou seja 144 px / 176 px, com
`sizes="(min-width: 640px) 176px, 144px"`); as dimensões vêm do import estático,
sem *layout shift*. O único efeito é o `brightness-125`, que clareia o azul
sobre o canvas sem trocar o tom: sem sombra, blur, glow ou `mix-blend-*`,
conforme o `DESIGN.md`. Não recolorir nem aplicar filtros além do que está ali.
Histórico: entre 2026-10-29 e 2026-11-01 esse cabeçalho exibiu uma troca
sazonal temporária, revertida em 2026-11-01 (o ativo oficial nunca foi alterado
e a rota `/og` não mudou).

## Tela de login única (route groups)

`/login` e `/ativar-conta` ficam em `src/app/(publico)/` e usam
`(publico)/layout.tsx`: viewport inteiro (`min-h-dvh`) sobre #101010, cabeçalho
com `AguLogo`, "Unidade Estadual de Administração em Tocantins" e eyebrow
`SISPAT-AGU`, `<main id="conteudo">` e rodapé
(copyright, "Sistema de Gestão Patrimonial — AGU, Palmas/TO" e a nota "Acesso
apenas por convite…"). Sem Sidebar/Header/AuthGuard. As demais rotas ficam em
`(app)/`, cujo layout traz o shell e o `AuthGuard` (sem sessão → `/login`,
destino fixo, sem loop). Os grupos não alteram as URLs. O fluxo de login
(senha → MFA TOTP → AAL2 via `/me`) e o foco WCAG 2.4.3 não mudaram; o painel
de orientações (`AuthGuidancePanel`) fica ao lado do formulário em `lg` e abaixo
dele em telas menores; é um slide (Embla) com autoplay pausável em todos os tamanhos, desligado sob prefers-reduced-motion. Não há "Cadastre-se" (só convite) nem "Esqueceu a
senha?" (fluxo inexistente). Testes: `e2e/functional.spec.ts` ("tela pública
autônoma"), `e2e/security-auth-functional.spec.ts` e a matriz de
`e2e/support/screens.ts`.

### Link de ativação/redefinição (`/ativar-conta`)

A leitura do link é PURA e centralizada em `src/lib/activation-link.ts`, usada
tanto pela página quanto pela rede de segurança da raiz
(`src/lib/activation-redirect.ts` + `src/lib/auth-guard.tsx`). Quatro formatos
são aceitos, na QUERY ou no HASH (query vence, como no supabase-js):

| Formato | Tratamento |
|---|---|
| `?token_hash=..&type=invite\|recovery` | fluxo atual (convite e recuperação são montados e enviados pelo backend); a credencial fica só em memória e é consumida **no clique** (`verifyOtp`) |
| `?code=..` (PKCE) | o cliente é implícito (sem `flowType`), então o SDK não consome `?code=`: a página troca por sessão no clique (`exchangeCodeForSession`) |
| `#access_token=..&type=..` | legado implícito: o SDK cria a sessão e a página só ADOTA a sessão daquele token |
| `?error=..&error_code=..` (ou no hash) | fase "link inválido" com a mensagem da causa |

Garantias:

- **Nunca consumir no carregamento.** Scanner de antivírus de e-mail faz GET em
  todo link; o token só é usado no clique da pessoa (correção do incidente de
  2026-10-27, estendida ao **convite** em 2026-10-28/29 — ver
  `../docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`). Falha de rede/429
  **preserva** a credencial para nova tentativa.
- **URL e histórico limpos** (`history.replaceState`) para credenciais e erros,
  inclusive quando o erro vem na query string.
- **Sem `type` reconhecível** os textos ficam neutros — a tela nunca afirma que
  é convite sem saber.
- **Mensagens por causa** em `src/app/(publico)/ativar-conta/activation-errors.ts`: só `otp_expired`,
  `access_denied`/`bad_jwt` e `over_request_rate_limit` se diferenciam; códigos
  que falam da conta (`user_not_found`...) caem na mensagem genérica, para a
  página pública não virar oráculo de enumeração de usuários.
- **Sessão de recuperação não libera o sistema** (`src/lib/recovery-session.ts`):
  o evento `PASSWORD_RECOVERY` do SDK marca a sessão; o shell esconde o chrome e
  o `AuthGuard` manda para `/ativar-conta` até a senha ser definida.

Testes: `e2e/password-recovery-link-functional.spec.ts` e
`e2e/activate-invite-functional.spec.ts`. UX: `../docs/ux/ATIVACAO_CONVITE.md`.

**Compartilhamento (meta tags):** `src/app/layout.tsx` define Open Graph/Twitter
(`summary_large_image`), `theme-color` #101010 e `robots: noindex`. A imagem
1200x630 é gerada pela rota `src/app/og/route.tsx` (`/og`; os arquivos
`opengraph-image.tsx` quebram o build com a raiz `force-dynamic`). A origem
pública vem de `NEXT_PUBLIC_SITE_URL` (padrão `https://ueato.revizzicar.com.br`).

## Estrutura

```
src/
  app/                     # App Router (layout raiz = html/body/providers/skip link)
    (app)/                 # Shell autenticado: Sidebar + Header + AuthGuard
    (publico)/             # Telas autônomas SEM shell: /login e /ativar-conta
    og/                    # Rota que gera a imagem 1200x630 de compartilhamento
  assets/brand/            # Logomarca oficial da AGU (agu-logo.png)
  components/
    animations/            # Primitivas de Motion (m.*) dentro dos limites do DESIGN.md
    brand/                 # AguLogo
    carousel/              # Embla
    dashboard/             # Gráficos Nivo + tema único (chart-theme.ts)
    features/              # Módulos de domínio: admin-access, appearance, assets,
                           # audit, auth, catalog, dashboard, imports, inventories,
                           # lookup, modules, movements, reports, settings, users
    layout/                # Shell: sidebar, header, mobile-nav, nav-items
    ui/                     # Componentes base no padrão shadcn/ui
  features/                 # Vazio (só .gitkeep) — os módulos vivem em components/features
  hooks/
  lib/                       # Clientes de API, provider do TanStack Query, CSP, sessão, utils
  middleware.ts              # CSP com nonce por requisição
```

## Limitações conhecidas (2026-10-29)

- **Sem rota de detalhe de patrimônio:** o clique num painel do dashboard abre a
  lista de bens em painel lateral, não uma página do bem (não existe
  `/patrimonios/<id>`).
- **Matriz perfil × permissão é somente leitura** — não há escrita de
  `role_permissions` em nenhuma tela ou rota.
- **Stubs sem backend:** `/administracao/integracoes` e
  `/administracao/configuracoes-sistema` (selo "Em breve" no menu).
- **Exportação** só aparece em `/relatorios`; ainda não está nos menus de
  Patrimônios, Movimentações e Inventários.
- **Sessão em `sessionStorage`** (não cookie HttpOnly): plano de migração
  registrado na auditoria de segurança (documento mantido fora do repositório).
- **Importação de Bens** não executada; a tela do Google Sheets é usada hoje para
  prévia, pendências e reconciliação.
- `FRONTEND_MEMORY=2G` do Compose é só para desenvolvimento; nunca em produção.
