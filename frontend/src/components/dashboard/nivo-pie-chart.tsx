"use client";

import { ResponsivePie, type PieTooltipProps } from "@nivo/pie";

import {
  ChartShell,
  TooltipBox,
  defaultFormatter,
  useCategoryModel,
  type AnimatedChartProps,
  type CategoryRow,
} from "./chart-shell";
import { chartClasses, nivoTheme, withAlpha } from "./chart-theme";

// =============================================================================
// Pizza e rosca (Nivo ResponsivePie) no tema Factory.
// =============================================================================
// - Ordem categórica fixa (a cor segue a entidade, nunca o ranking); a partir
//   da 5ª categoria o resto vira "Outros" (ver chart-shell.toCategoryRows).
// - Rosca = innerRadius 0.58; pizza = 0. Separação de 2 px na cor do fundo.
// - Sem rótulos dentro das fatias (o contraste mudaria com a seleção): a
//   legenda sempre visível traz os valores e a tabela cobre leitores de tela.
// - animate={false}: sem mola. Seleção pela legenda (aria-pressed) ou clique.
// =============================================================================

export function PieChart(props: AnimatedChartProps) {
  const {
    kind,
    title,
    description,
    valueLabel = "Valor",
    valueFormatter = defaultFormatter,
    selectedKey = null,
    onSelectKey,
    selectActionLabel,
    height = 240,
    theme = "screen",
    className,
  } = props;
  const model = useCategoryModel(props);
  const cls = chartClasses(theme);
  if (model.rows.length === 0) return null;

  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);
  const Tooltip = ({ datum }: PieTooltipProps<CategoryRow>) => (
    <TooltipBox
      title={datum.data.label}
      classes={cls}
      lines={[{ key: "v", color: datum.data.color, text: `${valueLabel}: ${valueFormatter(datum.value)}` }]}
    />
  );

  return (
    <ChartShell
      kind={kind}
      title={title}
      description={description}
      summary={model.summary}
      height={height}
      theme={theme}
      legend={model.legend}
      table={model.table}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      selectActionLabel={selectActionLabel}
      interactive={!!onSelectKey}
      className={className}
    >
      {() => (
        <ResponsivePie<CategoryRow>
          data={model.rows}
          id="key"
          value="value"
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          innerRadius={kind === "donut" ? 0.58 : 0}
          padAngle={0}
          cornerRadius={0}
          sortByValue={false}
          colors={(d) => withAlpha(model.fillFor(d.data), model.opacityFor(d.data))}
          borderWidth={2}
          borderColor={model.palette.ground}
          enableArcLabels={false}
          enableArcLinkLabels={false}
          activeOuterRadiusOffset={3}
          tooltip={Tooltip}
          onClick={(datum) => {
            const key = String(datum.id);
            if (onSelectKey && model.canSelect(key)) toggle(key);
          }}
          theme={nivoTheme(theme)}
          animate={false}
          role="presentation"
        />
      )}
    </ChartShell>
  );
}
