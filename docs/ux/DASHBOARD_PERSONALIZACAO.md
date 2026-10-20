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
