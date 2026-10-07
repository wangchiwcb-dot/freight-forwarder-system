import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA, searchQuotes } from './search';
import type { Quote, SearchCriteria } from './types';

const quote = (patch: Partial<Quote> = {}): Quote => ({
  id: 'test', providerId: 'agency', providerName: '代理', isOwn: false,
  channelName: '测试空运', countryCode: 'US', mode: 'air', delivery: 'amazon', origin: '深圳',
  destinationLabel: '美国仓', warehouseCodes: ['ONT8'], postalPrefixes: [],
  cargoTypes: ['general'], cargoCertainty: 'explicit', billingBasis: 'kg', currency: 'CNY',
  currencyEvidence: 'explicit', tiers: [{ label: '0kg以上', min: 0, max: null, price: 10, status: 'priced', sourceCell: 'C5' }],
  volumetricDivisor: 6000, minShipmentKg: null, minPieceKg: null, minCbm: null, maxKgPerCbm: null,
  transitText: '参考10天', notes: [], priceDate: '2026-10-06', effectiveAt: '2026-10-06', dateKind: 'explicit',
  status: 'reference', reviewReasons: [], reliability: { level: 'unknown', note: '无走货记录' },
  source: { fileId: 'sheet', fileName: 'test.xlsx', sheet: '空运', cells: ['C5'], hidden: false },
  ...patch,
});
const criteria = (patch: Partial<SearchCriteria> = {}): SearchCriteria => ({
  ...DEFAULT_CRITERIA, actualKg: 100, volumeCbm: 0.3, pieces: 1, asOf: '2026-10-07', ...patch,
});
afterEach(() => vi.useRealTimers());

describe('shipment baseline estimates', () => {
  it('uses the same shipment cost to expose the own CBM advantage over KG', () => {
    const own = quote({ id: 'cbm', isOwn: true, billingBasis: 'cbm', densityConversionKgPerCbm: 500,
      minCbm: 0.1, tiers: [{ label: '0.1方起', min: 0.1, max: null, price: 1190.376, status: 'priced', sourceCell: 'G9' }] });
    const results = searchQuotes([quote({ id: 'kg' }), own], criteria({ actualKg: 500, volumeCbm: 1 }));
    expect(results.map((item) => item.quote.id)).toEqual(['cbm', 'kg']);
    expect(results.map((item) => item.estimatedCost)).toEqual([1190.376, 5000]);
  });
  it('converts dense own-line cargo to chargeable CBM rather than rejecting it', () => {
    const own = quote({ billingBasis: 'cbm', densityConversionKgPerCbm: 500, volumeEquivalentKgPerCbm: 167,
      tiers: [{ label: '0.1方起', min: 0.1, max: null, price: 1190.376, status: 'priced', sourceCell: 'G9' }] });
    const [result] = searchQuotes([own], criteria({ actualKg: 1000, volumeCbm: 1 }));
    expect(result.eligible).toBe(true);
    expect(result.chargeableQuantity).toBe(2);
    expect(result.estimatedCost).toBe(2380.752);
  });
  it('does enforce an explicit maximum density restriction', () => {
    const limited = quote({ billingBasis: 'cbm', maxKgPerCbm: 500 });
    const [result] = searchQuotes([limited], criteria({ actualKg: 1000, volumeCbm: 1 }));
    expect(result.estimatedCost).toBeNull();
    expect(result.eligible).toBe(false);
    expect(result.warnings.join(' ')).toContain('超过');
  });
  it('requires real weight for a density-dependent CBM tariff', () => {
    const [result] = searchQuotes([quote({ billingBasis: 'cbm', densityConversionKgPerCbm: 500 })], criteria({ actualKg: null }));
    expect(result.estimatedCost).toBeNull();
    expect(result.warnings.join(' ')).toContain('需填写实重');
  });
  it('converts cubic metres with a centimetre volumetric divisor', () => {
    const [result] = searchQuotes([quote()], criteria({ actualKg: 100, volumeCbm: 1.2 }));
    expect(result.chargeableQuantity).toBe(200);
    expect(result.estimatedCost).toBe(2000);
  });
  it('keeps per-piece max weight and rounding as explicit limitations', () => {
    const [result] = searchQuotes([quote({ minPieceKg: 10, minShipmentKg: 50 })], criteria({ actualKg: 25, volumeCbm: 0.1, pieces: 4 }));
    expect(result.chargeableQuantity).toBe(50);
    expect(result.warnings.join(' ')).toContain('逐件取大');
  });
  it('does not fabricate costs without input or complete first/increment rules', () => {
    expect(searchQuotes([quote()], criteria({ actualKg: null }))[0].estimatedCost).toBeNull();
    expect(searchQuotes([quote({ billingBasis: 'first_increment' })], criteria())[0].estimatedCost).toBeNull();
  });
  it('does not mistake missing tier boundaries for a universal price', () => {
    const q = quote({ tiers: [{ label: '待确认', min: null, max: null, price: 5, status: 'priced', sourceCell: 'D9' }] });
    const [result] = searchQuotes([q], criteria());
    expect(result.estimatedCost).toBeNull();
    expect(result.warnings.join(' ')).toContain('未猜测');
  });
  it('blocks overlapping price ranges and honors exclusive edges', () => {
    const tiers: Quote['tiers'] = [
      { label: '0-100kg', min: 0, max: 100, price: 10, status: 'priced', sourceCell: 'A1' },
      { label: '100kg+', min: 100, max: null, price: 9, status: 'priced', sourceCell: 'B1' },
    ];
    const [ambiguous] = searchQuotes([quote({ tiers })], criteria());
    expect(ambiguous.estimatedCost).toBeNull();
    expect(ambiguous.warnings.join(' ')).toContain('重叠');
    tiers[0].maxInclusive = false;
    expect(searchQuotes([quote({ tiers })], criteria())[0].estimatedCost).toBe(900);
  });
  it('avoids floating point artifacts and incorporates explicit fixed fees', () => {
    const q = quote({ tiers: [{ label: '0kg+', min: 0, max: null, price: 0.1, status: 'priced', sourceCell: 'B1', fixedFee: 0.2 }] });
    expect(searchQuotes([q], criteria({ actualKg: 1, volumeCbm: 0.001 }))[0].estimatedCost).toBe(0.3);
  });
  it('does not multiply a per-parcel tariff using combined or assumed average weight', () => {
    const parcel = quote({ mode: 'parcel', tiers: [{ label: '0kg+', min: 0, max: null, price: 70, fixedFee: 20, status: 'priced', sourceCell: 'C5' }] });
    expect(searchQuotes([parcel], criteria({ pieces: 1, actualKg: 2, volumeCbm: 0.001 }))[0].estimatedCost).toBe(160);
    for (const pieces of [null, 2]) {
      const [result] = searchQuotes([parcel], criteria({ pieces, actualKg: 4, volumeCbm: 0.002 }));
      expect(result.estimatedCost).toBeNull();
      expect(result.warnings.join(' ')).toContain('不按总重或平均重量估算');
    }
  });
  it('rejects invalid numeric input', () => {
    expect(searchQuotes([quote()], criteria({ actualKg: -1 }))[0].eligible).toBe(false);
    expect(searchQuotes([quote()], criteria({ pieces: 1.1 }))[0].estimatedCost).toBeNull();
  });
});

describe('applicability and evidence', () => {
  it('never interprets a generic sensitive label as permission for pure batteries', () => {
    const q = quote({ cargoTypes: ['sensitive'] });
    expect(searchQuotes([q], criteria({ cargo: 'pure_battery' }))).toHaveLength(0);
    expect(searchQuotes([quote()], criteria({ cargo: 'battery' }))).toHaveLength(0);
  });
  it('shows unknown cargo only as an unconfirmed candidate', () => {
    const q = quote({ cargoTypes: [], cargoCertainty: 'unknown' });
    expect(searchQuotes([q], criteria())[0].eligible).toBe(false);
    expect(searchQuotes([q], criteria())[0].estimatedCost).toBeNull();
    expect(searchQuotes([q], criteria({ includePending: false }))).toHaveLength(0);
  });
  it('retains postal-code leading zeros and exact warehouse codes', () => {
    const q = quote({ postalPrefixes: ['09'], warehouseCodes: ['ONT8'] });
    expect(searchQuotes([q], criteria({ destination: '09301' }))).toHaveLength(1);
    expect(searchQuotes([q], criteria({ destination: '9301' }))).toHaveLength(0);
    expect(searchQuotes([q], criteria({ destination: 'ont8' }))).toHaveLength(1);
    expect(searchQuotes([q], criteria({ destination: 'ONT80' }))).toHaveLength(0);
  });
  it('matches explicit postal ranges, enumerations and literal city labels', () => {
    const q = quote({ postalRanges: [{ start: '09000', end: '09999' }], postalCodes: ['01234'], destinationLabel: '洛杉矶 Los Angeles' });
    expect(searchQuotes([q], criteria({ destination: '09301' }))).toHaveLength(1);
    expect(searchQuotes([q], criteria({ destination: '01234' }))).toHaveLength(1);
    expect(searchQuotes([q], criteria({ destination: '09301-2345' }))).toHaveLength(1);
    expect(searchQuotes([q], criteria({ destination: '01235' }))).toHaveLength(0);
    expect(searchQuotes([q], criteria({ destination: '9301' }))).toHaveLength(0);
    expect(searchQuotes([q], criteria({ destination: '洛杉矶' }))[0].warnings.join(' ')).toContain('城市文本');
  });
  it('does not automatically cover the UK with an EU-wide tariff', () => {
    const q = quote({ countryCode: 'EU' });
    expect(searchQuotes([q], criteria({ country: 'GB' }))).toHaveLength(0);
    expect(searchQuotes([q], criteria({ country: 'DE' }))[0].eligible).toBe(false);
  });
  it('blocks explicit future prices but only warns about inferred filename dates', () => {
    const future = quote({ effectiveAt: '2026-10-08T18:00:00+08:00', priceDate: '2026-10-08' });
    const [result] = searchQuotes([future], criteria());
    expect(result.eligible).toBe(false);
    expect(result.estimatedCost).toBeNull();
    expect(searchQuotes([future], criteria({ includePending: false }))).toHaveLength(0);
    expect(searchQuotes([future], criteria({ asOf: '2026-10-09' }))[0].estimatedCost).toBe(1000);
    const inferred = quote({ effectiveAt: null, priceDate: '2026-10-08', dateKind: 'filename' });
    expect(searchQuotes([inferred], criteria())[0].warnings.join(' ')).toContain('实际生效时间需确认');
  });
  it('respects same-day effective hours using current China time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T15:00:00+08:00'));
    const timed = quote({ effectiveAt: '2026-10-07T18:00:00+08:00', priceDate: '2026-10-07' });
    expect(searchQuotes([timed], criteria())[0].eligible).toBe(false);
    expect(searchQuotes([timed], criteria())[0].estimatedCost).toBeNull();
    vi.setSystemTime(new Date('2026-10-07T18:01:00+08:00'));
    expect(searchQuotes([timed], criteria())[0].eligible).toBe(true);
    expect(searchQuotes([timed], criteria())[0].estimatedCost).toBe(1000);
    vi.setSystemTime(new Date('2026-10-09T15:00:00+08:00'));
    expect(searchQuotes([timed], criteria())[0].warnings.join(' ')).toContain('按该日末判断');
    expect(searchQuotes([timed], criteria())[0].eligible).toBe(true);
  });
  it('applies provider, own source and delivery-type filters', () => {
    const own = quote({ id: 'own', isOwn: true, providerId: 'own' });
    expect(searchQuotes([own, quote()], criteria({ onlyOwn: true }))).toHaveLength(1);
    expect(searchQuotes([own, quote()], criteria({ providerId: 'own' }))).toHaveLength(1);
    expect(searchQuotes([own], { ...criteria(), delivery: 'residential' })).toHaveLength(0);
  });
  it('separates shipping-origin prices and retains unknown origin only as pending', () => {
    const shenzhen = quote({ id: 'sz', origin: '深圳/广州' });
    const qingdao = quote({ id: 'qd', origin: '青岛/临沂' });
    const unknown = quote({ id: 'unknown', origin: '按原表交仓' });
    const found = searchQuotes([shenzhen, qingdao, unknown], criteria({ origin: '深圳' }));
    expect(found.map((item) => item.quote.id)).toEqual(['sz', 'unknown']);
    expect(found[1].eligible).toBe(false);
    expect(found[1].estimatedCost).toBeNull();
    expect(searchQuotes([unknown], criteria({ origin: '深圳', includePending: false }))).toHaveLength(0);
  });
  it('allows browsing a usable tariff without entering shipment weight', () => {
    const [result] = searchQuotes([quote()], criteria({ actualKg: null, volumeCbm: null, includePending: false }));
    expect(result.eligible).toBe(true);
    expect(result.estimatedCost).toBeNull();
  });
});

describe('comparison semantics', () => {
  it('keeps currencies and unit-price bases in separate comparison groups', () => {
    const cbm = quote({ id: 'cbm', billingBasis: 'cbm', tiers: [{ label: '0方+', min: 0, max: null, price: 900, status: 'priced', sourceCell: 'A1' }] });
    const kg = quote({ id: 'kg' });
    const usd = quote({ id: 'usd', currency: 'USD' });
    const result = searchQuotes([usd, kg, cbm], criteria({ sort: 'unit' }));
    expect(result.map((item) => item.quote.id)).toEqual(['cbm', 'kg', 'usd']);
  });
  it('does not turn declared transit speed into an invented reliability score', () => {
    const slow = quote({ id: 'slow', transitText: '30天' });
    const fast = quote({ id: 'fast', transitText: '3天' });
    const result = searchQuotes([slow, fast], criteria({ sort: 'reliability' }));
    expect(result.map((item) => item.quote.id)).toEqual(['slow', 'fast']);
    expect(result.every((item) => item.warnings.includes('尚无实际走货稳定性记录'))).toBe(true);
  });
  it('does not calculate or rank an unconfirmed currency amount as a valid cost', () => {
    const q = quote({ currencyEvidence: 'unconfirmed' });
    expect(searchQuotes([q], criteria())[0].estimatedCost).toBeNull();
  });
});
