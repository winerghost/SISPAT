# Revisão AppSec — Vínculo do bem (`bond_status`) e filtros do dashboard

- **Data:** 2026-10-20
- **Escopo:** mudanças NÃO commitadas de hoje
  1. `assets.bond_status`: migração `0012_asset_bond_status` + `sql/0015`
     (já aplicada no Supabase, com backfill), `normalize_bond_status`,
     `import_service` (NOVO/EXISTENTE/vazio), `asset_schemas`/`asset_service`
     (filtro, `__none__`, ordenação, `GET /api/v1/assets/bond-statuses`) e o
     frontend de patrimônios.
  2. Filtros do dashboard: `DashboardFilters`, `dashboard_service`
     (`filter_clauses`, 6 agregados novos, `clean_label`), rotas novas
     (limite 1200/h por rota) e o frontend (`use-dashboard-url-filters`,
     `dashboard-filter-bar`, `dashboard-view`, `dashboard-filter-labels`,
     `dashboard-panels`, `/dashboard` e `/dashboard/relatorio`).
- **Método:** leitura do código, testes de segurança automatizados (SQLite com
  o schema real, `require_auth` real, sem rede) e `scripts/security-audit.sh`.
  Sem acesso ao banco real, sem git, sem a suíte completa.

## Parecer

**APROVADO COM RESSALVAS.** Nenhum achado Crítico, Alto ou Médio confirmado no
código revisado. Há 2 achados Baixos e 3 informativos. **Ressalva obrigatória
antes do deploy:** como o backfill da 0012 JÁ rodou em produção, execute as
consultas de verificação da seção "Verificação SQL pós-backfill" (V1–V4). Se
aparecer nome de pessoa em `bond_status`, trate como incidente LGPD (Médio:
dado pessoal exposto a todos os perfis) e limpe antes de liberar o dashboard.

Isto não significa que o sistema esteja livre de vulnerabilidades: vale só para
o escopo e os testes listados aqui.

## Achados

| ID | Severidade | CVSS 3.1 | Resumo |
|----|-----------|----------|--------|
| SEC-VF-01 | Baixa — **CORRIGIDO 2026-10-20** | 3.1 `AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N` | Com UMA só coluna `RESPONSAVEL`, o nome da pessoa vira `vinculo_situacao` e depois `assets.bond_status`, visível para todos os perfis |
| SEC-VF-02 | Baixa — **MITIGADO/ENCERRADO 2026-10-20** | 2.6 `AV:N/AC:H/PR:L/UI:R/S:U/C:N/I:L/A:N` | O backfill SQL não remove caracteres de controle/formatação (Cc/Cf), e `normalize_bond_status` remove |
| SEC-VF-03 | Informativa | — | Custo por requisição O(descrições distintas) com `tipo` e em `/tipos`, sem teto; o limite é por rota (10 rotas × 1200/h) |
| SEC-VF-04 | Informativa — **CORRIGIDO 2026-10-20** | — | Valores reservados (`__none__`, `__outros__`) podem colidir com um vínculo real da planilha |
| SEC-VF-05 | Informativa (LGPD) | — | O vínculo (Servidor/Terceirizado) é uma característica do responsável; ao lado do nome, em `/assets`, vira dado pessoal |

### SEC-VF-01 — Pessoa gravada como vínculo (mapeamento posicional sem checagem)

> **Status: CORRIGIDO (2026-10-20).** `google_sheets_client` só preenche
> `vinculo_situacao` e `responsavel_pessoa` quando há EXATAMENTE 2 colunas
> `RESPONSAVEL`; em outro caso deixa ambos nulos e emite um `aviso:` de
> cabeçalho que aparece na prévia. O `xfail` do teste foi removido e ele passa.
>
> **Item 2 (defesa em profundidade): IMPLEMENTADO (2026-10-20).**
> `import_references.screen_bond_status` roda na prévia (gera aviso) e de novo
> na confirmação (é a triagem autoritativa, com o cadastro atual), para NOVO e
> EXISTENTE. Se `person_match_key` do vínculo (calculado antes do corte em 64
> e também depois) for igual à chave da 2ª `RESPONSAVEL` da linha ou à de uma
> pessoa ATIVA, o vínculo não é gravado. Isso conta como célula vazia: no
> EXISTENTE o valor atual é mantido. A linha recebe um aviso que não repete o
> valor:
> `aviso: 1ª RESPONSAVEL (vínculo) é igual à 2ª RESPONSAVEL (pessoa) da linha; vínculo não será gravado`
> ou
> `aviso: 1ª RESPONSAVEL (vínculo) coincide com o nome de uma pessoa cadastrada; vínculo não será gravado`.
> O código fica em `normalized_values._vinculo_descartado`. Marcadores
> (`is_placeholder_person`, ex. `Ocioso`) continuam válidos. As chaves das
> pessoas são carregadas uma vez por operação (`ImportReferences`).
> O item 3 (allowlist) continua como melhoria futura. As consultas V1–V4 seguem
> recomendadas.

- **Local:** `backend/app/integrations/google_sheets_client.py:652-689`
  (`responsavel_indices` e `_responsavel_value(0)`), que alimenta
  `import_normalizer.normalize_row(responsavel_vinculo=...)`, depois
  `import_service.py:428/466` e o backfill da `0012` (linha 86).
- **Cenário:** a 1ª `RESPONSAVEL` é o vínculo e a 2ª é a pessoa, só pela
  ordem. Isso continua "pendente de confirmação institucional". Se a planilha
  tiver só UMA coluna `RESPONSAVEL` (a da pessoa), ou se as duas mudarem de
  ordem, o NOME vai para `vinculo_situacao`. Daí segue para
  `assets.bond_status` (importação e backfill) e aparece em
  `/assets`, `/assets/bond-statuses` (até 100 valores), `/dashboard/por-vinculo`
  e no relatório impresso. Todos os perfis veem, inclusive RH.
  `responsavel_pessoa` fica nulo e nenhum aviso é emitido. O docstring do
  dashboard afirma "sem PII", o que deixaria de ser verdade.
- **Comprovação:** `test_sec_vinculo_filtros.py::test_planilha_com_uma_so_coluna_responsavel_nao_grava_pessoa_como_vinculo`
  (`xfail(strict=True)`). Hoje `vinculo_situacao == 'Maria Sintetica da Silva'`.
  O teste existente `test_google_sheets_client.py:65-76` usa
  `"Joao da Silva"` na 1ª coluna e confirma o mapeamento posicional.
- **Correção sugerida:**
  1. Em `google_sheets_client`, preencher `vinculo_situacao`/`responsavel_pessoa`
     só quando houver EXATAMENTE 2 colunas `RESPONSAVEL`. Em qualquer outro
     caso, deixar ambos nulos e gerar um `erro:`/`aviso:` de cabeçalho que
     apareça na prévia. Ao corrigir, remova o `xfail` do teste.
  2. Defesa em profundidade na confirmação: não gravar `bond_status` quando
     `person_match_key(bond)` coincidir com a chave de uma pessoa ativa ou com
     `responsavel_pessoa_key` da mesma linha (registrar aviso).
  3. Opcional: allowlist configurável de vínculos conhecidos. Valor fora dela
     vira pendência na prévia em vez de ser gravado direto.

### SEC-VF-02 — Backfill SQL × `normalize_bond_status` (controle/formatação)

> **Status: MITIGADO/ENCERRADO (2026-10-20).** A 0012 não foi alterada.
> Motivos para encerrar:
> 1. O backfill rodou sobre 0 bens, porque `assets` estava vazia em produção.
>    Nenhum valor sujo foi gravado.
> 2. Daqui em diante, só a importação grava `bond_status`, sempre via
>    `ImportService._bond_status_of` → `screen_bond_status` →
>    `normalize_bond_status`. Os testes de regressão garantem isso:
>    `test_inventario_estatico_de_gravacoes_de_bond_status` (AST: a única
>    escrita em `app/` é a de `import_service`) e
>    `test_novo_e_existente_gravam_somente_via_normalize_bond_status` (com um
>    espião, prova que os caminhos NOVO e EXISTENTE da confirmação gravam a saída da função).
> 3. A saída também passa por limpeza. `/assets` (lista e detalhe) serializa
>    `bond_status` via `normalize_bond_status`, o que não muda nada em dado já
>    normalizado; o rótulo do dashboard usa `clean_label`
>    (`test_saida_de_assets_e_dashboard_passa_por_limpeza`).
>
> A consulta V3 continua recomendada antes do deploy, como confirmação.
> Ressalva: `GET /assets/bond-statuses` e o `id` de `por-vinculo` continuam
> devolvendo o valor gravado. Esse valor é o filtrável, e com 0 linhas legadas
> é sempre limpo.

- **Local:** `backend/migrations/versions/0012_asset_bond_status.py:86` e
  `sql/0015_asset_bond_status.sql` (só `regexp_replace('\s+')` + `btrim`) ×
  `backend/app/services/import_normalizer.py:202-218` (remove Cc/Cf).
- **Cenário:** `raw_import_records.normalized_values->>'vinculo_situacao'` vem
  de `normalize_free_text`, que faz só NFC + strip. Por isso pode conter
  U+0001..U+001F (exceto espaços), U+007F..U+009F, ZWSP (U+200B), RLO (U+202E)
  etc. O backfill copia esses caracteres para `bond_status`. Efeitos:
  - (a) a lista de bens exibe o valor cru (RLO permite *bidi spoofing* visual;
    o React escapa, então não há XSS);
  - (b) `por-vinculo` devolve `id` cru e `label` limpo. Um `id` com C0/C1 não é
    filtrável: o backend responde 400 e o frontend descarta;
  - (c) grupos diferentes podem ganhar o mesmo rótulo (`Servidor` e
    `Servidor​`);
  - (d) a próxima importação corrige o valor sozinha (EXISTENTE atualiza quando
    a forma normalizada difere).

  Também há divergências menores: o `\s` do Postgres depende do locale para
  NBSP/U+2000-200A, e `btrim` sem argumento remove só U+0020. O resultado
  continua satisfazendo o CHECK.
- **Comprovação:** `test_sec_vinculo_filtros.py::test_vinculo_gravado_com_controle_nao_quebra_e_sai_limpo`
  simula o dado gravado pelo backfill. Os agregados respondem 200 e o rótulo
  sai limpo. A divergência do SQL em si não pode ser executada em SQLite e foi
  verificada por leitura.
- **Correção sugerida:** não editar a 0012, que já foi aplicada. Rodar a
  verificação V3. Se houver linhas, corrigir com uma migração nova e aditiva
  (ou SQL manual autorizado) que aplique a mesma regra do Python:
  `regexp_replace(bond_status, '[[:cntrl:]­​-‏‪-‮⁠-⁤﻿]', '', 'g')`,
  seguido de colapso de espaços, `btrim` e `NULLIF ''`. Outra opção é
  simplesmente reimportar. Opcional: em `by_bond_status`, agrupar por
  `clean_label` para não duplicar rótulos.

### SEC-VF-03 — Custo dos agregados com `tipo` (informativo)

- **Local:** `dashboard_service.py:112-125` (`_tipo_clause`: `SELECT DISTINCT
  description` do escopo + `IN (...)` sem teto) e `:638-655` (`type_options`:
  todas as descrições distintas, sem `MAX_GRUPOS`). As consultas rodam em cada
  uma das 10 rotas de cada rodada de filtros. O limite é por usuário e POR
  ROTA (`rate_limit` usa a view na chave): até 12.000 req/h por usuário somando
  as rotas.
- **Avaliação:** no volume atual (centenas/poucos milhares de bens) é aceitável
  e o próprio código documenta o limite. `psycopg2` interpola os parâmetros no
  cliente, então não há teto de 65535 parâmetros. As respostas são limitadas:
  top 8/15/50, `bond-statuses` ≤ 100, janela de datas ≤ 5 anos e
  `meses` ≤ 24.
- **Recomendação:** persistir o `tipo` em coluna indexada quando a base passar
  de ~10⁴ descrições distintas. Considerar também um balde agregado por
  usuário para `/dashboard/*` (ex.: 3000/h) e `statement_timeout` na role da
  aplicação, se ainda não houver.

### SEC-VF-04 — Valores reservados (informativo)

> **Status: CORRIGIDO (2026-10-20).** `normalize_bond_status` devolve `None`
> para qualquer valor `__...__` (com ≥ 4 caracteres, sem distinção de caixa,
> avaliado após a normalização e antes e depois do corte em 64). Isso cobre
> `__none__` (`asset_service.BOND_STATUS_NONE`), `__outros__` e `__outras__`
> (`dashboard_service.OUTROS_ID`/`OUTRAS_ID`, ids de balde de `por-vinculo` e
> `por-sala`; o `__OUTROS__` de `tipos` é interno e nunca é vínculo). Na
> prévia, a linha recebe o aviso
> `aviso: 1ª RESPONSAVEL (vínculo) usa um valor reservado do sistema (__none__/__outros__); vínculo tratado como vazio`.
> Na confirmação o valor é tratado como vazio: o EXISTENTE mantém o valor atual.
> Testes: `test_valor_reservado_vira_vazio_com_aviso`,
> `test_existente_com_reservado_mantem_valor_atual`,
> `test_normalize_bond_status_recusa_reservado` e
> `..._aceita_parecido_com_reservado`.

`__none__` (filtro de nulo) e `__outros__`/`__outras__` (ids de balde) são
strings comuns. Um vínculo real escrito `__none__` na planilha nunca seria
filtrável. Sem impacto de segurança.

### SEC-VF-05 — Vínculo como dado pessoal (informativo, LGPD)

"Servidor/Terceirizado" descreve a relação de trabalho de quem responde pelo
bem. Ao lado de `responsible_person.name`, em `/assets` e `/assets/<id>`, é
dado pessoal, e RH o recebe. É compatível com a finalidade patrimonial (o
controle do bem depende do vínculo), mas convém registrar essa decisão em
`docs/architecture/assets-api.md` e no RoPA/inventário LGPD.

## Verificação SQL pós-backfill (obrigatória antes do deploy)

Execute no SQL Editor, somente leitura, pelo responsável autorizado:

```sql
-- V1: distribuição (esperado: poucos valores — Servidor, Terceirizado, Ocioso...)
SELECT bond_status, count(*) AS n
FROM public.assets WHERE deleted_at IS NULL
GROUP BY bond_status ORDER BY n DESC;

-- V2: vínculo igual a nome de pessoa cadastrada OU à 2ª RESPONSAVEL (esperado: 0)
SELECT count(*) FROM public.assets a
WHERE a.bond_status IS NOT NULL AND (
  EXISTS (SELECT 1 FROM public.responsible_people p
          WHERE lower(btrim(p.name)) = lower(a.bond_status))
  OR EXISTS (SELECT 1 FROM public.raw_import_records r
             WHERE r.source_record_id = a.source_record_id
               AND lower(btrim(r.normalized_values->>'responsavel_pessoa')) = lower(a.bond_status)));

-- V3: caracteres de controle/formatação (esperado: 0)
SELECT count(*) FROM public.assets
WHERE bond_status ~ '[[:cntrl:]­​-‏‪-‮⁠-⁤﻿]';

-- V4: cardinalidade e valores raros (n = 1 costuma ser nome ou lixo)
SELECT count(*) AS grupos,
       count(*) FILTER (WHERE n = 1) AS grupos_unitarios
FROM (SELECT lower(bond_status) AS k, count(*) AS n
      FROM public.assets WHERE bond_status IS NOT NULL GROUP BY 1) s;

-- V4b: listar os grupos unitários para revisão manual
SELECT lower(bond_status), count(*) FROM public.assets
WHERE bond_status IS NOT NULL GROUP BY 1 HAVING count(*) = 1;
```

## O que foi verificado e está correto

- **AuthZ:** todas as 10 rotas do dashboard e `bond-statuses` exigem token
  (401). O ADM em AAL1 é negado e gera o evento `AAL2_REQUIRED`. Sem
  `reports.read` a resposta é 403 com `ACCESS_DENIED`. A matriz de
  `test_sec_route_inventory` já inclui as rotas novas.
- **Escopo de unidade:** todos os agregados passam por `_scoped_active`
  (`asset_scope_clause`: `unit_id` OU `owner_unit_id`), ADM sem bypass.
  `bond-statuses` usa o mesmo escopo. Os filtros entram DEPOIS do escopo.
- **IDOR/BOLA:** `unit_id`/`owner_unit_id`/`room_id`/`responsible_person_id`
  de outra unidade produzem JSON idêntico ao de um UUID inexistente nos 10
  agregados, sem vazar nome de sala, pessoa, vínculo, tipo ou sigla. Filtrar
  por pessoa alheia só conta bens que já são visíveis pelo escopo (paridade
  com `/assets`), então não há oráculo adicional. `inventarios_abertos` com
  `unit_id` alheio dá 0. Movimentações pendentes com filtro ficam restritas
  aos bens filtrados do escopo.
- **Injeção:** só ORM e parâmetros. `bond_status` usa `lower(col) = lower(:p)`,
  sem LIKE (`%`, `_` e `' OR '1'='1` são literais, conforme teste). `tipo` é
  validado por regex `^[A-Z0-9]{1,40}|NAO_CLASSIFICADO$` e vira
  `description IN (...)` parametrizado. Ordenação por allowlist (`Literal` +
  `_SORTS`). `parse_query` rejeita parâmetro repetido e desconhecido (400 +
  `MASS_ASSIGNMENT_REJECTED`; nome privilegiado gera
  `PRIVILEGE_ESCALATION_ATTEMPT`), sem eco do valor na resposta nem no evento.
  Datas-limite (ano 9999/0001) e valores de 10 KB não viram 500.
- **Mass assignment:** `bond_status` no POST/PATCH, em qualquer forma
  (`null`, `""`, lista, objeto), retorna 400 + evento para USER e ADM, sem
  alterar `version`.
- **Saída:** modelos Pydantic `extra="forbid"` com limites, `Cache-Control:
  no-store`, `filtros_aplicados` só com NOMES, rótulos de sala/vínculo
  passados por `clean_label` (sem Cc/Cf, ≤ 200) e siglas por `clean_alias`.
- **Frontend:** sem `dangerouslySetInnerHTML`/`eval`/`innerHTML`; nada em
  `localStorage`/`sessionStorage`; o parse da URL só lê chaves da allowlist
  (não há como poluir protótipo) e valida cada valor (UUID, enum, regex,
  data); `router.replace` e os links usam paths fixos (`/dashboard`,
  `/dashboard/relatorio`), então não há open redirect; rótulos são
  renderizados como texto pelo React/Nivo; type guards limitam
  tamanho e quantidade das respostas. Sem exportação CSV/XLSX nas telas
  revisadas, portanto sem risco de formula injection.
- **IA:** nenhum módulo de IA lê `bond_status` ou os agregados novos.

## Testes adicionados

`backend/tests/test_sec_vinculo_filtros.py`, executado isoladamente:
**63 passed, 1 xfailed** (o xfail era o SEC-VF-01, estrito). Depois da
correção do SEC-VF-01 o `xfail` foi removido: `test_sec_vinculo_filtros.py` +
`test_google_sheets_client.py` → **79 passed**.

Na correção dos itens SEC-VF-01 item 2, SEC-VF-02 e SEC-VF-04 (2026-10-20),
foram adicionados 28 casos a `test_sec_vinculo_filtros.py`. Resultados:
`test_sec_vinculo_filtros.py` + `test_assets_bond_status.py` → **130 passed**;
`pytest tests -k "import or vinculo or bond or sheets"` (sem
`test_db_static.py`, que estava sendo editado por outro agente) → **1450
passed, 6 skipped**; `test_google_sheets_client.py` + `test_assets_api.py` +
`test_dashboard_filters.py` → **219 passed**.

## Ferramentas (execução real, 2026-10-20, `scripts/security-audit.sh` sem `--strict`)

Relatórios em `reports/security/20261020T211039Z/` (fora do git).

| Ferramenta | Versão | Resultado |
|-----------|--------|-----------|
| bandit | 1.9.4 | OK — sem MEDIUM/HIGH em `backend/app` |
| semgrep | 1.180.0 | OK — 0 resultados WARNING/ERROR |
| pip-audit | 2.10.1 | **ACHADOS** (fora do escopo desta revisão, ver abaixo) |
| npm audit | npm 11.16.0 | Produção: 0 vulnerabilidades. devDeps: 7 high + 2 moderate (tailwindcss/eslint-config-next → braces, micromatch, chokidar, fast-glob; postcss-*), só em build |
| gitleaks | — | NÃO EXECUTADO (binário ausente) |
| trivy | — | NÃO EXECUTADO (binário ausente; sem daemon Docker) |
| docker compose config | — | OK — portas só em 127.0.0.1, sem 80/443, sem n8n |

Com `--strict`, o script falharia por gitleaks e trivy ausentes.

**pip-audit (fora do escopo, para o coordenador):**
- `certifi 2026.7.22`: GHSA-6q48-6c7w-9gw2 (raiz emSign ECC G3 com
  intermediárias comprometidas). Correção: `2026.10.19`. Afeta TLS de saída
  (Google, n8n, Supabase). **Recomendo atualizar antes do deploy.**
- `pillow 12.3.0`: 8 CVEs (TIFF, GIF, EPS, PPM/MorphOp, PDF append).
  Correção: `13.0.0`. O avatar só aceita JPEG/PNG/WebP por magic bytes e com
  `formats=[...]` (`avatar_service.py:85-126`), então os vetores reportados
  não são alcançáveis hoje. Atualizar com teste de regressão do avatar, já que
  é versão major.

## O que NÃO foi verificado

- O conteúdo real de `assets.bond_status` em produção, porque não houve acesso
  ao banco (por isso as consultas V1–V4).
- Comportamento específico do Postgres: o `\s` do regex conforme o locale, o
  `lower()` conforme o collation, e planos e custos reais dos agregados
  (`EXPLAIN`). Também não foi feito teste de carga.
- A suíte completa do pytest e os testes Playwright/axe (estão com o
  coordenador). Rodei apenas `test_sec_vinculo_filtros.py`.
- gitleaks e trivy (binários ausentes).
- Os cabeçalhos reais da planilha de produção, ou seja, se há de fato 2 colunas
  `RESPONSAVEL` e em que ordem.
