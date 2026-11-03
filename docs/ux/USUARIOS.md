# UX — Administração de usuários (`/administracao/usuarios`)

Tela de gestão de contas, exclusiva do perfil ADM. Código:
`frontend/src/app/(app)/administracao/usuarios/page.tsx` e
`frontend/src/components/features/users/` (`users-table.tsx`,
`invite-user-dialog.tsx`, `user-detail-sheet.tsx`, `user-access-form.tsx`,
`user-account-actions.tsx`, `avatar-manager.tsx`, `user-audit-list.tsx`,
`confirm-action-dialog.tsx`, `unit-checkbox-list.tsx`, `user-labels.ts`);
cliente `frontend/src/lib/users-api.ts`. Contrato:
`docs/architecture/modulo-configuracoes.md`.

O frontend é só apresentação. Perfil, AAL2, escopo de unidade, "último ADM",
`version`, conferência do texto de confirmação, reautenticação e auditoria são
decididos pelo **backend**. Esconder o item do menu ou desabilitar um botão é UX,
nunca controle de acesso: o backend responde 403.

## Negar por padrão
Os dados administrativos só são pedidos depois que `GET /api/v1/me` confirma o
papel ADM (`enabled: isAdmin`). Enquanto `/me` carrega, nada é consultado. Se
`/me` falhar: "Não foi possível confirmar sua sessão. Entre novamente."; se o
perfil não for ADM: "Você não tem permissão para visualizar usuários. É
necessário o papel ADM com a permissão de gestão de usuários."

## Lista
- Cabeçalho: eyebrow "Administração", h1 "Usuários", resumo e o botão
  **"Convidar Usuário"**.
- Seção `aria-label="Busca e filtros"`: busca por nome ou e-mail (debounce de
  300 ms, ≤100 caracteres, `type="search"`), `<select>` "Unidade" ("Todas as
  unidades", rótulo "SIGLA — Nome", de `GET /api/v1/units`) e dois grupos de
  pílulas (`role="group"`): **Perfil** (Todos / ADM / USER / RH) e **Situação**
  (Todas / Ativos / Inativos). "Limpar filtros" aparece só com filtro ativo.
  Qualquer mudança volta à página 1.
- Tabela `aria-label="Usuários"` com as colunas Nome (com avatar), E-mail,
  Perfil, Unidades, Status, Último acesso e a coluna de ações (cabeçalho
  `sr-only`). Ordenação **só** pela allowlist do backend — nome, e-mail e último
  acesso — com `aria-sort` no cabeçalho, botão nativo e dica `sr-only`
  ("(ativar para ordenar)" / "(crescente; ativar para decrescente)").
- Status com **ícone + texto**, nunca só cor: "Ativo" (check), "Inativo"
  (círculo cortado) e "Excluído" (lixeira, selo de aviso). Perfil ausente aparece
  como "Sem perfil"; sem unidades, "Nenhuma". Datas em America/Araguaina;
  "Nunca" quando não há último acesso.
- Paginação: `PaginationBar` comum ("Exibindo X–Y de N usuário(s) · Página n de
  m") com seletor "Registros por página" de 50/100/200 (padrão 50).
- Estados: esqueleto de tabela ao carregar; vazio com e sem filtro ("Nenhum
  usuário encontrado para os filtros atuais." / "Use 'Convidar Usuário' para
  enviar o primeiro convite."); erro com mensagem fixa por status (401, 403,
  `aal2_required`, 429 com `Retry-After`, 400 de filtros, genérico) e "Tentar
  novamente".
- Paginação/filtro em andamento: a página anterior continua visível, esmaecida e
  com `aria-busy`, até a próxima resposta chegar (`keepPreviousData`).
- A tabela rola na horizontal **dentro do contêiner**; a página nunca rola na
  horizontal, de 320 a 1920 px. Entrada escalonada das linhas quando a
  página/filtro muda.
- Usuário excluído não vem nesta lista (o backend filtra `deleted_at IS NULL`).
  Se vier, a linha mostra o rótulo anonimizado (`userDisplayName` /
  `userDisplayEmail` decidem pelo payload, nunca por comparação de string) e o
  botão "Gerenciar" fica desabilitado.

## Convidar usuário
`InviteUserDialog` → `POST /api/v1/users/invite`. Diálogo em superfície clara
(Light Surface Card do DESIGN.md): foco preso, Esc fecha, foco devolvido ao
gatilho.

- Campos: **Nome** (obrigatório), **E-mail institucional** (obrigatório),
  **Perfil** (`<select>` com **USER** e **RH** apenas — promover a ADM é feito
  depois, na aba "Perfil e unidades", com confirmação própria), **Unidades**
  (checkboxes das unidades do escopo do ADM, nunca UUID digitado à mão) e a
  seção expansível "Justificativa (opcional)" (`aria-expanded`/`aria-controls`).
- `noValidate`: no lugar das mensagens nativas do navegador, erro por campo
  (`FormField` com `role="alert"`, `aria-invalid`, `aria-describedby`); o foco vai
  ao primeiro campo inválido. `required`/`type=email` continuam no DOM.
- Validação no cliente é só UX: quem valida e autoriza é o backend
  (ADM + AAL2 + `users.invite`). Sucesso (toast + fechar) só no `onSuccess` —
  nunca antes da resposta. O diálogo não fecha durante o envio.
- O link do convite e qualquer token **nunca** aparecem na tela nem no console.
  Fluxo de ativação pelo convidado: `docs/ux/ATIVACAO_CONVITE.md`.

## Painel de detalhe (`Sheet` lateral)
`GET /api/v1/users/<id>`; a linha da lista serve de esboço até a resposta chegar.
Título = nome exibido, descrição = e-mail exibido. Selos: perfil (ou "Sem
perfil"), situação e "Você" quando é a própria conta. Quatro abas (`ui/tabs`,
WAI-ARIA, setas/Home/End): **Perfil e unidades · Conta · Foto · Histórico**.

- `404` → "Usuário não encontrado, ou fora do seu escopo de unidades." + "Voltar à
  lista" (o backend não diferencia inexistente de alheio, de propósito).
- `409 version_conflict` → recarrega o detalhe, invalida a lista e mostra o aviso
  de concorrência no topo do painel.
- Toda resposta de escrita devolve o `UserSummary` novo, que substitui o cache do
  detalhe e invalida a lista e o histórico.

### Aba "Perfil e unidades"
`PATCH /api/v1/users/<id>` com `version`; só os campos alterados vão no corpo.

- **Perfil**: rádios nativos com rótulo e descrição ("ADM — Administração",
  "USER — Usuário", "RH — Recursos Humanos"). Sem perfil (acesso revogado) a tela
  explica: "Sem perfil no momento (acesso revogado). Escolha um perfil para
  conceder acesso."
- **Unidades vinculadas**: checkboxes das unidades do escopo do ADM, com a dica
  "Somente as unidades do seu escopo de administração aparecem aqui". Limites de
  UX: ao menos 1 e no máximo 50 ("Selecione ao menos uma unidade." /
  "Selecione no máximo 50 unidades."). Vínculos **fora do escopo** aparecem em
  lista separada ("Outras unidades (fora do seu escopo)") como leitura, com a
  nota de que você não pode alterá-los.
- **Mudança de privilégio**: promover a ADM ou rebaixar um ADM abre uma
  confirmação explícita que lista as consequências (incluindo "Precisará usar a
  verificação em duas etapas (MFA) para acessar a área administrativa" e "Se for
  o último administrador ativo, o sistema recusará a mudança") e só então envia
  `confirm_privilege_change: true`. `400 confirmation_required` reabre a
  confirmação.
- "Salvar perfil e unidades" fica desabilitado sem alteração; "Descartar
  alterações" volta ao estado do servidor. Na própria conta o formulário é
  bloqueado com o aviso de que outro administrador precisa fazer a mudança.

### Aba "Conta" — ações administrativas
São **sete** ações, em dois grupos visualmente separados, porque "desativar",
"revogar" e "excluir" são coisas diferentes. Cada uma abre um
`ConfirmActionDialog` que diz exatamente o que acontece, em lista de
consequências; o resultado exibido é o que o backend devolveu (nunca otimista),
anunciado numa região `aria-live="polite"`.

Cabeçalho da aba: situação (selo), criada em, último acesso e, se inativa,
desativada em.

Grupo reversível:

| Ação | O que a tela diz | Envio |
|---|---|---|
| Desativar conta | bloqueia o acesso, encerra todas as sessões, mantém dados e histórico, pode reativar; **não é exclusão** | `{version, reason?}` (motivo opcional ≤1000, vai para a auditoria) |
| Reativar conta | libera o acesso com o mesmo perfil e unidades; as sessões encerradas não voltam | `{version}` |
| Encerrar sessões | desconecta de todos os dispositivos; a conta continua ativa | — |
| Redefinição de senha | envia e-mail para a pessoa criar nova senha; "você nunca vê o link nem a senha"; limite de 5 envios por hora | — |
| Resetar MFA | remove os autenticadores TOTP; exige confirmar o SEU código | — |

Grupo **"Ações de alto impacto"** (`region` com borda `signal-orange` e o aviso
"Desativar uma conta é reversível. Revogar o acesso desfaz perfil e unidades (dá
para refazer). Excluir é definitivo e não tem desfazer."):

- **Revogar todo o acesso** (`POST /users/<id>/revoke`): remove o perfil e TODOS
  os vínculos de unidade, cancela convite pendente, desativa a conta e encerra as
  sessões; a conta, o nome, o e-mail e o histórico continuam existindo. Motivo
  opcional (≤1000). O sistema recusa revogar a própria conta e a do último ADM
  ativo.
- **Excluir usuário definitivamente** (`POST /users/<id>/delete`): exclusão
  lógica **com anonimização**. A confirmação enumera: é irreversível (sem
  desfazer, lixeira ou restauração); nome, e-mail, telefone e foto são apagados ou
  substituídos por um rótulo sem identificação; o histórico de auditoria é
  preservado, mas o usuário excluído deixa de aparecer na tela de auditoria e o
  identificador exibido passa a ser o rótulo anonimizado — nunca o nome ou o
  e-mail original; perfil, unidades, sessões e autenticadores terminam na hora; o
  usuário sai da listagem e só volta com um convite novo; e a alternativa
  "Desativar conta", se o objetivo é só bloquear por um tempo.

**Confirmação forte da exclusão.** É preciso digitar o e-mail exato do alvo, no
campo "Para confirmar, digite o e-mail do usuário" (dica mostra o endereço). O
botão "Excluir definitivamente" fica desabilitado até coincidir — comparação do
cliente ignora caixa e espaços só para não punir quem digita em maiúsculas; o
texto vai como digitado em `confirm_text` e **quem valida é o backend**
(`400 confirmation_mismatch` → "O e-mail digitado não confere com o do usuário.
Nada foi excluído."). Nunca pré-confirmada, nunca em massa. Concluída a exclusão,
o painel fecha e todo o cache da pessoa é descartado, inclusive a URL assinada do
avatar.

**Reautenticação (TOTP).** Em `403 REAUTH_REQUIRED` (resetar MFA e, se o backend
pedir, excluir) o MESMO diálogo troca para o passo "Confirme sua identidade",
pede o código de 6 dígitos do autenticador do ADM (`reverifyTotp`) e, verificado,
repete a mesma ação automaticamente. Sem fator TOTP, orienta a sair e entrar de
novo. O código fica só no input e é limpo ao concluir.

**Regras comuns.** Todas as ações destrutivas ficam desabilitadas na própria
conta, com o aviso "Esta é a sua conta…". O diálogo não fecha durante a
requisição. `409 version_conflict` fecha o diálogo, recarrega e avisa.
`409 last_admin` / `self_change_forbidden` têm texto próprio. O botão que abriu a
confirmação recebe o foco de volta quando ainda existe (WCAG 2.4.3); quando a
ação o faz desaparecer (ex.: "Desativar" vira "Reativar", ou o painel fecha), o
Radix resolve o foco.

### Aba "Foto"
`AvatarManager` sobre `/users/<id>/avatar*`. Pré-visualização **local**
(`URL.createObjectURL`, revogada ao trocar/cancelar/desmontar): nada sai do
navegador antes de "Enviar foto". Tipo (JPEG/PNG/WebP) e tamanho (2 MB) são
checados na tela só como orientação — o backend valida os bytes, recodifica para
WebP 512×512 e remove EXIF. A foto atual vem por URL assinada temporária.
`503 storage_unavailable` → "O armazenamento de fotos está indisponível no
momento. O restante do sistema continua funcionando."; o resto da tela segue.
Remover a foto passa por `ConfirmActionDialog`.

### Aba "Histórico"
`GET /api/v1/users/<id>/audit`, paginado pela `PaginationBar`. Inclui eventos em
que a pessoa é alvo ou autora. Operações têm rótulo humano
(`OPERATION_LABEL`; código desconhecido aparece como o próprio código, em texto).
`changes` usa a allowlist do backend (role, units, active, avatar,
`sessions_revoked_at`) e é sempre **texto escapado pelo React** — nunca HTML.
Datas em America/Araguaina.

## Mensagens de erro
Sempre texto fixo mapeado pelo `error.code`/status (`userErrorMessage` em
`user-labels.ts`); **nenhuma mensagem do backend é exibida**. Cobre AAL2
requerido, reautenticação, unidade fora do escopo, `version_conflict`, último
ADM, alteração da própria conta, `confirmation_mismatch`, indisponibilidade do
armazenamento, 404 uniforme, 403, 429 (com `Retry-After`), 400 e genérico.

## LGPD e segurança na tela
- Nenhum token, link de convite, link de redefinição ou segredo TOTP aparece na
  interface, em `localStorage`/`sessionStorage`, na URL ou no console.
- Dados pessoais só onde o backend os devolve; chave ausente = campo inexistente
  (não aparece "null"/"undefined").
- Saída sempre como texto; sem `dangerouslySetInnerHTML`.
- Campos privilegiados (`role`, `unit_id`, `deleted_at`…) nunca são montados a
  partir de entrada livre do cliente: perfil vem de rádio, unidades de checkbox.

## Acessibilidade e motion
- WCAG 2.2 AA verificado por axe e matriz responsiva 320–1920 px nas telas
  `usuarios`, `usuarios-convite`, `usuarios-filtros`, `usuarios-detalhe-perfil`,
  `usuarios-detalhe-conta`, `usuarios-detalhe-foto`,
  `usuarios-detalhe-historico`, `usuarios-confirmar-adm`,
  `usuarios-confirmar-desativar`, `usuarios-acoes-alto-impacto`,
  `usuarios-confirmar-revogacao` e `usuarios-confirmar-exclusao`
  (`frontend/e2e/support/screens.ts`). **Não reexecutado nesta data.**
- Status e resultados sempre com ícone + texto; alvos ≥ 24 px; nos diálogos
  claros o selo usa texto escuro + ícone (metric-green não tem contraste sobre
  bone).
- Animações só de `@/components/animations` e `@/lib/motion/tokens` (150–200 ms,
  sem spring), respeitando `prefers-reduced-motion`. Nenhum número é animado.

## Testes (não reexecutados nesta data)
- `frontend/e2e/users-functional.spec.ts` — lista, filtros, convite, perfil e
  unidades, foto, histórico e "Meu perfil".
- `frontend/e2e/users-delete-functional.spec.ts` — exclusão e revogação total:
  corpo `{version, confirm_text}` (campo extra → 400), resposta 200 com o resumo
  anonimizado, `confirmation_mismatch`, `last_admin`, `self_change_forbidden`,
  `version_conflict`, reautenticação TOTP, saída da listagem, axe e verificação
  de rolagem (`support/layout-checks.ts`).
- `frontend/e2e/security-users-functional.spec.ts` — nenhuma `error.message` do
  backend chega à tela; CSP do middleware com `img-src` limitado ao prefixo
  assinado de avatares; `script-src` sem `'unsafe-inline'`.
- `frontend/e2e/admin-access-functional.spec.ts` — a consulta de perfis e a
  matriz (somente leitura): `docs/ux/PERFIS_PERMISSOES.md`.

## A confirmar
- A matriz de permissões por perfil **não** é editável (só `GET` no backend);
  a decisão de torná-la gravável para RH e USER, com teto de permissões, segue
  pendente — ver `docs/ux/PERFIS_PERMISSOES.md`.
- `POST /users/<id>/delete` é interceptado nos testes do navegador (o mock
  compartilhado não conhece a rota); o contrato foi confirmado com o backend,
  mas o caminho real não é exercitado pela suíte.
