# API de leitura do dashboard (`/api/v1/dashboard/*`)

Código: rotas `backend/app/api/v1/dashboard.py`, schemas `dashboard_schemas.py`,
regras `backend/app/services/dashboard_service.py` (filtros comuns com a lista de
bens em `asset_service.asset_filter_clauses`). Testes:
`backend/tests/test_dashboard_summary_api.py`, `test_dashboard_filters.py`,
`test_sec_dashboard_review.py` e `test_sec_route_inventory.py`. **Sem migração**
(filtros só na URL; salvar por usuário fica para a fase 3). `GET /dashboard/alerts`
(Etapa 4a) está em `modulo-configuracoes.md`.

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
