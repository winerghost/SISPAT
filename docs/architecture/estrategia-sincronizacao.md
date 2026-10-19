# Estratégia de Sincronização — Google Sheets → Flask → PostgreSQL

> Fase 1 — sincronização **unidirecional**: Google Sheets é a fonte de dados
> legada; o Flask lê, valida, normaliza e grava no PostgreSQL (Supabase). Nenhuma
> escrita de volta para a planilha ocorre nesta fase (`CLAUDE.md`). n8n pode
> orquestrar o disparo da rotina, mas nunca substitui as regras de validação do
> backend.

## 1. Objetivo e limites da Fase 1

- Importar o acervo patrimonial hoje mantido em planilha Google Sheets para as
  tabelas `assets`, `units`, `rooms`, `locations` e `responsible_people`.
- Preservar **integralmente** o dado de origem, mesmo quando ele for ambíguo,
  inconsistente ou de semântica desconhecida — a normalização nunca descarta o
  valor bruto.
- Suportar reprocessamento idempotente: executar a mesma importação múltiplas
  vezes não deve duplicar bens nem perder histórico.
- Detectar e registrar (não resolver automaticamente, salvo regra explícita)
  divergências entre o que está na planilha e o que já está no banco.
- **Não** escrever de volta na planilha. **Não** presumir que toda coluna da
  planilha tem o significado que seu nome sugere (ver seção 4, coluna `QT`).

## 2. Pipeline de sincronização

```
Google Sheets (fonte)
      │  leitura via Google Sheets API
      ▼
sync_jobs (nova linha, status=RUNNING)
      │
      ▼
raw_import_records (uma linha por linha da planilha, raw_values = JSON fiel ao original)
      │  normalização (ver seção 3)
      ▼
raw_import_records.normalized_values + validation_errors
      │  validação de negócio (Flask/Pydantic)
      ▼
   ┌──────────────┬───────────────────┐
   │ válido e novo │ válido e já existe │ inválido/ambíguo
   ▼              ▼                    ▼
INSERT assets   UPDATE assets      sync_conflicts (se divergência)
                (se mudou)         raw_import_records.import_status=REJEITADO
      │
      ▼
sync_jobs atualizado (records_read/created/updated/failed, status final)
```

Cada execução completa é uma transação lógica por lote (não necessariamente uma
única transação SQL para a planilha inteira, para não manter locks longos —
ver seção 5), sempre referenciada por um `sync_jobs.id`.

## 3. Etapa 1 — Preservação do dado bruto (`raw_import_records`)

Para cada linha lida da planilha, antes de qualquer interpretação de negócio:

1. Grava-se uma linha em `raw_import_records` com:
   - `sync_job_id`: a execução atual.
   - `source_row_number`: a posição da linha na planilha (1-based, útil para o
     operador localizar a linha de origem para correção manual).
   - `source_record_id`: um identificador estável da linha, se a planilha tiver
     uma coluna de ID; caso não tenha, usar uma chave derivada e documentada
     (ex.: hash de `patrimony_number` + nome da aba) — **pendente de validação
     institucional** até inspeção da planilha real.
   - `raw_values` (`jsonb`): **todas** as colunas da linha, como lidas, sem
     qualquer transformação de tipo, incluindo as duas colunas `RESPONSAVEL`
     lado a lado exatamente como aparecem na planilha.
   - `import_status = 'PENDENTE'`.
2. Só então a normalização (etapa 2) é executada e grava seu resultado em
   `normalized_values` **na mesma linha**, sem jamais sobrescrever
   `raw_values`.

Esse desenho garante que qualquer decisão de normalização possa ser revisada e
reprocessada posteriormente a partir do dado original, sem precisar reler a
planilha.

## 4. Etapa 2 — Normalização

### 4.1 Número patrimonial

- Lido sempre como string (nunca convertido para número em nenhuma etapa do
  pipeline, incluindo a leitura da API do Google Sheets, que deve ser
  configurada para retornar o valor formatado/textual da célula, não o valor
  numérico). Isso evita a perda de zeros à esquerda e a conversão para notação
  científica, problema comum em planilhas com colunas numéricas longas.
- Normalização mínima: `trim()` de espaços; nenhuma remoção de zeros à esquerda,
  nenhuma reformatação.

### 4.2 Colunas duplicadas `RESPONSAVEL`

A planilha de origem traz **duas colunas** nomeadas `RESPONSAVEL`. Tratadas
como semanticamente distintas, nunca fundidas:

| Coluna de origem | Campo normalizado | Significado assumido | Uso no modelo lógico |
|---|---|---|---|
| 1ª coluna `RESPONSAVEL` | `vinculo_situacao` | Vínculo/situação (`Servidor`, `Terceirizado`, `Ocioso`) — **não é pessoa** | Informativo; não resolve FK |
| 2ª coluna `RESPONSAVEL` | `responsavel_pessoa` (+ `responsavel_pessoa_key`) | Nome da pessoa responsável; a chave de casamento é casefold, sem acento, espaços colapsados (a planilha mistura `Fulano` e `FULANO`) | Candidato a correspondência com `responsible_people.name` via a chave (ver matching abaixo) |

> **Revisão 2026-10-16:** a amostra real de 10 linhas invalidou a suposição
> anterior (1ª = pessoa, 2ª = unidade). As chaves antigas
> `responsavel_original` (1ª) e `responsavel_unidade` (2ª) continuam gravadas
> **apenas por compatibilidade** e não devem ser usadas. Normalização feita
> por `app/services/import_normalizer.py` (funções puras); ver também
> `plano-importacao-mconferencia.md`. Novas chaves em `normalized_values`:
> `codigo_material`, `descricao_limpa`, `owner_unit_code`, `owner_unit_name`,
> `located_enum`, `sala_codigo`, `usuario_email`, `latitude`, `longitude`,
> `source_updated_at_utc`, `registration_date`, `pesquisador`. Valores
> inválidos viram `null` com `validation_errors` `aviso:`; só `ID`/`PATRIMONIO`
> geram `erro:`.

**Pendente de validação institucional (hipótese baseada na amostra):**
confirmar na prévia real se 1ª = vínculo e 2ª = pessoa antes de fixar essa
interpretação em produção. Até a confirmação, o pipeline:

- Sempre grava ambos os valores brutos em `raw_import_records.raw_values` sob
  chaves distintas (`"RESPONSAVEL_1"`, `"RESPONSAVEL_2"` ou equivalente
  posicional, nunca sobrescrevendo uma com a outra).
- Grava a interpretação tentativa em `normalized_values.vinculo_situacao` e
  `normalized_values.responsavel_pessoa` (legado: `responsavel_original`/
  `responsavel_unidade`).
- Resolução de `responsible_person_id` (FK em `assets`): busca em
  `responsible_people` por `name` igual (normalizado: trim, colapso de espaços,
  comparação *case-insensitive*) dentro da unidade candidata. Se não houver
  correspondência exata, **não cria automaticamente** uma nova pessoa
  responsável silenciosamente — gera entrada em `validation_errors` do tipo
  `RESPONSAVEL_NAO_ENCONTRADO`, deixando o registro em `import_status =
  'PENDENTE'` ou `'REJEITADO'` conforme severidade configurada, para revisão
  humana antes da primeira carga. Criação automática de `responsible_people` a
  partir da planilha é uma decisão de produto que deve ser explicitamente
  aprovada — **pendente de validação institucional**.

### 4.3 Coluna `QT`

A planilha traz uma coluna `QT`. **Não se presume que `QT` significa
"quantidade de equipamentos"** por bem — essa é exatamente a armadilha que a
especificação do domínio pede para evitar: uma linha com `QT = 3` pode
significar quantidade de itens agrupados sob um único número patrimonial,
quantidade de partes de um conjunto, um código de categoria, ou um erro de
preenchimento herdado do controle manual anterior.

Tratamento adotado na Fase 1:

- A amostra de 2026-10-16 mostra `QT` = 25, 30, 32, 38... (parece contador
  sequencial, não quantidade) — reforça a decisão de não interpretar.
- `QT` é preservado em `raw_import_records.raw_values` e replicado, sem
  interpretação, em `normalized_values.qt_raw` (como texto, não como número).
- **Nenhuma coluna `assets.quantity` é criada neste momento** — o modelo lógico
  (`docs/database/modelo-logico.md`) não inclui campo de quantidade na tabela
  `assets` precisamente porque sua semântica é desconhecida.
- Se, ao final da validação institucional, `QT` for confirmado como quantidade
  de itens agrupados em um único registro patrimonial, a decisão de produto
  (dividir em N bens individuais vs. manter um campo de quantidade agregada)
  deve ser tomada antes de qualquer migração de schema adicional.
- Até essa confirmação, `QT` não participa de nenhuma regra de negócio,
  cálculo ou indicador do sistema.

### 4.4 Demais campos

Mapeamento direto para os campos correspondentes de `assets` (`description`,
`registration_date`, etc.), com:

- Datas: parse tolerante a formatos comuns de planilha (`DD/MM/AAAA` e
  variantes), gravando erro em `validation_errors` quando não parseável — nunca
  interpretar uma data inválida como `NULL` silenciosamente.
- Vínculos (implementado, etapa 3 — `app.services.import_references`; só para
  itens NOVO, sem nunca criar cadastro mestre):
  - `unit_id` <- sigla da coluna `UNIDADE` via `unit_aliases` (case-insensitive,
    trim). Sigla vazia, sem alias ou de unidade inativa => item **INVALIDO**
    com mensagem clara (nunca "chute", nunca por nome de unidade).
  - `owner_unit_id` <- código de 6 dígitos de `UNIDADE_PERTENCENTE` => `units.code`.
  - `located` <- S/N (`SIM`/`NAO`/`DESCONHECIDO`); `registration_date` e
    `source_updated_at` <- valores normalizados (dd/mm/aaaa em America/Araguaina
    -> UTC; sem valor, `source_updated_at` = instante da confirmação);
    `notes` <- `OBSERVACAO`.
  - `room_id` <- sala por NOME dentro da unidade do bem (casefold, espaços
    colapsados). `responsible_person_id` <- 2ª `RESPONSAVEL` pela chave de casamento
    entre pessoas ATIVAS. `USUARIO` (e-mail) vira `usuario_person_id` somente em
    `normalized_values`; `assigned_user_id` permanece NULL. A 1ª `RESPONSAVEL`
    (`Ocioso`...) é só `vinculo_situacao`, nunca pessoa.
  - Sala/pessoa/unidade pertencente inexistente ou ambígua => **pendência**:
    campo NULL, contada em `preview.pending_counts` / `ImportService.pending_report`
    (`unidade_sem_alias`, `unidade_ausente`, `sala_nao_encontrada`,
    `pessoa_nao_encontrada`, `pessoa_ambigua`, ...) e SEM bloquear a
    confirmação dos itens válidos. Os vínculos são resolvidos na prévia
    (informativo, em `normalized_values["_links"]`) e **de novo na confirmação**
    (autoritativo; alias removido entre as etapas => falha do item).
  - Itens EXISTENTE continuam atualizando só descrição/origem (não sobrescrevem
    edição manual de sala, responsável, observações).

### 4.5 Importação dos cadastros de apoio (unidades, salas, pessoas)

`app.services.catalog_import_service.CatalogImportService` (+ normalizadores
puros em `catalog_normalizer`), prévia -> confirmação, reutilizando
`import_previews`/`import_preview_items` com `source = 'catalog:units|rooms|people'`
(`ImportService.confirm_preview` recusa essas prévias e vice-versa). Leitura
via `GoogleSheetsClient.read_tab_rows(sheet_name=..., sheet_gid=...)` (nome
exato tem prioridade; sem nome nem GID nunca assume aba). Settings opcionais
(documentadas em `.env.example`): `GOOGLE_SHEETS_{UNITS,ROOMS,PEOPLE}_SHEET_{NAME,GID}`.

| Aba | Colunas | Regra |
|---|---|---|
| Unidades | `ID`, `UNIDADE` (sigla), `Orgao` (`023401 - NOME`) | casa por `units.code`; existente: grava `source_record_id` se vazio (nome não é alterado, divergência = aviso); ausente: cria. Garante o alias da sigla (sigla de outra unidade => CONFLITANTE) |
| Salas | `ID`, `SALA`, `UNIDADE` (sigla) | único por (unidade, nome casefold); `06` e `6` distintas, listadas em "prováveis duplicatas" |
| Pessoas | `ID`, `NOME`, `EMAIL`, `TELEFONE`, `UNIDADE` (sigla) | e-mail minúsculo/validado; telefone só dígitos (10–13; com/sem 55; inválido = NULL + aviso); sufixo ` -` removido; `Ocioso`/e-mail sem domínio válido não vira pessoa; mesmo e-mail => mantém a 1ª, a outra é DUPLICADO |

Comuns: trim e espaços colapsados; grafia NUNCA corrigida (relatório de nomes
suspeitos, ex.: `JÕAO`); sigla vazia/sem alias => INVALIDO (pendente); ID
repetido na origem => linhas mantidas, conflito sinalizado, só a 1ª linha
importável grava `source_record_id` (índice único) e o ID original fica em
`raw_import_records`. Existente: só preenche campos vazios. Confirmação:
savepoint por item, `SyncJob` + `RawImportRecord` + `AuditLog`
(`CONFIRM_CATALOG_IMPORT`) na mesma transação, idempotente (prévia CONFIRMADA
=> 409), revalidando contra o estado atual (corrida => falha só daquele item).
O relatório (`create_preview(...).report`, `get_report`) traz classificações,
pendências por código, `ids_repetidos`, `nomes_suspeitos` e `provaveis_duplicatas`.
Sem rotas nesta etapa; as rotas (ADM + AAL2) vêm na próxima onda.

## 5. Idempotência

A idempotência é garantida por duas camadas:

1. **Chave de correspondência determinística.** `assets` possui o índice único
   parcial `UNIQUE (source_system, source_record_id) WHERE source_record_id IS
   NOT NULL` (ver `modelo-logico.md`, seção 11). Cada execução de sincronização
   faz, por linha, um *upsert* lógico:
   - Se existe `assets` com o mesmo `(source_system, source_record_id)`:
     compara campo a campo o valor normalizado da planilha com o valor atual
     em banco.
     - Sem diferença: nenhuma escrita, `records_read` incrementado,
       `records_updated` não.
     - Com diferença: se o campo divergente estiver na lista de campos que o
       Flask decide atualizar automaticamente a partir da origem (ex.:
       `description`, `source_updated_at`), aplica `UPDATE` e incrementa
       `records_updated`. Se o campo divergente for sensível a edição manual
       já feita no sistema (ex.: `located`, `responsible_person_id`,
       `notes` — campos que um operador pode ter corrigido depois da última
       sincronização), **não sobrescreve automaticamente**: cria uma linha em
       `sync_conflicts` com `source_values` e `database_values` para resolução
       manual.
   - Se não existe: `INSERT` de novo `assets`, `records_created` incrementado.
   - **Pendente de validação institucional:** a lista exata de "campos
     sincronizáveis automaticamente" versus "campos protegidos contra
     sobrescrita automática" — a proposta acima (description/source_updated_at
     automáticos; located/responsible_person_id/notes protegidos) é um ponto
     de partida razoável, não uma decisão fechada.
2. **Reexecução segura.** Reexecutar o mesmo job (ou um novo job sobre a mesma
   planilha sem alterações) não duplica `assets` (graças à chave única acima),
   não duplica `raw_import_records` relevantes para auditoria de execuções
   distintas (cada execução gera suas próprias linhas, associadas ao seu
   próprio `sync_jobs.id` — isso é histórico de execução, não duplicação de
   dado de negócio) e não produz `sync_conflicts` repetidos para a mesma
   divergência já registrada e pendente (verificação por `source_record_id` +
   `status = 'PENDENTE'` antes de criar um novo conflito).

Toda a operação de gravação por linha ocorre em transação (`BEGIN`/`COMMIT`
por registro ou por lote pequeno, não pela planilha inteira) para que uma
falha em uma linha não comprometa as demais nem deixe `assets` em estado
parcialmente gravado.

## 6. Tratamento de falhas e `sync_jobs`

- `sync_jobs.status` inicia em `RUNNING`, é atualizado para `SUCCESS` (nenhuma
  falha), `PARTIAL` (alguma linha falhou, outras importaram) ou `FAILED` (falha
  impediu a execução, ex.: planilha inacessível, credencial inválida).
- `records_failed` conta linhas com `import_status IN ('REJEITADO','CONFLITO')`
  após a execução.
- `error_summary` guarda um resumo humano-legível (não o payload completo —
  isso já está em `raw_import_records.validation_errors`).
- Toda falha de autenticação/autorização com a Google Sheets API e toda falha
  de execução do job devem gerar entrada em `audit_logs`
  (`entity_type='sync_jobs'`, `result='FAILURE'`).

## 7. Resolução de `sync_conflicts`

Fase 1: resolução é sempre **manual**, através de uma ação administrativa
(`ADM`, via permissão implícita em `sync.execute`/`imports.execute` — ver
`docs/permissions/matriz-permissoes.md`) que define `status`:

- `RESOLVIDO_MANTEM_BD`: o valor em `assets` prevalece; a divergência da
  planilha é descartada para este ciclo (mas permanece registrada em
  `sync_conflicts` para histórico).
- `RESOLVIDO_APLICA_ORIGEM`: o valor da planilha é aplicado a `assets`,
  sobrescrevendo o valor atual (gera também entrada em `audit_logs` para o
  `UPDATE` resultante).
- `IGNORADO`: conflito descartado sem ação (ex.: identificado como erro de
  origem já corrigido na própria planilha em execução futura).

Nenhuma resolução automática de conflito ocorre nesta fase.

## 8. Preparação para sincronização bidirecional futura

O modelo já inclui as entidades necessárias para evoluir, em fase posterior,
para uma sincronização bidirecional controlada, sem necessidade de nova
modelagem de schema:

- `sync_jobs` já distingue execuções por `source`, permitindo adicionar no
  futuro um `source` do tipo `SISPAT_TO_SHEETS` (escrita de volta) sem alterar
  a tabela.
- `sync_conflicts` já modela divergência bidirecional (`source_values` vs.
  `database_values`) — o mesmo mecanismo serve para decidir qual lado prevalece
  quando ambos podem mudar independentemente.
- `assets.source_updated_at` já guarda o timestamp de última atualização *na
  origem*, pré-requisito para qualquer estratégia de resolução de conflito por
  "mais recente vence" (*last-write-wins*) caso essa regra venha a ser adotada
  — hoje não é usada para resolução automática, apenas para diagnóstico.
- `assets.version` (controle otimista) protege contra gravações concorrentes
  também no cenário de escrita automatizada futura (ex.: um worker de
  sincronização bidirecional e um usuário editando o mesmo bem ao mesmo tempo).

**Pendente de validação institucional, antes de habilitar escrita de volta à
planilha:** regra de precedência em caso de conflito simultâneo (origem vs.
banco), escopo de quais campos podem ser escritos de volta, e controle de
acesso da credencial de escrita na Google Sheets API (deve ser distinta e mais
restrita do que a credencial de leitura usada na Fase 1).

## 9. Papel do n8n

n8n pode ser usado para:

- Agendar o disparo periódico da rotina de sincronização (chamando um endpoint
  Flask autenticado que inicia um `sync_jobs`).
- Notificar operadores quando `sync_jobs.status IN ('FAILED','PARTIAL')` ou
  quando novos `sync_conflicts` forem criados.

n8n **nunca** acessa o PostgreSQL diretamente nem aplica regra de negócio — ele
consome apenas as APIs autenticadas do Flask (`CLAUDE.md`), que permanece o
único responsável por validação, idempotência e autorização.

## 10. Resumo dos pontos pendentes de validação institucional

1. Esquema real de identificação de linha na planilha (`source_record_id`) —
   depende de inspeção da planilha de produção.
2. Confirmação do significado das duas colunas `RESPONSAVEL`.
3. ~~Criação automática de `responsible_people`~~ — decidido: NÃO cria; pessoa
   não encontrada é pendência; cadastros entram pela importação dedicada (4.5).
4. Significado definitivo da coluna `QT` e, caso confirmado como quantidade,
   a decisão de modelagem associada (bens individuais vs. campo agregado).
5. Lista fechada de campos de `assets` sincronizáveis automaticamente versus
   protegidos contra sobrescrita automática por edição manual prévia.
6. Regras de precedência e escopo para a futura sincronização bidirecional.
