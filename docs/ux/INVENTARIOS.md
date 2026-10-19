# UX — Inventários (`/inventarios`)

Tela real de inventários (onda 4 do frontend). Contrato da API:
`docs/architecture/inventories-api.md`. Código:
`frontend/src/components/features/inventories/` (`inventarios-page.tsx` + tabela,
filtros, painel de detalhe, resumo, itens conferidos, bens da unidade e os diálogos de
criar, transição e conferir) e clientes `frontend/src/lib/inventories-api.ts`
(inventários e `GET /api/v1/locations`). O frontend é só apresentação: perfil, escopo
de unidade, AAL2, estados, transições, política de 1 conferência por bem e resultado
derivado são decididos pelo backend. Esconder botões por perfil é UX, nunca segurança.

## Perfis
- **ADM** (AAL2): lê, cria, inicia, encerra, cancela e confere.
- **USER**: lê e confere (permissão `inventory.check`); não vê "Novo inventário" nem
  Iniciar/Encerrar/Cancelar (o backend responde 403 se forçado).
- **RH**: sem acesso. A tela mostra "Sem acesso aos inventários" (mensagem fixa) e NÃO
  dispara nenhuma consulta de inventários, bens, locais ou unidades.

## Lista
- Cabeçalho (eyebrow "Patrimônio", h1), botão "Novo inventário" (só ADM).
- Filtros: estado (Aberto / Em andamento / Concluído / Cancelado), unidade
  (`GET /units/accessible`), busca por nome (debounce 300 ms, ≤100) e "Ordenar por"
  (allowlist `created_at|name|start_date|status`, com `-`; também nos cabeçalhos
  "Inventário", "Estado", "Início" e "Criado em" com `aria-sort`). Qualquer filtro volta
  à página 1; "Limpar filtros".
- Paginação "Página X de Y · N inventário(s)" (25 por página), estados carregando
  (skeleton), vazio (com e sem filtro) e erro com "Tentar novamente". Falha só da lista
  de unidades avisa e mantém a listagem.
- Responsivo 320–1920 sem rolagem da página: até `md` só "Inventário" (com estado,
  unidade e início embaixo) + Detalhes; `md` soma "Unidade" e "Estado"; `lg` soma
  "Início"; `xl` soma "Criado em".
- Estado sempre ícone + texto (Aberto = pasta, Em andamento = play, Concluído = check,
  Cancelado = proibido). Datas de criação em America/Araguaina; `start_date`/`end_date`
  são datas de calendário.
- Não há editar nem excluir: inventários e conferências são imutáveis.

## Detalhe (painel lateral)
- `GET /inventories/<id>` (a linha da lista serve de esboço). 404 = "não encontrado, ou
  fora do seu escopo" com "Voltar à lista".
- **Resumo** (`GET /inventories/<id>/summary`): total de bens, conferidos, pendentes,
  encontrados, não encontrados, divergentes e `progress_percent`, TODOS calculados no
  servidor. A barra (`role=progressbar`) reflete exatamente o `progress_percent`
  recebido, sem transição de largura; nenhum número é somado, estimado ou animado na
  tela. Os números mudam só depois que o servidor responde (refetch após cada ação).
- Dados: início, término, criado em, encerrado/cancelado em, criador (final do
  identificador). Avisos fixos: a conferência NÃO altera `assets.located` nem o local
  cadastrado; histórico imutável; cada bem é conferido uma única vez por inventário.
- Abas: **Itens conferidos** (`GET .../items`: filtro por resultado, ordenação por data,
  10 por página; cada item mostra bem, resultado com ícone+texto, conferidor, data, local
  cadastrado/observado e observações como TEXTO) e **Bens da unidade** (`GET /assets?
  unit_id=` com busca; cada bem aparece "Pendente" ou com o resultado, lido de `/items`;
  "Ocultar bens já conferidos" age só na página exibida).

## Ações do ADM (`ConfirmActionDialog`)
- **Novo inventário**: nome (1..200), unidade ativa e data de início opcional. Envia
  `{name, unit_id, start_date?}`; nasce ABERTO. Nome/unidade/início não são editáveis.
- **Iniciar** (só ABERTO): passa a EM ANDAMENTO; transição única.
- **Encerrar** (só EM ANDAMENTO): diz que é DEFINITIVO e IMUTÁVEL, não pode ser reaberto,
  e que a conferência não altera os bens. Estado final CONCLUÍDO.
- **Cancelar** (ABERTO ou EM ANDAMENTO): definitivo; as conferências já feitas permanecem.
- Motivo opcional (≤500) enviado como `{reason}` (o backend só audita `has_reason`).
  Sucesso só depois da resposta. 409 `invalid_transition` (outra pessoa mudou o estado)
  fecha o diálogo, avisa e recarrega.

## Conferir bem (ADM e USER)
- Só em inventário EM ANDAMENTO, para bens ainda pendentes (UX; o backend decide).
- Diálogo: "O bem foi encontrado?" (obrigatório, sem padrão), local observado (opcional,
  só com "Sim"; `GET /locations?unit_id=` da unidade do inventário, só ativos) e
  observações (≤500, texto livre). Envia `{asset_id, found, observed_location_id?, notes?}`.
- O RESULTADO (Encontrado / Não encontrado / Divergente), o conferidor e a data vêm do
  servidor; a tela só explica que um local diferente do cadastrado vira Divergente e mostra
  o que ele devolveu ("Conferência registrada: <resultado>. O bem não foi alterado.").
- Sem reconferência (política 1 por bem). Sem editar nem excluir conferência.

## Erros (texto fixo, nunca o do backend)
409 `already_checked`, `inventory_not_started`, `inventory_closed`, `invalid_transition`,
`link_inactive`, `unit_inactive`, `conflict`; 404 uniforme ("Inventário não encontrado,
ou fora do seu escopo de unidades"); 403; 400; 429 (com `Retry-After`); 401; AAL2
requerido; rede. `inventory_not_started`, `inventory_closed` e `invalid_transition`
fecham o diálogo, avisam e recarregam; `already_checked` mantém o diálogo e atualiza a
lista de bens.

## Acessibilidade e motion
- WCAG 2.2 AA (axe 1366 e 375 px) e matriz 320–1920 px nas telas `inventarios-*` de
  `frontend/e2e/support/screens.ts` (lista ADM/USER/RH, vazio, erro, detalhe em
  andamento/bens/encerrado, novo, iniciar, encerrar, cancelar, conferir).
- Tabela, painel e diálogos animam só via `@/components/animations` e
  `@/lib/motion/tokens` (150–200 ms), respeitando `prefers-reduced-motion`.

## Testes
`frontend/e2e/inventories-functional.spec.ts` com o mock
`frontend/e2e/support/inventory-mocks.ts`, que imita perfis ADM/USER/RH, escopo de
unidade (404 uniforme), estados e transições (409 `invalid_transition`), conferência só
EM ANDAMENTO, 1 conferência por bem (409 `already_checked`), local de outra unidade (404)
ou inativo (409), resultado derivado no servidor, resumo calculado no servidor,
conferidor/data do servidor, mass assignment (400), 405 para PUT/PATCH/DELETE e a
garantia de que a conferência não altera o bem. Nenhum dado é real.

## Lacunas conhecidas
- Não há endpoint de "bens pendentes": a tela lista os bens da unidade (`GET /assets`) e
  marca os conferidos com o mapa lido de `/items` (até 1000 conferências; acima disso o
  mapa é parcial e o servidor continua impedindo repetição com 409).
- Seletor de locais limitado a 100 por unidade (limite do backend).
- A decisão institucional sobre aplicar o resultado em `assets.located` está pendente no
  backend; hoje a conferência é só evidência.
- Contrato desenvolvido contra mocks; confirmar com o backend real publicado.
