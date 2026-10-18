import { describe, expect, it } from 'vitest';
import { defaultTransitFilters, readTransitFilters } from './filters';

describe('transit entry and shared URL scopes', () => {
  it('opens an unfiltered landing page at the snapshot-relative 180 day overview', () => {
    expect(readTransitFilters(new URLSearchParams(), '2026-09-25')).toEqual({ warehouse: '', channel: '', region: '', group: '', start: '2026-03-30', end: '2026-09-25' });
  });
  it('preserves all-history links and explicit open-ended dates', () => {
    expect(readTransitFilters(new URLSearchParams('warehouse=ONT8&channel=美森'), '2026-09-25')).toMatchObject({ warehouse: 'ONT8', channel: '美森', start: '', end: '' });
    expect(readTransitFilters(new URLSearchParams('start=&end='), '2026-09-25')).toMatchObject({ start: '', end: '' });
    expect(readTransitFilters(new URLSearchParams('start=2025-02-01'), '2026-09-25')).toMatchObject({ start: '2025-02-01', end: '' });
  });
  it('round-trips the visible default scope so a later data update does not change a shared filter', () => {
    const params = new URLSearchParams({ ...defaultTransitFilters('2026-09-25'), warehouse: 'ONT8' });
    expect(readTransitFilters(params, '2026-10-18')).toMatchObject({ warehouse: 'ONT8', channel: '', start: '2026-03-30', end: '2026-09-25' });
  });
});
