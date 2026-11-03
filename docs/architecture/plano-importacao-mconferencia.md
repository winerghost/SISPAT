# Plano — Importação da planilha MConferencia

Origem: Google Sheets "MConferencia" (aba GID 1729017438), tratada como
entrada NÃO confiável. Fluxo: Sheets → Flask → PostgreSQL (prévia → confirmação).
Este plano parte de uma amostra de 10 linhas fornecida pelo usuário
(2026-10-16); as hipóteses abaixo devem ser validadas na prévia real.

> **Estado em 2026-10-29 (leia antes do plano).** Este é um documento de PLANO,
> mantido como registro histórico das decisões; várias etapas marcadas abaixo como
> "falta" já existem. Conferido no código nesta data:
> - As rotas de importação existem: bens em `backend/app/api/v1/imports.py`
>   (`/api/v1/imports/google-sheets/preview`, `/preview/<id>/items`,
>   `/<id>/pending`, `/<id>/reconciliation`, `/confirm`) e cadastros de apoio em
>   `catalog_imports.py` (`/api/v1/catalog-imports/...`), todas ADM + AAL2.
> - O CRUD dos cadastros de apoio existe (`rooms.py`, `responsible_people.py`,
>   `units.py`, `locations.py`) — contrato em `cadastros-apoio-api.md`.
> - As telas existem: `/administracao/importacao/*`, `/salas-localizacoes`,
>   `/responsaveis`, `/unidades` e as de administração correspondentes.
> - `alembic_version` de produção = `0019_user_soft_delete` (head da cadeia linear
>   0001→0019). Os cabeçalhos dos arquivos de migração que ainda dizem "PENDENTE
>   DE APLICAÇÃO" (0007, 0008, 0015, 0016, 0019...) são texto de autoria não
>   atualizado; o estado real de cada DDL se confere com as consultas de
>   `docs/database/historico-migracoes.md`.
> - A classificação de equipamentos (migração 0018) roda na importação: NOVO é
>   sempre classificado e EXISTENTE é reclassificado pela descrição atual, salvo
>   `category_override` (ver `classificacao-patrimonial.md`, incluindo o efeito de
>   `version + 1` na primeira confirmação após a 0018).

## 1. Achados da amostra vs. código atual

| Coluna | O que a amostra mostra | Código atual | Ação |
|---|---|---|---|
| UNIDADE | sigla (`UEA`) | casa com `units.name` | **Todo item NOVO falharia.** Resolver por alias sigla→unidade |
| UNIDADE_PERTENCENTE | `023404 - UNIDADE ESTADUAL...` | não usada | extrair código (6 dígitos) → `units.code` → `owner_unit_id` |
| RESPONSAVEL (1ª) | categoria: `Terceirizado`/`Ocioso`/`Servidor` | assume pessoa física | **Suposição invalidada**: é situação/vínculo (`vinculo_situacao`) |
| RESPONSAVEL (2ª) | nome da pessoa (caixa inconsistente: `Phillipe Farias Ferreira` / `PHILLIPE FARIAS FERREIRA`) | assume unidade | **Suposição invalidada**: é a pessoa; normalizar caixa/acentos p/ chave de casamento |
| LOCALIZADO | `S` | não mapeado | `S/N` → enum `SIM/NAO/DESCONHECIDO` |
| SALA | `3`, `11`, `13` (código numérico) | não resolvido | guardar `sala_codigo`; vincular só se a sala existir |
| USUARIO | e-mail; placeholder `Ocioso@ocioso` | não resolvido | e-mail minúsculo; placeholders → `NULL` |
| DESCRICAO | `(00138020-6) NOTEBOOK ... |` | cru | extrair `codigo_material`; remover ` |` final; cru preservado |
| LOCALIZACAO | `0.000000, 0.000000` | cru | coordenadas; `0,0` → `NULL` |
| DATA_ALTERACAO | `15/10/2026 22:18:21` | cru | parse dd/mm/aaaa HH:MM:SS em America/Araguaina → UTC |
| DATA_REGISTRO | vazia | cru | parse dd/mm/aaaa; vazia → `NULL` |
| PESQUISADOR | `Developer` | só `raw_values` | manter em `normalized_values` |
| QT | 25, 30, 31, 32... | `qt_raw` | parece contador sequencial, **não** quantidade; continua sem interpretação |

Preservar sempre `raw_values` originais (`raw_import_records`). `PATRIMONIO`
continua texto.

## 2. Decisões padrão (reversíveis pelo usuário)
- `assets.unit_id` = unidade de `UNIDADE`; `owner_unit_id` = `UNIDADE_PERTENCENTE`.
- Siglas ficam em tabela `unit_aliases` (migração, sem hardcode). Sigla sem
  alias → item INVALIDO com mensagem clara (nunca chute).
- Sem criação automática de salas/responsáveis/usuários na importação de
  bens. Prévia lista valores sem correspondência; cadastro de apoio é etapa
  separada e explícita.
- Campos sem coluna em `assets` (pesquisador, código do material, coordenadas,
  vínculo, QT) ficam em `raw_import_records.normalized_values` (JSONB).

## 3. Etapas e responsáveis
1. Normalizador puro `app/services/import_normalizer.py` + testes (backend-domain).
   **CONCLUÍDA (2026-10-16):** `import_normalizer.py` + `tests/test_import_normalizer.py`,
   já ligado ao `_build_row` do `google_sheets_client` (chaves novas adicionadas
   em `normalized_values`; legadas `responsavel_original`/`responsavel_unidade`
   mantidas só por compatibilidade). Falta na etapa 3: `import_service` usar
   as chaves novas (alias de unidade, `owner_unit_id`, vínculo de pessoa).
2. Migração `unit_aliases` (+ espelho `.sql`) (backend-platform).
   Alembic `0007_unit_aliases`, espelho
   `backend/migrations/sql/0010_unit_aliases.sql`, modelo `UnitAlias`
   (`alias`, `unit_id`). Seed: `UEA` → unidade `023404`. Estado em 2026-10-29:
   o carimbo de produção já passou dessa revisão (head `0019_user_soft_delete`)
   e a resolução de siglas está em uso na importação; confirmar a presença do
   DDL com `docs/database/historico-migracoes.md`. Reverter:
   `alembic downgrade 0006_email_settings_permission` (desfaz só a tabela
   `unit_aliases`); backup antes, com `pg_dump`.
3. Ligar normalizador e alias ao `import_service`/`google_sheets_client` (backend-domain).
   **CONCLUÍDA (2026-10-16):** `app/services/import_references.py` + `import_service`
   (alias de unidade, `owner_unit_id`, `located`, datas, `notes`, sala por nome,
   pessoa por chave; pendências contadas sem bloquear). Detalhes em
   `estrategia-sincronizacao.md` 4.4. Testes: `test_import_links.py`.
4. Prévia mostra campos normalizados e pendências de vínculo (sispat-frontend).
5. Revisão de segurança e `scripts/security-audit.sh` (sispat-security-reviewer).
6. Usuário: ID da planilha/aba no `.env`, compartilhar a planilha com a
   service account, ADM com MFA; ensaio da prévia; autorização das migrações.
7. Confirmação da importação só após revisar contadores da prévia.

## 3.1 Cadastros de apoio (salas, pessoas, unidades) — 2026-10-16
O usuário enviou as listas de apoio e pediu CRUD (inserir/alterar/atualizar/
excluir) e importação normalizada. Siglas confirmadas: PF→023401, PU→023402,
CJU→023403, UEA→023404 (seed de `unit_aliases` com as 4).

Achados nos dados de exemplo:
- Salas (41): nome é o que `assets.SALA` referencia (`3`, `11`, `13`), não o ID.
  Sem coluna de unidade. ID `897bb3a10` tem 9 caracteres (os demais 8).
  Prováveis duplicatas para revisão humana: `06`/`6`; `2`/`2A`/`29`/`29 A` são
  distintas. Duas salas "07" (`07 - ANM`, `07 - Amamentação`).
- Pessoas (~75): ID 35 repetido (EVA / CARLOS); pessoa duplicada 60/61 (mesmo
  e-mail); sufixo ` -` no nome (38, 47); possível erro de digitação
  (`JÕAO`, ID 33); e-mail com caixa mista; telefone com/sem 55; mesmo telefone
  em 32 e 33; `Ocioso@ocioso` (ID 1) é marcador, não pessoa; faltam IDs 13 e 31.
- Unidades: já cobertas por `units` + `unit_aliases`.

Regras de normalização (padrão): trim e espaços colapsados; remover ` -` final;
e-mail em minúsculas; telefone só dígitos; casamento por chave (casefold, sem
acento); NÃO corrigir grafia automaticamente (vai para relatório); ID original
preservado em `source_record_id`; duplicata por e-mail → manter a 1ª e relatar;
`Ocioso` não vira pessoa. "Excluir" = inativar (`active=false`), nunca físico.
`assets.SALA` → sala por nome dentro da unidade; `RESPONSAVEL` (2ª) →
`responsible_person_id`; `USUARIO` (e-mail) → pessoa resolvida em
`normalized_values` (`assigned_user_id` referencia contas do sistema, fica NULL).

Etapas novas: (A) migrações (backend-platform) — `0007_unit_aliases` (espelho
`sql/0010_unit_aliases.sql`): tabela `unit_aliases` com o seed das 4 siglas; e
`0008_catalog_source_ids_permissions` (espelho
`sql/0011_catalog_source_ids_permissions.sql`): `source_record_id` em
`rooms`/`responsible_people`/`units`, `phone` em `responsible_people`/`users`,
as unicidades (unidade+nome da sala, e-mail da pessoa) e as permissões
`responsible.manage`/`units.update`. Em 2026-10-29 o carimbo de produção já passou
das duas (head `0019_user_soft_delete`) e as rotas que dependem dessas colunas estão
em uso. Rollback, só com autorização e `pg_dump` antes:
`alembic downgrade 0007_unit_aliases` (desfaz a 0008) e, em seguida,
`alembic downgrade 0006_email_settings_permission` (desfaz a 0007);
(B) API CRUD + serviços + importação dos cadastros (backend-domain) —
**CONCLUÍDA**: `catalog_import_service.py` + `catalog_normalizer.py` +
`GoogleSheetsClient.read_tab_rows` (estrategia-sincronizacao.md 4.5; testes
`test_catalog_*`) e as rotas `rooms.py`/`responsible_people.py`/`units.py`/
`catalog_imports.py` (contrato em `cadastros-apoio-api.md`);
(C) telas de CRUD — **CONCLUÍDA** (`/salas-localizacoes`, `/responsaveis`,
`/unidades`, `/administracao/importacao/*`); (D) revisão de segurança (ver
`docs/security/`).

## 3.2 DECISÃO (2026-10-16): usuários NÃO são importados
O usuário decidiu: os dados da tabela de Usuários são descartados; o único ADM
é o próprio usuário e ele mesmo enviará os convites, com e-mail institucional
(@agu.gov.br), quando o sistema estiver pronto. A tabela serve só de modelo de
ideia (nome, e-mail, telefone, perfil, auditoria de alteração), adaptada ao
fluxo de convite existente. A análise abaixo fica como registro histórico.

### Análise original (histórico)
Colunas: ID, Nome_Usuario, CPF, Foto, Email, Telefone, Permissao,
RespAlteracao, DataAlteracao (12 linhas). NÃO é importação de dados como as
demais: CLAUDE.md proíbe cadastro fora de convite de ADM e exige MFA/AAL2 para
ADM, e `invites.intended_role_code` nunca é `ADM`. Portanto os usuários entram
como **convites propostos** (revisão do ADM), nunca como contas criadas.

Achados: 3 contas do mesmo titular (telefone repetido: Master, Team Winer,
Developer, todas Adm); `Permissao` ∈ {Adm, RH, None}; 5 linhas sem perfil
(`None`); 1 sem e-mail (impossível convidar); 1 CPF com 8 dígitos (inválido);
e-mails quase todos pessoais (gmail/ifto), diferentes dos institucionais
(@agu.gov.br) da lista de pessoas — vínculo usuário↔pessoa pelo telefone
(sufixo, sem 55) e nome; `Foto` é caminho de arquivo (`Usuarios_Images/...`) sem
o arquivo; `DataAlteracao` com dia/mês sem zero (`14/1/2026`) e vazia em 4;
nome em caixa inconsistente (`wylkyson Gomes`).

Regras (padrão): NÃO importar CPF nem foto (minimização/LGPD; foto via fluxo de
avatar); `Adm` não é aplicado pela importação (promoção ADM é processo
separado, com MFA); `RH`→RH; `None`→sem convite (relatório); e-mail minúsculo e
validado; telefone só dígitos; unidade obrigatória no convite (decisão do
usuário); `ID` original, `RespAlteracao`, `DataAlteracao` só em dado bruto.

## 3.3 Roteiro de importação e reimportação (2026-10-16)

### Estado verificado em 2026-10-16 (prévia real, com rollback — nada gravado)
| Origem | Linhas | Resultado |
|---|---|---|
| Unidade | 4 | 4 EXISTENTE, sem pendências |
| Sala | 40 | 40 NOVO; 1 provável duplicata |
| Pessoas | 77 | 76 NOVO; 1 INVALIDO (marcador `Ocioso`); 2 nomes suspeitos |
| MConferencia (bens) | 471 | 471 NOVO (todas UEA); pendências: sala não encontrada 30, pessoa não encontrada 30, usuário→pessoa não encontrado 14 — esperadas até salas/pessoas serem importadas |

Ambiente: Docker em modo dev (`docker compose -f docker-compose.yml -f
docker-compose.dev.yml up -d`); credencial do Google montada como segredo
somente leitura (`GOOGLE_SHEETS_CREDENTIALS_HOST_PATH`); migrações 0007/0008
aplicadas no Supabase, naquela data ainda sem `alembic stamp` (em 2026-10-29 o
carimbo está em `0019_user_soft_delete`).

### Primeira importação (ordem obrigatória; confirmação sempre pela tela, ADM + MFA)
1. Cadastros de apoio → gerar prévia de **Unidades** → revisar → confirmar
   (só registra `source_record_id`; NÃO marcar opt-in de sigla de atalho).
2. **Salas** → prévia → revisar a provável duplicata → confirmar.
3. **Pessoas** → prévia → revisar os nomes suspeitos (corrigir na planilha se
   preciso) → confirmar. `Ocioso` nunca vira pessoa.
4. **Bens** → gerar a prévia DE NOVO; as pendências de sala/pessoa devem cair;
   → confirmar os 471.

### Reimportação quando a planilha crescer (inclui outras unidades)
1. Preencher `UNIDADE` (PF, PU, CJU, UEA) em toda linha nova.
2. Atualizar primeiro as abas de apoio (Sala, Pessoas) com o que as novas
   linhas usam e importar os cadastros antes dos bens.
3. Gerar a prévia; itens já importados vêm como EXISTENTE, novos como NOVO.
4. Confirmar só o que estiver conferido (linhas problemáticas ficam fora).

Comportamento da reimportação (limites conhecidos):
- Vínculo (1ª `RESPONSAVEL` → `assets.bond_status`, 2026-10-20): normalizado
  por `normalize_bond_status` (`app/services/import_normalizer.py`; NFC, espaços
  colapsados, sem caracteres Cc/Cf, corte em 64 e trim por último; vazio →
  NULL — mesma regra do backfill da migração 0012). NOVO grava; EXISTENTE
  atualiza quando o valor muda; célula vazia NÃO apaga o valor existente. O
  vínculo pertence à planilha: não é editável pela API/UI. `Ocioso` continua
  nunca sendo pessoa.
- Triagem do vínculo (SEC-VF-01 item 2 e SEC-VF-04, 2026-10-20,
  `import_references.screen_bond_status`): o vínculo NÃO é gravado (conta como
  célula vazia: no EXISTENTE o valor atual é mantido) e a linha NOVO/EXISTENTE
  ganha um aviso na prévia (não bloqueia; o texto nunca repete o valor):
  - igual (chave de pessoa: sem caixa/acento) à 2ª `RESPONSAVEL` da linha →
    `aviso: 1ª RESPONSAVEL (vínculo) é igual à 2ª RESPONSAVEL (pessoa) da linha; vínculo não será gravado`;
  - igual ao nome de uma pessoa ATIVA cadastrada →
    `aviso: 1ª RESPONSAVEL (vínculo) coincide com o nome de uma pessoa cadastrada; vínculo não será gravado`;
  - valor reservado `__...__` (`__none__`, `__outros__`, `__outras__`, sem
    caixa) →
    `aviso: 1ª RESPONSAVEL (vínculo) usa um valor reservado do sistema (__none__/__outros__); vínculo tratado como vazio`.

  Marcadores (`Ocioso`) seguem válidos. O código do descarte fica em
  `normalized_values._vinculo_descartado`. As pessoas são carregadas uma vez
  por prévia/confirmação, e a confirmação refaz a triagem com o cadastro atual.
  Esses avisos não entram em `pending_counts`, porque não são pendências de cadastro.
- Bem EXISTENTE: só descrição, vínculo e origem são atualizados. Mudança na planilha de
  sala, responsável ou `LOCALIZADO` NÃO é refletida (evita sobrescrever edição
  feita no sistema). Mudar isso é decisão de produto.
- Pessoa/sala existente: só campos vazios são preenchidos, nunca sobrescritos.
- Patrimônio repetido → DUPLICADO (decisão do ADM).
- Limites: 20.000 linhas por leitura; 10.000 itens por confirmação; 10 prévias
  e 10 confirmações por hora por ADM.

### Fonte da verdade e virada
Decisão pendente: data de virada a partir da qual a planilha vira somente
leitura e o sistema é a fonte da verdade. Sem ela, planilha e sistema
divergem quando houver cadastro nos dois lugares.

### Credencial do Google
Manter a chave JSON (fora do repositório) enquanto houver importações. Após a
última: apagar a chave no Google Cloud e reativar a política
`iam.disableServiceAccountKeyCreation`. Se a importação virar rotina, migrar
para identidade sem chave.

## 4. Pendências do usuário

Revisado em 2026-10-29.

- Importação inicial dos BENS (roteiro 3.3) e decisão da data de virada —
  seguem pendentes.
- Decidir a aplicação de `flask classify-equipment --apply` ANTES da primeira
  importação pós-0018 (o efeito de `version + 1` em cerca de 1.069 bens está
  descrito em `classificacao-patrimonial.md`, "Decisão pendente").
- SEC-CAT-06 já tem decisão implementada: USER vê apenas pessoas vinculadas a
  bens do seu escopo e só `{id, name, unit_id, active}`
  (`cadastros-apoio-api.md`, "Decisões"). SEC-CAT-07 também: existe
  `flask purge-import-previews` (padrão 7 dias, `--dry-run`;
  `estrategia-sincronizacao.md` §6.1) — resta fixar a periodicidade operacional.
- O `alembic stamp` pendente à época do deploy foi resolvido: o carimbo de
  produção é `0019_user_soft_delete`. As pendências de ferramental de segurança
  (nosemgrep em `email/templates.py`, gitleaks, trivy,
  `scripts/security-audit.sh`) são acompanhadas em `docs/security/` e
  `docs/deploy/` — fora deste documento.
- Resolvido: siglas PF/PU/CJU/UEA; leitura de RESPONSAVEL (1ª = vínculo,
  2ª = pessoa) e QT como texto bruto; salas e pessoas com coluna UNIDADE.

## Desempenho da pré-visualização (correção N+1)

Problema: `POST /imports/google-sheets/preview` consultava `assets` uma vez
por linha (≈1069 idas ao Postgres remoto), levando ~55-60s e estourando o
`--timeout 60` do gunicorn.

Correção em `ImportService.create_preview`:

- Os assets ativos de todos os patrimônios lidos são pré-carregados em lote
  (`_prefetch_active_assets`, `IN` sobre `lower(trim(patrimony_number))`, lotes
  de 500) e consultados por dicionário em memória; o cache vale só durante a
  operação. A semântica de classificação não mudou.
- Mapas de unidade/alias/sala/pessoa (`ImportReferences`) são carregados uma
  vez por operação (lazy).
- Persistência dos itens em lote (`add_all` + um `flush`; insertmanyvalues).
- Log INFO por etapa (leitura, prefetch, classificação, persistência, total),
  sem dados de planilha ou pessoais.

Testes: `backend/tests/test_import_preview_performance.py` (limite de
queries e equivalência com a busca unitária por linha).
