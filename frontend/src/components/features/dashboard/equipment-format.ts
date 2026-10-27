// =============================================================================
// Formatação de apresentação dos painéis do catálogo (equipment-*). Só formata
// o que o backend devolveu: nenhum valor é calculado ou completado aqui.
// UI em pt-BR e America/Araguaina (CLAUDE.md > Banco de Dados).
// =============================================================================

const integer = new Intl.NumberFormat("pt-BR");
const ratio = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Araguaina",
});

export const formatCount = (n: number) => integer.format(n);
export const formatRatio = (n: number) => ratio.format(n);

/** `percentual` já vem calculado pelo backend; `null` = sem base de cálculo. */
export const formatPercent = (p: number | null) => (p === null ? "—" : `${percent.format(p)}%`);

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

const CONFIDENCE_LABEL: Record<string, string> = {
  ALTA: "Alta",
  BAIXA: "Baixa",
  NAO_INFORMADA: "Não informada",
  NAO_INFORMADO: "Não informada",
};

export const confidenceLabel = (value: string | null) =>
  value === null ? "Não informada" : (CONFIDENCE_LABEL[value] ?? value);

const JOB_STATUS_LABEL: Record<string, string> = {
  CONCLUIDO: "Concluído",
  CONCLUIDA: "Concluída",
  EM_ANDAMENTO: "Em andamento",
  FALHA: "Falha",
  ERRO: "Erro",
  PENDENTE: "Pendente",
};

export const jobStatusLabel = (value: string) => JOB_STATUS_LABEL[value] ?? value;

/** Explicação do método da estimativa de "notebooks sem docking". */
export function rankingMethodNote(metodo: string): string {
  if (metodo === "diferenca_de_contagens_por_unidade") {
    return "Estimativa: para cada unidade, notebooks menos docking stations (nunca abaixo de zero). O cadastro não vincula cada notebook a uma docking station, então o resultado é uma aproximação, não uma relação confirmada.";
  }
  return `Estimativa calculada pelo servidor (método: ${metodo}). O cadastro não vincula cada notebook a uma docking station.`;
}
