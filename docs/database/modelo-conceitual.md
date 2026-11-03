# Modelo Conceitual — SISPAT-AGU

> Fase 1 — Banco de dados e permissionamento. Este documento descreve as entidades do
> domínio e seus relacionamentos em nível conceitual, sem detalhes de tipo de coluna,
> índice ou constraint (ver `modelo-logico.md` para o detalhamento físico e `der.md`
> para o diagrama entidade-relacionamento).
>
> **Atualizado em 2026-10-29** com os conceitos introduzidos pelas migrações `0012`
> a `0019` (head `0019_user_soft_delete`): vínculo do bem, classificação do bem,
> preferência de painéis do dashboard e exclusão lógica/anonimização de usuário.

## 1. Visão geral do domínio

O SISPAT-AGU controla o patrimônio da unidade AGU/Palmas-TO: bens (`assets`), sua
localização física (unidades, salas, locais), seus responsáveis, sua movimentação ao
longo do tempo, os ciclos de inventário/conferência, a sincronização com a planilha
Google Sheets que hoje é a fonte de dados legada, e o controle de acesso (usuários,
perfis e permissões) que o Flask aplica em toda operação.

O domínio conceitual se organiza em cinco blocos:

1. **Identidade e acesso** — quem pode usar o sistema e o que pode fazer.
2. **Estrutura organizacional e física** — onde os bens existem (unidades, salas,
   locais) e quem responde por eles (pessoas responsáveis).
3. **Patrimônio e seu ciclo de vida** — o bem em si, suas movimentações e sua
   conferência em inventários.
4. **Auditoria** — rastro de todas as alterações relevantes.
5. **Integração e operação** — sincronização com a planilha de origem, filtros
   salvos e exportações.

## 2. Entidades por bloco

### 2.1 Identidade e acesso

- **Usuário** — pessoa autenticada no sistema (servidor da AGU com acesso operacional).
- **Perfil (role)** — papel atribuído a um usuário (ADM, USER, RH).
- **Permissão (permission)** — capacidade atômica do sistema (ex.: ler bens, aprovar
  movimentação, gerenciar usuários).
- **Perfil-Permissão** — associação entre um perfil e as permissões que ele concede.
- **Usuário-Perfil** — associação entre um usuário e os perfis que ele acumula (um
  usuário pode ter mais de um perfil).
- **Acesso de usuário a unidade** — escopo que restringe um usuário a operar sobre
  determinadas unidades organizacionais, independentemente do seu perfil.
- **Preferência de aparência do usuário** — densidade, escala de fonte e escolha de
  gráficos do dashboard, por usuário (migrações `0005`, `0011` e `0013`).
- **Preferência de painéis do dashboard** — quais painéis o usuário vê, em que ordem
  e em que tamanho (migração `0017`). A ausência de preferência significa "layout
  padrão do perfil", resolvido na leitura; o catálogo de painéis e quem pode ver
  cada um são decididos **no backend**, nunca pelo cliente.

### 2.2 Estrutura organizacional e física

- **Unidade (unit)** — unidade organizacional da AGU (ex.: AGU/Palmas-TO), com um
  código curto e um identificador completo distintos entre si.
- **Sala (room)** — ambiente físico dentro de uma unidade.
- **Local (location)** — subdivisão opcional dentro de uma sala (ou diretamente na
  unidade, quando a sala não é conhecida), usada para localizar um bem com mais
  precisão.
- **Pessoa responsável (responsible person)** — pessoa física vinculada a uma
  unidade que responde patrimonialmente por um ou mais bens. Não é necessariamente
  um usuário do sistema.

### 2.3 Patrimônio e ciclo de vida

- **Bem patrimonial (asset)** — entidade central do domínio. Representa um item de
  patrimônio, com número patrimonial, descrição, unidade proprietária, unidade/sala/
  local onde atualmente se encontra, pessoa responsável e situação de localização
  (localizado, não localizado ou desconhecido).
- **Vínculo do bem** — atributo do bem (não uma entidade própria): a situação de
  vínculo trazida pela 1ª coluna `RESPONSAVEL` da planilha (ex.: Servidor,
  Terceirizado, Ocioso), materializada pela migração `0012`. Antes dela o valor só
  existia dentro do registro bruto de importação.
- **Classificação do bem** — também atributos do próprio bem, em duas camadas que
  **coexistem**: a classificação técnica (categoria do bem, tipo de TI e situação
  operacional, migração `0015`) e a classificação de equipamentos (família,
  categoria, grau de confiança, regra que decidiu, versão do conjunto de regras e
  **correção manual do ADM**, migração `0018`). Conceitualmente importante:
  classificação é **derivada** da descrição por regras do backend, carrega sempre a
  marca de quem/como decidiu e admite correção manual que vence a regra
  automática; "não classificado" é um estado legítimo e distinto de qualquer
  categoria. Ver `docs/architecture/classificacao-patrimonial.md`.
- **Movimentação de bem (asset movement)** — registro de uma mudança de unidade,
  sala e/ou responsável de um bem, com fluxo de solicitação e aprovação.
- **Inventário (inventory)** — campanha de conferência física de bens de uma
  unidade, com período de execução e situação.
- **Item de inventário (inventory item)** — a conferência de um bem específico
  dentro de um inventário: se foi encontrado, onde foi observado, por quem e quando.

### 2.4 Auditoria

- **Log de auditoria (audit log)** — registro imutável de toda operação relevante
  sobre qualquer entidade do sistema (quem fez, o quê, quando, valores antes/depois,
  resultado).

### 2.5 Integração e operação

- **Job de sincronização (sync job)** — execução de uma rotina de importação a
  partir do Google Sheets, com contagem de registros lidos, criados, atualizados e
  com falha.
- **Registro bruto de importação (raw import record)** — a linha original da
  planilha, preservada integralmente, associada a uma execução de sincronização,
  junto com sua versão normalizada e eventuais erros de validação.
- **Conflito de sincronização (sync conflict)** — divergência detectada entre o
  valor vindo da origem (Sheets) e o valor atual no banco para o mesmo bem,
  pendente de resolução.
- **Filtro salvo (saved filter)** — critério de busca/visualização de bens salvo
  por um usuário para reutilização.
- **Job de exportação (export job)** — solicitação de exportação de dados de bens
  em um formato de arquivo, com os filtros e colunas escolhidos.

## 3. Relacionamentos conceituais

| Relacionamento | Cardinalidade | Observação |
|---|---|---|
| Usuário — Perfil | N:N (via Usuário-Perfil) | um usuário pode acumular múltiplos perfis; um perfil é compartilhado por muitos usuários |
| Perfil — Permissão | N:N (via Perfil-Permissão) | cada perfil concede um conjunto de permissões |
| Usuário — Unidade (acesso) | N:N (via Acesso de usuário a unidade) | escopo de atuação do usuário, independente do perfil |
| Unidade — Sala | 1:N | uma unidade possui várias salas |
| Unidade — Local | 1:N | uma unidade possui vários locais |
| Sala — Local | 1:N (opcional) | um local pode ou não pertencer a uma sala específica |
| Unidade — Pessoa responsável | 1:N | uma pessoa responsável está vinculada a uma unidade |
| Bem — Unidade (atual) | N:1 | onde o bem está hoje |
| Bem — Unidade (proprietária) | N:1 | a quem o bem pertence patrimonialmente |
| Bem — Sala / Local | N:1 (opcionais) | localização física fina, quando conhecida |
| Bem — Pessoa responsável | N:1 (opcional) | quem responde pelo bem |
| Bem — Usuário (atribuído) | N:1 (opcional) | usuário do sistema vinculado operacionalmente ao bem, quando aplicável — distinto da pessoa responsável patrimonial |
| Bem — Movimentação | 1:N | histórico de movimentações de um bem |
| Movimentação — Unidade/Sala (origem e destino) | N:1 cada | contexto da movimentação |
| Movimentação — Pessoa responsável (anterior e nova) | N:1 cada | troca de responsabilidade |
| Movimentação — Usuário (solicitante e aprovador) | N:1 cada | fluxo de aprovação |
| Inventário — Unidade | N:1 | um inventário é conduzido em uma unidade |
| Inventário — Item de inventário | 1:N | os bens conferidos dentro de um inventário |
| Item de inventário — Bem | N:1 | o bem sendo conferido |
| Item de inventário — Local (observado) | N:1 (opcional) | onde o bem foi efetivamente encontrado |
| Qualquer entidade — Log de auditoria | 1:N (referência lógica, não FK física) | toda alteração relevante gera um registro de auditoria |
| Job de sincronização — Registro bruto de importação | 1:N | cada execução processa várias linhas da planilha |
| Bem — Conflito de sincronização | 1:N (opcional) | um bem pode acumular conflitos pendentes de resolução |
| Usuário — Filtro salvo | 1:N | um usuário pode salvar vários filtros |
| Usuário — Job de exportação | 1:N | um usuário solicita exportações |
| Usuário — Preferência de aparência | 1:0..1 | no máximo uma por usuário; sem registro = padrão do sistema |
| Usuário — Preferência de painéis | 1:0..1 | no máximo uma por usuário; sem registro = layout padrão do perfil |
| Usuário (ADM) — Usuário excluído | N:1 (opcional) | quem executou a exclusão lógica da conta (`deleted_by`); vira "desconhecido" se a conta do próprio ADM for excluída depois |

## 4. Observações conceituais importantes

- **Pessoa responsável ≠ Usuário do sistema.** A pessoa que responde por um bem
  patrimonialmente pode nunca ter acessado o SISPAT-AGU. Os dois conceitos são
  modelados como entidades distintas e não devem ser fundidos.
- **Unidade atual ≠ Unidade proprietária.** Um bem pode estar fisicamente em uma
  unidade diferente daquela a que patrimonialmente pertence (comodato, cessão,
  trânsito), por isso o modelo mantém as duas referências separadas desde a
  concepção.
- **Código curto ≠ identificador completo da unidade.** A existência de um código
  curto (ex.: `UEA`) e de um identificador completo (ex.: `023404`) para a mesma
  unidade não deve ser tratada como uma simples abreviação — os dois valores são
  preservados sem presumir uma regra de derivação entre eles. **Correção de
  2026-10-29:** no esquema implantado isso **não** é um segundo atributo de
  `units` (não existe `units.full_identifier`). O identificador numérico fica em
  `units.code` (o seed da migração `0007_unit_aliases` usa `023401`..`023404`) e a
  sigla curta da planilha fica em `unit_aliases.alias` (`PF`, `PU`, `CJU`, `UEA`),
  com unicidade **case-insensitive**. Ver `modelo-logico.md`, seção 0.6.
- **Localização pode ser desconhecida.** O domínio reconhece explicitamente um
  terceiro estado para a localização de um bem, além de "localizado" e "não
  localizado": "desconhecido" — relevante para o acervo legado migrado da planilha,
  cuja completude de dados não é garantida.
- **A sincronização nesta fase é unidirecional** (Google Sheets → Flask →
  PostgreSQL). O modelo já prevê as entidades de conflito e job de sincronização
  para suportar, em fase futura, uma sincronização bidirecional controlada (ver
  `docs/architecture/estrategia-sincronizacao.md`).
- **Nenhuma exclusão física de patrimônio.** A entidade Bem nunca é removida
  fisicamente; toda remoção é lógica, preservando o histórico para auditoria.
- **Exclusão de Usuário também é lógica — e vem com anonimização** (migração
  `0019`). A linha do usuário **precisa** continuar existindo para que a trilha de
  auditoria permaneça íntegra (o ator de cada registro é preservado) e porque o
  histórico de movimentações, inventários, pré-visualizações de importação e
  convites referencia o usuário. Em troca, os dados pessoais (nome, e-mail,
  telefone, foto, vínculo com o provedor de autenticação e último login) são
  apagados **irreversivelmente** no mesmo ato, e só o instante da exclusão, o ADM
  que a executou e o instante da anonimização ficam registrados. Nenhuma cópia do
  dado pessoal removido é guardada — nem na auditoria, que recebe apenas o e-mail
  mascarado. Conceitualmente: "usuário excluído" é um usuário **sem identidade**,
  não um usuário ausente.
- **A chave de busca do número patrimonial é derivada, não armazenada.** O domínio
  precisa casar `AGU-123` com `AGU123` ou `12.345` com `12345`; isso é obtido
  normalizando o valor (minúsculas, sem acento, sem pontuação) **no momento da
  consulta** (migrações `0014` e `0016`). Não existe um "número normalizado" como
  atributo do Bem — o número patrimonial original é preservado exatamente como veio
  da fonte, e nenhuma normalização pode sobrescrevê-lo.
