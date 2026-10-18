import { describe, expect, it } from 'vitest';
import { metricNames, toComparisonData, toTrendData } from './chartData';
import type { PeriodSummary } from './metrics';

const row: PeriodSummary = { period: '2025-12-29', n: 4, median: 16.5, p10: 14, p90: 21, min: 14, max: 21, mean: 17.25, small: true };

describe('Ant Design Charts data adapters', () => {
  it('aligns both series to the full calendar and preserves missing values as null', () => {
    const values = toTrendData([row], ['2025-12-29', '2026-01-05'], 'week');
    expect(values.map(value => [value.period, value.metric, value.days])).toEqual([
      ['2025-12-29', metricNames[0], 16.5], ['2025-12-29', metricNames[1], 21],
      ['2026-01-05', metricNames[0], null], ['2026-01-05', metricNames[1], null],
    ]);
    expect(values[0].title).toContain('2025-12-29 至 2026-01-04 · 到仓记录 4 条');
    expect(values[2].n).toBe(0);
  });
  it('keeps observed zero days distinct from a missing observation, and restricts data to the visible calendar', () => {
    const values = toTrendData([{ ...row, period: '2026-01', median: 0, p90: 0 }], ['2026-01'], 'month');
    expect(values.map(value => value.days)).toEqual([0, 0]);
    expect(values[0].title).toContain('2026 年 1 月');
    expect(toTrendData([row], [], 'week')).toEqual([]);
  });
  it('keeps channel comparisons paired and ordered without recomputing the business metrics', () => {
    const values = toComparisonData([{ ...row, channel: '美森' }, { ...row, channel: '定时达', median: 22, p90: 28 }]);
    expect(values.map(value => [value.channel, value.days])).toEqual([['美森', 16.5], ['美森', 21], ['定时达', 22], ['定时达', 28]]);
    expect(row.median).toBe(16.5);
  });
});
