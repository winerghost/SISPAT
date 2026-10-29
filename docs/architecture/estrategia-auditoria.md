# Estratégia de Auditoria — SISPAT-AGU

> Fase 1 — fundamenta o uso da tabela `audit_logs` (ver
> `docs/database/modelo-logico.md`, seção 15) como mecanismo central de
> rastreabilidade do sistema, em conformidade com a LGPD e com os princípios de
> segurança de `CLAUDE.md`: "registrar eventos críticos e tentativas de acesso
> indevido em `audit_logs`", "não expor detalhes internos de erros ao usuário
> final".

## 1. Objetivo

`audit_logs` existe para responder, a qualquer momento e sem depender de
backups ou logs de aplicação externos, três perguntas sobre qualquer entidade
do sistema: **quem** fez, **o quê**, **quando**, com **quais valores antes e
depois**, e **com qual resultado** — `SUCESSO` ou `FALHA`, os dois únicos
valores aceitos pela coluna `result` (ver seção 2.2). Isso é exigência tanto de
controle patrimonial (bem público) quanto de responsabilização de acesso a
dados pessoais (LGPD).

## 2. O que é auditado

### 2.1 Operações sobre entidades de negócio (`entity_type` / `entity_id`)

Toda operação de escrita sobre as seguintes entidades gera entrada em
`audit_logs`, com `operation IN ('CREATE','UPDATE','DELETE')`:

| `entity_type` | Quando audita | Observação |
|---|---|---|
| `assets` | Criação, toda atualização de campo, exclusão lógica | `previous_values`/`new_values` contêm o *diff* dos campos alterados, não o registro inteiro, para reduzir volume e ruído (ver seção 4) |
| `asset_movements` | Criação da solicitação, aprovação/rejeição, conclusão | Cobre o fluxo completo de movimentação |
| `inventories` / `inventory_items` | Criação de inventário, cada conferência (inclusive reconferência — ver `modelo-logico.md`, seção 14) | Reconferência é o caso em que `audit_logs` substitui uma tabela de histórico dedicada |
| `responsible_people` | Criação, atualização, inativação | Inclui vínculo/desvínculo via `responsible_link.manage` |
| `units` / `rooms` / `locations` | Criação, atualização, inativação | Cadastro mestre |
| `users` | Criação, atualização, ativação/inativação | Nunca inclui hash de senha/credencial (ver seção 5) |
| `roles` / `permissions` / `role_permissions` / `user_roles` / `user_unit_access` | Toda alteração | Exigido explicitamente por `CLAUDE.md`: "registrar toda alteração de usuários, perfis e permissões em auditoria" |
| `sync_jobs` / `sync_conflicts` | Início/fim de execução, resolução de conflito | Cobre a trilha de integração com o Google Sheets |
| `export_jobs` | Criação da solicitação | Quem exportou o quê, mesmo que o arquivo gerado não seja versionado em `audit_logs` |

> **Atenção ao consultar `audit_logs`:** os `entity_type` da tabela acima são os
> nomes **conceituais** (nomes de tabela). Os valores realmente gravados pelo
> código hoje são, literalmente: `user` (singular — gestão de usuários),
> `assets`, `asset`, `invite`, `import`, `catalog_import`, `report_export`,
> `ai`, `auth` e `security_event`. Qualquer filtro por `entity_type` tem de usar
> a string real, não o nome da tabela.

### 2.2 Eventos de autenticação e autorização (sem entidade de negócio)

Além de operações de escrita, `audit_logs` registra eventos de autenticação e
autorização. A tabela abaixo lista os nomes que **existem no código**, com o
arquivo que os grava — não uma lista de intenções:

| `entity_type` | `operation` | `result` | Onde é gravado |
|---|---|---|---|
| `auth` | `LOGIN` | `SUCESSO` | `backend/app/services/login_tracking_service.py` (`record_login`), acionado por `require_auth` em `backend/app/auth/supabase_auth.py` (`_record_login_best_effort`) — ver 2.2.1 |
| `security_event` | `AUTH_FAILED` | `FALHA` | `backend/app/auth/supabase_auth.py` (`_auth_failed`) via `backend/app/authorization/security_events.py` |
| `security_event` | `ACCESS_DENIED`, `AAL2_REQUIRED`, `UNIT_SCOPE_DENIED`, `PRIVILEGE_ESCALATION_ATTEMPT`, `MASS_ASSIGNMENT_REJECTED`, `REVOKE_BLOCKED`, `INVALID_IDENTIFIER` e demais constantes `EVENT_*` | `FALHA` (ou `SUCESSO`, quando o chamador passa `result="SUCESSO"`) | `backend/app/authorization/security_events.py` (`record_security_event`) |
| `user` | `USER_ROLE_CHANGED`, `USER_UNITS_CHANGED`, `USER_DEACTIVATED`, `USER_ACTIVATED`, `USER_SESSIONS_REVOKED`, `USER_PASSWORD_RESET_SENT`, `USER_MFA_RESET`, `USER_DELETED` | `SUCESSO` | `backend/app/services/user_admin_service.py` e `user_deletion_service.py` (seção 2.1) |

**`result` só aceita dois valores.** A CHECK `ck_audit_logs_result`
(`backend/app/models/audit.py:22-24`; espelho em
`backend/migrations/sql/0001_initial_schema.sql:333`) é
`result IN ('SUCESSO','FALHA')`. Versões anteriores desta seção previam
`result = 'DENIED'` para acesso negado: isso é **impossível** no banco (a
inserção seria rejeitada pela CHECK) e nunca existiu no código. Um acesso
negado é gravado com `result = 'FALHA'`; o que o distingue de um erro genérico
é o `operation` (`ACCESS_DENIED`, `UNIT_SCOPE_DENIED`, `AAL2_REQUIRED`...) e o
`details.reason` dentro de `new_values`.

**Nomes que esta seção previa e que NÃO existem no código:**

- `LOGIN_FAILED` — não existe. A falha de autenticação é o evento de segurança
  `AUTH_FAILED` (`entity_type = 'security_event'`, `result = 'FALHA'`). Um 401
  **sem nenhuma credencial** enviada não gera linha alguma (apenas `abort(401)`
  em `require_auth`); só a credencial *apresentada e rejeitada* é auditada.
- `PERMISSION_DENIED` — não existe com esse nome; ver `ACCESS_DENIED` e
  `UNIT_SCOPE_DENIED` na tabela acima.
- `entity_type = 'authorization'` — não é usado. Os eventos de autorização
  entram como `entity_type = 'security_event'`.

#### 2.2.1 O evento `LOGIN` (passou a existir em 2026-10-29)

**Lacuna que isto fecha.** Até esta data a trilha registrava apenas **falhas**
de autenticação (`AUTH_FAILED`) e **nenhum acesso bem-sucedido**: o evento
`LOGIN` era previsto por este documento, mas nenhum ponto do backend o gravava.
Em paralelo, a coluna `users.last_login_at` existia desde a migração `0001`, era
**lida** pela gestão de usuários (`user_admin_service.user_summary` e a
allowlist de ordenação `sort=last_login_at`) e nunca era escrita — em produção
estava `NULL` para todos os usuários e a coluna "Último acesso" da tela de
usuários mostrava "Nunca" para todo mundo. Consequência prática: era impossível
responder "quando esta conta foi usada?" a partir de `audit_logs`.

**Quem grava e quando.** `require_auth`
(`backend/app/auth/supabase_auth.py`) chama `_record_login_best_effort`
**depois de todas as negações** (usuário excluído, inativo, sessão anterior a
`sessions_revoked_at`, token inválido, `sub` sem usuário correspondente) e
antes de popular `flask.g`. Um acesso negado, portanto, nunca gera `LOGIN` —
gera `AUTH_FAILED`.

**Semântica: "último LOGIN", não "última atividade".** O instante gravado é
`min` dos `timestamp` do claim `amr` do JWT, ou seja o **início do primeiro
fator de autenticação da sessão** (o mesmo parser
`_strict_amr_timestamps` já usado pela defesa de sessões revogadas). Esse valor
é preservado nos refreshes do access token, logo toda requisição da mesma
sessão calcula o mesmo instante. Quando o `amr` falta, vem malformado ou traz
um instante fora dos limites de sanidade, cai em `now()` com janela mínima de
15 minutos (`FALLBACK_MIN_INTERVAL_SECONDS`) e a semântica degrada para
"primeiro acesso visto na janela". Nenhum valor é gravado cru do token.

**Uma linha por sessão, não por requisição.** O `UPDATE` é condicional
(`WHERE id = :uid AND (last_login_at IS NULL OR last_login_at < :corte)`); a
linha `LOGIN` só é inserida quando `rowcount > 0`, na **mesma transação**. O
dedupe é consequência do próprio `UPDATE` — a segunda requisição da sessão
afeta 0 linhas e não audita nada. Também não há retrocesso: um token de sessão
mais antiga não sobrescreve um login mais recente.

**Conteúdo da linha.** `entity_type = 'auth'`, `operation = 'LOGIN'`,
`entity_id = <users.id>`, `actor_user_id = <users.id>`, `result = 'SUCESSO'`,
`previous_values = null` e `new_values = {"aal": "aal1"|"aal2"}` — apenas o
nível de garantia da sessão. Nunca token, claim bruto, e-mail ou IP (a chave
`aal` está na allowlist `CHANGE_KEYS` de
`backend/app/services/admin_audit_service.py`, por isso aparece na API de
auditoria).

**Falha nunca derruba a autenticação.** O registro é melhor-esforço: qualquer
exceção é apenas logada (só a classe do erro) e a requisição segue.

**Sem alteração de esquema.** Nenhuma migração Alembic foi criada: a coluna
`users.last_login_at timestamptz NULL` já existia em
`backend/migrations/sql/0001_initial_schema.sql:73` (modelo em
`backend/app/models/rbac.py:51`) e `audit_logs` não mudou. Logo não há espelho
`.sql` novo, não há `alembic downgrade` a executar e não há `pg_dump` de
backup associado a esta mudança — reverter é reverter código. O `UPDATE` toca
somente `last_login_at` e **não** incrementa `users.version` (um login não pode
provocar 409 no formulário que um ADM tenha aberto); como efeito do
`TimestampMixin`, `users.updated_at` é renovado.

**Regressão:** `backend/tests/test_last_login_tracking.py`.

#### 2.2.2 Decisão: sem backfill de `auth.users.last_sign_in_at`

Os logins anteriores a 2026-10-29 **não foram importados** do Supabase Auth, e
essa decisão é deliberada. Apuração feita no ambiente de produção na mesma
data: para os dois usuários `@agu.gov.br` existentes, o intervalo entre o
evento `INVITE_CREATED` e o `auth.users.last_sign_in_at` correspondente era de
**3,9 s** e **4,1 s**, sem nenhum refresh de sessão posterior. Esse é o padrão
já documentado do **scanner de antivírus de e-mail corporativo** que abre o
link do convite segundos após o envio (incidente em
`docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md` e
`docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`).

Ou seja: aqueles timestamps **não representam acesso de pessoa alguma**.
Copiá-los para `users.last_login_at` criaria um dado falso numa coluna que
existe justamente para detectar uso indevido de conta. Usuários já existentes
seguem com `last_login_at = NULL` ("Nunca" na tela) até o primeiro login real
pós-implantação.

### 2.3 O que **não** é individualmente auditado

- Leituras simples (`SELECT`) bem-sucedidas de listagens/relatórios não geram
  uma linha por leitura — o volume tornaria a tabela inviável e a LGPD não
  exige granularidade de leitura para esse perfil de dado. Exceção: exportações
  (`export_jobs`) são auditadas como evento de criação de solicitação, porque
  representam extração de dados do sistema, não apenas visualização.
- Operações internas de infraestrutura sem efeito sobre dado de negócio (ex.:
  *health check*).

## 3. Caráter append-only

`audit_logs` é projetada para ser **somente-inserção**:

- A role de aplicação usada pelo Flask para gravar em `audit_logs` deve ter
  privilégio de `INSERT` e `SELECT`, **sem** `UPDATE` nem `DELETE` concedidos a
  nível de banco (revogação explícita de privilégio na migração, não apenas
  convenção de código).
- **Já implementado no banco** (migração Alembic
  `0004_db_security_hardening`, espelho
  `backend/migrations/sql/0006_db_security_hardening.sql`): a função
  `public.sispat_block_mutation()` e os gatilhos
  `trg_audit_logs_block_update_delete` (`BEFORE UPDATE OR DELETE`, por linha) e
  `trg_audit_logs_block_truncate` (`BEFORE TRUNCATE`, por comando) lançam
  exceção `42501` — a tabela fica blindada mesmo contra uma conexão com
  privilégio elevado usada incorretamente. A mesma função protege `assets`,
  `asset_movements` e `raw_import_records` contra `DELETE` físico.
- Nenhuma rotina do sistema deve "corrigir" uma entrada de auditoria já
  gravada — se um registro de auditoria estiver errado (ex.: bug no serializador
  de `previous_values`), a correção é uma nova entrada explicativa, nunca uma
  edição da entrada original.

## 4. Conteúdo de `previous_values` / `new_values`

- Formato: `jsonb`, contendo apenas os campos que efetivamente mudaram em um
  `UPDATE` (diff), ou o estado relevante completo em `CREATE`/`DELETE`.
- **Nunca** incluir campos de credencial (hash de senha, tokens, segredos de
  integração) em `previous_values`/`new_values`, mesmo que a entidade auditada
  tecnicamente os possua — esses campos são explicitamente filtrados antes da
  serialização, em todo serializador de auditoria, independentemente de qual
  entidade está sendo registrada.
- Valores de `responsible_people` e `users` (nome, e-mail, identificador
  institucional) podem aparecer em `previous_values`/`new_values` porque são o
  próprio objeto da alteração sendo auditada — isso é tratado na seção 6 como
  dado pessoal sob LGPD, não como motivo para omitir a auditoria (o princípio
  de responsabilização prevalece sobre a minimização nesse ponto específico:
  auditar uma alteração de dado pessoal é, em si, parte da proteção desse
  dado).

## 5. Proteção de dados sensíveis em `audit_logs`

1. **Nunca auditar credenciais.** Nenhuma senha, hash, token de sessão,
   chave de API ou segredo de integração (ex.: credencial da Google Sheets
   API) é gravado em `audit_logs`, em nenhuma circunstância, em nenhum campo.
2. **Minimização em eventos de autenticação.** Entradas `AUTH_FAILED` (o nome
   real do evento de falha — ver seção 2.2) não registram a senha nem o token
   apresentado: apenas `details.reason` (ex.: `inactive_user`,
   `session_revoked`, `invalid_sub`), o ator quando já identificado, e os
   metadados de requisição montados por `build_security_event` (método, rota,
   `request_id` e `request.remote_addr` — ou seja, o IP de origem **está** em
   `new_values` dos eventos de segurança; ver a pendência da seção 6.1).
   Entradas `LOGIN` (sucesso) carregam somente `{"aal": ...}` em `new_values`,
   sem IP.
3. **`request_id` em vez de payload de requisição completo.** `audit_logs`
   guarda um identificador de correlação (`request_id`), não o corpo integral
   da requisição HTTP — evita duplicar, em um segundo lugar, dados sensíveis
   que já estão em `previous_values`/`new_values` de forma controlada, e evita
   vazar cabeçalhos (ex.: `Authorization`) para a tabela de auditoria.
4. **Acesso a `audit_logs` é ele próprio controlado.** Apenas usuários com a
   permissão `audit.read` (ver `docs/permissions/matriz-permissoes.md`) podem
   consultar auditoria, e o escopo de unidade se aplica também aqui — um ADM
   não visualiza, por padrão, auditoria de unidades fora do seu próprio
   escopo. Consultar `audit_logs` é, em si, um evento sensível e deve estar
   coberto pela mesma rigidez de autorização aplicada aos dados que ele
   descreve.
5. **RH e dados pessoais em auditoria.** O perfil `RH` não recebe `audit.read`
   (ver matriz de permissões) — reforça o princípio de que RH não acessa dados
   pessoais fora da finalidade estrita de vinculação patrimonial; auditoria é
   uma visão transversal de todo o sistema, incompatível com esse escopo
   restrito.

## 6. LGPD

### 6.1 Natureza do tratamento

`audit_logs` realiza tratamento de dados pessoais (nome, e-mail de usuários e
de pessoas responsáveis; endereço de IP/`request_id`, se este vier a
incorporar IP de origem — **pendente de validação institucional** se
`request_id` deve ou não incluir IP) sob as seguintes bases legais
potencialmente aplicáveis (a confirmar com a área jurídica da AGU —
**pendente de validação institucional**):

- **Cumprimento de obrigação legal/regulatória** (art. 7º, II da LGPD) — a
  rastreabilidade de atos sobre patrimônio público é, em muitos contextos de
  administração pública, uma exigência de controle e prestação de contas.
- **Interesse legítimo do controlador** (art. 7º, IX) para fins de segurança
  da informação e prevenção a fraude/uso indevido, observado o teste de
  proporcionalidade.

### 6.2 Minimização

- `audit_logs` grava apenas os campos necessários para reconstituir a
  alteração realizada, não o registro completo de uma entidade quando apenas
  parte dela mudou (ver seção 4).
- Dados pessoais de terceiros (ex.: `responsible_people.email`) só aparecem em
  `audit_logs` quando a própria operação auditada os envolve diretamente —
  nunca como efeito colateral de uma auditoria mais ampla (ex.: uma alteração
  em `units` não deveria arrastar dados de `responsible_people` para o
  `previous_values`/`new_values` daquela entrada).

### 6.3 Retenção

**Pendente de validação institucional** o prazo final de retenção de
`audit_logs`, que deve ser definido com base em norma de guarda documental
aplicável à administração pública federal (prazos de prescrição
administrativa, tribunal de contas, etc.) e não apenas em critério técnico.
Proposta de trabalho para a Fase 1, a ser validada:

- Retenção mínima proposta: **5 (cinco) anos**, alinhada a prazos comuns de
  prescrição administrativa no serviço público federal — valor de partida, não
  definitivo.
- Mecanismo técnico: nenhum expurgo automático é implementado nesta fase;
  `occurred_at` já está indexado (`modelo-logico.md`, seção 15) para suportar,
  no futuro, uma rotina de arquivamento/expurgo por período sem necessidade de
  nova migração.
- Quando o prazo for definido institucionalmente, a rotina de retenção deve
  **arquivar** (exportar para armazenamento frio) em vez de simplesmente
  excluir, preservando a possibilidade de reconstituição histórica em caso de
  auditoria externa (TCU, CGU, Judiciário).

### 6.4 Direitos do titular

- Dados pessoais que aparecem em `audit_logs` (de `users` e de
  `responsible_people`) estão sujeitos aos direitos de titular previstos na
  LGPD (confirmação, acesso, correção), mas a **correção** de um dado pessoal
  em `audit_logs` nunca é uma edição da entrada histórica (incompatível com o
  caráter append-only, seção 3) — é feita corrigindo a entidade de origem
  (`users`/`responsible_people`), o que por si gera uma nova entrada de
  auditoria documentando a correção. A entrada antiga permanece como registro
  histórico fiel do que estava correto/incorreto *naquele momento*.
- Pedido de eliminação de dado pessoal (quando aplicável) é tensionado com a
  obrigação de guarda de auditoria de bem público — **pendente de validação
  institucional** como esse conflito é resolvido (ex.: anonimização do nome em
  `audit_logs` após desligamento da pessoa responsável, mantendo o rastro da
  operação sem o dado identificável, quando legalmente permitido).
- **Acesso do titular ao próprio histórico de login.** `GET /api/v1/me`
  devolve `last_login_at` ao próprio usuário (art. 18, II) — ver
  `backend/app/api/v1/me.py`. A exclusão de conta
  (`backend/app/services/user_deletion_service.py`) zera `users.last_login_at`
  junto com a anonimização, porque numa linha anonimizada ele seria um dado
  comportamental re-identificável; a trilha append-only de `audit_logs` não é
  tocada.

#### 6.4.1 Pendência em aberto: o titular não vê o acesso penúltimo

**Não implementado.** Como a gravação acontece no **primeiro acesso da
sessão** (seção 2.2.1), `GET /api/v1/me` mostra o início da **sessão atual** e
o valor anterior é sobrescrito. Ou seja: o titular nunca vê o acesso
**penúltimo**, que é exatamente o mais útil para perceber que alguém usou a
conta ("eu não entrei ontem às 03h"). Hoje o dado existe — as linhas `LOGIN`
em `audit_logs` preservam o histórico — mas só é alcançável por quem tem
`audit.read` (ADM), não pelo próprio titular.

Opções levantadas, nenhuma escolhida ainda:

1. Expor ao titular **as linhas `LOGIN` dele próprio** (filtro
   `actor_user_id = usuário do JWT`, `entity_type = 'auth'`), sem exigir
   `audit.read` e sem revelar auditoria de terceiros. Não precisa de migração.
2. Criar uma coluna `users.previous_login_at`, deslocando o valor antigo no
   mesmo `UPDATE` condicional. **Exigiria migração Alembic + espelho `.sql`**
   e, por isso, autorização explícita.

A decisão fica para quando houver mais de um usuário ativo em produção.

## 7. Resumo dos pontos pendentes de validação institucional

1. Se `request_id` deve incorporar endereço IP de origem da requisição
   (situação atual: o `request_id` não contém IP, mas os eventos de
   `entity_type = 'security_event'` gravam `request.ip` em `new_values` —
   seção 5, item 2).
2. Base legal (LGPD) definitiva para o tratamento realizado por `audit_logs`,
   a ser confirmada pela área jurídica da AGU.
3. Prazo final de retenção de `audit_logs` (proposta de trabalho: 5 anos).
4. Procedimento de conciliação entre pedido de eliminação de dado pessoal e a
   obrigação de guarda de auditoria patrimonial (ex.: anonimização retroativa).
5. Como dar ao titular acesso ao **penúltimo** login (seção 6.4.1): expor as
   próprias linhas `LOGIN` ou criar `users.previous_login_at` (esta segunda
   opção depende de migração autorizada).
