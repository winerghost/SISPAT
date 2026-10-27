# Dashboard personalizável — análise e plano de ação

Registrado em 2026-10-20 a pedido do responsável pelo sistema.

## Princípio

**A exibição do dashboard é personalizável: cada usuário escolhe o que é de seu
interesse** — tipo de cada gráfico, quais painéis aparecem e em que ordem, e
os filtros que recortam os números (unidade, localizado, vínculo...). A
personalização é apresentação: os números sempre vêm do backend, dentro do
escopo de unidade do usuário, e os filtros são validados no servidor
(allowlist, `extra="forbid"`).

## O que já existe (2026-10-20)

- **Localizado (coluna `LOCALIZADO` S/N da planilha)** já é contado:
  `Asset.located` = SIM / NAO / DESCONHECIDO
  (`backend/app/services/dashboard_service.py`, `summary` e `by_situation`).
  Aparece no card "Localizados" e no painel "Bens por situação"
  (pizza/rosca/barras). Não há card de "Não localizados".
- **Personalização atual:** só o tipo de gráfico de 3 painéis (unidades,
  situação, mensal), salvo em `user_preferences.dashboard_charts`
  (`docs/ux/DASHBOARD_GRAFICOS.md`).
- **Filtros:** nenhum. `/dashboard/resumo`, `/por-unidade` e `/por-situacao`
  não aceitam parâmetros (qualquer parâmetro → 400); `/aquisicoes-mensais` aceita
  só `meses`. Os painéis são fixos e o relatório imprimível não tem filtros.

## Catálogo de filtros (dashboard e relatórios)

Pedido do responsável (2026-10-20): além de Unidade, Localizado e Vínculo,
oferecer filtros que tornem a exibição flexível. Todos usam dados que já
existem; o mesmo schema de filtros serve ao dashboard, ao relatório imprimível
e, depois, ao menu Relatórios (exportações via `app.security.csv_safety`).

| Grupo | Filtro | Origem do dado | Parâmetro (proposto) |
|---|---|---|---|
| Local | Unidade de uso | `assets.unit_id` | `unit_id` |
| Local | Unidade pertencente (dona) | `assets.owner_unit_id` | `owner_unit_id` |
| Local | Sala (depende da unidade) | `assets.room_id` | `room_id` |
| Local | Com / sem sala | `room_id IS [NOT] NULL` | `has_room=true/false` |
| Situação | Localizado: Sim / Não / Desconhecido | `assets.located` (coluna LOCALIZADO S/N) | `located` |
| Situação | Vínculo: Servidor / Terceirizado / Ocioso / sem vínculo | `assets.bond_status` (1ª RESPONSAVEL) | `bond_status` (`__none__`) |
| Responsabilidade | Pessoa responsável | `assets.responsible_person_id` | `responsible_person_id` |
| Responsabilidade | Com / sem responsável | `responsible_person_id IS [NOT] NULL` | `has_responsible=true/false` |
| Tipo | Tipo de bem (NOTEBOOK, CADEIRA...) | deduzido da descrição (`infer_type`, já usado no dashboard) | `tipo` |
| Período | Data de registro de / até | `assets.registration_date` | `registrado_desde`, `registrado_ate` |
| Inventário | Conferido em inventário: sim / não / encontrado / não encontrado | `inventory_items.found`, `checked_at` | `inventario` |
| Movimentação | Com movimentação pendente | `asset_movements.status = 'PENDENTE'` | `movimentacao_pendente=true` |

Regras: todos opcionais e combináveis (E lógico); validados no backend
(allowlist, limites, UUID, datas com `desde ≤ ate` e janela ≤ 5 anos); IDs
fora do escopo de unidade devolvem resultado vazio (sem distinguir de
inexistente); na tela, os mais usados (Unidade, Localizado, Vínculo, Tipo)
ficam visíveis e os demais em "Mais filtros"; um resumo dos filtros ativos
aparece acima dos números e no cabeçalho do relatório; "Limpar filtros" volta
ao total. O filtro de tipo é aplicado após a dedução do tipo (volume atual de
centenas de bens; revisar se passar de dezenas de milhares).

Painéis adicionais habilitados pelo catálogo: Localizados × não localizados
por unidade; Bens por vínculo; Ociosos por unidade; Bens sem responsável / sem
sala; Não localizados por sala (top 15); Conferidos × não conferidos no
inventário.

## Lacunas

- Filtros globais: unidade, localizado, vínculo, sala, unidade pertencente,
  período (`registration_date`), com/sem responsável, com/sem sala.
- Escolher, ocultar e reordenar painéis; restaurar padrão.
- Painéis novos viáveis com os dados atuais: Localizados × não localizados por
  unidade; Bens por vínculo; Ociosos por unidade; Bens sem responsável / sem
  sala; Não localizados por sala (top N); unidade pertencente × unidade de uso.
- Sem dados hoje: valor, manutenção e baixas.

## Arquitetura proposta

- **Backend:** schema `DashboardFilters` (Pydantic, `extra="forbid"`) único para
  todos os endpoints de agregação; filtros aplicados depois do escopo de
  unidade (unidade alheia → resultado vazio, igual a inexistente); lógica de
  filtro compartilhada com a lista de bens (mesmas contagens). Novos
  endpoints: `/dashboard/localizacao-por-unidade`, `/dashboard/por-vinculo`,
  `/dashboard/pendencias-cadastro`, `/dashboard/por-sala` (top N + "Outros").
- **Preferências:** os 512 bytes de `dashboard_charts` não comportam layout e
  filtros salvos. Nova coluna `user_preferences.dashboard_layout` (JSONB,
  CHECK objeto e ≤ 2048 bytes; painéis em allowlist), migração
  `0013_user_prefs_dashboard_layout` + espelho `sql/0016`.
  `dashboard_charts` continua valendo.
- **Frontend:** barra de filtros com estado na URL (link compartilhável; o
  relatório imprimível herda e lista os filtros); aviso "os números refletem os
  filtros ativos"; diálogo "Personalizar dashboard" com caixas de seleção e
  botões mover para cima/baixo (sem depender de arrastar), acessível por
  teclado; card "Não localizados".
- **Segurança:** IDOR por filtro (mesma resposta), parâmetro desconhecido →
  400, mass assignment nas preferências → 400 + evento, rótulos da planilha
  sempre como texto (React), payload limitado.

## Plano por fases

| Fase | Entrega | Agentes | Depende | Rebuild na VPS |
|---|---|---|---|---|
| 1 | Filtros Unidade + Localizado + Vínculo em todos os endpoints; `/localizacao-por-unidade`; `/por-vinculo` | backend-domain → security-reviewer | Vínculo (0012) aplicado | backend |
| 2 | Barra de filtros (URL), card "Não localizados", 2 painéis novos, relatório com filtros | frontend → security-reviewer | 1 | frontend |
| 3 | Layout salvo (`dashboard_layout`) e diálogo "Personalizar dashboard" | backend-platform → frontend → security-reviewer | 2 | backend + frontend + migração (com autorização) |
| 4 | Filtros avançados (sala, unidade pertencente, responsável/sala sim-não, período); `/pendencias-cadastro`, `/por-sala`; filtros salvos | backend-domain → frontend → security-reviewer | 1 (3 para salvar) | backend + frontend |

Testes por fase: pytest (filtros, escopo/IDOR, 400, top N, paridade com a
lista de bens, preferências) e Playwright + axe (320–1920 px, teclado).

## Riscos

1. Cerca de 7 chamadas por troca de filtro: debounce e/ou limite de leitura
   próprio do dashboard.
2. Paridade de contagens depende de lógica de filtro compartilhada.
3. Vínculo é texto livre da planilha: grafias diferentes podem virar
   categorias extras.
4. Muitos bens "Desconhecido" na importação: exibir os três estados.
5. Filtro de unidade conta `unit_id` (unidade de uso); deixar claro na tela.

## Decisões do responsável (2026-10-20)

- **MVP = fases 1 e 2** com os filtros **Unidade + Localizado + Vínculo**.
- **Ampliação (mesmo dia):** o responsável pediu os demais filtros do catálogo
  junto, para dashboard e relatórios flexíveis. As fases 1, 2 e 4 passam a ser
  entregues juntas (filtros e painéis); a fase 3 (layout salvo) continua depois.
- **Filtros só na URL** por enquanto (link compartilhável); salvar por usuário
  fica para a fase 3, junto com o layout.
- **Relatório imprimível herda os filtros** e os lista no cabeçalho.
- **Personalização só por usuário** (sem padrão por perfil definido pelo ADM).

Ainda em aberto (padrões propostos, usados até decisão em contrário):
"Desconhecido" exibido junto de Localizado/Não localizado; período por
`registration_date`; top N vínculo 8 e sala 15.

## Contrato implementado (backend, 2026-10-20)

Detalhes e regras: `docs/architecture/dashboard-api.md`. Todos os endpoints são
`GET`, exigem sessão (ADM com AAL2) e `reports.read`, respondem `Cache-Control:
no-store`, 1200 chamadas/h por usuário e por rota. Erro de filtro → 400
`{"error":{"code":"validation_error","message":"Parâmetro(s) inválido(s): located."}}`
(só nomes de campo).

**Filtros (query string, iguais em todos os endpoints abaixo):** `unit_id`,
`owner_unit_id`, `room_id`, `responsible_person_id` (UUID); `has_room`,
`has_responsible`, `movimentacao_pendente` (`true`/`false`); `located`
(`SIM`/`NAO`/`DESCONHECIDO`); `bond_status` (texto ≤ 64 ou `__none__`); `tipo`
(`[A-Z0-9]{1,40}` ou `NAO_CLASSIFICADO`, valores de `/tipos`); `registrado_desde`,
`registrado_ate` (`AAAA-MM-DD`, `desde ≤ ate`, janela ≤ 5 anos); `inventario`
(`conferido`/`nao_conferido`/`encontrado`/`nao_encontrado`). `meses` (1..24) só em
`/aquisicoes-mensais`. Parâmetro vazio (`?located=`) é inválido: omita o filtro.
Ex.: `/api/v1/dashboard/resumo?unit_id=…&located=NAO&bond_status=Ocioso`.

| URL | Resposta (exemplo) |
|---|---|
| `/api/v1/dashboard/resumo` | `{"total_bens":120,"localizados":80,"nao_localizados":25,"desconhecidos":15,"movimentacoes_pendentes":2,"inventarios_abertos":1,"novos_30d":4,"valor_total":null,"em_manutencao":null,"baixas_ano":null,"variacao":{"total_bens":33.3,"valor_total":null,"em_manutencao":null,"baixas_ano":null},"filtros_aplicados":["located","bond_status"]}` |
| `/api/v1/dashboard/por-unidade` | `[{"unidade":"PU/TO","total":90,"tipos":{"NOTEBOOK":40,"MESA":30,"OUTROS":20}}]` |
| `/api/v1/dashboard/por-situacao` | `[{"id":"Localizado","value":80},{"id":"Não localizado","value":25},{"id":"Desconhecido","value":15}]` |
| `/api/v1/dashboard/aquisicoes-mensais?meses=6` | `[{"id":"NOTEBOOK","data":[{"x":"2026-05","y":0},…,{"x":"2026-10","y":3}]}]` |
| `/api/v1/dashboard/localizacao-por-unidade` | `[{"unidade":"PU/TO","sim":60,"nao":20,"desconhecido":10,"total":90},…,{"unidade":"Outras","sim":2,"nao":1,"desconhecido":0,"total":3}]` (top 15 + "Outras") |
| `/api/v1/dashboard/por-vinculo` | `[{"id":"Servidor","label":"Servidor","value":70},{"id":"Ocioso","label":"Ocioso","value":20},{"id":"__outros__","label":"Outros","value":5},{"id":"__none__","label":"Sem vínculo","value":25}]` (top 8) |
| `/api/v1/dashboard/pendencias-cadastro` | `{"sem_responsavel":30,"sem_sala":12,"ociosos":20,"nao_localizados":25}` |
| `/api/v1/dashboard/por-sala` | `[{"id":"<uuid>","label":"Recepção (PU/TO)","value":18},…,{"id":"__outras__","label":"Outras","value":9},{"id":"__none__","label":"Sem sala","value":12}]` (top 15) |
| `/api/v1/dashboard/inventario` | `{"conferidos":50,"nao_conferidos":70,"encontrados":45,"nao_encontrados":4}` |
| `/api/v1/dashboard/tipos` | `[{"value":"NOTEBOOK","count":40},{"value":"MESA","count":30}]` (top 50; ignora o próprio `tipo`) |

Notas para o frontend: itens de `por-vinculo`/`por-sala` com `id` real podem virar
filtro ao clicar (`bond_status=<id>`; `room_id=<id>`); `__none__` de vínculo é
`bond_status=__none__` e de sala é `has_room=false`; `__outros__`/`__outras__`
não são filtráveis. Rótulos de sala/vínculo vêm da planilha: exibir como texto
(nunca HTML). `filtros_aplicados` serve ao resumo "filtros ativos" (os valores
estão na URL). Listas vazias/zeros quando nada casa — nunca 404.

## Implementado no frontend (2026-10-20)

- **Filtros** (`frontend/src/components/features/dashboard/dashboard-filter-bar.tsx`):
  visíveis Unidade de uso, Localizado, Vínculo, Tipo; "Mais filtros" (disclosure
  acessível) com Unidade pertencente, Sala e Pessoa (após a unidade), com/sem sala,
  com/sem responsável, Período de registro, Inventário e Movimentação pendente;
  "Limpar filtros"; resumo `role="status"` acima dos números.
- **URL** (`use-dashboard-url-filters.ts`): estado só na query string (`router.replace`,
  debounce 400 ms, sem recarregar); parse defensivo descarta chave desconhecida, repetida
  ou valor inválido e normaliza a URL; filtros em todas as queryKeys
  (`src/lib/dashboard-api.ts`: `DashboardFilters`, `parseDashboardFilters`,
  `dashboardFiltersQueryString`). Nada salvo por usuário (fase 3).
- **Painéis**: card "Não localizados"; Localizados × não localizados por unidade
  (empilhadas); Bens por vínculo (barras); Pendências de cadastro (cartões); Bens por
  sala (horizontais, top 15); Inventário (cartões). (Tipo de gráfico e clique →
  filtro desses painéis: ver a seção seguinte.)
- **Relatório** (`/dashboard/relatorio`): herda os filtros da URL, lista-os no
  cabeçalho com rótulos humanos e inclui os painéis novos no tema "paper"; o link
  "Imprimir relatório" e o "Voltar ao dashboard" preservam os filtros.
- **Testes**: `frontend/e2e/dashboard-filters-functional.spec.ts`, `dashboard.spec.ts`,
  telas `dashboard-filtros` e `dashboard-relatorio-filtros` (responsive + axe).

## Personalização por usuário (frontend, 2026-10-21)

Contrato do backend (mockado nos testes; backend em paralelo):

- `dashboard_charts` ganha `location` (`stacked`|`grouped`|`horizontal`, padrão
  `stacked`), `bond` (`pie`|`donut`|`bar`, padrão `donut`) e `rooms`
  (`bar`|`horizontal`, padrão `horizontal`) — ver `DASHBOARD_GRAFICOS.md`.
- `dashboard_layout`: GET `{"order": [9 ids na ordem efetiva], "hidden": [ids]}`;
  PATCH `{"version": n, "dashboard_layout": {"order": [...], "hidden": [...]}}`
  (ambos opcionais) ou `{"dashboard_layout": null}` (restaurar). IDs: `kpis`,
  `units`, `status`, `monthly`, `location`, `bond`, `pending`, `rooms`,
  `inventory`. 400 se esconder os 9; 409 em conflito de versão.

**Tipo de gráfico nos 3 painéis novos** — mesmo seletor/fluxo dos painéis
unidades/situação/mensal (`chart-type-menu.tsx`, `use-dashboard-chart-prefs.ts`):
salva só depois do PATCH, aviso "Salvando…", 409/400 com mensagem fixa, "Restaurar
padrão" envia `null`. Vínculo usa pizza/rosca (`PieChart`) ou barras
(`CategoryBarChart`); sala usa barras verticais ou horizontais.

**"Personalizar painéis"** (`dashboard-layout-dialog.tsx`,
`use-dashboard-layout-prefs.ts`, `dashboard-panel-meta.ts`): botão no cabeçalho do
`/dashboard` abre um diálogo (superfície clara) com os 9 painéis em lista
ordenada: caixa "mostrar" (dentro do `<label>`, alvo ≥ 24 px) e botões "Mover
<painel> para cima/baixo" (sem arrastar). Ao mover, o foco acompanha o painel e a
nova posição é anunciada (`aria-live`). "Salvar" (só com mudança e ≥ 1 painel
visível), "Cancelar" (descarta o rascunho), "Restaurar padrão" (desabilitado no
padrão). Estado honesto: a grade só muda depois da confirmação; 409 recarrega e
volta o rascunho ao servidor; 400/erro mostra mensagem fixa. Nada em
localStorage. Painel oculto não é montado (nem consulta o backend). A grade de 2
colunas não reordena (DOM = ordem escolhida); painel de meia largura que ficaria
sozinho ocupa a linha. O "Detalhamento por unidade" (tabela) não é
personalizável e fica sempre no fim. O relatório imprimível usa a mesma ordem e
os mesmos ocultos, sem o botão. Backend anterior (GET sem `dashboard_layout`) =
layout padrão, sem erro; layout inválido na resposta (id desconhecido/repetido,
ordem incompleta, todos ocultos, não-objeto) = resposta rejeitada → padrões, sem
seletores nem botão.

**Clique no gráfico → filtro da URL** (`dashboard-chart-filters.ts`,
`chart-filter-shortcuts.tsx`, `use-dashboard-url-filters.ts#toggle`):

| Painel | Item | Filtro |
|---|---|---|
| Bens por situação | Localizado / Não localizado / Desconhecido | `located=SIM/NAO/DESCONHECIDO` |
| Bens por vínculo | vínculo (`id`) / "Sem vínculo" | `bond_status=<id>` / `bond_status=__none__` |
| Bens por sala | sala (UUID) / "Sem sala" | `room_id=<uuid>` / `has_room=false` (um tira o outro) |
| Bens por unidade | unidade | `unit_id` |
| Localização por unidade | segmento (unidade × situação) | `unit_id` + `located` |

- Sem filtro equivalente = sem ação: "Outros"/"Outras" (agregados), categorias
  agrupadas em "Outros" na pizza/rosca, situação desconhecida, unidade cuja sigla
  não identifica EXATAMENTE UMA unidade acessível (`/units/accessible`, código
  sem diferença de caixa). Valor que não passaria na sanitização da URL não vira
  filtro. Se o backend passar a enviar `unit_id` (UUID) nas linhas de
  `/por-unidade` e `/localizacao-por-unidade`, ele é usado (campo opcional
  validado); recomendação ao backend: incluir `unit_id`, já que a sigla é a menor
  alias e pode não bater com `units.code`.
- Clicar de novo no item já aplicado remove o filtro (alternância). Mesmo caminho
  dos seletores: rascunho → URL com debounce de 400 ms; trocar a unidade limpa
  sala/pessoa.
- Teclado/leitor de tela (o SVG do Nivo é `aria-hidden`): legenda da situação e do
  vínculo com botões "Filtrar por situação:/vínculo: …" (`aria-pressed` = filtro
  ativo); unidade, localização e sala com o disclosure "Filtrar pelo gráfico"
  (fechado por padrão; grupos "Unidade de uso", "Localizado", "Sala" com botões
  `aria-pressed`). Depois de filtrar, o bloco recarrega e o foco volta ao mesmo
  botão (`chart-focus-context.tsx`; só se o foco estiver perdido e por até 5 s) e o
  disclosure continua aberto.
- Relatório: sem ação de clique, sem legenda clicável, sem "Filtrar pelo gráfico".

**Barra de filtros no celular** (< 768 px): recolhível, fechada por padrão; o
título vira o botão "Filtros (N ativos)" (`aria-expanded`/`aria-controls`, alvo de
44 px; N = filtros aplicados na URL, "1 ativo" no singular). A partir de 768 px o
botão some e os controles ficam sempre visíveis (só CSS, sem `matchMedia` nem
flash). O resumo dos filtros continua visível com a barra fechada.

**Testes** (Playwright, `--workers=1`): `e2e/dashboard-layout-functional.spec.ts`
(padrão, teclado/foco/anúncio, PATCH, estado honesto, persistência, relatório,
painel oculto sem consulta, grade sem buracos, restaurar, cancelar, todos ocultos,
400, 409, backend anterior, 5 layouts inválidos, GET falho, axe, 320/768 px);
`e2e/dashboard-chart-click-functional.spec.ts` (legenda por teclado, fatia e barras
pelo mouse, "Outros" sem ação, unidade por sigla, segmento empilhado, sala/"Sem
sala", axe, relatório sem ação, barra recolhível em 320/375/430 e fixa em
768/1024/1920); `e2e/dashboard-charts-functional.spec.ts` (tipos dos 3 painéis
novos); `e2e/security-dashboard-charts-functional.spec.ts` (L-2). Telas novas em
`e2e/support/screens.ts` (responsive 320–1920 + axe): `dashboard-filtros-celular`,
`dashboard-personalizar`, `dashboard-layout-personalizado`,
`dashboard-relatorio-personalizado`.

**Rebuild na VPS:** só frontend (não há migração no frontend; o backend e a
migração de `dashboard_layout` são entregues em paralelo e precisam estar no ar
para salvar — sem eles, o GET antigo mantém o layout padrão e o PATCH de layout
recebe 400).

## Painéis de Tecnologia (2026-10-22)

Seis painéis novos entram na personalização (ids `tech_summary`, `tech_category`,
`tech_units`, `tech_status`, `tech_no_owner`, `tech_age`), ao fim da ordem padrão: o
`dashboard_layout` passa a ter **15 ids** (`order` completo; esconder todos continua
400). Usuários que já personalizaram veem os novos ao fim da própria ordem. Backend
anterior (9 ids) é aceito: os novos entram ao fim. Contrato e regras:
`docs/architecture/dashboard-api.md` (seção "Painéis de Tecnologia").

| Painel (`data-dashboard-block`) | Conteúdo | Gráfico |
|---|---|---|
| Tecnologia: indicadores (`tecnologia-indicadores`) | total no filtro, bens de TI, não classificados, TI sem responsável / sem tipo / sem situação + exportar CSV/XLSX | cartões (`StatCard`) |
| Bens por categoria (`tecnologia-categoria`) | categorias (incl. "Não classificado") e tipos de TI | barras horizontais |
| Tecnologia por unidade (`tecnologia-por-unidade`) | tipos de TI por unidade, "Outras" somada | barras empilhadas |
| Por situação operacional (`tecnologia-situacao`) | em uso / estoque / manutenção / baixado / "Não informado" | barras horizontais |
| Sem responsável (`tecnologia-sem-responsavel`) | contagem, percentual do backend e ranking por unidade (nenhuma pessoa) | cartões + barras |
| Tempo desde o registro (`tecnologia-tempo-registro`) | faixas pela data de REGISTRO do bem | barras horizontais |

Princípios: números só do backend (o percentual vem pronto); valores ausentes aparecem
como "não classificado"/"não informado" (nunca um padrão inventado); "tempo desde o
registro" não é idade do equipamento e não há prazo de garantia (a tela diz isso); cada
gráfico usa `chart-shell` (resumo em texto + tabela alternativa sr-only); só contagens,
inclusive para RH; erro por bloco com "Tentar novamente" sem a mensagem do backend; painel
oculto não consulta o backend; sem animação de números não confirmados.

**Filtros**: `categoria`, `tipo_ti` e `status` (grupo "Classificação (painéis de
Tecnologia)" em "Mais filtros") ficam na URL como os demais, mas só são enviados às
consultas de Tecnologia (os endpoints antigos os recusam) e não entram nas queryKeys dos
outros painéis. O resumo de filtros avisa que eles filtram só a Tecnologia. Os painéis
de Tecnologia também recebem os filtros comuns (unidade, período etc.).

**Exportação**: botões "Exportar CSV"/"Exportar XLSX" no painel de indicadores (não
aparecem no relatório imprimível); `GET /dashboard/tecnologia/export` via `requestFile`
(Bearer, nada de token na URL); mensagens fixas para 403/429/413/erro.

Testes: `frontend/e2e/dashboard-tech-functional.spec.ts` (renderização, tabela/resumo,
filtros, exportação, erro isolado, oculto sem consulta, RH, axe, 320/768/1920 sem rolagem
horizontal); `dashboard-layout-functional.spec.ts` (15 ids); mocks em
`e2e/support/dashboard-mocks.ts` (`defaultTech`, `TECH_FILTER_RULES`).

**Rebuild na VPS:** backend + frontend. A migração `0015_asset_tech_classification` só
com autorização explícita (aplicar o espelho `sql/0018` e depois `alembic stamp
0015_asset_tech_classification`). Sem a migração aplicada, os seis blocos mostram erro
isolado ("Tentar novamente"); o restante do dashboard segue normal. Depois de aplicada,
rodar `flask classify-assets` (dry-run) e, se aprovado, `flask classify-assets --apply`.

## Catálogo novo de painéis (2026-10-27) — substitui os 15 ids antigos

O que o usuário personaliza passa a ser um catálogo de **12 painéis** definido
no BACKEND, com permissão por perfil (ADM 12, USER 9, RH 7) e **tamanho por
painel** (`P`, `M`, `G`), além de visibilidade e ordem. A tela deve:

1. chamar `GET /api/v1/dashboard/panels` e desenhar SÓ o que vier (nunca
   decidir perfil no cliente, nunca manter uma lista de ids no frontend);
2. usar `panels[].label`/`description` como rótulo e ajuda, `panels[].sizes`
   para oferecer só os tamanhos admitidos daquele painel e
   `preferences.panels` (lista completa e ordenada) como estado inicial;
3. salvar com `PUT /api/v1/dashboard/preferences` enviando a lista completa
   (`version` do `GET`; `409` = recarregar) e oferecer "Restaurar padrão"
   com `{"version": n, "restore_default": true}`.

Painéis exclusivos de ADM (`unclassified_review`, `classification_overrides`,
`sync_status`) e de ADM/USER (`notebooks_without_docking`,
`workstation_ratio`) simplesmente não aparecem no catálogo de quem não pode
vê-los; enviá-los devolve `403 panel_forbidden` e gera registro em
`audit_logs`. O contrato exato (JSON de ida e volta, códigos de erro, mapa de
migração das escolhas antigas) está em `docs/architecture/dashboard-api.md`.

A personalização antiga (`user_preferences.dashboard_layout`, ordem +
ocultos de 15 ids) continua aceita em `PATCH /api/v1/me/preferences` apenas
durante a transição e é traduzida automaticamente para o catálogo novo.
