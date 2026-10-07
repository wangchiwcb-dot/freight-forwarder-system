import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCatalog, loadQuotes } from './repository';
import type { Catalog, Quote } from '../domain/types';

const catalog: Catalog = {
  schemaVersion: '1.0', version: 'sample-v1', generatedAt: '2026-10-07T00:00:00Z', files: [],
  chunks: [{ country: 'US', path: 'quotes-us.json', count: 1 }],
  stats: { quotes: 1, providers: 1, countries: 1, sources: 1, cbmQuotes: 0 },
};
const sampleQuote: Quote = {
  id: 'sample', providerId: 'agency', providerName: '代理', isOwn: false, channelName: '测试',
  countryCode: 'US', mode: 'sea', delivery: 'amazon', origin: '深圳', destinationLabel: '美西',
  warehouseCodes: ['ONT8'], postalPrefixes: ['09'], cargoTypes: ['general'], cargoCertainty: 'explicit',
  billingBasis: 'kg', currency: 'CNY', currencyEvidence: 'explicit',
  tiers: [{ label: '0kg+', min: 0, max: null, price: 10, status: 'priced', sourceCell: 'C4' }],
  volumetricDivisor: null, minShipmentKg: null, minPieceKg: null, minCbm: null, maxKgPerCbm: null,
  transitText: '', notes: [], priceDate: '2026-10-06', effectiveAt: null, dateKind: 'filename',
  status: 'reference', reviewReasons: [], reliability: { level: 'unknown', note: '' },
  source: { fileId: 'source', fileName: 'source.xlsx', sheet: 'Sheet1', cells: ['C4'], hidden: false },
};
const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
afterEach(() => vi.unstubAllGlobals());

describe('static JSON boundary', () => {
  it('loads and validates the catalogue through the deployment base URL', async () => {
    const fetcher = vi.fn((_path: string) => reply(catalog)); vi.stubGlobal('fetch', fetcher);
    expect((await loadCatalog()).version).toBe('sample-v1');
    expect(fetcher.mock.calls[0][0]).toMatch(/data\/catalog\.json$/);
  });
  it('rejects invalid data instead of presenting corrupt prices', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply({ schemaVersion: '0.1' })));
    await expect(loadCatalog()).rejects.toThrow('报价目录格式无效');
    vi.stubGlobal('fetch', vi.fn(() => reply([{ ...sampleQuote, postalPrefixes: [9] }])));
    await expect(loadQuotes(catalog, 'US')).rejects.toThrow('报价记录格式无效');
  });
  it('fetches only relevant country chunks and never imports EU for the UK', async () => {
    const fetcher = vi.fn((_path: string) => reply([sampleQuote])); vi.stubGlobal('fetch', fetcher);
    const c: Catalog = { ...catalog, chunks: [
      { country: 'US', path: 'quotes-us.json', count: 1 },
      { country: 'GB', path: 'quotes-gb.json', count: 1 },
      { country: 'EU', path: 'quotes-eu.json', count: 1 },
    ] };
    await loadQuotes(c, 'GB');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toMatch(/data\/quotes-gb\.json$/);
  });
  it('hydrates deduplicated rules and preserves leading-zero postal prefixes', async () => {
    const c: Catalog = { ...catalog, chunks: [{ country: 'US', path: 'quotes-us.json', count: 1, rulesPath: 'rules-us.json' }] };
    const fetcher = vi.fn((path: string) => path.includes('rules-')
      ? reply({ shared: ['偏远费需另核'] }) : reply([{ ...sampleQuote, ruleRef: 'shared' }]));
    vi.stubGlobal('fetch', fetcher);
    const [q] = await loadQuotes(c, 'US');
    expect(q.notes).toEqual(['偏远费需另核']);
    expect(q.postalPrefixes).toEqual(['09']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('marks missing rule references for review', async () => {
    const c: Catalog = { ...catalog, chunks: [{ country: 'US', path: 'quotes-us.json', count: 1, rulesPath: 'rules-us.json' }] };
    vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('rules-') ? reply({}) : reply([{ ...sampleQuote, ruleRef: 'missing' }])));
    expect((await loadQuotes(c, 'US'))[0].status).toBe('needs_review');
  });
  it('surfaces network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(loadCatalog()).rejects.toThrow('404');
  });
});
