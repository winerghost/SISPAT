# UX — Cadastros de apoio (salas, pessoas responsáveis, unidades)

Telas: `/administracao/salas`, `/administracao/responsaveis`,
`/administracao/unidades` (grupo Administração, itens `adminOnly` em
`frontend/src/components/layout/nav-items.ts`). Contrato da API:
`docs/architecture/cadastros-apoio-api.md`. O frontend é só apresentação: perfil,
escopo de unidade, AAL2, unicidade e concorrência são decididos pelo backend.

## Padrão das telas
- Cabeçalho (eyebrow Geist Mono + h1), busca com debounce de 300 ms (≤100
  caracteres), filtro de unidade (`<select>` nativo, "SIGLA — Nome"), pílulas de
  situação (Todas/Ativas/Inativas, `aria-pressed`), "Limpar filtros".
- Tabela (`ui/table`): ordenação só pela allowlist do backend (`aria-sort` +
  botão), entrada escalonada ≤20 linhas, `busy` esmaece com `keepPreviousData`,
  estado vazio com orientação, paginação "Página X de Y · N registro(s)".
  Rola na horizontal só dentro do contêiner (nunca a página, 320–1920 px).
- Situação com ícone + texto (nunca só cor). Datas em America/Araguaina.
- Criar/editar em `Dialog` claro (foco preso, Esc fecha, foco devolvido); não
  fecha durante a requisição; sucesso (toast + fechar + recarregar) só depois da
  resposta do backend. Nenhum número é animado.

## Regras de interface
- **Excluir = Inativar.** Não existe DELETE. O diálogo de confirmação explica
  que o registro é preservado, que bens já vinculados continuam válidos (a
  inativação só impede novas associações) e que dá para reativar. Motivo
  opcional (≤500) vai para a auditoria.
- Edição: unidade, sigla e ID de origem aparecem como leitura. O PATCH envia só
  campos alterados (`null` limpa opcionais) + `expected_updated_at`.
- Erros (texto fixo, sem eco da API): 409 `conflict` (duplicado), 409
  `unit_inactive`, 409 `version_conflict` (recarrega o registro e avisa), 403
  (genérico), 404 ("não encontrado, ou fora do seu escopo"), 400, 429 e
  AAL2 requerido.
- **LGPD / telefone**: coluna e campo só existem se a chave `phone` veio no JSON
  (ADM). Lista mascarada (`(••) •••••-NNNN`); o formulário de edição mostra o
  número ao ADM. Nunca em URL, storage, console ou logs. Mesma regra para
  `address` (unidade).
- Unidades: a lista usa `GET /units/catalog` (ADM + AAL2): ativas e inativas,
  busca server-side com debounce (sigla/nome), pílulas Todas/Ativas/Inativas
  (padrão Todas), ordenação por sigla/nome/atualizada em (allowlist) e
  paginação de 25. Cada linha tem "Gerenciar" (diálogo de edição: sigla e ID de
  origem só leitura; descrição e `updated_at` vêm de `GET /units/<id>`) e
  "Inativar"/"Reativar" (inclusive para inativas), com `expected_updated_at`.
  O seletor de unidades de salas/pessoas/usuários continua em `GET /units`
  (só ativas, outro contrato) e é recarregado após inativar/reativar.

## Acessibilidade e motion
- WCAG 2.2 AA verificado por axe (1366 e 375 px) e matriz 320–1920 px nas telas
  `salas*`, `responsaveis*`, `unidades*` (`frontend/e2e/support/screens.ts`).
  No diálogo claro o selo de situação usa texto escuro + ícone (metric-green não
  tem contraste sobre bone).
- Animações só de `@/components/animations` e `@/lib/motion/tokens`
  (150–200 ms, sem spring), respeitando `prefers-reduced-motion`.
