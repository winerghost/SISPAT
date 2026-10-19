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
- ADM: switch "Incluir excluídos" (`include_deleted=true`). USER/RH nunca enviam o
  parâmetro (o backend responde 403 se enviado). Excluídos ganham selo com ícone
  + texto "Excluído".
- Ordenação só pela allowlist (`patrimony_number`, `description`, `updated_at`;
  `aria-sort` + botão), paginação "Página X de Y · N bem(ns)" (25 por página),
  estados carregando (skeleton), vazio (com e sem filtro) e erro com "Tentar
  novamente". Falha só dos seletores de apoio avisa e mantém a lista.
- Responsivo 320–1920 sem rolagem da página: colunas priorizadas por largura
  (até `md`: Patrimônio + Descrição com resumo de unidade e situação + Detalhes;
  `md`: + Unidade e Localizado; `lg`: + Sala e Responsável; `xl`: + Atualizado em).
  Colunas opcionais só existem se a chave veio no JSON.
- **Número patrimonial é TEXTO** (fonte mono, `translate="no"`): nunca passa por
  `Number`/formatação, zeros à esquerda preservados. Datas/horas em
  America/Araguaina; a data de registro (AAAA-MM-DD) é data de calendário e não
  sofre conversão de fuso. Nenhum número é animado; o total vem do backend.

## Detalhe e histórico (painel lateral)
- `GET /assets/<id>` (linha da lista como esboço). Abas "Dados" e "Histórico".
- Campos ausentes não são renderizados: RH não recebe `notes`, então não há campo
  "Observações". Telefone e e-mail de pessoas não aparecem nesta tela.
- Histórico (`GET /assets/<id>/history`, 10 por página): operação em português,
  data, ator (só o final do identificador), "Campo: antes → depois" como TEXTO
  escapado pelo React (`notes` nunca mostra conteúdo). O contrato permite o
  histórico a quem lê o bem (inclusive RH); 403/404 viram mensagem fixa.
- Ações: Editar (ADM/USER, bem não excluído), Excluir (ADM) e Restaurar (ADM, bem
  excluído). Não existe exclusão física nem botão para ela.

## Criar e editar
- Diálogo claro (padrão dos cadastros): foco preso, Esc fecha, não fecha durante a
  requisição; sucesso (toast + fechar + recarregar) só depois da resposta.
- Campos por perfil (lista provisória do contrato, validada só no backend):
  USER = descrição, observações, sala, responsável, data de registro (e remover o
  local atual); ADM = isso + número patrimonial (na edição), unidade proprietária
  e "Localizado". A unidade é escolhida só na criação (lista só unidades ativas);
  na edição é leitura. Para USER o número aparece como leitura na edição.
- Edição envia **só os campos alterados + `version`**; sem alteração o botão fica
  desativado. `null` limpa opcionais. O local (`location_id`) não tem endpoint de
  listagem: a edição só permite mantê-lo ou removê-lo (checkbox).
- Sala/responsável vêm de `GET /rooms` e `GET /responsible-people` da unidade do
  bem (só ativos) + o vínculo atual, mesmo se inativo.

## Excluir / restaurar (lógico, só ADM)
`ConfirmActionDialog` explica: exclusão LÓGICA (registro, histórico e auditoria
preservados), o bem some da lista e da busca (ADM o vê com "Incluir excluídos"), o
número fica livre enquanto excluído e a restauração é recusada se o número foi
reutilizado. Motivo opcional (≤500) vai para a auditoria. Envia `{version, reason}`.

## Erros (texto fixo, nunca o do backend)
409 `version_conflict` (recarrega o registro, avisa e reinicia o formulário com a
nova `version`), 409 `conflict` (número duplicado), `link_unit_mismatch`,
`link_inactive`, `unit_inactive`, 404 uniforme ("não encontrado, ou fora do seu
escopo de unidades"), 403, 400, 429, 401, AAL2 requerido e rede.

## Acessibilidade e motion
- WCAG 2.2 AA (axe 1366 e 375 px) e matriz 320–1920 px nas telas `patrimonios-*`
  de `frontend/e2e/support/screens.ts` (lista por perfil, excluídos, vazio, erro,
  detalhe ADM/RH, histórico, novo USER/ADM, editar USER/ADM, excluir, restaurar).
- Situação e "Localizado" com ícone + texto (nunca só cor); no diálogo claro, texto
  escuro + ícone. Tabela, painel e diálogos animam só via `@/components/animations`
  e `@/lib/motion/tokens` (150–200 ms), respeitando `prefers-reduced-motion`.

## Testes
`frontend/e2e/assets-functional.spec.ts` (43 casos) com o mock
`frontend/e2e/support/asset-mocks.ts`, que imita escopo, `version`, campos por
perfil, `include_deleted` só ADM, unicidade sem distinguir caixa, vínculos e
exclusão lógica. Nenhum dado é real.

## Lacunas conhecidas (backend)
- Não há endpoint de listagem de **locais** (`locations`): criar não permite
  escolher local e editar só permite remover.
- Seletores de sala/responsável limitados a 100 itens por unidade (`page_size` máx.).
- Lista de campos editáveis por perfil ainda provisória (validação institucional).
- Sem índice único no banco para o número patrimonial (apenas lock + verificação).
- Contrato desenvolvido contra mocks; confirmar com o backend real publicado.
