# Classificação patrimonial (família / categoria / confiança)

Atualizado na Onda 5 (2026-10-27). Descreve apenas o que existe no código.

Código: `backend/app/services/asset_classification.py` (motor e vocabulário),
`asset_classification_backfill.py` (`flask classify-equipment`), `import_service.py`
(classificação na importação), `dashboard_classification_service.py` (override e fila de
revisão), `backend/app/cli.py`. Migração: `0018_equipment_classification` (ver
`docs/database/historico-migracoes.md`). Contrato das APIs que consomem a classificação:
`docs/architecture/dashboard-api.md`.

## Dois vocabulários independentes

- **Legado (0015):** `assets.asset_category` / `tech_type` / `operational_status`, 5
  categorias; alimenta só `/dashboard/tecnologia/*` e `flask classify-assets`.
- **Vigente (0018):** `assets.equipment_family`, `equipment_category`,
  `classification_confidence`, `classification_rule`, `classification_rules_version` e
  `category_override`. Alimenta os painéis de equipamentos (13 no catálogo; `located_by_unit_chart` usa só os filtros `familia`/`categoria` e a categoria efetiva), a fila de revisão e o override. Os dois
  vocabulários não se sobrescrevem.

Todas as colunas são `text NULL` sem default: `NULL` = "não classificado/informado"; o motor
nunca inventa valor. A descrição original em `raw_import_records` nunca é alterada.

## Famílias e 20 categorias

| Família | Rótulo | Categorias (`id` = rótulo) |
|---|---|---|
| `TI` | Tecnologia da Informação | `COMPUTADOR`, `NOTEBOOK`, `MONITOR`, `IMPRESSORA`, `NOBREAK`, `ESTABILIZADOR`, `DOCKING` (Docking station), `REDE`, `OUTRO_TI` (Outro item de TI) — 9 |
| `MOBILIARIO` | Mobiliário | `MESA`, `ARMARIO`, `GAVETEIRO`, `ESTACAO_TRABALHO`, `CADEIRA`, `POLTRONA`, `SOFA`, `ESTANTE`, `OUTRO_MOB` — 9 |
| `OUTROS` | Outros | `EQUIPAMENTO`, `OUTROS` — 2 |

`POLTRONA` é categoria PRÓPRIA (regra 12), separada de `CADEIRA`. Para filtros e rótulos
existe ainda `NAO_CLASSIFICADO` (categoria nula); não é valor gravável. Confiança:
`ALTA` ou `BAIXA` (`CLASSIFICATION_CONFIDENCES`). O CHECK
`ck_assets_equipment_category` exige que a categoria pertença à família gravada; a família
efetiva é sempre derivada da categoria efetiva (`CATEGORY_FAMILY`).

**Categoria efetiva** = `COALESCE(category_override, equipment_category)`
(`effective_equipment_category`). O override do ADM prevalece e o motor NUNCA escreve nele.

## Medidas do acervo (2026-10-27, origem: protótipo do motor validado contra os 1.069 bens reais, conforme o docstring de `backend/tests/test_asset_classification_rules.py`; informadas pelo responsável)

| Medida | Valor |
|---|---|
| MOBILIARIO / TI / OUTROS | 630 / 403 / 36 (total 1.069) |
| Confiança ALTA / BAIXA | 1.068 / 1 |
| Fila de revisão (OUTROS + BAIXA, sem override) | 1 bem |
| Impressoras | 0 — o acervo não tem impressora; o cartão "Impressoras" de `kpi_infrastructure` mostra 0 e isso está **correto** |

Estas contagens são do protótipo/dry-run, não de leitura do banco: segundo o cabeçalho da
migração 0018 o DDL foi aplicado em 2026-10-27 SEM backfill (colunas NULL). Os painéis só
mostram esses números depois de `flask classify-equipment --apply` ou da primeira
importação (ver "Decisão pendente").

## Como a regra decide (`classify_equipment`, função pura)

Entrada: descrição normalizada (`normalize_description`: sem o `(codigo)` inicial, sem
acento, maiúscula, pontuação trocada por espaço exceto `/` e `-`). Termos casam como
PALAVRA INTEIRA, tolerando hífen/espaço entre as partes (`NO BREAK` = `NO-BREAK`). Antes
de tudo, `strip_accessory_tail` corta o texto a partir de um marcador de acessório
(`ACCESSORY_MARKERS`: `ACOMPANHA`, `COM KIT`, `COMPOSTO DE`...), de modo que
"MICROCOMPUTADOR ... COMPOSTO DE MONITOR" é computador (correção D3).

Ordem REAL de avaliação (a primeira que casa decide; o código em `classify_equipment` é a
fonte — o docstring da função lista 11 depois de 1-10, mas a implementação avalia a regra
de MESA antes do estágio 1):

| Ordem | Prioridade | Regra | Resultado |
|---|---|---|---|
| 1 | sem texto | descrição vazia/só código | `OUTROS/OUTROS`, BAIXA, regra `99_SEM_DESCRICAO` |
| 2 | `0` | termo de `ACCESSORY_TERMS` (`CARREGADOR`, `FONTE`, `BATERIA`, `MALETA`, `MOCHILA`, `SUPORTE`, `CABO`) nos 2 primeiros tokens (`HEAD_TOKENS`, correção D1) | `OUTROS/OUTROS`, ALTA |
| 3 | `11` | `MESA` como PRIMEIRO token (D2); exceções de `MESA_EXCEPTION_TERMS` (`MESA DIGITALIZADORA`, `MESA DE SOM`, `MESA DE CORTE`) | `MOBILIARIO/MESA` ALTA; exceção: `OUTROS/OUTROS` BAIXA |
| 4 | `1` a `10` (estágio 1) | termos de TI e de mobiliário específico (tabela abaixo) | família/categoria da regra, ALTA |
| 5 | `7.5` | `GABINETE` por contexto (`GABINETE_TI_CONTEXT` x `GABINETE_MOB_CONTEXT`/medidas) | só TI -> `TI/COMPUTADOR` ALTA; só mobiliário -> `MOBILIARIO/ARMARIO` ALTA; ambíguo ou sem contexto -> `OUTROS/OUTROS` BAIXA |
| 6 | `11` (exceção fora do 1º token) | `MESA_EXCEPTION_TERMS` em qualquer posição | `OUTROS/OUTROS` BAIXA |
| 7 | `12` a `19` (estágio 2) | demais mobiliário, rede, outros de TI, equipamentos | família/categoria da regra, ALTA |
| 8 | — | nada casou | `OUTROS/OUTROS`, BAIXA, regra `99_SEM_REGRA` |

`classification_rule` registra QUAL regra decidiu (`<prioridade>_<categoria>:<termo>`,
truncada em 64 caracteres), e `classification_rules_version` a versão (`RULES_VERSION`,
hoje `"2"`).

Regras de termo (`TERM_RULES`, a ordem da tupla é a prioridade):

| Prior. | Estágio | Família/categoria | Termos |
|---|---|---|---|
| 1 | 1 | TI/DOCKING | DOCKING, DOCK STATION, HUB DOCKING, HUB USB-C, HUB MULTIFUNCIONAL |
| 2 | 1 | TI/NOBREAK | NOBREAK, NO-BREAK, NO BREAK, UPS |
| 3 | 1 | TI/ESTABILIZADOR | ESTABILIZADOR |
| 4 | 1 | TI/IMPRESSORA | IMPRESSORA, PRINTER, MULTIFUNCIONAL |
| 5 | 1 | TI/NOTEBOOK | NOTEBOOK, LAPTOP, ULTRABOOK, THINKPAD, TP E14, VAIO FE |
| 6 | 1 | TI/MONITOR | MONITOR |
| 7 | 1 | TI/COMPUTADOR | MICROCOMPUTADOR, MICRO COMPUTADOR, COMPUTADOR, DESKTOP, CPU, THINKCENTRE, SFF, ALL IN ONE |
| 8 | 1 | MOBILIARIO/ESTACAO_TRABALHO | ESTACAO DE TRABALHO, ESTACAO TRABALHO |
| 9 | 1 | MOBILIARIO/GAVETEIRO | GAVETEIRO |
| 10 | 1 | MOBILIARIO/ARMARIO | ARMARIO |
| 12 | 2 | MOBILIARIO/POLTRONA | POLTRONA |
| 13 | 2 | MOBILIARIO/CADEIRA | CADEIRA, LONGARINA |
| 14 | 2 | MOBILIARIO/SOFA | SOFA |
| 15 | 2 | MOBILIARIO/ESTANTE | ESTANTE, PRATELEIRA |
| 16 | 2 | TI/REDE | SWITCH, ROTEADOR, ACCESS POINT, ACESS POINT, MODEM, SERVIDOR, NETSERVER, RACK, FIREWALL, CENTRAL TELEFONICA |
| 17 | 2 | TI/OUTRO_TI | SCANNER, PROJETOR, CAMERA, DRONE, TABLET, WEBCAM |
| 18 | 2 | MOBILIARIO/OUTRO_MOB | CABIDEIRO, PULPITO, PUPITO, CLAVICULARIO, QUADRO DE AVISO, QUADRO PORTA CHAVES, BALCAO, ARQUIVO, BIOMBO, CREDENZA, ESCRIVANINHA, BANCADA |
| 19 | 2 | OUTROS/EQUIPAMENTO | AR CONDICIONADO, CONDICIONADOR DE AR, REFRIGERADOR, FRIGOBAR, GELADEIRA, BEBEDOURO, PURIFICADOR, FILTRO, MICROONDAS, FORNO, FOGAO, TELEVISOR, CESTO, LIXEIRA, CARRINHO, VENTILADOR, CAFETEIRA |

Listas de contexto configuráveis (todas em `asset_classification.py`): `ACCESSORY_TERMS`,
`HEAD_TOKENS`, `ACCESSORY_MARKERS`, `MESA_EXCEPTION_TERMS`, `GABINETE_TI_CONTEXT` (CPU,
PROCESSADOR, PLACA MAE, MEMORIA, SSD, HD, INTEL, AMD, CELERON), `GABINETE_MOB_CONTEXT`
(PORTAS, PORTA, PRATELEIRA(S), MDF, MADEIRA, GAVETA(S), ACO; medidas como `1,40 X 0,70` ou
`120/60` também contam como contexto de mobiliário).

## Onde a classificação é gravada

1. **Importação** (`import_service.py`): bem NOVO é classificado sempre
   (`apply_equipment_classification`); bem EXISTENTE é reclassificado pela descrição atual,
   exceto se tiver `category_override`.
2. **Backfill:** `flask classify-equipment` (abaixo).
3. **Override do ADM:** `POST /api/v1/assets/<id>/category-override` (ADM + AAL2,
   `assets.update`, `version` obrigatória).
O `PATCH /assets/<id>` comum não aparece gravando as colunas `equipment_*`/`category_override`
(só o vocabulário legado, em `asset_service._classification_changes`).

## COMO ADICIONAR UMA REGRA NOVA

Procedimento verdadeiro, derivado do módulo e dos testes existentes.

1. **Decida o destino.** Se o termo novo pertence a uma das 20 categorias, nenhuma
   migração é necessária. Uma categoria NOVA exige mudar as tuplas de vocabulário, os
   rótulos e os CHECKs do banco (migração Alembic nova + espelho `.sql`; o DDL da 0018 está
   congelado) e o teste `test_asset_classification_migration.py` compara as tuplas com os
   CHECKs. Só a opção sem migração é descrita adiante.
2. **Edite `TERM_RULES`** (`backend/app/services/asset_classification.py`):
   - termo em categoria existente: acrescente à tupla `terms` da `TermRule` dessa categoria
     (termos em MAIÚSCULAS, sem acento; use palavras inteiras e, se necessário, a forma com
     espaço — o hífen é tolerado);
   - regra nova: crie `TermRule(priority, stage, family, category, terms)` com
     `priority` ÚNICA (texto), `stage` 1 se o termo deve vencer o tratamento de GABINETE e
     de MESA (itens específicos de TI/mobiliário) ou 2 se é genérico, e a categoria
     pertencente à família.
   - **Ordem de prioridade:** entre regras, vale a posição na tupla (`first_matching_term`
     por regra, em sequência); o estágio 1 inteiro vence o estágio 2 independentemente da
     posição do termo no texto. Mantenha os grupos contíguos (estágio 1 antes do 2): o teste
     `test_regras_sao_dados_consistentes_e_ordenados` exige. Coloque o termo mais
     específico ANTES do genérico (ex.: DOCKING antes de MULTIFUNCIONAL/IMPRESSORA).
   - exceções e contexto: ajuste as listas de contexto (`ACCESSORY_TERMS`,
     `MESA_EXCEPTION_TERMS`, `GABINETE_*_CONTEXT`) em vez de criar código novo.
3. **Suba `RULES_VERSION`** (texto, até 16 caracteres, sem espaços nas pontas). O backfill e
   a importação comparam também esta versão; sem a mudança, bens cujo resultado não muda
   mantêm a versão antiga.
4. **Crie o teste** em `backend/tests/test_asset_classification_rules.py`: acrescente uma
   tupla `(descrição, família, categoria, confiança ou None)` a `FIXTURES` (a fixture
   parametrizada `test_fixtures_aprovadas` verifica família, categoria e que a regra é
   registrada); para conflito conhecido, use os blocos parametrizados de MESA/GABINETE/
   acessório. O teste `test_toda_regra_cabe_nos_checks_do_banco` já cobre os limites de
   64/16 caracteres de todos os termos. Rode:
   `cd backend && pytest tests/test_asset_classification_rules.py
   tests/test_asset_classification_equipment_backfill.py
   tests/test_asset_classification_equipment_sync.py
   tests/test_asset_classification_migration.py tests/test_dashboard_equipment.py
   tests/test_qa_onda4_equipment.py`. Painéis e contagens de testes que dependam de
   descrições de fixture podem precisar de ajuste.
5. **Meça o impacto ANTES de aplicar.** O comando é somente leitura sem `--apply`:
   `docker compose exec backend flask classify-equipment` imprime bens candidatos, quantos
   seriam reclassificados, quantos já estão atualizados, quantos ficariam com confiança
   BAIXA, quantos têm override (intocados), quantos sem descrição, e a distribuição por
   família e `cat/<categoria>`. `--list-low-confidence` lista `id` e descrição truncada
   (limite `LIST_LIMIT_MAX`), também sem gravar. Para medir só o DELTA da regra, rode o
   dry-run com a regra nova e a `RULES_VERSION` ANTIGA: como o alvo inclui a versão, só os
   bens cujo resultado muda aparecerão em "reclassificados"; depois suba a versão. Compare
   com a distribuição atual (`category_distribution`) e com a fila de revisão.
6. **Aplicar** (`--apply`) só com autorização explícita do responsável e backup
   (`pg_dump`, ver historico-migracoes): grava em lotes por descrição distinta, incrementa
   `version` e registra `ASSETS_EQUIPMENT_CLASSIFIED` em `audit_logs`. É idempotente.
   Aviso: o incremento de `version` invalida prévias de importação criadas ANTES do apply
   (a confirmação compara a versão lida); gere a prévia depois.

## Decisão pendente: backfill x primeira importação

Estado documentado (cabeçalho da 0018): DDL aplicado, nenhum backfill, colunas NULL.

- **Se nada for feito antes**, a primeira confirmação de importação que tocar os bens
  existentes os trata como MUDADOS: `would_reclassify` é verdadeiro para colunas NULL, a
  guarda "inalterado" falha, o item conta como atualizado e `version` sobe em 1
  (`updated_by` e `source_updated_at` também mudam). Efeito único previsto: cerca de
  1.069 bens contados como "atualizados" e `version+1`, mesmo que a planilha não tenha
  mudado. (Número vindo do acervo medido em 2026-10-27; é previsão, não uma execução.)
  Também vale para o vocabulário legado se `asset_category` ainda estiver nulo
  (`would_classify`).
- **Alternativa:** rodar antes `flask classify-equipment --apply` (com autorização; antes
  disso, `--dry-run` por padrão para conferir). O mesmo `version+1` acontece, mas uma vez e
  de forma auditada (`ASSETS_EQUIPMENT_CLASSIFIED`), e a importação seguinte não contará
  esses bens como atualizados por causa da classificação. Gerar a prévia DEPOIS.
- Decisão do responsável: pendente.
