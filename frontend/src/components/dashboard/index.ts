// Componentes do dashboard — dados SEMPRE por props (ver types.ts).
// AnimatedChart NÃO é reexportado aqui (puxaria o Nivo para o bundle de quem
// importa o barrel); importe via next/dynamic de "@/components/dashboard/animated-chart"
// ou dos módulos nivo-*-chart(s).
export type { AnimatedChartProps } from "./chart-shell";
export { DashboardEmptyState, type DashboardEmptyStateProps } from "./dashboard-empty-state";
export { DashboardOverview, type DashboardOverviewProps } from "./dashboard-overview";
export { StatCard, type StatCardProps } from "./stat-card";
export type * from "./types";
export { chartClasses, chartPalette, type ChartThemeName } from "./chart-theme";
