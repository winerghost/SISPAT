# UX — Movimentações (`/movimentacoes`)

Tela real de movimentações de bens (onda 3 do frontend). Contrato da API:
`docs/architecture/movements-api.md`. Código:
`frontend/src/components/features/movements/` (`movimentacoes-page.tsx` + tabela,
filtros, seletor de bem, painel de detalhe, solicitação e decisão) e cliente
`frontend/src/lib/movements-api.ts`. O frontend é só apresentação: perfil, escopo
de unidade, AAL2, transições de estado, vínculos e concorrência (`asset_version`)
são decididos pelo backend. Esconder botões por perfil é UX, nunca segurança.

## Lista
- Cabeçalho (eyebrow "Patrimônio", h1), botão "Solicitar movimentação" (ADM e USER;
  RH não vê e a descrição diz que o perfil é somente de consulta).
- Filtros: estado (Pendente/Aprovada/Rejeitada/Cancelada), unidade de origem e de
  destino (`GET /units/accessible`), período ("Solicitada a partir de" / "até",
  `AAAA-MM-DD`), bem (busca em `GET /assets`, envia `asset_id`) e "Ordenar por"
  (allowlist `created_at|-created_at|status|-status`; também nos cabeçalhos
  "Estado" e "Solicitada em" com `aria-sort`). Qualquer filtro volta à página 1;
  "Limpar filtros".
- Paginação "Página X de Y · N movimentação(ões)" (25 por página), estados
  carregando (skeleton), vazio (com e sem filtro) e erro com "Tentar novamente".
  Falha só da lista de unidades avisa e mantém a listagem.
- Responsivo 320–1920 sem rolagem da página: até `md` só "Bem" (com estado, De/Para
  e data embaixo) + Detalhes; `md` soma "Movimento" (De/Para) e "Estado"; `lg` soma
  "Solicitada em".
- O estado é sempre ícone + texto (Pendente = relógio, Aprovada = check,
  Rejeitada = X, Cancelada = proibido). Número patrimonial é TEXTO (mono,
  `translate="no"`). Datas em America/Araguaina. Nenhum número é animado; o total
  vem do backend.
- Não há botões de editar nem excluir: o histórico é imutável.

## Detalhe (painel lateral)
- `GET /movements/<id>` (a linha da lista serve de esboço). Origem → destino em
  texto claro (blocos "Origem" e "Destino" com unidade, sala e responsável; seta
  decorativa e frase "o bem sai da origem e vai para o destino").
- Campos opcionais só existem se a CHAVE veio: RH não recebe `reason`,
  `requested_by` nem `approved_by`, então não há "Motivo da solicitação",
  "Solicitante" nem "Aprovada por". Identificadores de autoria mostram só o final.
- Leitor com escopo só no DESTINO: o backend OMITE (chave ausente, não `null`)
  `origin_room_id`, `origin_room`, `previous_responsible_id`, `previous_responsible`
  e `reason`. A tela testa a presença da CHAVE: na origem mostra "indisponível (fora
  do seu escopo)" em vez de "sem sala"/"sem responsável", acrescenta a nota
  `origin-scope-note`, não mostra "Motivo da solicitação" e nunca exibe
  "null"/"undefined". Ao aprovar, sala/responsável de origem só entram na
  comparação de "o bem mudou desde a solicitação" se as chaves vieram (sem aviso
  falso). Código: `originVisibility`/`sideSummary` em `movement-labels.ts`.
- Ações só em movimentação PENDENTE: Aprovar e Rejeitar (ADM), Cancelar solicitação
  (solicitante — `requested_by` igual ao `/me` — ou ADM). Decididas não têm ação.

## Solicitar (ADM e USER)
- Diálogo claro: bem (busca com debounce 300 ms em `/assets`, escopo do backend),
  unidade de destino (só ativas), sala de destino (`/rooms` da unidade, só ativas),
  novo responsável (`/responsible-people` da unidade, só ativos) e motivo (≤500).
- Envia `{asset_id, asset_version, destination_unit_id, destination_room_id?,
  new_responsible_id?, reason?}`; o bem NÃO muda na solicitação.
- Semântica exibida claramente (decidida pelo backend):
  - outra unidade: "Sem sala/responsável no destino" = campo não enviado; o bem
    ficará sem sala/responsável;
  - mesma unidade: "Manter a sala/o responsável atual" = campo não enviado; "Remover
    ..." = `null` explícito;
  - mesma unidade sem nenhuma mudança: aviso e botão desativado (dica de UX; o
    backend responde `no_change`).
- 409 `version_conflict`: recarrega o bem (nova `version`), avisa, e o reenvio usa a
  nova versão.

## Aprovar, rejeitar e cancelar
`ConfirmActionDialog`, sempre explicando que a transição é única e o histórico é
imutável.
- Aprovar (só ADM): diz que ALTERA O BEM de forma definitiva. Ao abrir lê
  `GET /assets/<id>`, mostra a situação atual do bem, avisa se ele mudou desde a
  solicitação e envia `{asset_version}` (a versão que o aprovador viu). Sem leitura
  do bem (ex.: só o destino no escopo) a confirmação fica bloqueada.
- Rejeitar (só ADM): motivo obrigatório na tela (o contrato o aceita opcional);
  envia `{reason}` e não altera o bem.
- Cancelar (solicitante ou ADM): motivo opcional; envia `{}` ou `{reason}`.
- 409 `version_conflict` (aprovar): recarrega o bem, avisa e mantém o diálogo para
  nova revisão. 409 `invalid_transition`: fecha, avisa e recarrega a movimentação.

## Erros (texto fixo, nunca o do backend)
409 `version_conflict`, `movement_pending`, `no_change`, `invalid_transition`,
`asset_unavailable`, `unit_inactive`, `link_inactive`, `link_unit_mismatch`;
404 uniforme ("não encontrada, ou fora do seu escopo de unidades"); 403; 400; 429
(com `Retry-After`); 401; AAL2 requerido; rede.

## Acessibilidade e motion
- WCAG 2.2 AA (axe 1366 e 375 px) e matriz 320–1920 px nas telas `movimentacoes-*`
  de `frontend/e2e/support/screens.ts` (lista ADM/USER/RH, vazio, erro, detalhe
  ADM/RH, solicitar, aprovar, rejeitar).
- Tabela, painel e diálogos animam só via `@/components/animations` e
  `@/lib/motion/tokens` (150–200 ms), respeitando `prefers-reduced-motion`.

## Testes
`frontend/e2e/movements-functional.spec.ts` com o mock
`frontend/e2e/support/movement-mocks.ts`, que imita escopo (origem OU destino na
leitura; origem E destino para decidir), perfis ADM/USER/RH, transições únicas,
`asset_version` + instantâneo de origem, vínculos, semântica ausente × null, 405
para PUT/PATCH/DELETE e a alteração do bem na aprovação. O mock também omite as
chaves de origem e `reason` para quem só tem escopo no destino (caso `FORA-001`),
com specs para ADM (painel e linha sem "null"/"undefined") e RH. Nenhum dado é real.

## Lacunas conhecidas
- O objeto de movimentação não traz a versão do bem: a tela a lê com
  `GET /assets/<id>` ao aprovar (precisa de escopo de leitura sobre o bem).
- Aprovar/rejeitar exigem escopo de origem e destino (decisão provisória do backend).
- Seletores de sala/responsável limitados a 100 itens por unidade.
- Contrato desenvolvido contra mocks; confirmar com o backend real publicado.
