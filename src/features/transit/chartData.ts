import { periodLabel, type Granularity, type PeriodSummary, type Summary } from './metrics';

export const metricNames = ['典型到仓 · 中位数', '90% 记录到仓 · P90'] as const;
export type MetricName = typeof metricNames[number];
export interface TrendDatum { period: string; title: string; metric: MetricName; days: number | null; n: number }
export interface ComparisonDatum { channel: string; title: string; metric: MetricName; days: number }

const sampleTitle = (n: number) => `到仓记录 ${n} 条${n < 10 ? ' · 样本较少' : ''}`;

/** Standard multi-series Line data. Null observations let the library break missing periods. */
export function toTrendData(rows: PeriodSummary[], periods: string[], granularity: Granularity): TrendDatum[] {
  const byPeriod = new Map(rows.map(row => [row.period, row]));
  return periods.flatMap(period => {
    const row = byPeriod.get(period);
    const title = `${periodLabel(period, granularity)} · ${sampleTitle(row?.n ?? 0)}`;
    return [
      { period, title, metric: metricNames[0], days: row?.median ?? null, n: row?.n ?? 0 },
      { period, title, metric: metricNames[1], days: row?.p90 ?? null, n: row?.n ?? 0 },
    ];
  });
}

/** Standard grouped Bar data; channels keep their existing business sort order. */
export function toComparisonData(rows: (Summary & { channel: string })[]): ComparisonDatum[] {
  return rows.flatMap(row => [
    { channel: row.channel, title: `${row.channel} · ${sampleTitle(row.n)}`, metric: metricNames[0], days: row.median },
    { channel: row.channel, title: `${row.channel} · ${sampleTitle(row.n)}`, metric: metricNames[1], days: row.p90 },
  ]);
}
