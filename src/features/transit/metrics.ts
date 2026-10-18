import type { TransitRecord } from './data';

export interface TransitFilters { warehouse: string; channel: string; region: string; group: string; start: string; end: string }
export interface Summary { n: number; median: number; p10: number; p90: number; min: number; max: number; mean: number }
export interface PeriodSummary extends Summary { period: string; small: boolean }
export type Granularity = 'week' | 'month';
const DAY = 86_400_000;

/** Excel dates are local wall-clock readings. Appending Z only makes arithmetic timezone-invariant. */
export function elapsedDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const days = (Date.parse(end + 'Z') - Date.parse(start + 'Z')) / DAY;
  return Number.isFinite(days) && days >= 0 ? days : null;
}
export function totalDays(record: TransitRecord): number | null {
  return record.status === 'arrived' ? elapsedDays(record.nodes.departure, record.nodes.delivered) : null;
}
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length || p < 0 || p > 1) throw new Error('Quantile requires observations and p in [0, 1]');
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
export function summarize(records: TransitRecord[]): Summary | null {
  const values = records.map(totalDays).filter((d): d is number => d !== null).sort((a, b) => a - b);
  if (!values.length) return null;
  const n = values.length, middle = Math.floor(n / 2);
  return { n, median: n % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    p10: quantile(values, .1), p90: quantile(values, .9), min: values[0], max: values[n - 1],
    mean: values.reduce((a, b) => a + b, 0) / n };
}
export function filterRecords(records: TransitRecord[], filters: TransitFilters): TransitRecord[] {
  return records.filter(r => (!filters.warehouse || r.warehouse === filters.warehouse) &&
    (!filters.channel || (r.channel || 'unknown') === filters.channel) && (!filters.region || (r.region || 'unknown') === filters.region) &&
    (!filters.group || r.group === filters.group) && (!filters.start || !!r.nodes.departure && r.nodes.departure.slice(0, 10) >= filters.start) &&
    (!filters.end || !!r.nodes.departure && r.nodes.departure.slice(0, 10) <= filters.end));
}
export function periodKey(date: string, granularity: Granularity): string {
  if (granularity === 'month') return date.slice(0, 7);
  const monday = new Date(date.slice(0, 10) + 'T00:00:00Z');
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}
export function periodEnd(period: string, granularity: Granularity): string {
  const date = new Date((granularity === 'month' ? period + '-01' : period) + 'T00:00:00Z');
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 6);
  else { date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0); }
  return date.toISOString().slice(0, 10);
}
export function periodLabel(period: string, granularity: Granularity): string {
  return granularity === 'month' ? `${period.slice(0, 4)} 年 ${Number(period.slice(5))} 月` : `${period} 至 ${periodEnd(period, granularity)}`;
}
/** Pages run backwards from the latest period; clamp when filters shorten the range. */
export function periodWindow(periods: string[], offset: number, size = 12) {
  const pages = Math.max(1, Math.ceil(periods.length / size));
  const page = Math.min(Math.max(0, offset), pages - 1);
  const end = periods.length - page * size;
  return { periods: periods.slice(Math.max(0, end - size), end), page, pages };
}
export function trend(records: TransitRecord[], granularity: Granularity): PeriodSummary[] {
  const groups = new Map<string, TransitRecord[]>();
  for (const r of records) {
    if (totalDays(r) === null || !r.nodes.departure) continue;
    const key = periodKey(r.nodes.departure, granularity);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, rows]) => {
    const summary = summarize(rows)!;
    return { period, ...summary, small: summary.n < 10 };
  });
}
export function periodDomain(records: TransitRecord[], granularity: Granularity, start = '', end = ''): string[] {
  const dates = records.filter(r => totalDays(r) !== null).map(r => r.nodes.departure!.slice(0, 10)).sort();
  if (!dates.length) return [];
  const firstKey = periodKey(start || dates[0], granularity);
  const lastKey = periodKey(end || dates.at(-1)!, granularity);
  const first = new Date((granularity === 'month' ? firstKey + '-01' : firstKey) + 'T00:00:00Z');
  const last = new Date((granularity === 'month' ? lastKey + '-01' : lastKey) + 'T00:00:00Z');
  const result = new Set<string>();
  for (let i = 0; first <= last && i < 1200; i++) {
    result.add(periodKey(first.toISOString(), granularity));
    if (granularity === 'week') first.setUTCDate(first.getUTCDate() + 7);
    else first.setUTCMonth(first.getUTCMonth() + 1);
  }
  return [...result];
}
export function channelComparison(records: TransitRecord[], filters: TransitFilters) {
  if (!filters.warehouse) return [];
  const rows = filterRecords(records, { ...filters, channel: '' });
  return [...new Set(rows.map(r => r.channel))].filter(Boolean).flatMap(channel => {
    const summary = summarize(rows.filter(r => r.channel === channel));
    return summary ? [{ channel, ...summary }] : [];
  }).sort((a, b) => a.median - b.median);
}

export const overviewRegions = ['美西', '美中', '美东'] as const;
const channelOrder = ['美森', '定时达', '快船', '纽约', '萨凡纳', '芝加哥'];

/** Regional summaries describe the observed warehouse mix; they are not route rankings. */
export function regionalOverview(records: TransitRecord[], filters: TransitFilters) {
  const rows = filterRecords(records, { ...filters, warehouse: '' });
  const eligible = rows.filter(r => r.channel && overviewRegions.some(region => region === r.region) && !r.flags.includes('unverified_warehouse'));
  const channels = [...new Set(records.map(r => r.channel).filter(Boolean))]
    .filter(channel => !filters.channel || channel === filters.channel)
    .sort((a, b) => (channelOrder.includes(a) ? channelOrder.indexOf(a) : 99) - (channelOrder.includes(b) ? channelOrder.indexOf(b) : 99) || a.localeCompare(b));
  return {
    rows: channels.map(channel => ({ channel, cells: overviewRegions.map(region => ({ region,
      summary: summarize(eligible.filter(r => r.channel === channel && r.region === region)),
    })) })),
    excluded: rows.length - eligible.length,
  };
}
export function thresholdShare(records: TransitRecord[], threshold: number) {
  const values = records.map(totalDays).filter((n): n is number => n !== null);
  const within = values.filter(n => n <= threshold).length;
  return { within, n: values.length, rate: values.length ? within / values.length : null };
}
export function coverage(records: TransitRecord[]) {
  return { total: records.length, arrived: records.filter(r => totalDays(r) !== null).length,
    unknown: records.filter(r => r.status === 'unknown').length, invalid: records.filter(r => r.status === 'invalid').length,
    trips: new Set(records.filter(r => totalDays(r) !== null && r.containerTripId).map(r => r.containerTripId)).size,
    duplicateRows: records.filter(r => r.duplicateGroup).length,
    unverified: records.filter(r => r.flags.includes('unverified_warehouse')).length };
}
export function stageSummary(records: TransitRecord[]) {
  const stages = [['departure', 'arrival', '海上航行'], ['arrival', 'pickup', '到港至提柜'],
    ['pickup', 'devanning', '提柜至拆柜'], ['devanning', 'delivered', '拆柜至到仓']] as const;
  const complete = records.filter(r => totalDays(r) !== null && stages.every(([from, to]) => elapsedDays(r.nodes[from], r.nodes[to]) !== null));
  return { n: complete.length, data: complete.length ? stages.map(([from, to, stage]) => ({
    route: '平均运输耗时', stage, days: complete.reduce((sum, r) => sum + elapsedDays(r.nodes[from], r.nodes[to])!, 0) / complete.length,
  })) : [], mean: summarize(complete)?.mean ?? null };
}
export function heatmapData(records: TransitRecord[], filters: TransitFilters, granularity: Granularity) {
  if (!filters.channel) return { cells: [], warehouses: [], periods: [] };
  const rows = filterRecords(records, { ...filters, warehouse: '' }).filter(r => totalDays(r) !== null && !r.flags.includes('unverified_warehouse'));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.warehouse, (counts.get(r.warehouse) ?? 0) + 1);
  const warehouses = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code]) => code);
  if (filters.warehouse && counts.has(filters.warehouse) && !warehouses.includes(filters.warehouse)) warehouses.splice(-1, 1, filters.warehouse);
  const periods = periodDomain(rows, granularity, filters.start, filters.end);
  const cells = warehouses.flatMap(warehouse => {
    const byPeriod = new Map(trend(rows.filter(r => r.warehouse === warehouse), granularity).map(s => [s.period, s]));
    return periods.map(period => { const s = byPeriod.get(period); return { warehouse, period, p90: s?.p90 ?? null, n: s?.n ?? 0 }; });
  });
  return { cells, warehouses, periods };
}
export function relativeRange(asOf: string, days: number): [string, string] {
  const end = new Date(asOf + 'T00:00:00Z');
  return [new Date(end.getTime() - (days - 1) * DAY).toISOString().slice(0, 10), asOf];
}
export const formatDays = (value: number | null | undefined) => value == null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);
