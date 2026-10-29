// Rótulos pt-BR dos filtros, opções e ordenações do catálogo de relatórios.
// Apresentação apenas: o catálogo do backend é a allowlist; o que não estiver
// aqui cai no nome técnico (nunca quebra se o backend ganhar um filtro novo).

export const FILTER_LABEL: Record<string, string> = {
  q: "Busca (número ou descrição)",
  unit_id: "Unidade",
  owner_unit_id: "Unidade proprietária",
  room_id: "Sala",
  responsible_person_id: "Responsável",
  located: "Localizado",
  bond_status: "Vínculo",
  status: "Situação",
  movement_type: "Tipo de movimentação",
  origin_unit_id: "Unidade de origem",
  destination_unit_id: "Unidade de destino",
  created_from: "Solicitada a partir de",
  created_to: "Solicitada até",
  inventory_id: "Inventário",
  inventory_status: "Situação do inventário",
  result: "Resultado da conferência",
  checked_from: "Conferido a partir de",
  checked_to: "Conferido até",
};

/**
 * Dica do campo LIVRE (input). Só aparece enquanto o catálogo declarar o filtro
 * como `uuid`/`text`: quando o backend anuncia `room`/`person`/opções, o
 * controle passa a ser um <select> e a dica deixa de ser usada.
 */
export const FILTER_HINT: Record<string, string> = {
  room_id: "UUID da sala, como exibido no cadastro.",
  responsible_person_id: "UUID do responsável, como exibido no cadastro.",
  bond_status: "Texto exato do vínculo.",
};

/** Opção "sem filtro" dos selects de opções fixas (lookups têm a sua, por tipo). */
const ALL_OPTION_LABEL: Record<string, string> = {
  bond_status: "Todos os vínculos",
};

export function allOptionLabel(name: string): string {
  return ALL_OPTION_LABEL[name] ?? "Todos";
}

/** Sentinela do backend (`asset_service.BOND_STATUS_NONE`): `bond_status` nulo. */
export const FILTER_NONE_VALUE = "__none__";

/**
 * Filtros cujas opções são VALORES DE DADOS (vêm da planilha e mudam a cada
 * importação), não um domínio ordenado: ordem alfabética estável, com a
 * sentinela "sem vínculo" sempre no fim. Os demais `enum` mantêm a ordem do
 * catálogo, que é semântica (PENDENTE -> APROVADA -> ...).
 */
const DATA_OPTION_FILTERS = new Set(["bond_status"]);

export function orderedOptions(name: string, options: readonly string[]): string[] {
  if (!DATA_OPTION_FILTERS.has(name)) return [...options];
  return [...options].sort((a, b) => {
    if (a === FILTER_NONE_VALUE || b === FILTER_NONE_VALUE) return a === b ? 0 : a === FILTER_NONE_VALUE ? 1 : -1;
    return optionLabel(a).localeCompare(optionLabel(b), "pt-BR", { sensitivity: "base" }) || a.localeCompare(b);
  });
}

export const OPTION_LABEL: Record<string, string> = {
  __none__: "Sem vínculo",
  SIM: "Sim",
  NAO: "Não",
  DESCONHECIDO: "Desconhecido",
  PENDENTE: "Pendente",
  APROVADA: "Aprovada",
  REJEITADA: "Rejeitada",
  CONCLUIDA: "Concluída",
  CANCELADA: "Cancelada",
  TRANSFERENCIA_UNIDADE: "Transferência entre unidades",
  MUDANCA_SALA: "Mudança de sala",
  TROCA_RESPONSAVEL: "Troca de responsável",
  ABERTO: "Aberto",
  EM_ANDAMENTO: "Em andamento",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
  ENCONTRADO: "Encontrado",
  NAO_ENCONTRADO: "Não encontrado",
  DIVERGENTE: "Divergente",
};

const SORT_FIELD_LABEL: Record<string, string> = {
  patrimony_number: "Nº patrimonial",
  description: "Descrição",
  created_at: "Data de criação",
  updated_at: "Última atualização",
  bond_status: "Vínculo",
  status: "Situação",
  checked_at: "Data da conferência",
  result: "Resultado",
};

export function sortLabel(sort: string): string {
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  return `${SORT_FIELD_LABEL[field] ?? field} — ${desc ? "decrescente" : "crescente"}`;
}

export function filterLabel(name: string): string {
  return FILTER_LABEL[name] ?? name.replace(/_/g, " ");
}

export function optionLabel(value: string): string {
  return OPTION_LABEL[value] ?? value;
}
