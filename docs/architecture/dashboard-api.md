# API de leitura do dashboard (`/api/v1/dashboard/*`)

Código: rotas `backend/app/api/v1/dashboard.py`, schemas `dashboard_schemas.py`,
regras `backend/app/services/dashboard_service.py` (filtros comuns com a lista de
bens em `asset_service.asset_filter_clauses`). Testes:
`backend/tests/test_dashboard_summary_api.py`, `test_dashboard_filters.py`,
`test_sec_dashboard_review.py` e `test_sec_route_inventory.py`. Os filtros dos
endpoints de agregação abaixo vivem só na URL (sem migração). `GET /dashboard/alerts`
(Etapa 4a) está em `modulo-configuracoes.md`.

**Mapa deste documento (atualizado na Onda 5, 2026-10-27):** as seções "Política
comum", "Filtros" e "Rotas" descrevem os endpoints de agregação ANTERIORES; "Painéis de
Tecnologia" descreve `/dashboard/tecnologia/*` (vocabulário legado da 0015); as seções
"Personalizar painéis" e "Dados dos 12 painéis" (Ondas 1-2) são o contrato VIGENTE do
dashboard de equipamentos. Regras de classificação, famílias e categorias:
`docs/architecture/classificacao-patrimonial.md`. Limitações conhecidas: seção final
"Limitações e lacunas conhecidas".

## Política comum
Pilha: `require_auth -> require_aal2_for_adm -> require_permission("reports.read")
-> rate_limit` (1200/h por usuário e POR ROTA = `LIST_LIMIT`; a chave inclui a
view. Uma troca de filtro chama cada painel uma vez; 600/h daria só 10 trocas/min
sustentadas, apertado para exploração interativa). Resposta `Cache-Control:
no-store`. Escopo de unidade no banco com o MESMO escopo de `/assets`
(`asset_scope_clause`: `unit_id` OU `owner_unit_id` acessíveis; ADM sem bypass);
escopo vazio devolve zeros/listas vazias (200, nunca 404). Só bens com
`deleted_at IS NULL`. Só contagens/rótulos: sem PII. Agregação em SQL portável
(SQLite/PostgreSQL), sem SQL textual.

## Filtros (`DashboardFilters`) — todos os endpoints de agregação
Query string, todos opcionais e combináveis (E lógico), aplicados DEPOIS do escopo.
Parâmetro desconhecido (auditado), repetido ou inválido -> 400
`{"error":{"code":"validation_error","message":"Parâmetro(s) inválido(s): <nomes>."}}`
— só NOMES de campo, nunca o valor.

| Parâmetro | Valores | Regra |
|---|---|---|
| `unit_id`, `owner_unit_id`, `room_id`, `responsible_person_id` | UUID | igualdade (mesmo SQL de `/assets`) |
| `has_room`, `has_responsible` | `true`/`false` | coluna `IS NOT NULL` / `IS NULL` |
| `located` | `SIM`/`NAO`/`DESCONHECIDO` | igualdade |
| `bond_status` | texto 1..64 sem controle, ou `__none__` | exato sem caixa (`lower()` nos dois lados); `__none__` = sem vínculo |
| `tipo` | `^[A-Z0-9]{1,40}$` ou `NAO_CLASSIFICADO` | ver "Tipo"; `OUTROS`/`__OUTROS__` (balde) -> 400 |
| `registrado_desde`, `registrado_ate` | `AAAA-MM-DD` (ano ≥ 1900) | `registration_date` ≥ / ≤ (bens sem data saem); `desde ≤ ate`; janela ≤ 5 anos quando ambos |
| `inventario` | `conferido`/`nao_conferido`/`encontrado`/`nao_encontrado` | ver "Inventário" |
| `movimentacao_pendente` | `true`/`false` | existe / não existe `asset_movements` do bem com `status='PENDENTE'` |
| `meses` | 1..24 (padrão 6) | **só** `/aquisicoes-mensais` (nos demais -> 400) |

- **Escopo/IDOR:** ID alheio não gera erro: como o escopo vem antes, a resposta é
  igual à de um ID inexistente (vazio). Exceção coerente com `/assets`: bens já
  visíveis pelo escopo (ex.: `owner_unit_id` acessível com `unit_id` alheio)
  aparecem ao filtrar pelo `unit_id` alheio — mesmo total da lista de bens.
- **Tipo:** não há coluna; é `infer_type(description)` (primeira palavra após o
  `(codigo)` inicial, maiúscula, sem acento; sem descrição = `NAO_CLASSIFICADO`).
  O filtro resolve as descrições DISTINTAS do escopo com aquele tipo e filtra por
  elas (`description IN (...)`), igual em todos os endpoints. Custo
  O(descrições distintas) por requisição: ok para centenas de bens; acima de
  dezenas de milhares, persistir o tipo em coluna (migração).
- **Inventário:** vale a conferência MAIS RECENTE do bem: `inventory_items` com
  `checked_at` não nulo, de inventário não `CANCELADO`, ordem `checked_at` desc
  (desempate `id`). `conferido` = existe conferência; `nao_conferido` = nenhuma;
  `encontrado`/`nao_encontrado` = `found` true/false da mais recente (`found`
  nulo não entra em nenhum). Itens só são criados ao conferir (`checked_at`
  sempre preenchido), então "item mais recente" = "conferência mais recente".
- **Resumo com filtros:** `movimentacoes_pendentes` passa a contar só as
  movimentações PENDENTE dos bens filtrados (origem/destino no escopo, como antes);
  `inventarios_abertos` respeita só `unit_id` (inventário é por unidade).

## Rotas
- `GET /resumo` -> `total_bens`, `localizados` (`located=SIM`), `nao_localizados`
  (`NAO`), `desconhecidos`, `movimentacoes_pendentes`, `inventarios_abertos`,
  `novos_30d` (`created_at` nos últimos 30 dias), `variacao.total_bens` (% últimos 30
  dias vs os 30 anteriores; `null` se a base for 0), `filtros_aplicados` (NOMES dos
  filtros ativos, na ordem da tabela; nunca valores). `valor_total`,
  `em_manutencao` e `baixas_ano` (e variações) são **sempre `null`**.
- `GET /por-unidade` -> `[{unidade, total, tipos:{TIPO:n}}]` por `total` desc. Sigla:
  menor alias de `unit_aliases`; sem alias, `units.code` (sanitizada: letras/dígitos
  e ` -_./()&,ºª`). 6 tipos mais frequentes, resto em `OUTROS` (balde interno
  `__OUTROS__`; tipo real "OUTROS" sai `OUTROSTIPO`). Teto `MAX_GRUPOS` (500) grupos
  por descrição; excedente no balde com soma exata.
- `GET /por-situacao` -> `[{id:"Localizado|Não localizado|Desconhecido", value}]`,
  só valores > 0.
- `GET /aquisicoes-mensais?meses=6` -> `[{id:tipo, data:[{x:"YYYY-MM", y}]}]`, 3 tipos
  + `OUTROS`; todos os meses (UTC), `y=0` sem aquisições; data =
  `COALESCE(registration_date, created_at)`.
- `GET /localizacao-por-unidade` -> `[{unidade, sim, nao, desconhecido, total}]` por
  unidade de USO (`unit_id`), `total` desc (desempate sigla); top 15 + item
  `unidade:"Outras"` com a soma exata do resto.
- `GET /por-vinculo` -> `[{id, label, value}]`: grupos sem caixa; `id` = grafia mais
  frequente (igual a `/assets/bond-statuses`, usável em `bond_status=`); top 8 por
  contagem + `{id:"__outros__", label:"Outros"}` + `{id:"__none__", label:"Sem
  vínculo"}`; só `value > 0`.
- `GET /pendencias-cadastro` -> `{sem_responsavel, sem_sala, ociosos
  (lower(bond_status)='ocioso'), nao_localizados}` (um bem pode contar em mais de um).
- `GET /por-sala` -> `[{id, label, value}]`: top 15 salas (`id` = UUID, usável em
  `room_id=`) + `{id:"__outras__", label:"Outras"}` + `{id:"__none__", label:"Sem
  sala"}` (filtro equivalente: `has_room=false`). Rótulo = nome da sala sem
  controle/invisíveis, espaços colapsados, ≤ 200; se o mesmo nome (sem caixa)
  aparece em mais de uma unidade entre as exibidas, `"Nome (SIGLA)"`.
- `GET /inventario` -> `{conferidos, nao_conferidos, encontrados, nao_encontrados}`;
  `conferidos + nao_conferidos = total_bens`; `encontrados + nao_encontrados ≤
  conferidos`.
- `GET /tipos` -> `[{value, count}]` top 50 tipos (contagem desc, desempate
  alfabético), sobre TODAS as descrições distintas (contagem exata), respeitando os
  demais filtros e ignorando o próprio `tipo` (opções do filtro).

Rótulos de sala/vínculo vêm da planilha (não confiáveis): saem como texto JSON
(`application/json`), sem HTML; o frontend os exibe com o escape do React.

## Painéis de Tecnologia (`/dashboard/tecnologia/*`)

Código: rotas em `dashboard.py`; regras em `backend/app/services/dashboard_tech_service.py`;
vocabulário e regra de classificação em `backend/app/services/asset_classification.py`;
schemas `TechFilters`/`Tech*Out` em `dashboard_schemas.py`. Testes:
`backend/tests/test_dashboard_tech.py`, `test_dashboard_tech_preferences.py`,
`test_import_classification.py`, `test_db_static.py` (migração 0015).

**Migração `0015_asset_tech_classification`** (espelho `backend/migrations/sql/0018_*.sql`):
colunas `assets.asset_category`, `assets.tech_type`, `assets.operational_status`
(`text NULL`, SEM default: `NULL` = "não informado"/"não classificado"; nunca há valor
fictício), CHECKs fechados, índice parcial `ix_assets_category_active`
(`deleted_at IS NULL AND asset_category IS NOT NULL`). **PENDENTE DE APLICAÇÃO**: sem ela
as rotas de Tecnologia respondem erro de banco; só com autorização (padrão do projeto:
executar o espelho `.sql` e depois `alembic stamp 0015_asset_tech_classification`).
(Atualização Onda 5: o `alembic_version` do banco foi levado a `0018` por UPDATE manual;
isso NÃO prova que o DDL da 0015 esteja no banco. Conferir com as consultas de
verificação de `docs/database/historico-migracoes.md` antes de usar `/tecnologia/*`.)

| Campo | Valores |
|---|---|
| `asset_category` | `TECNOLOGIA`, `MOBILIARIO`, `VEICULO`, `EQUIPAMENTO`, `OUTROS` |
| `tech_type` (só com `TECNOLOGIA`) | `COMPUTADOR`, `NOTEBOOK`, `MONITOR`, `IMPRESSORA`, `OUTRO_TI` |
| `operational_status` | `EM_USO`, `ESTOQUE`, `MANUTENCAO`, `BAIXADO` |

Não existe coluna de garantia/data de aquisição: não há indicador de fim de garantia.
"Tempo desde o registro" usa `registration_date` e é rotulado assim.

**Classificação inicial** (`app/services/asset_classification.py`): regra determinística pela
primeira palavra da descrição (mesmo `infer_type`); palavra desconhecida => continua nula.
Usada (1) pela importação, que preenche SÓ quando `asset_category` é nula (nunca
sobrescreve a existente) e (2) pelo comando `flask classify-assets` — **dry-run por padrão**
(`--apply` grava, em lotes, só bens ativos sem categoria, incrementa `version`, audita
`ASSETS_CLASSIFIED`; saída só com contagens). `operational_status` nunca é deduzido.

**Política**: igual às demais leituras (`require_auth -> require_aal2_for_adm ->
require_permission("reports.read") -> rate_limit`, `no-store`, escopo `asset_scope_clause`,
só `deleted_at IS NULL`, só contagens: RH não recebe nenhum dado pessoal; ADM sem bypass).

**Filtros (`TechFilters`, `extra="forbid"`)**: todos os de `DashboardFilters` mais
`categoria` (`TECNOLOGIA|MOBILIARIO|VEICULO|EQUIPAMENTO|OUTROS|NAO_CLASSIFICADO`), `tipo_ti`
(`COMPUTADOR|NOTEBOOK|MONITOR|IMPRESSORA|OUTRO_TI|NAO_INFORMADO`) e `status`
(`EM_USO|ESTOQUE|MANUTENCAO|BAIXADO|NAO_INFORMADO`), todos `Literal` fechados. Período
`registrado_desde/ate` <= 5 anos (UTC no banco; datas de calendário). Valor fora da lista,
repetido ou desconhecido => 400 sem eco de valor. Os endpoints ANTERIORES recusam (400) as
três chaves novas. ID de unidade alheio == inexistente (resultado vazio, escopo antes do filtro).

Rotas:
- `GET /tecnologia/resumo` -> `{total_bens, tecnologia, nao_classificados,
  tecnologia_sem_responsavel, tecnologia_sem_tipo, tecnologia_sem_status, filtros_aplicados}`.
- `GET /tecnologia/por-categoria` -> `{categorias:[{id,label,value}], tipos_ti:[...]}`;
  `categorias` soma EXATAMENTE o total do filtro (inclui `NAO_CLASSIFICADO`); `tipos_ti` só
  TECNOLOGIA (inclui `NAO_INFORMADO`). Só `value > 0`.
- `GET /tecnologia/por-unidade` -> `[{unidade, total, tipos:{"Notebook":n,...}}]` (rótulos pt-BR),
  top 15 + `Outras` com a soma exata (inclusive por tipo).
- `GET /tecnologia/por-status` -> `[{id,label,value}]` situação operacional dos bens de TI.
- `GET /tecnologia/sem-responsavel` -> `{tecnologia, sem_responsavel, percentual|null,
  por_unidade:[{unidade,value}]}` (só contagens).
- `GET /tecnologia/tempo-registro` -> faixas `ate_1_ano`, `1_a_3_anos`, `3_a_5_anos`,
  `mais_de_5_anos`, `data_futura`, `sem_data` (só `value > 0`; referência = hoje em
  America/Araguaina).
- `GET /tecnologia/export?format=csv|xlsx&<filtros>` (permissão `exports.create`, 30/h):
  tabela agregada `Unidade; Categoria; Tipo de TI; Situação operacional; Quantidade`, sem
  linha por bem e sem dados pessoais; toda célula passa por `app.security.csv_safety`
  (`report_export`); acima de `MAX_EXPORT_ROWS` => 413; auditoria `DASHBOARD_TECH_EXPORTED`
  (formato, nº de linhas e NOMES dos filtros; nunca valores) na mesma transação.

Painéis de layout novos (`dashboard_layout`): `tech_summary`, `tech_category`,
`tech_units`, `tech_status`, `tech_no_owner`, `tech_age` (ao fim da ordem padrão; 15 ids no
total). O CHECK de tamanho de `dashboard_layout` (1024 bytes) comporta o pior caso (cerca de
600 bytes): não foi alterado. **Substituído** pelo catálogo de 12 painéis (próxima seção):
esses 15 ids só existem agora como entrada do mapa de migração.

## Personalizar painéis (`GET /dashboard/panels`, `PUT /dashboard/preferences`)

Substitui integralmente a personalização antiga de 15 ids em
`user_preferences.dashboard_layout` (que permanece aceita em
`PATCH /api/v1/me/preferences` só durante a transição; ver abaixo).

**Catálogo e permissões vivem no BACKEND** (`app.services.dashboard_panels_service`):
12 painéis, com rótulo, descrição, grupo, tamanhos admitidos (`P`/`M`/`G`),
tamanho padrão e sinalização de exportação. O frontend nunca decide o que um
perfil pode ver: ele pede o catálogo e desenha o que vier.

`tipo` é o campo `tipo` do envelope de `GET /dashboard/panels/<id>/data`; "Exportável" é
`exportable` do catálogo (rota `/export`). Fonte: `PANEL_CATALOG` e `PANEL_BUILDERS`.

| Id | Painel | Tipo | Perfis | Exportável | Tamanhos | Padrão |
|---|---|---|---|---|---|---|
| `kpi_workstations` | Postos de trabalho (Computadores, Notebooks, Monitores) | `cartoes` | ADM/USER/RH | não | P M G | G |
| `kpi_infrastructure` | Infraestrutura de TI (Impressoras, Nobreaks, Estabilizadores, Docking) | `cartoes` | ADM/USER/RH | não | P M G | G |
| `kpi_furniture` | Mobiliário (Gaveteiros, Armários, Mesas, Estações) | `cartoes` | ADM/USER/RH | não | P M G | G |
| `equipment_by_unit_table` | Equipamentos de TI por unidade | `tabela` | ADM/USER/RH | sim | M G | G |
| `furniture_by_unit_table` | Mobiliário por unidade | `tabela` | ADM/USER/RH | sim | M G | G |
| `equipment_by_unit_chart` | Equipamentos por unidade (barras agrupadas) | `grafico` | ADM/USER/RH | não | P M G | G |
| `category_distribution` | Distribuição percentual por família/categoria | `distribuicao` | ADM/USER/RH | não | P M G | M |
| `notebooks_without_docking` | Notebooks sem docking station, por unidade | `ranking` | ADM/USER | não | P M G | M |
| `workstation_ratio` | Monitores por computador/notebook | `razao` | ADM/USER | não | P M G | P |
| `unclassified_review` | Pendentes de revisão (OUTROS + BAIXA) | `fila` | ADM | não (a fila tem rota própria de exportação) | M G | M |
| `classification_overrides` | Últimas correções manuais de categoria | `lista` | ADM | não | M G | M |
| `sync_status` | Última sincronização do Sheets e divergências | `status` | ADM | não | P M G | P |

Total por perfil: **ADM 12, USER 9, RH 7**. Papel desconhecido/ausente -> nenhum
painel (negar por padrão).

**Tela "Personalizar painéis"** (frontend, apresentação apenas):
`frontend/src/components/features/dashboard/dashboard-layout-dialog.tsx`
(`DashboardLayoutButton`, aberta pelo `dashboard-view.tsx`), com o estado em
`use-dashboard-panel-prefs.ts` e as chamadas em `frontend/src/lib/preferences-api.ts`. O
diálogo lista só o catálogo devolvido por `GET /dashboard/panels`; trabalha num rascunho
local; "Salvar" envia `PUT {version, panels}` e "Restaurar padrão" envia `{version,
restore_default: true}`; a grade só muda depois da confirmação do servidor (409/403
recarrega e refaz o rascunho). Ordem por arrastar (alça) ou botões mover para cima/baixo;
tamanho P/M/G só entre os admitidos pelo painel; ao menos um painel visível (o backend
também recusa). Detalhes de UX: `docs/ux/DASHBOARD_PERSONALIZACAO.md`.

### `GET /api/v1/dashboard/panels`

`require_auth -> require_aal2_for_adm -> require_permission("reports.read") ->
rate_limit` (`LIST_LIMIT`, 1200/h por usuário), `Cache-Control: no-store`,
qualquer parâmetro de consulta -> 400. Devolve SÓ os painéis do perfil do JWT,
o layout padrão do perfil e as preferências efetivas (sem criar linha):

```json
{
  "panels": [
    {"id": "kpi_workstations", "label": "Postos de trabalho",
     "description": "Cartões de Computadores, Notebooks e Monitores.",
     "group": "indicadores", "sizes": ["P","M","G"],
     "default_size": "G", "exportable": false}
  ],
  "sizes": ["P", "M", "G"],
  "default_layout": [{"id": "kpi_workstations", "visible": true, "size": "G"}],
  "preferences": {
    "panels": [{"id": "kpi_workstations", "visible": true, "size": "G"}],
    "version": 0
  }
}
```

`preferences.panels` é SEMPRE a lista completa e ordenada dos painéis do
perfil (ordem do array = ordem de exibição). `version = 0` significa "sem
linha salva" (o primeiro `PUT` usa `version: 0`). O campo `roles` do catálogo
nunca é exposto.

### `PUT /api/v1/dashboard/preferences`

Mesmos decorators, limite de 60 gravações/h por usuário (`PANELS_WRITE_LIMIT`),
`Cache-Control: no-store`.

**Política READ (decisão registrada na Onda 4):** apesar de ser um `PUT`, a rota exige
`reports.read` (e não `assets.update`/`exports.create`) porque grava apenas a
preferência de exibição do PRÓPRIO usuário, nunca dado patrimonial. A defesa não vem da
permissão e sim de: alvo sempre o `sub` do JWT; painel proibido ao perfil nunca é
habilitado (nem por `restore_default`, ids repetidos ou desconhecidos); controle otimista
por `version`; negação gravada em `audit_logs`. Testes:
`backend/tests/test_qa_onda4_preferences.py` (14 funções de teste) e `test_dashboard_panels_api.py`. Corpo `extra="forbid"`; `user_id` NUNCA vem do
cliente (o alvo é sempre o usuário do JWT; tentativa -> 400 + evento
`PRIVILEGE_ESCALATION_ATTEMPT`). Exatamente UM de `panels` ou
`restore_default: true`:

```json
{"version": 3,
 "panels": [{"id": "category_distribution", "visible": true, "size": "G"},
            {"id": "kpi_workstations", "visible": false, "size": "P"}]}
```

```json
{"version": 3, "restore_default": true}
```

Regras de `panels`: 1 a 12 itens, sem repetição; `id` da allowlist do catálogo
(ids antigos como `kpis`/`tech_units` -> 400); `visible` booleano estrito;
`size` na allowlist global **e** nos tamanhos admitidos do painel; ao menos um
item visível. Painéis omitidos entram ao fim, visíveis, no tamanho padrão.

Respostas: `200` com `{"panels": [...], "version": n}` (lista efetiva
completa); `400 validation_error`; `403 panel_forbidden` quando um id do
catálogo não é permitido ao perfil — rejeitado por inteiro (nada é gravado) e
registrado em `audit_logs` (`DASHBOARD_PANEL_FORBIDDEN`, `result = FALHA`,
`new_values = {rejected_panels, roles}`) na MESMA transação;
`409 version_conflict` no controle otimista.

Auditoria de sucesso: `DASHBOARD_PREFERENCES_UPDATED` (`entity_type =
user_dashboard_preferences`) com `previous_values`/`new_values` contendo só
ids, visibilidade, tamanho e versão — nunca dado pessoal.

### Persistência e dado legado

Tabela `user_dashboard_preferences` (migração `0017_dashboard_panel_prefs` +
espelho `sql/0020`): `panels jsonb` (array ORDENADO de
`{"id","visible","size"}`; `[]` = layout padrão do perfil), `version`
(controle otimista) e `created_at`/`updated_at` em timestamptz (UTC). RLS
habilitado sem políticas (deny-all) e sem grants para `anon`/`authenticated`.

Qualquer conteúdo inválido no banco (id fora do catálogo, id antigo, tamanho
inválido, painel que o perfil perdeu, tipo errado, todos invisíveis) é
ignorado e cai no padrão do perfil — **nunca** gera erro.

Migração das escolhas antigas (`user_preferences.dashboard_layout`), feita
pela migração e também em tempo de leitura enquanto não houver linha nova:

| Id antigo | Id novo |
|---|---|
| `kpis` | `kpi_workstations` |
| `tech_summary` | `kpi_infrastructure` |
| `tech_units` | `equipment_by_unit_table` |
| `units` | `equipment_by_unit_chart` |
| `tech_category` | `category_distribution` |

Os outros dez (`status`, `monthly`, `location`, `bond`, `pending`, `rooms`,
`inventory`, `tech_status`, `tech_no_owner`, `tech_age`) são DESCARTADOS em
silêncio. A linha de `user_preferences` NÃO é apagada e `dashboard_layout`
continua aceito em `PATCH /api/v1/me/preferences` (junto com densidade,
escala e `dashboard_charts`) durante a transição — a tela nova deve usar
apenas as rotas acima.

## Dados dos 12 painéis, fila de revisão e override (ONDA 2)

Código: `app/api/v1/dashboard_equipment.py` (rotas), `app/services/dashboard_equipment_service.py`
(painéis), `app/services/dashboard_classification_service.py` (fila, override, exportações).
Política comum: só bens ativos, escopo de unidade (`asset_scope_clause`/`apply_unit_scope`, ADM sem
bypass), `Cache-Control: no-store`, só contagens e rótulos (nenhum dado pessoal, nem para RH),
`extra="forbid"` (400 sem eco). A categoria considerada é a EFETIVA: `category_override` prevalece
sobre `equipment_category`; a família efetiva é derivada da categoria.

| Método | Rota | Acesso | Resposta |
|---|---|---|---|
| GET | `/dashboard/panels/<panel_id>/data` | `require_auth -> require_aal2_for_adm -> reports.read` | `{panel_id, tipo, dados, filtros_aplicados}` |
| GET | `/dashboard/panels/<panel_id>/export` | idem, `exports.create` | CSV/XLSX (só `equipment_by_unit_table`, `furniture_by_unit_table`) |
| GET | `/dashboard/classificacao/revisao` | `require_auth -> require_role(ADM) -> require_aal2 -> reports.read` | fila paginada |
| GET | `/dashboard/classificacao/revisao/export` | idem, `exports.create` | CSV/XLSX da fila |
| POST | `/assets/<id>/category-override` | `require_auth -> require_role(ADM) -> require_aal2 -> assets.update` | bem (resumo) |

Painel inexistente, malformado OU proibido ao perfil (catálogo `PANEL_CATALOG[...].roles`) => a MESMA
resposta 404 `not_found` e o mesmo evento `ACCESS_DENIED`.

Query dos painéis: `unit_id` (uuid), `familia` (`TI|MOBILIARIO|OUTROS|NAO_CLASSIFICADO`), `categoria`
(20 categorias ou `NAO_CLASSIFICADO`). `unit_id` alheio == inexistente (resultado vazio).

`dados` por painel (`tipo`):
- `kpi_workstations|kpi_infrastructure|kpi_furniture` (`cartoes`): `{itens:[{id,label,value}], total}`
  (cartões fixos, com zeros).
- `equipment_by_unit_table|furniture_by_unit_table` (`tabela`): `{colunas:[{id,label}],
  linhas:[{unidade,total,valores:{cat:n}}], total}`.
- `equipment_by_unit_chart` (`grafico`): `{familia, familia_label, series, unidades (top 15 + "Outras",
  soma exata), total}`; `familia` padrão `TI`.
- `category_distribution` (`distribuicao`): `{total, familias:[{id,label,value,percentual}],
  categorias:[{id,label,familia,value,percentual}]}`.
- `notebooks_without_docking` (`ranking`, ADM/USER): `{metodo, notebooks, docking, sem_docking,
  por_unidade}`. ESTIMATIVA por diferença de contagens (`max(notebooks - docking, 0)`): não há vínculo
  notebook x docking no banco.
- `workstation_ratio` (`razao`, ADM/USER): `{computadores, notebooks, monitores,
  monitores_por_computador, monitores_por_notebook}` (`null` sem divisor).
- `unclassified_review` (`fila`, ADM): `{total_pendentes, por_unidade}`.
- `classification_overrides` (`lista`, ADM): `{total, por_categoria, recentes:[{asset_id,
  patrimony_number, description, categoria_anterior, categoria_nova, em}]}` (da auditoria; sem autor).
- `sync_status` (`status`, ADM): `{ultima_importacao|null, ultimo_job|null, conflitos_pendentes}`.

Fila de revisão: bens com `equipment_category='OUTROS'`, `classification_confidence='BAIXA'` e sem
override. Query: `page`, `page_size` (50/100/200), `unit_id`, `sort` (`patrimony_number`,
`description`, `updated_at`, com `-`). Resposta: `{items:[{id, patrimony_number, description, unit_id,
unidade, equipment_family, equipment_category, classification_confidence, classification_rule,
version}], total, page, page_size, pages, categorias:[{id,label,familia,familia_label}]}`.

Override: corpo `{category, version}` (`extra="forbid"`; `category` = uma das 20 categorias). Grava
`category_override`, define `classification_confidence='ALTA'`, `version+1`, e registra
`ASSET_CATEGORY_OVERRIDDEN` em `audit_logs` na mesma transação. Erros: 400 (validação / campo extra,
com evento de segurança), 403 (não ADM / sem AAL2), 404 (alheio, inexistente ou excluído, idênticos),
409 `version_conflict` (a versão é checada ANTES da idempotência). Repetir a mesma categoria
sobre um bem que já está com esse override e confiança `ALTA` devolve o bem sem gravar nem
auditar (`override_category` em `dashboard_classification_service.py`). A auditoria
`ASSET_CATEGORY_OVERRIDDEN` traz em `previous_values` o override, a categoria efetiva e a de
regra, a confiança, a regra e a versão; em `new_values`, categoria e família efetivas.
Exportações: auditadas (`DASHBOARD_EQUIPMENT_EXPORTED`, `DASHBOARD_REVIEW_QUEUE_EXPORTED`), toda
célula via `csv_safety`. Limites: leituras `LIST_LIMIT` (1200/h); exportações
`TECH_EXPORT_LIMIT` (30/h).

## Limitações e lacunas conhecidas (Onda 5, 2026-10-27)

1. **`notebooks_without_docking` é ESTIMATIVA.** Não existe vínculo notebook x docking no
   banco. O painel calcula, por unidade, `max(notebooks - docking, 0)` sobre contagens de
   categoria efetiva e só lista unidades com pelo menos um notebook; o campo `metodo` vem
   como `diferenca_de_contagens_por_unidade`. Uma docking station em unidade diferente
   da do notebook, ou uma docking compartilhada, distorce o número. A interface deve
   apresentá-lo como estimativa.
2. **`sync_status` é GLOBAL (achado QA4-03).** `ultima_importacao` (última `ImportPreview`
   `CONFIRMADA`) e `ultimo_job` (último `SyncJob`) não são filtrados por escopo de unidade
   nem pelos filtros do painel; só `conflitos_pendentes` respeita o escopo (conflitos cujo
   bem está no escopo OU ainda sem bem). Como o painel é só ADM e o ADM não tem bypass de
   unidade em bens, é uma exceção consciente do escopo: contagens e datas, nenhum registro
   de bem. Aberto como achado de baixa severidade (ver
   `docs/security/REVISAO_QA_ONDA4_2026-10-27.md`).
3. **Não existe remoção de override (achado QA4-04).** Só há `POST
   /assets/<id>/category-override`; nenhuma rota `DELETE`/"limpar" devolve o bem à
   classificação por regra. O override também fixa `classification_confidence = 'ALTA'`,
   tira o bem da fila de revisão e o motor (importação e `flask classify-equipment`) nunca
   escreve em `category_override`. Hoje a única forma de desfazer é SQL manual (fora do
   fluxo auditado) ou outro override para a categoria desejada. Pendência de produto.
4. `PUT /dashboard/preferences` usa a política READ (`reports.read`); ver a seção da rota.
5. Os endpoints `/dashboard/tecnologia/*` e o vocabulário legado da 0015 continuam no código
   e nenhum dos 12 painéis do catálogo os usa (o frontend ainda contém
   `dashboard-tech-panels.tsx`; se ele continua montado na tela não foi verificado nesta
   rodada — pendência de limpeza); as colunas `equipment_*` (0018) são
   independentes de `asset_category`/`tech_type` (0015).
