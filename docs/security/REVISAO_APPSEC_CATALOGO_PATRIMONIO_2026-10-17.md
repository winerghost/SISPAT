# Revisão AppSec das APIs de cadastros, patrimônios, movimentações, inventários e leitura admin

Data: 2026-10-17 · Revisor: AppSec (somente leitura de código de produção) · Método: leitura
dirigida do código + sondas executáveis (testes) contra o carregador REAL de `require_auth`
sobre SQLite, sem rede, sem Supabase, sem git.

## 1. Escopo

Rotas e serviços revisados (arquivos em `backend/app`):

| Área | Rotas | Código |
|---|---|---|
| Cadastros de apoio | `/rooms`, `/responsible-people`, `/units` (+`/catalog`, `/accessible`, `/<id>`, ações), `/locations` | `api/v1/{rooms,responsible_people,units,locations,catalog_http,catalog_schemas,location_schemas}.py`, `services/{catalog_service,location_service}.py` |
| Importação de cadastros | `/catalog-imports/*` | `api/v1/{catalog_imports,catalog_import_schemas}.py`, `services/{catalog_import_service,catalog_import_view}.py` |
| Patrimônio | `/assets/*` | `api/v1/{assets,asset_schemas}.py`, `services/asset_service.py` |
| Movimentações | `/movements/*` | `api/v1/{movements,movement_schemas}.py`, `services/movement_service.py` |
| Inventários | `/inventories/*` | `api/v1/{inventories,inventory_schemas}.py`, `services/inventory_service.py` |
| Leitura admin | `/admin/roles`, `/admin/permissions`, `/admin/unit-access`, `/admin/audit-logs[/<id>]` | `api/v1/{admin_access,admin_audit,admin_schemas}.py`, `services/{admin_access_service,admin_audit_service}.py` |

Fora do escopo desta passagem: frontend, migrações/RLS, IA, convites/MFA, upload de avatar.

## 2. Parecer

**APROVADO COM RESSALVAS** para estas APIs: nenhum achado Crítico ou Alto; nenhuma falha de
autorização (perfil/unidade/AAL2), IDOR/BOLA ou mass assignment encontrada. Há 1 achado
Médio (SEC-REV-01) e 1 Médio (SEC-REV-03) que devem ser corrigidos antes do deploy, mais
achados Baixos/Informativos. Isto NÃO declara o sistema livre de vulnerabilidades: é o resultado
de uma revisão com cobertura declarada (seção 7) e limitações (seção 8).

## 3. Achados (CVSS 3.1)

| ID | Sev. | CVSS | Resumo | Teste (xfail estrito = aberto) |
|---|---|---|---|---|
| SEC-REV-01 | Média | 4.3 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L` | JSON profundamente aninhado (~20 mil `[`, 40 KB) => `RecursionError` => HTTP 500 com traceback completo no log | `test_json_aninhado_nas_rotas_de_cadastro_e_400_e_nao_500`, `test_json_aninhado_em_patrimonios_e_movimentacoes_e_400` |
| SEC-REV-03 | Média | 4.3 `AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | `GET /assets/<id>/history` devolve `reason` (texto livre de exclusão/restauração) ao perfil RH | `test_rh_nao_recebe_motivo_de_texto_livre_no_historico_do_bem` |
| SEC-REV-02 | Baixa | 2.7 `AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:L/A:N` | `GET /catalog-imports/<id>/items?...`: `BadRequest` não tratado chega ao handler global, que registra nomes de parâmetro do cliente com CR/LF (forja de linha de log, CWE-117) | `test_consulta_de_itens_da_previa_com_parametro_forjado_nao_forja_log` |
| SEC-REV-05 | Baixa | 3.1 `AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N` | Unicidade global (nº patrimonial, e-mail e identificador de pessoa): 409 vs 201 revela a ADM/USER de uma unidade que o valor existe em OUTRA unidade. Resíduo inerente à restrição global; mensagem não diz campo nem unidade | `test_conflito_de_numero_patrimonial_de_outra_unidade_e_generico` (pina o 409 genérico) |
| SEC-REV-04 | Info | n/a | `safe_scalar` (projeção da trilha admin) aceita strings com formato de CPF/telefone (`123.456.789-09`). Hoje só valores escritos pelo servidor chegam lá; defesa em profundidade | `test_projecao_da_trilha_admin_redige_valor_com_formato_de_cpf` |
| SEC-REV-06 | Info | n/a | RH recebe e-mail e `institutional_identifier` completos em `/responsible-people`; só a PRÉVIA de importação mascara e-mail. É a decisão registrada na matriz de permissões (RH vê cadastro completo, sem telefone), mas diverge da expectativa "e-mail mascarado" do pedido: confirmar com o dono do produto | sem teste (decisão de produto) |
| SEC-REV-07 | Info | n/a | Instabilidade de `test_sala_criacao_valida_corpo[body2]` não reproduzida; ver seção 5 | `test_criacao_de_sala_invalida_e_sempre_400_sob_repeticao` |

### SEC-REV-01 (Média) — RecursionError no parse de JSON

- Onde: `backend/app/api/v1/catalog_http.py:84` (`read_body` -> `request.get_json(silent=True)`);
  o mesmo padrão em `users.py:239/568/603/634`, `ai.py:114`, `me.py`, `ai_settings.py`.
  `silent=True` só captura `ValueError`; `RecursionError` escapa e cai em
  `app/errors.py:113` (`logger.exception` com traceback completo, resposta 500).
- Evidência: corpo `b"[" * 20000 + b"]" * 20000` em `POST /rooms`, `/responsible-people`,
  `PATCH /rooms/<id>`, `PATCH /units/<id>`, `POST /assets`, `PATCH /assets/<id>`,
  `POST /assets/<id>/delete` => 500 (testes). Exige sessão válida (PR:L); body bem abaixo de
  `MAX_CONTENT_LENGTH` (1 MiB); cada requisição gera um traceback grande no log.
- Correção sugerida (uma, central): em `app/errors.py` registrar
  `app.register_error_handler(RecursionError, ...)` devolvendo 400 `validation_error`
  genérico, OU criar `safe_json()` em `app/api/v1/schemas.py` (try/except `RecursionError`
  => `abort(400)`) e usá-lo no lugar de `request.get_json(silent=True)` nas rotas acima.
  Opcional: rejeitar `Content-Length` > 64 KB em rotas de cadastro (os corpos legítimos têm < 4 KB).
- Observação: produção usa Python 3.12 (Dockerfile); o ambiente de testes local é 3.10.0.
  O limite de recursão do decodificador JSON existe nas duas versões.

### SEC-REV-03 (Média) — RH lê `reason` no histórico do bem

- Onde: `backend/app/services/asset_service.py` (método `history`, bloco que monta `entry`):
  `previous_values`/`new_values` saem brutos; `delete`/`restore` gravam `new["reason"]`
  (texto livre, até 500 caracteres; pode conter nome, telefone, e-mail).
- Inconsistência: `movements` oculta `reason` do RH (`can_view_internal`), `notes` do bem nem é
  carregada para RH, a trilha admin descarta texto livre. Só o histórico do bem ignora a regra.
- Correção sugerida: em `history`, quando `not self._can_view_notes`, filtrar
  `previous_values`/`new_values` por allowlist (ex.: `deleted`, `patrimony_number`,
  `unit_id`, `owner_unit_id`, `located`, `room_id`, `location_id`,
  `responsible_person_id`, `changed_fields`, `movement_id`) e remover `reason`.
  Para USER/ADM manter como está. O teste passa a XPASS; remover o `xfail`.

### SEC-REV-02 (Baixa) — forja de linha de log via nome de parâmetro

- Onde: `backend/app/api/v1/catalog_imports.py` (`catalog_items_endpoint`) chama
  `parse_query(...)` fora de `try/except BadRequest`, ao contrário de TODAS as demais rotas.
  O handler `handle_known_http_exception` (`app/errors.py`) registra
  `exc.description`, que contém os nomes de parâmetros enviados (até 64 caracteres cada,
  CR/LF preservados).
- Evidência: `?x%0AERROR%20linha-forjada=1` produz, no log, a linha
  `ERROR linha-forjada` separada. Exige ADM com AAL2 e `units.update|rooms.manage|responsible.manage`.
- Correção sugerida: (a) envolver em `try/except BadRequest -> validation_error(exc)` como nas
  outras rotas; (b) neutralizar caracteres de controle em
  `reject_unexpected_fields`/`parse_query`/`parse_body` (`re.sub(r"[^\w.\-\[\]]", "?", nome)`)
  e/ou logar `description!r` em `app/errors.py`.
- Efeito colateral hoje: o mesmo nome (com CR/LF) também é gravado em `audit_logs.details.fields`
  (JSON, inofensivo) e ecoado na resposta 400 do próprio cliente.

### SEC-REV-05 (Baixa) — oráculo de existência por unicidade global

- Onde: `asset_service._number_taken` (global, sem escopo), `catalog_service._taken` (e-mail/
  identificador globais), `catalog_import_service._apply_person` (e-mail global).
- Impacto: um USER/ADM da unidade A que tente cadastrar o nº patrimonial ou o e-mail de uma
  pessoa existente SÓ na unidade B recebe 409 `conflict` em vez de 201. Não revela unidade,
  campo nem ID. Mitigações já presentes: limite por usuário/hora, mensagem fixa.
- Recomendação: aceitar o risco (a unicidade é regra de negócio global) e registrá-lo; se o
  dono do produto exigir, responder 409 também quando o valor existir só fora do escopo E
  retornar a mesma mensagem (já é o caso) — ou nada a fazer.

### SEC-REV-04 / SEC-REV-06 (Informativos)

- SEC-REV-04: `admin_audit_service.safe_scalar` usa `[A-Za-z0-9_.:+\-/]{1,64}`; CPF
  formatado (`123.456.789-09`) e dígitos puros passam. Sugestão: rejeitar `\d{3}\.\d{3}\.\d{3}-\d{2}`
  e sequências numéricas de 10 a 14 dígitos fora de UUID.
- SEC-REV-06: se RH não precisar do e-mail/identificador para a vinculação responsável↔bem,
  reduzir `serialize_person` do RH a `id/name/unit_id/active` (como o USER) ou mascarar o e-mail
  com `catalog_import_view.mask_email`.

## 4. Controles verificados e funcionando (com evidência executável)

Cada item tem teste (existente ou novo em `backend/tests/test_sec_catalog_api_review.py`).

- AuthN/AuthZ: inventário dinâmico de rotas (`test_sec_route_inventory.py`) cobre 401, USER/RH
  negados em rota admin, AAL1/`aal` forjado negado, perfil/permissão do JWT ignorados. Todas as
  rotas novas estão classificadas; uma rota nova sem classificação derruba o teste.
- Escopo de unidade e 404 uniforme: `rooms`, `units`, `responsible-people`, `assets` (+history,
  patch, delete, restore), `movements` (get/cancel/approve/reject, solicitação com bem ou
  destino alheio) devolvem status e corpo idênticos para alheio, inexistente (novo teste
  `test_404_uniforme_em_cadastros|patrimonios|movimentacoes_e_vinculos_alheios`); o ID alheio
  nunca aparece na resposta; o bem alheio não é alterado.
- Mass assignment: `extra="forbid"` em todos os corpos e consultas. Novos testes de CRIAÇÃO:
  `deleted_at`, `deleted_by`, `version`, `assigned_user_id`, `created_by`, `source_record_id`,
  `id`, `role`, `active` em `POST /assets` (USER e ADM); `origin_unit_id`, `status`,
  `movement_type`, `requested_by`, `approved_by`, `previous_responsible_id`, `completed_at`, `id`
  em `POST /movements`; `role`, `unit_id`, `active`, `auth_user_id`, `deleted_at`, `version` em
  `PATCH /responsible-people|units`. Todos 400 `validation_error`, evento
  `PRIVILEGE_ESCALATION_ATTEMPT|MASS_ASSIGNMENT_REJECTED` com o NOME do campo, nada gravado.
- Limites: nº patrimonial 64, descrição/observações 2000, IDs 64, motivo 500, nome 200, e-mail
  254, telefone, identificador 64; `page_size` <= 100, `page` <= 100000, `q` <= 100, `sort`/
  `active`/`unit_id` por allowlist, parâmetro repetido ou desconhecido => 400; corpo > 1 MiB => 413
  sem efeito.
- PII: telefone só ADM (coluna nem é carregada para outros perfis); RH/USER não localizam
  pessoa por telefone (`q`); USER só vê pessoas vinculadas e 4 campos; prévia de importação
  devolve só `email_masked` e `has_phone`; logs (`caplog` em DEBUG) e `audit_logs` das
  mutações de pessoa não contêm e-mail, telefone nem identificador; auditoria grava só NOMES de
  campos pessoais alterados.
- Leitura admin: `/admin/*` somente ADM + AAL2 + permissão, escopo por unidade do autor,
  projeção em allowlist, IP reduzido a /24 (/48), detalhe alheio = inexistente = malformado,
  `AUDIT_VIEWED` sem payload.
- Concorrência: `version` (bens) e `expected_updated_at` (cadastros) => 409; movimentações e
  inventários com guardas ORM de imutabilidade e transições por allowlist.
- SQL: tudo via ORM/parâmetros; `LIKE` com `escape_like`; ordenação por mapa fixo.

## 5. Teste instável `test_catalog_api.py::test_sala_criacao_valida_corpo[body2]`

Parâmetro `body2` = `{"unit_id": "x"}` (falta `name`): caminho = `require_auth` ->
`require_role` -> `require_aal2` -> `require_permission` -> `rate_limit` -> `read_body` ->
`parse_body` -> 400. Não há acesso a banco além do carregamento do usuário em `require_auth`,
nem evento de segurança, nem escrita.

Tentativas de reprodução (Python 3.10.0 local, todas verdes):

| Experimento | Resultado |
|---|---|
| Arquivo isolado, 91 testes | 91 passed |
| `-k sala_criacao or sala_mass or sala_crud`, 25 processos em série | 25 x 16 passed |
| Suíte completa `tests` (17 min) | exit 0, sem falhas |
| Todos os vizinhos anteriores (`test_a*`, `test_avatar*`) + arquivo (804 e 855 testes) | passed |
| Varredura de threads vivas na entrada de cada módulo até `test_catalog_api` | nenhuma thread vazada |
| `PYTHONHASHSEED` 1..20 em série (arquivo inteiro) | 20 x 91 passed |
| 3 processos concorrentes (arquivo + assets + revisão) x 6 rodadas, CPU saturada | sem 500 (3 falhas foram do meu próprio teste de repetição, 429 do rate limit, já corrigido) |
| 14 rodadas dos 8 corpos no mesmo app/DB | 112 x 400 |

Causa raiz: **não identificada**; nenhuma evidência de estado compartilhado entre testes
(Redis falso novo por teste e cache de cliente limpo por autouse; `_dispatch` neutralizado por
autouse; sem threads de auditoria; sem `setrecursionlimit`/`cache_clear`/relógio falso;
SQLite em memória por teste). Hipóteses restantes, em ordem de probabilidade:

1. **Árvore de trabalho editada durante a execução** (vários agentes alteram `rooms.py`,
   `catalog_http.py`, `catalog_schemas.py` enquanto a suíte roda; import tardio de módulo
   parcialmente salvo ou `.pyc` obsoleto em bind mount do Docker no Windows). Um 500 assim some
   na repetição e não reproduz isolado.
2. **Teto de requisições do rate limit** se o teste for repetido/parametrizado no mesmo `cat`
   (`WRITE_LIMIT=120/h` por usuário e rota): daria 429, não 500, mas é a única fonte de
   não-determinismo por contagem encontrada.
3. **Exceção não prevista no caminho comum** (mesmo caminho dos demais 7 corpos, que não
   falharam): para o próximo episódio, o corpo/log do 500 identifica a causa na hora.

Correção proposta (fora do meu escopo de escrita; `test_catalog_api.py` não é `test_sec_*`):

```python
def test_sala_criacao_valida_corpo(cat, body, caplog):
    r = cat.client.post("/api/v1/rooms", json=body, headers=adm())
    assert r.status_code == 400, (r.status_code, r.get_data(as_text=True), caplog.text[-2000:])
```

e, para quem for rodar a suíte com agentes concorrentes, executar em cópia/snapshot do código
(`git worktree`/cópia) ou com `pytest -p no:cacheprovider` e `PYTHONDONTWRITEBYTECODE=1`.
Em paralelo, `test_criacao_de_sala_invalida_e_sempre_400_sob_repeticao` (novo) falha com o corpo
da resposta se o 500 voltar a ocorrer sob repetição.

## 6. Testes adicionados

Arquivo: `backend/tests/test_sec_catalog_api_review.py` (62 testes: 54 passam, 8 `xfail(strict=True)`
= achados abertos: SEC-REV-01 (4 casos), SEC-REV-02 (1), SEC-REV-03 (1), SEC-REV-04 (2)).

Para fechar um achado: aplicar a correção sugerida, rodar o arquivo e remover a marca `xfail`
do teste que virar XPASS.

## 7. Ferramentas, versões e resultados REAIS

| Item | Resultado |
|---|---|
| Python local | 3.10.0 (produção: 3.12-slim-trixie no Dockerfile; diferença registrada) |
| pytest 8.2.2, Flask 3.0.3, SQLAlchemy 2.0.54, pydantic 2.13.4 | em uso |
| `pytest tests` (suíte completa, antes dos testes novos) | exit 0 (17m14s) |
| `pytest tests` (suíte completa FINAL, com os testes novos) | 9665 passed, 38 skipped, 12 xfailed (8 deste relatório + 4 anteriores), 0 falhas, 20m50s |
| `pytest tests/test_sec_catalog_api_review.py` | 54 passed, 8 xfailed |
| `scripts/security-audit.sh --strict` | **NÃO EXECUTADO** nesta passagem: `bandit` e `pip-audit` não estão instalados no ambiente e o script instalaria ferramentas (rede); o pedido era revisão de APIs. Deve rodar antes do deploy |
| bandit / pip-audit / semgrep / gitleaks / trivy | NÃO EXECUTADO |

## 8. Limitações

- Testes em SQLite: as colunas `CHECK`, índices únicos parciais, RLS e `FOR UPDATE` reais do
  PostgreSQL não são exercitados; a corrida de unicidade de nº patrimonial depende do advisory
  lock (apenas verificado por inspeção/teste de chave).
- Sem teste de carga real nem de Redis real; JWKS/ES256 só por testes existentes.
- Frontend, migrações, RLS do Supabase e IA não foram revisados aqui.
- Achados abertos exigem correção do coordenador (não editei código de produção).
