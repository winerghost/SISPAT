# API de leitura do dashboard (`/api/v1/dashboard/*`)

Código: rotas `backend/app/api/v1/dashboard.py`, schemas `dashboard_schemas.py`,
regras `backend/app/services/dashboard_service.py`. Testes:
`backend/tests/test_dashboard_summary_api.py` e `test_sec_route_inventory.py`.
**Sem migração**. `GET /dashboard/alerts` (Etapa 4a) está em
`modulo-configuracoes.md`.

## Política comum
Pilha: `require_auth -> require_aal2_for_adm -> require_permission("reports.read")
-> rate_limit` (600/h por usuário). Resposta `Cache-Control: no-store`. Escopo de
unidade no banco com o MESMO escopo de `/assets` (`asset_scope_clause`:
`unit_id` OU `owner_unit_id` acessíveis; ADM sem bypass), garantindo paridade de total;
escopo vazio devolve zeros/listas vazias (200, nunca 404). Só bens com
`deleted_at IS NULL`. Só contagens/rótulos: sem PII. Consulta com parâmetro
desconhecido (inclusive `unit_id`) ou repetido -> 400. Agregação em SQL portável
(SQLite/PostgreSQL: `count`, `case`, `coalesce`, `extract`).

## Rotas
- `GET /resumo` -> `total_bens`, `localizados` (`located=SIM`), `nao_localizados`
  (`NAO`), `desconhecidos`, `movimentacoes_pendentes` (`asset_movements.status =
  PENDENTE` com origem OU destino no escopo), `inventarios_abertos`
  (`inventories.status = ABERTO` no escopo), `novos_30d` (`created_at` nos últimos
  30 dias), `variacao.total_bens` (% de bens cadastrados nos últimos 30 dias vs os 30
  anteriores; `null` se a base for 0). `valor_total`, `em_manutencao` e `baixas_ano`
  (e suas variações) são **sempre `null`**: o modelo `Asset` não tem campos de valor,
  manutenção nem baixa.
- `GET /por-unidade` -> `[{unidade, total, tipos:{TIPO:n}}]` por `total` desc. Sigla:
  menor alias de `unit_aliases` da unidade; sem alias, `units.code`. Tipo: primeira
  palavra da `description` após o `(codigo_material)` inicial, maiúscula e sem
  acento (`NAO_CLASSIFICADO` sem descrição); 6 tipos mais frequentes no escopo, o
  restante em `OUTROS` (balde interno `__OUTROS__`; um tipo real "OUTROS" sai como
  `OUTROSTIPO`). Teto de `MAX_GRUPOS` (500) grupos por descrição no banco; o excedente
  entra no balde com soma exata. Sigla sanitizada (letras/dígitos e ` -_./()&,ºª`).
- `GET /por-situacao` -> `[{id:"Localizado|Não localizado|Desconhecido", value}]`,
  só valores > 0.
- `GET /aquisicoes-mensais?meses=6` (1..24) -> `[{id:tipo, data:[{x:"YYYY-MM", y}]}]`
  para os 3 tipos mais frequentes no intervalo (+ `OUTROS` se houver mais). Todos
  os meses (UTC) presentes, `y=0` sem aquisições. Data = `COALESCE(registration_date,
  created_at)`. Sem bens no intervalo -> `[]`.
