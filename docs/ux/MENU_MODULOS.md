# UX — Menu e status por módulo

Fonte do menu: `frontend/src/components/layout/nav-items.ts` (sidebar, menu móvel
e trilha do Header). Regra: **nenhum item do menu resulta em 404** e nenhuma tela
mostra dado inventado. Ocultar itens por perfil é só UX; toda decisão de
autorização é do backend.

## Status por rota

| Rota | Quem vê no menu | Estado | Fonte de dados |
|---|---|---|---|
| `/` | todos | real | alertas/IA (já existentes) |
| `/dashboard`, `/dashboard/relatorio` | todos | **real** (KPIs, gráficos, tabela e relatório imprimível) | `GET /api/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais}` — ver `docs/ux/DASHBOARD.md` |
| `/unidades` | todos | **consulta** (só leitura) | `GET /api/v1/units/accessible` |
| `/salas-localizacoes` | todos | **consulta** (só leitura) | `GET /api/v1/rooms` |
| `/responsaveis` | todos | **consulta** (só leitura) | `GET /api/v1/responsible-people` |
| `/patrimonios` | todos | **real** (lista, detalhe, histórico, criar/editar, exclusão lógica ADM) | `GET/POST/PATCH /api/v1/assets` — ver `docs/ux/PATRIMONIOS.md` |
| `/movimentacoes` | todos | **real** (lista, detalhe, solicitar ADM/USER, aprovar/rejeitar ADM, cancelar) | `GET/POST /api/v1/movements` — ver `docs/ux/MOVIMENTACOES.md` |
| `/inventarios` | ADM e USER (RH: acesso negado com mensagem fixa) | **real** (lista, detalhe com resumo do servidor, criar/iniciar/encerrar/cancelar ADM, conferir bem ADM/USER) | `GET/POST /api/v1/inventories`, `GET /api/v1/locations` — ver `docs/ux/INVENTARIOS.md` |
| `/relatorios` | todos | em preparação | — |
| `/importacoes` | todos | ADM → `/administracao/importacao/cadastros`; demais: acesso restrito | — |
| `/administracao` (pai) | ADM | ADM → `/administracao/usuarios`; demais: acesso restrito | — |
| `/administracao/usuarios`, `unidades`, `salas`, `responsaveis`, `importacao/*` | ADM | real | ver docs anteriores |
| `/administracao/perfis-permissoes`, `vinculos-unidades`, `auditoria`, `integracoes`, `configuracoes-sistema` | ADM | em preparação (adminOnly) | — |
| `/configuracoes/*` | todos (IA: ADM) | real | ver `docs/architecture/modulo-configuracoes.md` |

## Telas de consulta
- Mesmo padrão das telas de cadastro (`CatalogHeader`, `CatalogToolbar`, tabela,
  `CatalogPagination`), mas **sem nenhuma ação de escrita**; eyebrow
  "Cadastros · Consulta". ADM vê o botão-link "Gerenciar cadastro de …" para
  `/administracao/...`.
- `/unidades`: o contrato devolve a lista inteira do escopo (`{units:[{id,code,
  name,active}]}`, sem parâmetros); busca (sem acento), situação, ordenação por
  sigla/nome e paginação de 25 são locais, sobre dados já autorizados. Lista de
  unidades também alimenta o filtro e o rótulo "SIGLA — Nome" das outras duas telas.
- `/salas-localizacoes` e `/responsaveis`: busca (debounce 300 ms), unidade,
  situação, ordenação (allowlist) e paginação vão como parâmetros ao backend.
  **Colunas só existem se a chave veio**: USER recebe pessoas só com `id, name,
  unit_id, active` (sem e-mail, telefone nem identificador). Telefone, quando vem
  (ADM), é sempre mascarado `(••) •••••-NNNN`.
- Erros com texto fixo (nunca o do backend): 401 sessão expirada, AAL2
  (ADM sem MFA), 403 "sem permissão para consultar …", 404 "nada foi encontrado
  no seu escopo de unidades", 400 filtros, 429, rede e genérico com "Tentar
  novamente". Falha só da lista de unidades do filtro avisa e mantém a listagem.

## Módulos em preparação (`ModuleStatePanel`)
- Cabeçalho (eyebrow, h1, resumo) + painel: selo "Em preparação" (ícone + texto),
  "O que o módulo fará", "Próxima entrega" (sem datas inventadas) e link de volta.
  Não há números, tabelas nem chamadas de dados; só `/me` (e preferências).
- Módulos `adminOnly` negam por padrão: enquanto `/me` carrega mostram um esboço;
  com erro ou perfil diferente de ADM mostram "Acesso restrito".
- Textos: `frontend/src/components/features/modules/module-catalog.ts`.
- A trilha (breadcrumb) vem do Header; o destaque no menu usa `aria-current`.

## Acessibilidade e motion
- WCAG 2.2 AA (axe 1366 e 375 px) e matriz 320–1920 px em
  `frontend/e2e/support/screens.ts`: `consulta-*`, `modulo-*`,
  `modulo-admin-negado`, `importacoes-restrito`, `administracao-restrito`; telas
  reais de Patrimônios, Movimentações e Inventários em `patrimonios-*`,
  `movimentacoes-*` e `inventarios-*`.
- Somente entrada do painel/tabela via `@/components/animations` (150–200 ms),
  respeitando `prefers-reduced-motion`; nenhum número é animado.

## Lacunas
- `GET /units/accessible` foi desenvolvido contra o contrato e mocks; confirmar
  com o backend real quando publicado.
- "USER só vê pessoas vinculadas a bens" é regra do backend; o mock devolve todas
  (só projeta as chaves).
- Busca global do Header continua estática.
