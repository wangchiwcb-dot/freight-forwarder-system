import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadTransit } from './data';

function fixture() {
  const files = [
    { kind: 'records', file: 'records-2025-test.json', values: [{ id: 'tr_' + 'a'.repeat(20), containerTripId: null, channel: '美森', warehouse: 'ONT8', region: '美西', group: '', channelGroup: '', nodes: { departure: '2025-12-01T00:00:00', arrival: null, unloaded: null, pickup: null, devanning: null, delivered: '2025-12-21T00:00:00' }, status: 'arrived', flags: [], duplicateGroup: null, source: { sheet: '2025', row: 2 } }] },
    { kind: 'warehouses', file: 'warehouses-test.json', values: [{ code: 'ONT8', city: 'Moreno Valley', state: 'CA', region: '美西', group: '', sourceRow: 3, verifiedUS: true, mappingConflict: false, country: 'US', stateNameZh: '加利福尼亚州', postalCode: '92551', address: '24300 Nandina Ave', mappingStatus: 'matched', addressSource: 'workbook', referenceUrls: [], reviewedAt: null, reviewNote: '' }] },
    { kind: 'rules', file: 'rules-test.json', values: [{ group: '美森组一', reminderDays: 15, compensationDays: 16, effectiveFrom: null, effectiveTo: null, sourceRow: 3 }] },
  ];
  const bodies = new Map(files.map(f => [f.file, JSON.stringify(f.values)]));
  const manifest = { schemaVersion: 2, metricsVersion: 'elapsed-naive-seconds_nearest-rank_v1', version: 'test', sourceFile: 'test.xlsx', sourceSha256: 'a'.repeat(64), generatedAt: '2026-10-18T00:00:00Z', dataThrough: '2025-12-21', departureRange: ['2025-12-01', '2025-12-01'], warehouseReviewSha256: 'b'.repeat(64), warehouseReviewedAt: '2026-10-18', exclusions: { records: 0, codes: 0, byCategory: {} }, counts: { records: 1, arrived: 1, unknown: 0, invalid: 0, warehouseCodes: 1, duplicateGroups: 0, duplicateExtraRows: 0 }, flags: {}, sheets: [],
    files: files.map(f => ({ kind: f.kind, file: f.file, count: f.values.length, bytes: Buffer.byteLength(bodies.get(f.file)!), sha256: createHash('sha256').update(bodies.get(f.file)!).digest('hex') })) };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const file = String(url).split('/').at(-1)!;
    return new Response(file === 'manifest.json' ? JSON.stringify(manifest) : bodies.get(file), { status: 200 });
  });
  return { manifest, bodies, fetcher };
}

describe('transit static data loader', () => {
  it('loads all versioned files under the deployment subpath and makes no API calls', async () => {
    const { fetcher } = fixture();
    const data = await loadTransit(undefined, fetcher, '/freight-forwarder-system/');
    expect(data.records).toHaveLength(1);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/freight-forwarder-system/transit/'))).toBe(true);
  });
  it('fails on unreadable manifest, missing shard, corruption and incompatible schema', async () => {
    await expect(loadTransit(undefined, vi.fn(async () => new Response('', { status: 404 })), '/')).rejects.toThrow('版本读取失败');
    const { fetcher, bodies } = fixture(); bodies.set('records-2025-test.json', '[]');
    await expect(loadTransit(undefined, fetcher, '/')).rejects.toThrow('长度校验失败');
    const incompatible = fixture(); incompatible.manifest.schemaVersion = 1;
    await expect(loadTransit(undefined, incompatible.fetcher, '/')).rejects.toThrow('格式无效');
    const missing = fixture();
    const fetchMissing: typeof fetch = (url) => String(url).includes('warehouses-') ? Promise.resolve(new Response('', { status: 404 })) : missing.fetcher(url);
    await expect(loadTransit(undefined, fetchMissing, '/')).rejects.toThrow('分片读取失败');
  });
  it('does not accept a manifest pointing outside the transit directory', async () => {
    const { manifest, fetcher } = fixture(); manifest.files[0].file = '../private.json';
    await expect(loadTransit(undefined, fetcher, '/')).rejects.toThrow('格式无效');
  });
});
