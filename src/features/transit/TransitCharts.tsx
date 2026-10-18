import { useMemo, useRef } from 'react';
import { Line, Bar, Heatmap, type Chart, type LineConfig, type BarConfig, type HeatmapConfig } from '@ant-design/charts';
import { Empty } from 'antd';
import { useChartFrame } from '../../components/charts/useChartFrame';
import { colors } from '../../theme/tokens';
import { chartColors, chartTheme } from '../../theme/charts';
import { formatDays, periodLabel, type Granularity, type PeriodSummary, type Summary } from './metrics';
import { metricNames, toComparisonData, toTrendData, type ComparisonDatum, type TrendDatum } from './chartData';

const base = { autoFit: true, animate: false, paddingLeft: 48, paddingRight: 22, theme: chartTheme };
const metricScale = { domain: [...metricNames], range: [chartColors.median, chartColors.p90] };
const metricTooltip = {
  title: 'title',
  items: [(row: TrendDatum | ComparisonDatum) => ({ name: row.metric, value: `${formatDays(row.days)} 天` })],
};
const timeAxis = (granularity: Granularity) => ({ title: false as const, labelAutoRotate: false, labelAutoHide: true,
  labelFormatter: (value: string) => granularity === 'week' ? value.slice(5).replace('-', '/') : value.slice(2).replace('-', '/') });
const metricLegend = { color: { position: 'top' as const, title: false, itemLabelFontSize: 11 } };

export function TrendChart({ data, periods, granularity, onSelect }: {
  data: PeriodSummary[]; periods: string[]; granularity: Granularity; onSelect?: (period: string) => void;
}) {
  const { ref, tooltip, ready, onReady } = useChartFrame();
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const rows = useMemo(() => toTrendData(data, periods, granularity), [data, periods, granularity]);
  const config = useMemo<LineConfig>(() => ({
    ...base, data: rows, height: 340, xField: 'period', yField: 'days', colorField: 'metric',
    scale: { x: { type: 'point', domain: periods, padding: .5 }, y: { domain: [0, Math.ceil(Math.max(...data.map(row => row.p90), 5) / 5) * 5] }, color: metricScale },
    axis: { x: timeAxis(granularity), y: { title: '到仓天数', grid: true } }, legend: metricLegend,
    style: { lineWidth: 2, lineDash: (datum: TrendDatum | TrendDatum[]) => (Array.isArray(datum) ? datum[0] : datum).metric === metricNames[1] ? [5, 4] : [] },
    point: { sizeField: 4, tooltip: metricTooltip, style: { lineWidth: 1, stroke: colors.surface } },
    tooltip: metricTooltip, interaction: { tooltip: { ...tooltip, shared: true, crosshairs: true, crosshairsPointerEvents: 'none', marker: true } },
    onReady: (chart: Chart) => {
      onReady(chart);
      chart.chart.on('element:click', (event: { data?: { data?: TrendDatum } }) => {
        if (event.data?.data?.period) selectRef.current?.(event.data.data.period);
      });
    },
  }), [rows, data, periods, granularity, tooltip, onReady]);
  return <div ref={ref} className="transit-chart" data-testid="transit-trend-chart" role="img" aria-label="按开船周或月的典型到仓与90%到仓趋势">
    {!rows.some(row => row.n) ? <Empty description="本段时间暂无有效到仓记录，可翻看更早时段" /> : ready && <Line {...config} />}
  </div>;
}

export function ComparisonChart({ data, selected, onSelect }: {
  data: (Summary & { channel: string })[]; selected: string; onSelect: (channel: string) => void;
}) {
  const { ref, tooltip, ready, onReady } = useChartFrame();
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const rows = useMemo(() => toComparisonData(data), [data]);
  const config = useMemo<BarConfig>(() => ({
    ...base, data: rows, height: Math.max(230, data.length * 62 + 80), xField: 'channel', yField: 'days', colorField: 'metric', group: true,
    scale: { x: { domain: data.map(row => row.channel) }, y: { domain: [0, Math.ceil(Math.max(...data.map(row => row.p90), 5) / 5) * 5] }, color: metricScale },
    axis: { x: { title: false }, y: { title: '到仓天数' } }, legend: metricLegend,
    style: { radius: 3, maxWidth: 16, fillOpacity: (row: ComparisonDatum) => !selected || row.channel === selected ? 1 : .55 },
    tooltip: metricTooltip, interaction: { tooltip: { ...tooltip, shared: true } },
    onReady: (chart: Chart) => {
      onReady(chart);
      chart.chart.on('element:click', (event: { data?: { data?: ComparisonDatum } }) => {
        if (event.data?.data?.channel) selectRef.current(event.data.data.channel);
      });
    },
  }), [data, rows, selected, tooltip, onReady]);
  return <div ref={ref} className="transit-chart" data-testid="transit-comparison-chart" role="img" aria-label="各渠道的典型到仓和90%到仓天数分组条形图">{ready && <Bar {...config} />}</div>;
}

interface HeatCell { warehouse: string; period: string; p90: number | null; n: number }
export function WarehouseHeatmap({ cells, warehouses, periods, granularity, colorMax, onSelect }: {
  cells: HeatCell[]; warehouses: string[]; periods: string[]; granularity: Granularity; colorMax: number; onSelect: (warehouse: string) => void;
}) {
  const { ref, showLabels, tooltip, ready, onReady } = useChartFrame();
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const config = useMemo<HeatmapConfig>(() => ({
    ...base, mark: 'cell', data: cells, height: Math.max(220, warehouses.length * 31 + 90), xField: 'period', yField: 'warehouse', colorField: 'p90',
    scale: { x: { domain: periods }, y: { domain: warehouses }, color: { type: 'linear', domain: [0, colorMax], range: chartColors.heat, unknown: colors.surfaceMuted } },
    axis: { x: timeAxis(granularity), y: { title: false } },
    legend: { color: { position: 'bottom', title: '90% 到仓 / 天', size: 45 } }, style: { inset: 2, radius: 3 },
    label: showLabels ? { text: (row: HeatCell) => formatDays(row.p90), style: { pointerEvents: 'none', fontSize: 11, fill: (row: HeatCell) => (row.p90 ?? 0) > colorMax * .6 ? colors.surface : colors.primaryStrong } } : false,
    tooltip: { title: (row: HeatCell) => `${row.warehouse} · ${periodLabel(row.period, granularity)}`, items: [
      { field: 'p90', name: '90% 记录到仓', valueFormatter: (value: number | null) => value == null ? '无样本' : `${formatDays(value)} 天` },
      { field: 'n', name: '到仓记录', valueFormatter: (value: number) => `${value} 条${value < 10 ? ' · 样本较少' : ''}` },
    ] }, interaction: { tooltip },
    onReady: (chart: Chart) => {
      onReady(chart);
      chart.chart.on('element:click', (event: { data?: { data?: HeatCell } }) => {
        if (event.data?.data?.warehouse) selectRef.current(event.data.data.warehouse);
      });
    },
  }), [cells, warehouses, periods, granularity, colorMax, showLabels, tooltip, onReady]);
  return <div ref={ref} className="transit-chart" data-testid="transit-heatmap" role="img" aria-label="各仓库按开船周或月的90%到仓天数热力图">
    {!cells.length ? <Empty description="此范围暂无已匹配美国仓库的样本" /> : ready && <Heatmap {...config} />}
  </div>;
}

export function StageChart({ data }: { data: { route: string; stage: string; days: number }[] }) {
  const { ref, tooltip, ready, onReady } = useChartFrame();
  const config = useMemo<BarConfig>(() => ({
    ...base, data, onReady, height: 180, xField: 'route', yField: 'days', colorField: 'stage', stack: true,
    scale: { color: { domain: ['海上航行', '到港至提柜', '提柜至拆柜', '拆柜至到仓'], range: chartColors.stages } },
    legend: metricLegend, axis: { x: false, y: { title: '平均耗时 / 天' } }, style: { maxWidth: 34 }, interaction: { tooltip },
    tooltip: { title: 'stage', items: [{ field: 'days', name: '平均耗时', valueFormatter: (value: number) => `${formatDays(value)} 天` }] },
  }), [data, tooltip, onReady]);
  return <div ref={ref} className="transit-chart" data-testid="transit-stages" role="img" aria-label="四个运输环节的平均耗时">
    {!data.length ? <Empty description="暂无节点完整且先后合理的记录" /> : ready && <Bar {...config} />}
  </div>;
}
