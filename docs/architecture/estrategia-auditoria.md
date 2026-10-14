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
depois**, e **com qual resultado** (sucesso, falha, negado). Isso é exigência
tanto de controle patrimonial (bem público) quanto de responsabilização de
acesso a dados pessoais (LGPD).

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

### 2.2 Eventos de segurança (sem entidade de negócio associada)

Além de operações de escrita, `audit_logs` registra eventos de autenticação e
autorização, com `entity_type = 'auth'` ou `'authorization'`:

- `LOGIN` (sucesso) e `LOGIN_FAILED` (falha de credencial).
- `PERMISSION_DENIED`: toda requisição rejeitada por falta de permissão ou por
  violação de escopo de unidade (`result = 'DENIED'`) — essencial para detectar
  tentativas de acesso indevido (`CLAUDE.md`).
- Alterações de sessão relevantes (ex.: revogação de acesso).

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
- Alternativa/complemento: um trigger `BEFORE UPDATE OR DELETE ON audit_logs`
  que sempre lança excessão, blindando a tabela mesmo contra uma conexão com
  privilégio elevado usada incorretamente.
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
2. **Minimização em eventos de autenticação.** Entradas `LOGIN_FAILED` não
   registram a senha tentada (óbvio, mas explicitado), apenas o identificador
   da conta e o resultado.
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

## 7. Resumo dos pontos pendentes de validação institucional

1. Se `request_id` deve incorporar endereço IP de origem da requisição.
2. Base legal (LGPD) definitiva para o tratamento realizado por `audit_logs`,
   a ser confirmada pela área jurídica da AGU.
3. Prazo final de retenção de `audit_logs` (proposta de trabalho: 5 anos).
4. Procedimento de conciliação entre pedido de eliminação de dado pessoal e a
   obrigação de guarda de auditoria patrimonial (ex.: anonimização retroativa).
