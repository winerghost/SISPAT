// Rótulos pt-BR dos filtros, opções e ordenações do catálogo de relatórios.
// Apresentação apenas: o catálogo do backend é a allowlist; o que não estiver
// aqui cai no nome técnico (nunca quebra se o backend ganhar um filtro novo).

export const FILTER_LABEL: Record<string, string> = {
  q: "Busca (número ou descrição)",
  unit_id: "Unidade",
  owner_unit_id: "Unidade proprietária",
  room_id: "Sala (identificador)",
  responsible_person_id: "Responsável (identificador)",
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

export const FILTER_HINT: Record<string, string> = {
  room_id: "UUID da sala, como exibido no cadastro.",
  responsible_person_id: "UUID do responsável, como exibido no cadastro.",
  bond_status: "Texto exato do vínculo.",
};

export const OPTION_LABEL: Record<string, string> = {
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
