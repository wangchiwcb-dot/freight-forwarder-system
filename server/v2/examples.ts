import type { Offer, Rule } from '../../src/domain/v2/pricing-contracts';
import type { Condition } from '../../src/domain/v2/contracts';

const threshold = (field: 'package.longestCm' | 'package.secondCm' | 'package.girthCm' | 'package.actualKg', op: 'gt' | 'gte', value: string): Condition => ({ field, op, value });
const any = (...conditions: Condition[]): Condition => ({ op: 'any', conditions });
const rule = (id: string, label: string, condition: Condition | null, rate: string | null, extra: Partial<Rule> = {}): Rule => ({
  id, label, kind: 'fee', scope: 'shipment', condition, inclusion: 'additional', basis: 'shipment', rate,
  percentBase: [], minimum: null, maximum: null, evidence: '用户于 2026-10-26 提供的示例及边界确认。', ...extra,
});
const address: Condition = { op: 'eq', field: 'destination.addressType', value: 'residential' };
const base = (country: string, mode: Offer['mode'], rate: string): Offer => ({
  id: `example_${country.toLowerCase()}_${mode}`, providerId: 'user_examples', providerName: '用户提供示例', isOwn: false,
  channelId: `example_${country.toLowerCase()}_${mode}`, name: `${country} ${mode} 示例`, mode, lastMile: 'express',
  country, origin: null, targets: [], scopeKey: `example_door_delivery_${country}`, serviceDescription: '示例约定的运输及派送范围；不表示实际代理已核价',
  currency: 'CNY', costBasis: 'supplier_purchase', status: 'draft', sourceKind: 'example', validFrom: null, validTo: null,
  reviewed: false, cargoReviewed: false, acceptedAttributes: [], reviewReasons: ['待对应实际代理、服务范围和报价版本'],
  billing: { basis: 'kg', aggregation: 'piece', volumetricDivisor: null, quantityStep: null, dimensionStepCm: null,
    minimumQuantity: '0', minimumPieceKg: '0', densityKgPerCbm: null, verified: false },
  tiers: [{ id: 'base_tier', min: '0', max: null, minInclusive: true, maxInclusive: false, unitPrice: rate, status: 'priced' }],
  rules: [], notes: ['所有价格均为成本价格；本记录仅作示例试算。', '基础运费与附加费分别展示；最终按入仓数据复算。'], transitText: '',
  sourceEvidence: [{ sourceId: null, sheet: null, cells: [], text: '用户于 2026-10-26 提供示例，并确认 UPS 边界和三项附加费累加；示例不关联实际代理。' }],
});

const ups = (country: 'DE' | 'IT', rate: string, weight: string, weightFee: string): Offer => {
  const offer = base(country, 'sea', rate);
  offer.name = country === 'DE' ? '德国海运快递派（示例）' : '意大利海运快递派（示例）';
  offer.rules = [
    rule('deny_infringing', '侵权仿牌拒收', { op: 'eq', field: 'cargo.intellectualProperty', value: 'infringing' }, null, { kind: 'deny' }),
    rule('deny_ups_limits', 'UPS 尺寸或重量超标拒收', any(threshold('package.longestCm', 'gt', '120'),
      threshold('package.secondCm', 'gt', '80'), threshold('package.girthCm', 'gte', '330'), threshold('package.actualKg', 'gt', '40')), null,
      { kind: 'deny', scope: 'package' }),
    rule('address', country === 'DE' ? '私人地址附加费（1 元/计费 kg）' : '私人地址附加费（100 元/票）', address,
      country === 'DE' ? '1' : '100', { basis: country === 'DE' ? 'chargeable_kg' : 'shipment' }),
    rule('ups_size', 'UPS 超长附加费', any(threshold('package.longestCm', 'gte', '97'), threshold('package.secondCm', 'gte', '73')), '280', { scope: 'package', basis: 'piece' }),
    rule('ups_weight', 'UPS 超重附加费', threshold('package.actualKg', 'gte', weight), weightFee, { scope: 'package', basis: 'piece' }),
    rule('ups_girth', 'UPS 围长附加费', threshold('package.girthCm', 'gte', '295'), '1500', { scope: 'package', basis: 'piece' }),
  ];
  offer.notes.push('超长两项同时命中只收一次；超长、超重、围长费用分别累加。', '围长 = 最长边 + 2 ×（其余两边之和），单位 cm；达到 330 cm 拒收。');
  return offer;
};
const spain = (mode: 'road' | 'sea', price: string, transit: string): Offer => {
  const offer = base('ES', mode, price);
  offer.name = mode === 'road' ? '西班牙卡航（示例）' : '西班牙海运（示例）';
  offer.lastMile = 'other'; offer.transitText = transit;
  offer.rules = [
    rule('address', '私人/商业地址附加费（1 元/计费 kg）', { op: 'in', field: 'destination.addressType', values: ['residential', 'commercial'] }, '1', { basis: 'chargeable_kg' }),
    rule('customs', '报关费（每票）', null, '200'),
  ];
  return offer;
};
export const exampleOffers: Offer[] = [ups('DE', '9.6', '35', '465'), ups('IT', '13', '24.5', '280'),
  spain('road', '18.5', '18–22 天提取'), spain('sea', '12.5', '45–55 天提取')];
