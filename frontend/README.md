# SISPAT-AGU — Frontend

Next.js 14 (App Router) + TypeScript + Tailwind CSS. Camada de apresentação do
SISPAT-AGU — nunca mecanismo de segurança (toda regra de negócio e validação
crítica vive no backend Flask; ver `../CLAUDE.md`).

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

## Verificação de tipos / lint

```bash
npm run typecheck
npm run lint
```

## Animações

Sistema de animação reutilizável (Motion + Embla) dentro dos limites do DESIGN.md
(150–200 ms, sem spring/parallax), com suporte a `prefers-reduced-motion`. Use
`@/components/animations` e `@/lib/motion/tokens`, sempre com `m.*` (nunca `motion.*`).
Guia completo: [`../docs/ux/ANIMACOES.md`](../docs/ux/ANIMACOES.md). Testes: `npx playwright test --project=motion`.

## Testes E2E, responsividade e acessibilidade (Playwright + axe)

```bash
npx playwright install chromium   # uma vez
npm run test:e2e          # todos os testes (responsivo + a11y + funcional)
npm run test:responsive   # 9 resoluções: 320 → 1920 px
npm run test:a11y         # axe-core, WCAG 2.2 AA
```

O Playwright sobe o `next dev` na porta 3100 com variáveis **sintéticas**;
Supabase Auth e API Flask são mockados (`e2e/support/mocks.ts`) e qualquer
requisição fora de localhost é abortada. Nunca aponte estes testes para
Supabase/VPS reais. Evidências (screenshots) ficam em `test-results/`.

## Segurança do cliente

- CSP com nonce por requisição em `src/middleware.ts` (`src/lib/csp.ts`).
- Sessão Supabase em `sessionStorage` (chave `sispat-auth`), nunca em
  `localStorage` (regra de lint). Plano de migração para cookies HttpOnly em
  `../docs/security/SECURITY_AUDIT.md`.
- O frontend não toma decisões de segurança: toda autorização é do backend.

## Configurações

- Menu "Configurações" é um grupo: **Segurança** (todos) e **Inteligência
  Artificial** (só ADM — ocultar é UX; o backend exige ADM + AAL2). "Aparência"
  entra na Etapa 3 junto com a página.
- `/configuracoes` lista as subseções do perfil (fonte: `nav-items.ts`).
- `/configuracoes/inteligencia-artificial` usa `src/lib/ai-settings-api.ts`
  (contrato em `../docs/architecture/modulo-configuracoes.md`): estado geral,
  chaves só como "Configurada"/"Não configurada", provedor/modelo em `<select>`
  nativo (modelos só da allowlist do backend), switches nativos
  (`components/ui/switch.tsx`, `role="switch"`), teto mensal, `version` no
  PATCH (409 recarrega e avisa), aviso LGPD obrigatório para DeepSeek e
  "Testar conexão".

## Dashboard de indicadores e relatório imprimível

Rotas `/dashboard` e `/dashboard/relatorio` (item "Dashboard" no menu, logo após Home;
todos os perfis). Detalhes de contrato, estados e decisões em `docs/ux/DASHBOARD.md`.

- Dados: `src/lib/dashboard-api.ts` (apiClient + type guards por allowlist + hooks
  react-query) para `/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais}`.
  `valor_total`, `em_manutencao` e `baixas_ano` são sempre `null` (o cadastro não tem esses
  campos): a tela mostra "Indicadores indisponíveis" e nunca um número.
- Gráficos: Recharts 2.15.4 já instalado, via `src/components/dashboard/animated-chart.tsx`
  (barras, rosca, barras agrupadas, linhas), import dinâmico `ssr:false`. **Paleta e tema
  ficam só em `src/components/dashboard/chart-theme.ts`** (tokens Factory); para trocar cores,
  edite apenas esse arquivo.
- Composição: `src/components/features/dashboard/dashboard-panels.tsx` (blocos com skeleton,
  erro com "Tentar novamente" e vazio honesto) e `dashboard-transform.ts` (funções puras).
- Relatório: folha clara (`theme="paper"`), `@media print` (sem sidebar/header, sem rolagem
  interna, quebras de página evitadas dentro dos blocos), botão "Imprimir / Salvar PDF".
- Testes: `e2e/dashboard.spec.ts` (projeto Playwright `dashboard`), telas `dashboard-painel*`
  e `dashboard-relatorio` em `e2e/support/screens.ts` (responsivo 320–1920 + axe) e mocks em
  `e2e/support/dashboard-mocks.ts`.

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
- Testes: `e2e/catalog-functional.spec.ts`, mocks em `e2e/support/catalog-mocks.ts`
  e telas `salas*`, `responsaveis*`, `unidades*` em `e2e/support/screens.ts`
  (responsivo 320–1920 + axe WCAG 2.2 AA).

## Menu sem 404: consultas e módulos em preparação

Nenhum item do menu leva a 404 (status por módulo em `docs/ux/MENU_MODULOS.md`):

- **Consulta (todos os perfis, só leitura):** `/unidades` (`GET /api/v1/units/accessible`,
  contrato `{units:[{id,code,name,active}]}`; busca/ordem/paginação locais, pois o
  contrato devolve a lista do escopo), `/salas-localizacoes` (`GET /rooms`) e
  `/responsaveis` (`GET /responsible-people`; colunas só se a chave veio — USER
  recebe `id,name,unit_id,active`; telefone só mascarado). ADM vê um atalho para o
  cadastro em `/administracao/...`. Código em `src/components/features/lookup/`.
- **Rotas pai:** `/administracao` (ADM → `/administracao/usuarios`) e `/importacoes`
  (ADM → `/administracao/importacao/cadastros`); demais perfis veem acesso
  restrito (`features/modules/admin-redirect.tsx`).
- **Patrimônios (real, onda 2):** `/patrimonios` — lista, detalhe, histórico, criar/editar
  (campos por perfil, `version`) e exclusão/restauração lógicas (ADM) contra
  `/api/v1/assets`; ver `docs/ux/PATRIMONIOS.md`. Código em
  `src/components/features/assets/` e `src/lib/assets-api.ts`; testes em
  `e2e/assets-functional.spec.ts`, mock `e2e/support/asset-mocks.ts` e telas
  `patrimonios-*` de `e2e/support/screens.ts`.
- **Movimentações (real, onda 3):** `/movimentacoes` — lista com filtros (estado, bem,
  origem/destino, período), detalhe (origem → destino), solicitar (ADM/USER), aprovar e
  rejeitar (só ADM, com `ConfirmActionDialog`) e cancelar (solicitante ou ADM) contra
  `/api/v1/movements`; histórico imutável (sem editar/excluir). Ver
  `docs/ux/MOVIMENTACOES.md`. Código em `src/components/features/movements/` e
  `src/lib/movements-api.ts`; testes em `e2e/movements-functional.spec.ts`, mock
  `e2e/support/movement-mocks.ts` e telas `movimentacoes-*` de `e2e/support/screens.ts`.
- **Inventários (real, onda 4):** `/inventarios` — lista (estado, unidade, busca por nome,
  ordenação, paginação), detalhe em painel lateral com resumo calculado no servidor
  (total, conferidos, pendentes, encontrados, não encontrados, divergentes,
  `progress_percent`), itens conferidos (`/items`) e bens da unidade; ADM cria, inicia,
  encerra (definitivo e imutável) e cancela com `ConfirmActionDialog`; ADM e USER
  conferem bens (`found`, local observado via `GET /api/v1/locations`, notas) em
  inventários EM_ANDAMENTO; RH é negado com mensagem fixa. A conferência não altera
  `assets.located`. Ver `docs/ux/INVENTARIOS.md`. Código em
  `src/components/features/inventories/` e `src/lib/inventories-api.ts`; testes em
  `e2e/inventories-functional.spec.ts`, mock `e2e/support/inventory-mocks.ts` e telas
  `inventarios-*` de `e2e/support/screens.ts`.
- **Auditoria (real, só ADM):** `/administracao/auditoria` — `GET /api/v1/admin/audit-logs`
  (filtros e janela máx. 90 dias validados no backend). Código em
  `src/components/features/audit/`, `src/lib/audit-api.ts` e `src/lib/audit-filters.ts`;
  testes em `e2e/audit-admin-functional.spec.ts` e `e2e/support/audit-mocks.ts`.
- **Vínculos de unidades (real, só ADM, somente leitura):** `/administracao/vinculos-unidades`
  — `GET /api/v1/admin/unit-access`; sem edição (vínculos se alteram em Usuários). Código em
  `features/admin-access/unit-access-view.tsx` e `src/lib/unit-access-api.ts`; testes em
  `e2e/unit-access-functional.spec.ts` e `e2e/support/unit-access-mocks.ts`.
- **Relatórios (real, todos os perfis conforme `reports.read`/`exports.create`):** `/relatorios`
  — catálogo `GET /api/v1/reports` e exportação CSV/XLSX em
  `GET /api/v1/reports/<kind>/export` (contrato em `docs/architecture/reports-api.md`).
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
  para valor fora da lista. `enum` (e qualquer filtro com `options`, como `bond_status`,
  cujas opções são dinâmicas por usuário, com `__none__` = "Sem vínculo") vira `<select>`
  de opções fixas; `date` e `text`/`uuid` seguem em campo livre — se o catálogo voltar a
  declarar sala/responsável como `uuid`, a tela degrada para input sem quebrar. Valor fora
  da lista NUNCA bloqueia a exportação: quem valida é o backend.
- **Home (`/`):** sem selo "Fase 1"; traz o atalho `DashboardShortcut`
  (`features/dashboard/dashboard-shortcut.tsx`) para `/dashboard`.
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
- Tela de bens (`/administracao/importacao/google-sheets`): exibe
  `pending_counts` da prévia e o botão "Carregar relatório de pendências"
  (`GET /imports/google-sheets/<id>/pending`); só contadores, não bloqueiam a
  confirmação.
- Testes: `e2e/catalog-import-functional.spec.ts`, mocks em
  `e2e/support/catalog-import-mocks.ts` e telas `cadastros-*` /
  `importacao-pendencias` em `e2e/support/screens.ts` (responsivo 320–1920 + axe).

## Tema

O tema visual segue **estritamente** `../DESIGN.md` ("Factory" — terminal war
room, dark-only). Não altere cores, tipografia, raios ou espaçamentos sem
atualizar `DESIGN.md` primeiro — ele é a fonte oficial e imutável do Design
System. Os tokens estão traduzidos em `tailwind.config.ts` e
`src/app/globals.css`.

Ativo de marca: a logomarca da AGU (`src/assets/brand/agu-logo.png`, 640 px,
derivada de `../logo.png`) é exibida na tela de login por
`components/brand/agu-logo.tsx`, sobre um Light Surface Card (#eeeeee, raio
10px, sem sombra) para manter contraste; não recolorir nem aplicar filtros.

## Tela de login única (route groups)

`/login` e `/ativar-conta` ficam em `src/app/(publico)/` e usam
`(publico)/layout.tsx`: viewport inteiro (`min-h-dvh`) sobre #101010, cabeçalho
com `AguLogo` (direto sobre o canvas, sem painel claro, `brightness-125`),
"Unidade Estadual de Administração em Tocantins" e eyebrow `SISPAT-AGU`,
`<main id="conteudo">` e rodapé
(copyright, "Sistema de Gestão Patrimonial — AGU, Palmas/TO" e a nota "Acesso
apenas por convite…"). Sem Sidebar/Header/AuthGuard. As demais rotas ficam em
`(app)/`, cujo layout traz o shell e o `AuthGuard` (sem sessão → `/login`,
destino fixo, sem loop). Os grupos não alteram as URLs. O fluxo de login
(senha → MFA TOTP → AAL2 via `/me`) e o foco WCAG 2.4.3 não mudaram; o painel
de orientações (`AuthGuidancePanel`) fica ao lado do formulário em `lg` e abaixo
dele em telas menores; é um slide (Embla) com autoplay pausável em todos os tamanhos, desligado sob prefers-reduced-motion. Não há "Cadastre-se" (só convite) nem "Esqueceu a
senha?" (fluxo inexistente). Testes: `e2e/functional.spec.ts` ("tela pública
autônoma") e a matriz de `e2e/support/screens.ts`.

### Link de ativação/redefinição (`/ativar-conta`)

A leitura do link é PURA e centralizada em `src/lib/activation-link.ts`, usada
tanto pela página quanto pela rede de segurança da raiz
(`src/lib/activation-redirect.ts` + `src/lib/auth-guard.tsx`). Quatro formatos
são aceitos, na QUERY ou no HASH (query vence, como no supabase-js):

| Formato | Tratamento |
|---|---|
| `?token_hash=..&type=invite\|recovery` | fluxo atual (convite e recuperação são montados pelo backend); a credencial fica só em memória e é consumida **no clique** (`verifyOtp`) |
| `?code=..` (PKCE) | o cliente é implícito (sem `flowType`), então o SDK não consome `?code=`: a página troca por sessão no clique (`exchangeCodeForSession`) |
| `#access_token=..&type=..` | legado implícito: o SDK cria a sessão e a página só ADOTA a sessão daquele token |
| `?error=..&error_code=..` (ou no hash) | fase "link inválido" com a mensagem da causa |

Garantias:

- **Nunca consumir no carregamento.** Scanner de antivírus de e-mail faz GET em
  todo link; o token só é usado no clique da pessoa (correção do incidente de
  2026-10-27). Falha de rede/429 **preserva** a credencial para nova tentativa.
- **URL e histórico limpos** (`history.replaceState`) para credenciais e erros,
  inclusive quando o erro vem na query string.
- **Sem `type` reconhecível** os textos ficam neutros — a tela nunca afirma que
  é convite sem saber.
- **Mensagens por causa** em `activation-errors.ts`: só `otp_expired`,
  `access_denied`/`bad_jwt` e `over_request_rate_limit` se diferenciam; códigos
  que falam da conta (`user_not_found`...) caem na mensagem genérica, para a
  página pública não virar oráculo de enumeração de usuários.
- **Sessão de recuperação não libera o sistema** (`src/lib/recovery-session.ts`):
  o evento `PASSWORD_RECOVERY` do SDK marca a sessão; o shell esconde o chrome e
  o `AuthGuard` manda para `/ativar-conta` até a senha ser definida.

Testes: `e2e/password-recovery-link-functional.spec.ts` e
`e2e/activate-invite-functional.spec.ts`.

**Compartilhamento (meta tags):** `src/app/layout.tsx` define Open Graph/Twitter
(`summary_large_image`), `theme-color` #101010 e `robots: noindex`. A imagem
1200x630 é gerada pela rota `src/app/og/route.tsx` (`/og`; os arquivos
`opengraph-image.tsx` quebram o build com a raiz `force-dynamic`). A origem
pública vem de `NEXT_PUBLIC_SITE_URL` (padrão `https://ueato.revizzicar.com.br`).


## Estrutura

```
src/
  app/                     # App Router (layout raiz = html/body/providers/skip link)
    (app)/                 # Shell autenticado: Sidebar + Header + AuthGuard (/, /configuracoes, /administracao)
    (publico)/             # Telas autônomas SEM shell: /login e /ativar-conta
  components/
    layout/                # Shell: sidebar, header, itens de navegação
    ui/                     # Componentes base no padrão shadcn/ui
  features/                 # Módulos de domínio (ainda vazio — Fase 1)
  lib/                       # Cliente de API, provider do TanStack Query, utils
```

## Limitações conhecidas desta rodada

- Sem autenticação de frontend: não há login/sessão; o cliente de API
  (`src/lib/api-client.ts`) tem um ponto de extensão comentado para o header
  `Authorization` quando a sessão existir.
- Itens administrativos da sidebar são exibidos para todos os usuários (sem
  RBAC no frontend ainda) — ver comentários `TODO` em
  `src/components/layout/sidebar.tsx` e `nav-items.ts`.
- A busca global no header é um `<input>` estático, sem lógica de pesquisa.
- A página `administracao/importacao/google-sheets` é um placeholder; a tela
  real dos botões de importação será implementada em uma rodada futura.
