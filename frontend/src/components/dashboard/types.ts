// =============================================================================
// Tipos do dashboard — contrato de PROPS (não há endpoint de indicadores
// ainda). Quando o backend expuser indicadores, a camada de dados (hook em
// src/lib) converte a resposta nestes tipos; os componentes não buscam nada.
// NUNCA preencha estes tipos com números de demonstração.
// =============================================================================

/** Um indicador numérico (Metric Tile do DESIGN.md). */
export interface DashboardStat {
  /** Identificador estável (chave React e de testes). */
  id: string;
  /** Rótulo curto (renderizado em Geist Mono uppercase). */
  label: string;
  /** Valor REAL vindo do backend; `null` = sem dado disponível. */
  value: number | null;
  /** Unidade exibida após o número (ex.: "itens", "%"). */
  unit?: string;
  /** Casas decimais (padrão 0). */
  decimals?: number;
  /** Texto de apoio (ex.: "atualizado em …"). */
  description?: string;
}

/** Ponto de uma série categórica (barra ou fatia). */
export interface ChartDatum {
  /** Identificador estável da categoria (a cor segue a entidade). */
  key: string;
  label: string;
  /** Valor REAL (>= 0). */
  value: number;
}

export type ChartKind = "bar" | "donut";

export interface DashboardChart {
  id: string;
  kind: ChartKind;
  title: string;
  description?: string;
  data: ChartDatum[];
  /** Nome da medida para tooltip/tabela (ex.: "Quantidade"). */
  valueLabel?: string;
}

export interface DashboardPeriodOption {
  value: string;
  label: string;
}

export interface DashboardData {
  stats: DashboardStat[];
  charts?: DashboardChart[];
  /** Momento da apuração (ISO 8601, UTC) — exibido em America/Araguaina. */
  generatedAt?: string;
}

/**
 * Estado da fonte de dados:
 *  - "unavailable": não existe endpoint/módulo ativo (estado vazio honesto);
 *  - "loading": consulta REAL em andamento (único caso com skeleton);
 *  - "error": a consulta falhou;
 *  - "ready": `data` presente.
 */
export type DashboardStatus = "unavailable" | "loading" | "error" | "ready";
