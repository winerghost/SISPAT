# UX — Perfis e Permissões (`/administracao/perfis-permissoes`)

Tela de **consulta somente leitura**, exclusiva do perfil ADM. Mostra o que cada
perfil (ADM, USER, RH) pode fazer e quantos usuários ativos o utilizam. Ocultar
ou negar na interface é só UX: a autorização real (ADM + AAL2 + `roles.manage`)
é do backend, que decide em toda chamada.

## Fonte de dados
| Chamada | Uso |
|---|---|
| `GET /api/v1/admin/roles` | `{roles:[{code,name,description,active,permissions:[{code,description,resource,action}],active_users_count}], users_count_scope:"actor_units"}` |
| `GET /api/v1/admin/permissions` | `{permissions:[{code,description,resource,action,roles:[codes]}]}` (só ao abrir a aba Matriz) |

Sem query string, só `GET`. Perfis, colunas da matriz e permissões vêm
exclusivamente da API; nada é hardcoded no frontend. Cliente:
`frontend/src/lib/admin-access-api.ts`.

## Interface
- Cabeçalho (eyebrow "Administração", h1 "Perfis e Permissões").
- Abas nativas (`Tabs`, WAI-ARIA, setas/Home/End):
  - **Perfis**: um cartão por perfil: nome (h2), selo Ativo/Inativo (ícone +
    texto), código em Geist Mono, descrição, contagem de usuários ativos com a
    nota "considera apenas as unidades do seu escopo" (`users_count_scope =
    actor_units`) e permissões agrupadas por `resource` (h4 em mono).
  - **Matriz**: linhas = permissões, colunas = perfis. Cada célula tem ícone
    (check/traço) **e** texto para leitores de tela ("Concedida" / "Não
    concedida"), nunca só cor. A tabela é uma região focável que rola dentro do
    próprio contêiner em telas estreitas; a página nunca rola na horizontal.
- Textos da API são renderizados como texto puro (escape do React); sem
  `dangerouslySetInnerHTML`.

## Estados
| Estado | Comportamento |
|---|---|
| Carregando | `LoadingSkeleton` (role=status, "Carregando perfis…"/"Carregando matriz…") |
| Erro (rede, 5xx, 429) | `CatalogNotice` com mensagem útil e fixa + "Tentar novamente"; o detalhe do backend não é exibido |
| Vazio | `EmptyState` ("Nenhum perfil encontrado" / "Nenhuma permissão encontrada") |
| Sem permissão | `AccessRestrictedPanel`: USER/RH, `/me` falho, ou 401/403 do backend (inclui `AAL2_REQUIRED`), com texto fixo; sem chamar `/admin/*` quando o perfil não é ADM |

## Motion
Entrada escalonada dos cartões (`StaggerContainer`/`StaggerItem`) e fade das abas,
via `@/components/animations` (150–200 ms, sem spring, respeita
`prefers-reduced-motion`). Nenhum número é animado.

## Testes
`frontend/e2e/admin-access-functional.spec.ts` (projeto `e2e`): ADM vê perfis e
matriz; USER/RH/`/me` com erro/403/AAL1 veem acesso restrito; estados de
carregando, erro (com retry), erro só na matriz e vazio; XSS inerte; 320, 768,
1280 e 1920 px sem overflow horizontal e axe WCAG 2.2 AA sem violações.
Mocks em `e2e/support/admin-access-mocks.ts` e `e2e/support/mocks.ts`; telas
registradas em `e2e/support/screens.ts` (responsive + a11y).
