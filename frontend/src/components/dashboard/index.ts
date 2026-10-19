// Componentes do dashboard — dados SEMPRE por props (ver types.ts).
// AnimatedChart NÃO é reexportado aqui (puxaria o Recharts para o bundle de
// quem importa o barrel); importe de "@/components/dashboard/animated-chart".
export type { AnimatedChartProps } from "./animated-chart";
export { DashboardEmptyState, type DashboardEmptyStateProps } from "./dashboard-empty-state";
export { DashboardOverview, type DashboardOverviewProps } from "./dashboard-overview";
export { StatCard, type StatCardProps } from "./stat-card";
export type * from "./types";
export { chartClasses, chartPalette, type ChartThemeName } from "./chart-theme";
