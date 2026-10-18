import { colors, fontFamily } from './tokens';

// Keep AntV's layout, axes, interaction and rendering; override only shared theme values.
export const chartTheme = {
  defaultColor: colors.primary,
  defaultCategory10: [
    colors.primary,
    colors.purple,
    colors.cyan,
    colors.warning,
    colors.success,
  ],
  view: { viewFill: 'transparent' },
  axis: {
    labelFontFamily: fontFamily,
    labelFontSize: 11,
    labelFill: colors.textSecondary,
    labelOpacity: 1,
    titleFill: colors.textSecondary,
    gridStroke: colors.border,
    gridStrokeOpacity: 1,
  },
};
export const chartColors = {
  median: colors.primary,
  p90: colors.purple,
  stages: [colors.primary, colors.cyan, colors.primaryMuted, colors.purple],
  heat: [colors.chartHeatLow, colors.chartHeatMid, colors.chartHeatHigh],
};
