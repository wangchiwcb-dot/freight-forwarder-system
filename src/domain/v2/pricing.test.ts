import { describe, expect, it } from 'vitest';
import { calculateOffers } from './pricing';
import type { Offer, PricingRequest } from './pricing-contracts';
import { exampleOffers } from '../../../server/v2/examples';

export const request = (overrides: Partial<PricingRequest> = {}): PricingRequest => ({
  country: 'DE', origin: '', postalCode: '', warehouseCode: '', addressType: 'residential', cargoAttributes: [],
  intellectualProperty: 'clear', modes: ['sea', 'rail', 'road', 'air'], asOf: '2026-10-26', measurementStage: 'estimated',
  packages: [{ id: 'box1', pieces: 1, actualKg: '20', lengthCm: '50', widthCm: '40', heightCm: '30' }],
  actualKg: null, volumeCbm: null, pieces: null, includeExamples: true,
  // Explicit test assumptions, not supplier-confirmed coefficients.
  trialBilling: { basis: 'kg', aggregation: 'piece', volumetricDivisor: '6000', quantityStep: '1', dimensionStepCm: '0',
    minimumQuantity: '0', minimumPieceKg: '0', densityKgPerCbm: null, verified: true }, ...overrides,
});
const result = (input: Partial<PricingRequest> = {}) => calculateOffers(exampleOffers, request(input))[0];
const box = (actualKg: string, lengthCm: string, widthCm: string, heightCm: string, pieces = 1) => [{ id: 'box1', pieces, actualKg, lengthCm, widthCm, heightCm }];

describe('V2 user quotation examples', () => {
  it.each([['0.1', '17'], ['0.100001', '34'], ['0.2', '34'], ['0.200001', '50']])(
    'rounds shipment volume %s to 0.1 CBM before converting and rounding KG', (volumeCbm, expected) => {
      const quote = result({ packages: [], actualKg: '1', volumeCbm, pieces: 1,
        trialBilling: { ...request().trialBilling!, aggregation: 'shipment', volumeStepCbm: '0.1' } });
      expect(quote.chargeableQuantity).toBe(expected);
    });
  it('sums package volumes before CBM rounding, then compares actual weight without rounding individual boxes', () => {
    const input = { packages: box('1', '50', '40', '20', 2),
      trialBilling: { ...request().trialBilling!, aggregation: 'shipment' as const, volumeStepCbm: '0.1' } };
    expect(result(input).chargeableQuantity).toBe('17'); // 2 * .04 => .1 => 16.667 => 17
    expect(result({ ...input, packages: box('20.01', '50', '40', '20', 2) }).chargeableQuantity).toBe('41');
    expect(result({ ...input, trialBilling: { ...input.trialBilling, volumeStepCbm: '0' } }).chargeableQuantity).toBe('14');
    expect(result({ ...input, trialBilling: { ...input.trialBilling, aggregation: 'piece' } }).total).toBeNull();
  });
  it.each([['00001', 'complete'], ['39999', 'complete'], ['39999-1234', 'complete'], ['40000', 'rejected'], ['', 'partial'], ['ABC', 'partial']])(
    'matches five-digit postal ranges including leading zeros and ZIP+4: %s', (postalCode, state) => {
      const offer: Offer = { ...exampleOffers[0], targets: [{ kind: 'postal_range', value: '00001-39999' }] };
      expect(calculateOffers([offer], request({ postalCode }))[0].state).toBe(state);
    });
  it('requires the relevant destination identifier instead of rejecting on an unrelated supplied identifier', () => {
    const offer: Offer = { ...exampleOffers[0], targets: [{ kind: 'warehouse', value: 'ONT8' }] };
    expect(calculateOffers([offer], request({ postalCode: '91761' }))[0].state).toBe('partial');
    expect(calculateOffers([offer], request({ warehouseCode: ' ont8 ' }))[0].state).toBe('complete');
    expect(calculateOffers([{ ...offer, targets: [{ kind: 'postal_prefix', value: '91' }] }], request({ postalCode: '91761' }))[0].state).toBe('complete');
  });
  it('uses chargeable weight for German residential cost and a per-shipment Italian charge', () => {
    expect(result().total).toBe('212.00');
    expect(result({ country: 'IT' }).total).toBe('360.00');
    expect(result({ country: 'IT', packages: box('20', '50', '40', '30', 3) }).total).toBe('880.00');
    expect(result({ addressType: 'commercial' }).total).toBe('192.00');
  });
  it('keeps parcel size and weight charges separate and adds all three fees per affected box', () => {
    const quote = result({ packages: box('35', '120', '73', '15', 2) }); // girth=296; 21.9 volumetric kg each
    expect(quote.chargeableQuantity).toBe('70');
    expect(quote.total).toBe('5232.00'); // 70*10.6 + 2*(280+465+1500)
    expect(quote.lines.filter(line => line.ruleId === 'ups_size')).toHaveLength(1);
    expect(quote.lines.find(line => line.ruleId === 'ups_size')?.amount).toBe('560.00');
  });
  it.each([
    ['96.99', '50', '20', 'not_matched'], ['97', '50', '20', 'matched'],
    ['80', '72.99', '20', 'not_matched'], ['80', '73', '20', 'matched'],
  ])('checks length boundary at %s × %s × %s', (length, width, height, expected) => {
    const quote = result({ packages: box('20', length, width, height) });
    expect(quote.lines.some(line => line.ruleId === 'ups_size')).toBe(expected === 'matched');
  });
  it.each([['DE', '34.999', false], ['DE', '35', true], ['IT', '24.499', false], ['IT', '24.5', true]])(
    '%s has its own weight threshold %s', (country, weight, charged) => {
      expect(result({ country, packages: box(weight, '50', '40', '30') }).lines.some(line => line.ruleId === 'ups_weight')).toBe(charged);
    });
  it.each([
    ['40.01', '50', '40', '30'], ['20', '120.01', '50', '20'], ['20', '100', '80.01', '20'],
    ['20', '120', '80', '25'], // exactly 330: refusal takes precedence over the fee's former upper bound
  ])('rejects UPS package %s kg, %s × %s × %s', (weight, length, width, height) => {
    const quote = result({ packages: box(weight, length, width, height) });
    expect(quote.state).toBe('rejected'); expect(quote.lines).toEqual([]); expect(quote.total).toBeNull();
  });
  it('charges girth from 295 up to but excluding 330 and permits exactly 40 kg', () => {
    expect(result({ packages: box('40', '120', '80', '24.99') }).state).toBe('complete');
    expect(result({ packages: box('20', '115', '70', '20') }).lines.find(line => line.ruleId === 'ups_girth')?.amount).toBe('1500.00');
    expect(result({ packages: box('20', '114.99', '70', '20') }).lines.some(line => line.ruleId === 'ups_girth')).toBe(false);
  });
  it('sorts dimensions instead of assuming the input length is longest', () => {
    expect(result({ packages: box('35', '15', '120', '73') }).total)
      .toBe(result({ packages: box('35', '120', '73', '15') }).total);
  });
  it('bills Spain commercial/residential +1 per kg and customs once per shipment', () => {
    const quotes = calculateOffers(exampleOffers, request({ country: 'ES', addressType: 'commercial', packages: box('20', '50', '40', '30', 3) }));
    expect(quotes.map(quote => quote.total)).toEqual(['1010.00', '1370.00']);
    expect(quotes[0].lowest).toBe(true); expect(quotes[1].lowest).toBe(false);
    expect(quotes[0].offer.transitText).toBe('45–55 天提取');
  });
  it('requires package facts and unknown address/IP information without guessing a zero fee', () => {
    expect(result({ packages: [], actualKg: '100', volumeCbm: '1', pieces: 5 }).state).toBe('partial');
    expect(result({ addressType: 'unknown' }).total).toBeNull();
    expect(result({ intellectualProperty: 'unknown' }).total).toBeNull();
    expect(result({ intellectualProperty: 'infringing' }).state).toBe('rejected');
    expect(result({ trialBilling: null }).total).toBeNull();
  });
  it('takes the maximum per piece, rounds each piece, and distinguishes it from total max', () => {
    const packages = [...box('30', '10', '10', '10'), { id: 'box2', pieces: 1, actualKg: '1', lengthCm: '100', widthCm: '60', heightCm: '30' }];
    expect(result({ packages }).chargeableQuantity).toBe('60');
    expect(result({ packages, trialBilling: { ...request().trialBilling!, aggregation: 'shipment' } }).chargeableQuantity).toBe('31');
    expect(result({ packages: box('20.01', '10', '10', '10', 3) }).chargeableQuantity).toBe('63');
  });
  it('keeps estimated and inbound measurements distinct without changing the supplied numbers', () => {
    expect(result().measurementNotice).toContain('入仓');
    expect(result({ measurementStage: 'warehouse' }).measurementNotice).toContain('已按');
    expect(result({ measurementStage: 'warehouse' }).total).toBe(result().total);
  });
  it('does not apply sample billing overrides to a supplier or rank incomplete supplier costs', () => {
    const supplier: Offer = { ...exampleOffers[0], sourceKind: 'workbook', status: 'published', validFrom: '2026-10-01' };
    const quote = calculateOffers([supplier], request())[0];
    expect(quote.state).toBe('partial'); expect(quote.total).toBeNull(); expect(quote.lowest).toBe(false);
  });
  it('only compares costs in the same currency and service scope', () => {
    const offers = [exampleOffers[0], { ...exampleOffers[0], id: 'usd_example', currency: 'USD' as const }];
    const quotes = calculateOffers(offers, request());
    expect(quotes[0].comparisonKey).not.toBe(quotes[1].comparisonKey);
    expect(quotes.every(quote => quote.lowest)).toBe(true);
  });
  it('supports CBM density conversion and explicit minimum billing separately from KG', () => {
    const quote = calculateOffers([{ ...exampleOffers[0], billing: { ...exampleOffers[0].billing, basis: 'cbm' }, rules: [], tiers: [{ ...exampleOffers[0].tiers[0], unitPrice: '500' }] }],
      request({ packages: [], actualKg: '800', volumeCbm: '1', pieces: 4,
        trialBilling: { ...request().trialBilling!, basis: 'cbm', aggregation: 'shipment', densityKgPerCbm: '500', quantityStep: '0.01' } }))[0];
    expect(quote.chargeableQuantity).toBe('1.6'); expect(quote.total).toBe('800.00');
  });
  it('does not change a KG price into a CBM price via trial parameters', () => {
    expect(result({ trialBilling: { ...request().trialBilling!, basis: 'cbm', aggregation: 'shipment' } }).total).toBeNull();
  });
  it('does not approximate mixed parcel minimum weights using a shipment-wide average', () => {
    const quote = result({ packages: [
      { id: 'a', pieces: 1, actualKg: '30', lengthCm: '10', widthCm: '10', heightCm: '10' },
      { id: 'b', pieces: 1, actualKg: '1', lengthCm: '10', widthCm: '10', heightCm: '10' },
    ], trialBilling: { ...request().trialBilling!, aggregation: 'shipment', minimumPieceKg: '10' } });
    expect(quote.state).toBe('partial'); expect(quote.total).toBeNull();
  });
  it('applies the confirmed minimum to each actual weight before shipment max: the user example is 42 KG', () => {
    const input = { packages: [
      { id:'heavy',pieces:1,actualKg:'30',lengthCm:'50',widthCm:'30',heightCm:'20' }, // .03 CBM / 6000 => 5 KG
      { id:'light',pieces:1,actualKg:'5',lengthCm:'60',widthCm:'50',heightCm:'40' }, // .12 CBM / 6000 => 20 KG
    ], trialBilling:{ ...request().trialBilling!,aggregation:'shipment' as const,volumeStepCbm:'0.1',minimumPieceKg:'12',minimumPieceApplication:'actual_before_shipment_max' as const } };
    const quote=result(input);
    expect(quote.state).toBe('complete'); expect(quote.chargeableQuantity).toBe('42');
    expect(quote.total).toBe('445.20'); // Address charge also uses 42 KG.
    expect(result({ ...input,packages:[input.packages[0],{ ...input.packages[1],pieces:2 }] }).chargeableQuantity).toBe('54');
    expect(result({ ...input,packages:[input.packages[0],{ ...input.packages[1],heightCm:'90' }] }).chargeableQuantity).toBe('50');
  });
  it('rounds once after shipment max and preserves actual weights for fee conditions', () => {
    const offer:Offer={...exampleOffers[0],rules:[{
      ...exampleOffers[0].rules.find(rule=>rule.id==='ups_weight')!,rate:'100',
      condition:{op:'gte',field:'package.actualKg',value:'12'},
    }]};
    const quote=calculateOffers([offer],request({packages:box('11.9','10','10','10',2),trialBilling:{
      ...request().trialBilling!,aggregation:'shipment',volumeStepCbm:'0.1',minimumPieceKg:'12',minimumPieceApplication:'actual_before_shipment_max',
    }}))[0];
    expect(quote.chargeableQuantity).toBe('24'); expect(quote.lines).toHaveLength(1);
    expect(result({packages:box('12.1','10','10','10',2),trialBilling:{ ...request().trialBilling!,aggregation:'shipment',volumeStepCbm:'0.1',minimumPieceKg:'12',minimumPieceApplication:'actual_before_shipment_max' }}).chargeableQuantity).toBe('25');
  });
  it('requires per-box actual weights for a per-box minimum, even with totals and a piece count', () => {
    const quote=result({packages:[],actualKg:'35',volumeCbm:'0.15',pieces:2,trialBilling:{
      ...request().trialBilling!,aggregation:'shipment',volumeStepCbm:'0.1',minimumPieceKg:'12',minimumPieceApplication:'actual_before_shipment_max',
    }});
    expect(quote.chargeableQuantity).toBeNull(); expect(quote.reasons.join(' ')).toContain('需要每箱实重');
  });
  it('keeps a shipment minimum separate from a piece minimum and does not infer missing policies', () => {
    expect(result({packages:box('2','10','10','10',2),trialBilling:{ ...request().trialBilling!,aggregation:'shipment',minimumQuantity:'12' }}).chargeableQuantity).toBe('12');
    expect(result({trialBilling:{ ...request().trialBilling!,aggregation:'shipment',minimumPieceKg:'12',minimumPieceApplication:null }}).total).toBeNull();
  });
});
