import { describe, expect, it } from 'vitest';
import type { TransitRecord } from './data';
import { channelComparison, coverage, elapsedDays, filterRecords, heatmapData, periodDomain, periodEnd, periodKey, periodLabel, periodWindow, regionalOverview, relativeRange, stageSummary, summarize, thresholdShare, trend } from './metrics';

const record = (days: number, overrides: Partial<TransitRecord> = {}): TransitRecord => ({
  id: `row-${days}`, containerTripId: `trip-${days}`, channel: '美森', warehouse: 'ONT8', region: '美西', group: '组合-2', channelGroup: '美森组一',
  nodes: { departure: '2025-12-25T00:00:00', arrival: '2026-01-02T00:00:00', unloaded: null, pickup: '2026-01-04T00:00:00', devanning: '2026-01-05T00:00:00', delivered: new Date(Date.UTC(2025, 11, 25 + days)).toISOString().slice(0, 19) },
  status: 'arrived', flags: [], duplicateGroup: null, source: { sheet: '2025', row: 2 }, ...overrides,
});
const all = { warehouse: '', channel: '', region: '', group: '', start: '', end: '' };

describe('transit metric definitions', () => {
  it('uses exact elapsed time across years and does not interpret missing dates as zero', () => {
    expect(elapsedDays('2025-12-31T12:00:00', '2026-01-01T00:00:00')).toBe(.5);
    expect(elapsedDays(null, '2026-01-01T00:00:00')).toBeNull();
    expect(elapsedDays('2026-01-01T00:00:00', '2025-01-01T00:00:00')).toBeNull();
  });
  it('uses nearest rank for P90, preserves long deliveries, and uses the midpoint median', () => {
    const rows = [12, 13, 14, 14, 15, 16, 17, 20, 22, 80].map(n => record(n));
    expect(summarize(rows)).toMatchObject({ n: 10, p10: 12, median: 15.5, p90: 22, max: 80 });
    expect(summarize([])).toBeNull();
    expect(summarize([record(15)])).toMatchObject({ n: 1, p10: 15, median: 15, p90: 15 });
  });
  it('counts threshold equality and separates unknown/invalid rows from the observed denominator', () => {
    const rows = [record(20), record(21), record(30, { status: 'unknown', nodes: { ...record(30).nodes, delivered: null } }), record(10, { status: 'invalid', flags: ['negative_total'] })];
    expect(thresholdShare(rows, 20)).toEqual({ within: 1, n: 2, rate: .5 });
    expect(coverage(rows)).toMatchObject({ total: 4, arrived: 2, unknown: 1, invalid: 1 });
  });
  it('retains duplicate candidates while reporting independent container trips separately', () => {
    const a = record(20, { duplicateGroup: 'candidate', flags: ['duplicate_candidate'] });
    expect(coverage([a, { ...a, id: 'another' }])).toMatchObject({ arrived: 2, trips: 1, duplicateRows: 2 });
  });
  it('assigns cross-year deliveries to their departure period and leaves missing months visible', () => {
    const a = record(20), b = record(20, { nodes: { ...record(20).nodes, departure: '2026-02-01T00:00:00', delivered: '2026-02-21T00:00:00' } });
    expect(trend([a, b], 'month').map(s => s.period)).toEqual(['2025-12', '2026-02']);
    expect(periodDomain([a, b], 'month')).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(trend([a], 'week')[0]).toMatchObject({ period: '2025-12-22', small: true });
  });
  it('groups Monday through Sunday by departure, including year and month boundaries', () => {
    expect(periodKey('2026-01-04T23:59:59', 'week')).toBe('2025-12-29');
    expect(periodKey('2026-01-05T00:00:00', 'week')).toBe('2026-01-05');
    expect(periodEnd('2025-12-29', 'week')).toBe('2026-01-04');
    expect(periodLabel('2025-12-29', 'week')).toBe('2025-12-29 至 2026-01-04');
    expect(periodEnd('2024-02', 'month')).toBe('2024-02-29');
    expect(periodDomain([record(20)], 'week', '2025-12-28', '2026-01-06')).toEqual(['2025-12-22', '2025-12-29', '2026-01-05']);
  });
  it('preserves weekly gaps and reconciles weekly totals with observed arrivals', () => {
    const a = record(20), b = record(30, { nodes: { ...record(30).nodes, departure: '2026-01-05T00:00:00', delivered: '2026-02-04T00:00:00' } });
    const rows = [a, a, b, record(10, { status: 'unknown' })];
    expect(trend(rows, 'week').map(r => [r.period, r.n])).toEqual([['2025-12-22', 2], ['2026-01-05', 1]]);
    expect(periodDomain(rows, 'week')).toEqual(['2025-12-22', '2025-12-29', '2026-01-05']);
    expect(trend(rows, 'week').reduce((n, row) => n + row.n, 0)).toBe(summarize(rows)?.n);
    const heat = heatmapData(rows, { ...all, channel: '美森' }, 'week');
    expect(heat.cells[1]).toMatchObject({ period: '2025-12-29', p90: null, n: 0 });
  });
  it('pages through every period exactly once, including partial pages and shorter filters', () => {
    const periods = Array.from({ length: 27 }, (_, i) => String(i));
    expect(periodWindow(periods, 0).periods).toEqual(periods.slice(15));
    expect(periodWindow(periods, 1).periods).toEqual(periods.slice(3, 15));
    expect(periodWindow(periods, 2).periods).toEqual(periods.slice(0, 3));
    expect(periodWindow(periods.slice(0, 2), 5)).toEqual({ periods: ['0', '1'], page: 0, pages: 1 });
    expect(periodWindow([], 0)).toEqual({ periods: [], page: 0, pages: 1 });
  });
  it('compares only the selected warehouse and period, ignoring the selected channel', () => {
    const rows = [record(20), record(30, { channel: '快船' }), record(90, { warehouse: 'ABE8' })];
    expect(channelComparison(rows, { ...all, warehouse: 'ONT8', channel: '美森' }).map(s => s.channel)).toEqual(['美森', '快船']);
    expect(channelComparison(rows, all)).toEqual([]);
    expect(filterRecords(rows, { ...all, start: '2026-01-01' })).toEqual([]);
  });
  it('uses a common complete cohort for stage means without dropping valid totals', () => {
    const complete = record(20), missing = record(30, { nodes: { ...record(30).nodes, pickup: null } });
    const reversed = record(40, { nodes: { ...record(40).nodes, pickup: '2026-01-01T00:00:00' } });
    const stages = stageSummary([complete, missing, reversed]);
    expect(stages.n).toBe(1);
    expect(stages.data.reduce((sum, s) => sum + s.days, 0)).toBe(20);
    expect(summarize([complete, missing, reversed])?.n).toBe(3);
  });
  it('keeps missing heatmap observations null and excludes unresolved warehouse mappings', () => {
    const rows = [record(20), record(30, { warehouse: 'UNKNOWN', flags: ['unverified_warehouse'] })];
    const heat = heatmapData(rows, { ...all, channel: '美森', start: '2025-11-01', end: '2025-12-31' }, 'month');
    expect(heat.warehouses).toEqual(['ONT8']);
    expect(heat.cells[0]).toMatchObject({ p90: null, n: 0 });
    expect(heat.cells[1]).toMatchObject({ p90: 20, n: 1 });
  });
  it('anchors recent windows to the advertised snapshot date, including both endpoints', () => {
    expect(relativeRange('2026-09-25', 90)).toEqual(['2026-06-28', '2026-09-25']);
  });
  it('keeps regional cohorts separate and exposes mapping exclusions without losing source rows', () => {
    const rows = [record(16), record(30, { region: '美东' }), record(99, { flags: ['unverified_warehouse'] }),
      record(80, { channel: '' }), record(90, { region: '' }), record(70, { status: 'unknown' })];
    const overview = regionalOverview(rows, all);
    expect(overview.rows[0].cells.map(cell => cell.summary?.median ?? null)).toEqual([16, null, 30]);
    expect(overview.excluded).toBe(3);
    expect(coverage(rows)).toMatchObject({ total: 6, unknown: 1 });
  });
  it('keeps channels with no recent samples visible and applies date and group filters to every cell', () => {
    const rows = [record(16), record(40, { channel: '快船', group: '组合-3' })];
    const overview = regionalOverview(rows, { ...all, group: '组合-2' });
    expect(overview.rows.map(row => row.channel)).toEqual(['美森', '快船']);
    expect(overview.rows[1].cells.every(cell => cell.summary === null)).toBe(true);
    expect(regionalOverview(rows, { ...all, start: '2026-01-01' }).rows.every(row => row.cells.every(cell => cell.summary === null))).toBe(true);
    expect(regionalOverview(rows, { ...all, channel: '快船' }).rows.map(row => row.channel)).toEqual(['快船']);
  });
});
