# UX — Patrimônios (`/patrimonios`)

Tela real de bens patrimoniais (onda 2 do frontend). Contrato da API:
`docs/architecture/assets-api.md`. Código: `frontend/src/components/features/assets/`
(`patrimonios-page.tsx` + tabela, filtros, painel de detalhe, formulário, exclusão
lógica e histórico) e cliente `frontend/src/lib/assets-api.ts`. O frontend é só
apresentação: perfil, escopo de unidade, AAL2, unicidade do número, vínculos e
concorrência (`version`) são decididos pelo backend. Esconder botões por perfil é
UX, nunca segurança.

## Lista
- Cabeçalho (eyebrow "Patrimônio", h1), botão "Novo bem" (ADM e USER; RH não vê).
- Busca por patrimônio/descrição com debounce de 300 ms (≤100 caracteres), filtros
  de unidade (`GET /units/accessible`), sala (`GET /rooms?unit_id=`), responsável
  (`GET /responsible-people?unit_id=`) e "Localizado" (SIM/NAO/DESCONHECIDO).
  Sala e responsável ficam desativados até escolher a unidade (evita listas
  truncadas em 100 itens e respeita o vínculo à unidade). "Limpar filtros".
- **Parâmetros lidos da URL** (`use-asset-filters.ts`): `?busca=` (vem da busca
  global do Header, normalizada para ≤100 caracteres — ver `MENU_MODULOS.md`) e
  `?page=` (valor inválido → 1; página além da última é ajustada). Os demais
  filtros ficam só no estado da tela. Uma nova busca global com a lista já aberta
  sincroniza o campo e aplica na hora.
- **Vínculo** (`bond_status`, 1ª coluna RESPONSAVEL da planilha: "Servidor",
  "Terceirizado", "Ocioso"...): somente leitura (vem da importação; não existe no
  formulário de criar/editar). Filtro "Vínculo" com "Todos", "Sem vínculo"
  (`bond_status=__none__`) e as opções de `GET /assets/bond-statuses` no formato
  "Ocioso (12)" (contagem do backend, escopo do usuário); escolher envia
  `bond_status=<valor>` (o backend compara sem distinguir caixa). Resposta de
  opções fora do formato (texto >100, contagem não inteira/negativa, >200 itens)
  é rejeitada em `assets-api.ts`. Se o endpoint falhar, o filtro fica desativado
  com aviso e a lista continua. Como os demais filtros, fica só no estado da
  tela (não vai para a URL).
- ADM: switch "Incluir excluídos" (`include_deleted=true`). USER/RH nunca enviam o
  parâmetro (o backend responde 403 se enviado). Excluídos ganham selo com ícone
  + texto "Excluído".
- Ordenação só pela allowlist (`patrimony_number`, `description`, `bond_status`
  — cabeçalho "Vínculo", visível a partir de `lg` —, `updated_at`;
  `aria-sort` + botão), paginação pela `PaginationBar` comum ("Exibindo X–Y de
  N bem(ns) · Página n de m", seletor 50/100/200, padrão 50),
  estados carregando (skeleton), vazio (com e sem filtro) e erro com "Tentar
  novamente". Falha só dos seletores de apoio avisa e mantém a lista.
- Responsivo 320–1920 sem rolagem da página: colunas priorizadas por largura
  (até `md`: Patrimônio + Descrição com resumo de unidade e situação + Detalhes;
  `md`: + Unidade e Localizado; `lg`: + Sala, Responsável e Vínculo; `xl`: +
  Atualizado em). Abaixo de `lg` o vínculo aparece no resumo da descrição
  ("Vínculo: Ocioso"). Vínculo vazio = "—" visual + texto acessível "sem vínculo".
  O vínculo é texto importado não confiável: só texto escapado pelo React.
  Colunas opcionais só existem se a chave veio no JSON.
- **Número patrimonial é TEXTO** (fonte mono, `translate="no"`): nunca passa por
  `Number`/formatação, zeros à esquerda preservados. Datas/horas em
  America/Araguaina; a data de registro (AAAA-MM-DD) é data de calendário e não
  sofre conversão de fuso. Nenhum número é animado; o total vem do backend.

## Classificação técnica (categoria, tipo de TI, situação operacional)
Três campos opcionais, editáveis por ADM e USER no formulário e exibidos no
cartão "Classificação técnica" do detalhe. Rótulos em
`features/assets/asset-labels.ts`:

| Campo | Valores |
|---|---|
| `asset_category` | Tecnologia, Mobiliário, Veículo, Equipamento, Outros |
| `tech_type` | Computador, Notebook, Monitor, Impressora, Outro item de TI |
| `operational_status` | Em uso, Em estoque, Em manutenção, Baixado |

Ausente ou desconhecido aparece como **"Não informado"** (nunca um padrão
inventado). A consistência "tipo de TI só vale para a categoria Tecnologia" é
decidida pelo backend; a tela explica com texto fixo: "O tipo de TI só vale para
a categoria Tecnologia. Ajuste a categoria ou deixe o tipo como 'Não
informado'." A correção em massa pela regra automática fica em
`/dashboard/classificacao` (`docs/ux/DASHBOARD.md`).

## Detalhe e histórico (painel lateral)
- `GET /assets/<id>` (linha da lista como esboço; sem esboço, esqueleto). Abas
  "Dados" e "Histórico".
- Cabeçalho: eyebrow "PATRIMÔNIO", número em Geist Mono grande (texto, nunca
  convertido) e selos com ícone + texto. Corpo em cartões (borda `ash-stroke`,
  sem sombra): Identificação, Localização e responsável, Classificação técnica,
  Vínculo, Registro e Observações.
- Ações numa **barra fixa no rodapé do painel**: "Editar" (ADM/USER) como ação
  primária; "Excluir" e "Restaurar" (só ADM) em `outline`, separadas.
- Campos ausentes não são renderizados: RH não recebe `notes`, então não há campo
  "Observações". Telefone e e-mail de pessoas não aparecem nesta tela.
- Histórico (`GET /assets/<id>/history`, mesma `PaginationBar`, 50/100/200): operação em português,
  data, ator (só o final do identificador), "Campo: antes → depois" como TEXTO
  escapado pelo React (`notes` nunca mostra conteúdo). O contrato permite o
  histórico a quem lê o bem (inclusive RH); 403/404 viram mensagem fixa.
- Ações: Editar (ADM/USER, bem não excluído), Excluir (ADM) e Restaurar (ADM, bem
  excluído). Não existe exclusão física nem botão para ela.

## Criar e editar
- Diálogo claro (padrão dos cadastros): foco preso, Esc fecha, não fecha durante a
  requisição; sucesso (toast + fechar + recarregar) só depois da resposta.
- **Seções**, na mesma ordem do detalhe (`asset-form-sections.tsx`):
  Identificação, Localização e responsável, Classificação técnica e, só para ADM,
  o subgrupo "Somente administrador". Controles usam as classes "light" (contraste
  correto sobre `bone`).
- Campos por perfil (lista provisória do contrato, validada só no backend):
  USER = descrição, observações, sala, responsável, data de registro,
  classificação técnica (e remover o local atual); ADM = isso + número
  patrimonial (editável), unidade proprietária e "Localizado". A unidade é
  escolhida só na criação (lista só unidades ativas); na edição é leitura. Para
  USER o número aparece como leitura na edição. Limites de tamanho na tela:
  número ≤64, textos ≤2000, motivo ≤500.
- **Campo alterado** ganha um ponto de 6 px (`signal-orange`, voz de estado) +
  texto "alterado" para leitor de tela — nunca só cor. O resumo
  "N campo(s) alterado(s)" fica num `<details>` nativo ("Ver resumo" /
  "Ocultar resumo") listando "Campo: antigo → novo", exatamente os campos que
  irão no `PATCH`.
- **Barra de ações fixa** no rodapé do diálogo, fora da área que rola: estado
  anunciado (`role="status"`/`aria-live`), erro de servidor sempre visível (recebe
  o foco), alvos de 44 px, empilha em 320 px e respeita a `safe-area`. "Salvar"
  sem alterações fica `aria-disabled` (continua focável) e aponta por
  `aria-describedby` para o motivo.
- Sair com alterações pendentes pede confirmação.
- Edição envia **só os campos alterados + `version`**. `null` limpa opcionais.
  O local (`location_id`) não tem endpoint de listagem: a edição só permite
  mantê-lo ou removê-lo (checkbox).
- **Rascunho × servidor**: o rascunho é separado do registro do servidor; a base
  de comparação e a `version` só mudam quando o servidor é recarregado de
  propósito. Um refetch de fundo do painel nunca troca a `version` nem o que foi
  digitado. No `409 version_conflict` o rascunho **não** é perdido: um aviso único
  (`role="alert"`, recebe o foco) lista, campo a campo, "o meu" × "no servidor" e
  oferece duas saídas — "manter as minhas alterações e salvar de novo" (com a
  `version` recarregada) ou "descartar o rascunho e usar os dados do servidor".
- Sala/responsável vêm de `GET /rooms` e `GET /responsible-people` da unidade do
  bem (só ativos) + o vínculo atual, mesmo se inativo, cada um com estado próprio
  de carregando/erro + "Tentar novamente".

## Excluir / restaurar (lógico, só ADM)
`ConfirmActionDialog` explica: exclusão LÓGICA (registro, histórico e auditoria
preservados), o bem some da lista e da busca (ADM o vê com "Incluir excluídos"), o
número fica livre enquanto excluído e a restauração é recusada se o número foi
reutilizado. Motivo opcional (≤500) vai para a auditoria. Envia `{version, reason}`.

## Erros (texto fixo, nunca o do backend)
409 `version_conflict` (relê o registro e avisa; no formulário o rascunho é
mantido e o aviso lista as divergências — ver "Criar e editar"), 409
`conflict` (número duplicado), `link_unit_mismatch`,
`link_inactive`, `unit_inactive`, 404 uniforme ("não encontrado, ou fora do seu
escopo de unidades"), 403, 400, 429, 401, AAL2 requerido e rede.

## Acessibilidade e motion
- WCAG 2.2 AA (axe 1366 e 375 px) e matriz 320–1920 px nas telas `patrimonios-*`
  de `frontend/e2e/support/screens.ts`: `patrimonios-adm`, `-user`, `-rh`,
  `-vazio`, `-erro`, `-sem-escopo`, `-excluidos`, `-vinculo-ocioso`,
  `-vinculo-indisponivel`, `-detalhe`, `-detalhe-rh`, `-detalhe-excluido`,
  `-historico`, `-novo`, `-novo-adm`, `-editar`, `-editar-adm`,
  `-editar-alterado`, `-editar-conflito`, `-editar-confirmar-saida`,
  `-editar-salas-erro`, `-excluir` e `-restaurar`. Não reexecutado nesta data.
- Situação e "Localizado" com ícone + texto (nunca só cor); no diálogo claro, texto
  escuro + ícone. Tabela, painel e diálogos animam só via `@/components/animations`
  e `@/lib/motion/tokens` (150–200 ms), respeitando `prefers-reduced-motion`.

## Testes (não reexecutados nesta data)
Mock comum: `frontend/e2e/support/asset-mocks.ts`, que imita escopo, `version`,
campos por perfil, `include_deleted` só ADM, unicidade sem distinguir caixa,
vínculos, exclusão lógica e `bond_status` (filtro sem caixa, `__none__`, opções
com contagem, falha do endpoint, resposta inválida e vínculo com marcador XSS).
Nenhum dado é real.

| Spec | Cobertura |
|---|---|
| `frontend/e2e/assets-functional.spec.ts` | fluxo completo: lista, filtros, detalhe, histórico, criar/editar, excluir/restaurar |
| `frontend/e2e/assets-states-functional.spec.ts` | busca, paginação e *clamp* de página, estados vazios e "Limpar filtros" |
| `frontend/e2e/assets-classification-functional.spec.ts` | edição manual de categoria, tipo de TI e situação operacional (inclusive a inconsistência tipo × categoria, recusada pelo backend) |
| `frontend/e2e/assets-edit-redesign-functional.spec.ts` | detalhe redesenhado (cabeçalho, cartões, barra fixa) e edição (seções, marca "alterado", resumo, confirmação ao sair, 409 sem perder o rascunho, salas/responsáveis com carregando/erro) |

## Lacunas conhecidas (backend)
- Não há endpoint de listagem de **locais** (`locations`): criar não permite
  escolher local e editar só permite remover.
- Seletores de sala/responsável limitados a 100 itens por unidade (`page_size` máx.).
- Lista de campos editáveis por perfil ainda provisória (validação institucional).
- Sem índice único no banco para o número patrimonial (apenas lock + verificação).
- Contrato desenvolvido contra mocks; confirmar com o backend real publicado.
