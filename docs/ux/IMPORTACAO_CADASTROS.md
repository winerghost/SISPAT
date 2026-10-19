# UX — Importação dos cadastros de apoio e pendências de bens

Tela: `/administracao/importacao/cadastros` (menu Administração → "Importação de
Dados → Cadastros de apoio", item `adminOnly` em
`frontend/src/components/layout/nav-items.ts`). Contrato da API:
`docs/architecture/cadastros-apoio-api.md` (seção "Importação dos cadastros") e
`docs/architecture/plano-importacao-mconferencia.md`. O frontend só apresenta:
perfil, AAL2, permissão do tipo, expiração e idempotência são decididos pelo
backend; ocultar o item do menu para USER/RH não é segurança.

## Fluxo (uma aba por cadastro: Unidades, Salas, Pessoas responsáveis)
1. **Gerar prévia** — `POST /catalog-imports/<kind>/preview` (sem corpo). Lê a
   planilha, não grava nada. Indicador "Requisição" reflete só o estado real da
   mutation (sem barra de progresso inventada).
2. **Resumo** — contadores do backend por classificação (NOVO / EXISTENTE /
   DUPLICADO / INVALIDO / CONFLITANTE), reaproveitando `PreviewSummaryCards`
   (única animação numérica: 0 → valor confirmado pelo backend).
3. **Relatório** — pendências por código (rótulos humanos, ex.: "Unidade sem
   alias", "Nome vazio"), IDs repetidos (com linhas), nomes suspeitos (com
   motivo) e prováveis duplicatas. Só leitura, listas semânticas (sem tabela),
   números não animados. O sistema não corrige nomes nem chuta vínculos.
4. **Itens** — `GET /catalog-imports/<id>/items`: pílulas de classificação
   (`aria-pressed`), busca com debounce de 400 ms (≤100), ordenação só pela
   allowlist (`label`, `source_id`, `classification`, `aria-sort`), 25 por
   página. Checkbox só em NOVO/EXISTENTE; os demais mostram o motivo.
   "Selecionar todos os elegíveis" / "Limpar seleção" + exceção por item.
5. **Confirmar** — `ConfirmActionDialog` diz que é gravação **em massa** e
   **idempotente** (a 2ª confirmação da mesma prévia é recusada com 409), que
   itens duplicados/inválidos/conflitantes não são gravados e que nada é
   excluído. Ao abrir, o painel coleta TODOS os `item_ids` elegíveis paginando
   `GET /items` (100 por página) e aplica a seleção local, mostrando a contagem
   exata ("Serão criados: N. Serão atualizados: M."). O diálogo não fecha
   durante a gravação (Esc ignorado) e o botão fica em `loading`.
   **Sigla de atalho (só Unidades, SEC-CAT-04).** Itens NOVO com
   `details.create_alias=true` mostram o controle "Criar sigla de atalho para
   esta unidade", **desmarcado por padrão** (nunca marcado em massa
   automaticamente). O painel explica que a sigla passa a decidir a unidade dos
   bens importados e só deve ser aceita se conferida. Ações opcionais: "Criar
   sigla nos itens selecionados desta página" (só itens que o ADM marcou para
   importação e que admitem sigla) e "Limpar siglas marcadas". Item fora da
   seleção não aceita sigla. O diálogo mostra "Siglas de atalho a criar: N". O
   envio inclui `alias_item_ids` (subconjunto de `item_ids`) só com os itens
   optados e **omite o campo se vazio** (nenhum alias é criado). Salas e pessoas
   não mudam.
6. **Resultado** — criados / atualizados / ignorados / falhas e a lista de
   falhas por item (linha, nome, motivo — texto escapado). Só após a resposta do
   backend; a prévia é consumida (para nova importação, gerar outra).

Trocar de aba descarta a prévia em tela (continua válida no servidor até
expirar, mas é preciso gerar outra).

## LGPD
- Telefone **nunca** aparece: só "Telefone: informado (oculto)" / "não informado"
  (`has_phone`). E-mail só mascarado (`c***@agu.gov.br`), como vem do backend.
- Nomes de pessoas só aparecem onde o backend os devolve para revisão (itens e
  relatório). Nada vai para `localStorage`/`sessionStorage`/cookies/URL/console;
  o cache do TanStack Query vive só em memória e é descartado ao confirmar.
- Saída sempre como texto (React escapa); sem `dangerouslySetInnerHTML`.

## Mensagens de erro fixas (nunca o texto cru da API)
| Situação | Mensagem (resumo) |
|---|---|
| 409 na prévia | A aba deste cadastro não está configurada para importação. |
| 409 na confirmação | Prévia já confirmada, expirada ou não confirmável — gerar nova. |
| 422 | A planilha de origem não tem a estrutura esperada (colunas). |
| 502 | Não foi possível ler a planilha (Google Sheets) agora. |
| 429 | Muitas solicitações — aguarde (usa `Retry-After`). |
| 403 / 404 | Genéricos, sem detalhe ("sem permissão", "fora do seu escopo"). |
| `AAL2_REQUIRED` | Exige verificação em duas etapas concluída nesta sessão. |

404/409 na confirmação ou nos itens invalidam a prévia em tela e pedem uma nova.

## Pendências de vínculo na importação de bens
`/administracao/importacao/google-sheets` passou a exibir, após a prévia, o
painel "Pendências de vínculo" com `pending_counts` (só códigos com contagem
> 0), o aviso de que **não bloqueiam** a confirmação, o botão "Carregar relatório
de pendências" (`GET /imports/google-sheets/<id>/pending`, lista todos os
códigos) e um link para a importação de cadastros quando há pendências. O fluxo
e os controles anteriores não mudaram.

## Acessibilidade e motion
- WCAG 2.2 AA verificado por axe (1366 e 375 px) e matriz 320–1920 px nas telas
  `cadastros-*` e `importacao-pendencias` (`frontend/e2e/support/screens.ts`).
  Status/classificação sempre com ícone + texto; alvos ≥ 24 px; tabela rola só
  dentro do contêiner.
- Abas com padrão WAI-ARIA APG (`ui/tabs`), setas/Home/End.
- Animações só de `@/components/animations` e `@/lib/motion/tokens`
  (150–200 ms, sem spring), respeitando `prefers-reduced-motion`; nenhum número
  que o backend não confirmou é animado.
