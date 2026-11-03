# UX — Perfis e Permissões (`/administracao/perfis-permissoes`)

Tela de **consulta somente leitura**, exclusiva do perfil ADM. Mostra o que cada
perfil (ADM, USER, RH) pode fazer e quantos usuários ativos o utilizam. Ocultar
ou negar na interface é só UX: a autorização real (ADM + AAL2 + `roles.manage`)
é do backend, que decide em toda chamada.

> **Matriz gravável: ainda NÃO existe (verificado em 2026-10-29).** A decisão de
> tornar a matriz editável para RH e USER, com teto de permissões (registrada em
> 2026-10-27), **não está implementada**. No backend,
> `backend/app/api/v1/admin_access.py` declara apenas três rotas, todas `GET`
> (`/admin/roles`, `/admin/permissions`, `/admin/unit-access`) e o próprio módulo
> diz "Nenhuma escrita". No frontend, `matrix-panel.tsx` renderiza células
> estáticas (`Check`/`Minus` + texto) e a página escreve "Somente leitura"; não há
> `PUT`/`PATCH` em `src/lib/admin-access-api.ts`. O que já é gravável é o
> **perfil e as unidades de UM usuário**, em `PATCH /api/v1/users/<id>` pela aba
> "Perfil e unidades" — ver `docs/ux/USUARIOS.md`. Não documente a matriz como
> editável antes de o endpoint de escrita existir.

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
`perfis-permissoes`, `perfis-permissoes-matriz`, `perfis-permissoes-erro` e
`perfis-permissoes-negado` em `e2e/support/screens.ts` (responsive + a11y).
Não reexecutado nesta data.

## Onde ficam as decisões de acesso de cada pessoa
Esta tela não altera nada. As ações estão em `/administracao/usuarios`
(`docs/ux/USUARIOS.md`): trocar perfil e unidades, convidar, desativar/reativar,
encerrar sessões, enviar redefinição de senha, resetar MFA, revogar todo o acesso
e excluir definitivamente (exclusão lógica com anonimização e confirmação forte).
