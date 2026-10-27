import Decimal from 'decimal.js';
import { evaluateCondition } from './conditions';
import type { Facts } from './contracts';
import { offerSchema, requestSchema, type Billing, type Package, type PricingRequest, type Offer, type CostLine, type QuoteResult } from './pricing-contracts';

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const ceil = (value: Decimal, step: string) => new D(step).isZero() ? value : value.div(step).ceil().mul(step);
const total = (values: Decimal[]) => values.reduce((sum, value) => sum.add(value), new D(0));
const money = (value: Decimal) => value.toDecimalPlaces(2).toFixed(2);
export const ENGINE_VERSION = 'quotation-v2/2026-10-26.4';
const factLabels: Record<string, string> = {
  'package.actualKg': '单箱实重', 'package.longestCm': '最长边', 'package.secondCm': '次长边',
  'package.girthCm': '完整箱规（用于计算围长）', 'cargo.intellectualProperty': '侵权仿牌情况',
  'cargo.attributes': '货品属性', 'destination.addressType': '地址类型',
  'destination.countryCode': '目的国家', 'destination.postalCode': '邮编', 'destination.warehouseCode': '仓码',
};
const missing = (fields: string[]) => fields.map(field => factLabels[field] ?? field).join('、');

function packageFacts(item: Package, billing: Billing): Facts {
  const facts: Facts = { 'package.actualKg': item.actualKg };
  const dims = [item.lengthCm, item.widthCm, item.heightCm];
  if (dims.some(value => value === null)) return facts;
  const measured = dims.map(value => new D(value!));
  // UPS acceptance thresholds use measured dimensions. Billing dimension rounding
  // belongs to the volume calculation below, not to the refusal threshold.
  measured.sort((a, b) => b.comparedTo(a));
  return { ...facts, 'package.lengthCm': item.lengthCm, 'package.widthCm': item.widthCm,
    'package.heightCm': item.heightCm, 'package.longestCm': measured[0].toString(),
    'package.secondCm': measured[1].toString(),
    'package.girthCm': measured[0].add(measured[1].add(measured[2]).mul(2)).toString() };
}

function volume(item: Package, billing: Billing): Decimal | null {
  if ([item.lengthCm, item.widthCm, item.heightCm].some(value => value === null) || billing.dimensionStepCm === null) return null;
  return [item.lengthCm!, item.widthCm!, item.heightCm!]
    .reduce((product, value) => product.mul(ceil(new D(value), billing.dimensionStepCm!)), new D(1)).div(1e6);
}

export function quantity(input: PricingRequest, billing: Billing): { value: Decimal | null; pieces: number | null; reasons: string[] } {
  const reasons: string[] = [];
  if (!billing.verified) reasons.push('渠道计费规则尚未核实');
  if (billing.quantityStep === null) reasons.push('缺少计费数量进位规则');
  if (billing.volumeStepCbm === null) reasons.push('缺少整票体积进位规则');
  if (billing.aggregation === 'piece' && new D(billing.volumeStepCbm ?? '0').gt(0)) reasons.push('整票体积进位不能直接套用逐箱取大，请核实计费方式');
  if (billing.basis === 'kg' && billing.volumetricDivisor === null) reasons.push('缺少材积系数');
  const grouped = input.packages.length > 0;
  const pieces = grouped ? input.packages.reduce((sum, item) => sum + item.pieces, 0) : input.pieces;
  const weightsComplete = grouped && input.packages.every(item => item.actualKg !== null);
  const weights = weightsComplete ? input.packages.map(item => new D(item.actualKg!).mul(item.pieces)) : [];
  const volumes = input.packages.map(item => volume(item, billing));
  const volumeComplete = grouped && volumes.every(value => value !== null);
  // Package groups are authoritative when supplied. No silent mixture with stale totals.
  const actual = grouped ? weightsComplete ? total(weights) : null : input.actualKg ? new D(input.actualKg) : null;
  const measuredCbm = grouped ? volumeComplete ? total(volumes.map((value, index) => value!.mul(input.packages[index].pieces))) : null
    : input.volumeCbm ? new D(input.volumeCbm) : null;
  const cbm = measuredCbm === null ? null : ceil(measuredCbm, billing.volumeStepCbm ?? '0');
  let value: Decimal | null = null;
  if (billing.basis === 'kg') {
    if (actual === null) reasons.push('缺少实重');
    if (cbm === null) reasons.push(grouped ? '缺少完整箱规或尺寸进位规则' : '缺少体积');
    if (billing.aggregation === 'piece' && !grouped) reasons.push('该渠道逐箱取大，需要每箱实重和箱规');
    const shipmentPieceMinimum = billing.aggregation === 'shipment' && new D(billing.minimumPieceKg).gt(0);
    if (shipmentPieceMinimum && billing.minimumPieceApplication !== 'actual_before_shipment_max') reasons.push('单箱最低计费与整票取大的计算顺序尚未核实');
    if (shipmentPieceMinimum && !grouped) reasons.push('单件最低计费需要每箱实重，不能仅用整票重量和件数估算');
    if (reasons.length === 0 && actual && cbm) {
      if (billing.aggregation === 'piece') {
        value = total(input.packages.map((item, index) => ceil(D.max(item.actualKg!, volumes[index]!.mul(1e6).div(billing.volumetricDivisor!), billing.minimumPieceKg), billing.quantityStep!).mul(item.pieces)));
      } else {
        const billedActual = shipmentPieceMinimum
          ? total(input.packages.map(item => D.max(item.actualKg!, billing.minimumPieceKg).mul(item.pieces))) : actual;
        value = D.max(billedActual, cbm.mul(1e6).div(billing.volumetricDivisor!));
      }
    }
  } else {
    if (new D(billing.minimumPieceKg).gt(0)) reasons.push('按方运费的单件最低公斤计费暂不支持');
    if (cbm === null) reasons.push('缺少体积或完整箱规');
    if (billing.densityKgPerCbm !== null && actual === null) reasons.push('密度换算需要实重');
    if (billing.aggregation === 'piece') reasons.push('按方逐箱计费尚未配置，需复核');
    if (reasons.length === 0 && cbm) value = billing.densityKgPerCbm ? D.max(cbm, actual!.div(billing.densityKgPerCbm)) : cbm;
  }
  if (value !== null) value = ceil(D.max(value, billing.minimumQuantity), billing.quantityStep!);
  return { value, pieces, reasons };
}

function calculate(offer: Offer, input: PricingRequest): QuoteResult {
  const trial = offer.sourceKind === 'example';
  const unitMismatch = trial && input.trialBilling !== null && input.trialBilling.basis !== offer.billing.basis;
  const billing = trial && input.trialBilling && !unitMismatch ? input.trialBilling : offer.billing;
  const reasons: string[] = [];
  if (unitMismatch) reasons.push('试算计费单位与该报价单价单位不一致');
  const lines: CostLine[] = [];
  let rejected = false;
  const reject = (message: string) => { rejected = true; reasons.push(message); };
  if (offer.status === 'revoked') reject('该报价已撤销');
  if (!trial && offer.status !== 'published') reasons.push('报价尚未发布');
  if (!trial && (!offer.reviewed || !offer.cargoReviewed)) reasons.push('渠道承运与收费范围尚未核实');
  if (!trial && !offer.validFrom) reasons.push('报价生效日期尚未确认');
  if (offer.validFrom && input.asOf < offer.validFrom) reject('尚未到报价生效日期');
  if (offer.validTo && input.asOf >= offer.validTo) reject('报价已过有效期');
  if (offer.costBasis === 'customer_sale' || offer.costBasis === 'unknown') reasons.push('采购成本口径未确认');
  if (!trial && !offer.origin) reasons.push('交仓点尚未核实');
  if (!trial && !input.origin) reasons.push('请填写交仓点');
  if (offer.origin && input.origin && offer.origin !== input.origin) reject('交仓点不同，未补齐转运成本');
  if (!trial && !offer.scopeKey) reasons.push('服务与税费比较口径未核实');
  if (offer.targets.length) {
    const coverage = offer.targets.map(target => {
      const value = (target.kind === 'warehouse' ? input.warehouseCode : input.postalCode).trim().toUpperCase();
      if (!value) return null;
      const expected = target.value.trim().toUpperCase();
      if (target.kind === 'postal_prefix') return value.startsWith(expected);
      if (target.kind === 'postal_range') {
        if (!/^\d{5}(?:-\d{4})?$/.test(value)) return null;
        return value.slice(0, 5) >= expected.slice(0, 5) && value.slice(0, 5) <= expected.slice(6);
      }
      return value === expected;
    });
    if (!coverage.includes(true)) {
      if (coverage.includes(null)) reasons.push('缺少此渠道需要的完整目的邮编或仓码');
      else reject('目的地不在此渠道覆盖范围');
    }
  }
  if (input.cargoAttributes === null) reasons.push('货品属性未确认');
  else if (input.cargoAttributes.some(attribute => !offer.acceptedAttributes.includes(attribute))) reasons.push('部分货品属性尚无明确承运依据');
  if (!trial) reasons.push(...offer.reviewReasons);
  const facts: Facts = {
    'destination.countryCode': input.country,
    'destination.addressType': input.addressType === 'unknown' ? null : input.addressType,
    'destination.postalCode': input.postalCode || null, 'destination.warehouseCode': input.warehouseCode || null,
    'cargo.attributes': input.cargoAttributes,
    'cargo.intellectualProperty': input.intellectualProperty === 'unknown' ? null : input.intellectualProperty,
    'shipment.actualKg': input.packages.length ? input.packages.every(item => item.actualKg !== null)
      ? total(input.packages.map(item => new D(item.actualKg!).mul(item.pieces))).toString() : null : input.actualKg,
    'shipment.pieces': input.packages.length ? String(input.packages.reduce((sum, item) => sum + item.pieces, 0)) : input.pieces?.toString() ?? null,
    'shipment.volumeCbm': input.packages.length ? null : input.volumeCbm,
  };
  const counted = quantity(input, billing);
  reasons.push(...counted.reasons);
  const contexts = (scope: 'shipment' | 'package') => scope === 'shipment' ? [{ facts, item: null as Package | null }]
    : input.packages.length ? input.packages.map(item => ({ facts: { ...facts, ...packageFacts(item, billing) }, item })) : [{ facts, item: null as Package | null }];
  for (const rule of offer.rules.filter(rule => rule.kind === 'deny')) {
    for (const context of contexts(rule.scope)) {
      const result = rule.condition ? evaluateCondition(rule.condition, context.facts) : { state: 'matched', missingFields: [] };
      if (result.state === 'matched') reject(`${context.item ? `包装组 ${context.item.id}：` : ''}${rule.label}`);
      else if (result.state === 'unknown') reasons.push(`${rule.label}：缺少 ${missing(result.missingFields)}`);
    }
  }
  if (counted.value !== null && !rejected) {
    const matches = offer.tiers.filter(tier => (tier.minInclusive ? counted.value!.gte(tier.min) : counted.value!.gt(tier.min)) &&
      (tier.max === null || (tier.maxInclusive ? counted.value!.lte(tier.max) : counted.value!.lt(tier.max))));
    if (matches.length !== 1) reasons.push(matches.length ? '价格档位重叠，需复核' : '计费数量未命中价格档位');
    else if (matches[0].status === 'unavailable') reject('本价格档位不可承运');
    else if (matches[0].status !== 'priced' || matches[0].unitPrice === null) reasons.push('本价格档位需询价');
    else lines.push({ ruleId: 'base', label: '基础运费', packageId: null, quantity: counted.value.toString(), unitPrice: matches[0].unitPrice,
      amount: money(counted.value.mul(matches[0].unitPrice)), inclusion: 'additional', evidence: `${offer.name}，按${billing.basis === 'kg' ? '计费重' : '计费体积'}计算` });
  }
  // A percentage rule runs only after each named dependency has been resolved.
  const fees = offer.rules.filter(rule => rule.kind === 'fee');
  const ruleIds = new Set(offer.rules.map(rule => rule.id));
  if (ruleIds.size !== offer.rules.length || ruleIds.has('base')) throw new Error('规则编号重复或使用了保留编号 base');
  const pending = [...fees];
  const resolved = new Set<string>(['base']);
  const amounts = new Map<string, Decimal | null>([['base', lines.find(line => line.ruleId === 'base')?.amount ? new D(lines[0].amount!) : null]]);
  while (pending.length && !rejected) {
    const index = pending.findIndex(rule => rule.basis !== 'percentage' || rule.percentBase.every(ref => resolved.has(ref)));
    if (index < 0) { reasons.push('百分比费用引用缺失或存在循环'); break; }
    const rule = pending.splice(index, 1)[0];
    let feeAmount: Decimal | null = new D(0);
    for (const context of contexts(rule.scope)) {
      const result = rule.condition ? evaluateCondition(rule.condition, context.facts) : { state: 'matched', missingFields: [] };
      if (result.state === 'not_matched') continue;
      const line: CostLine = { ruleId: rule.id, label: rule.label, packageId: context.item?.id ?? null,
        quantity: null, unitPrice: rule.rate, amount: null, inclusion: rule.inclusion, evidence: rule.evidence };
      if (result.state === 'unknown') {
        reasons.push(`${rule.label}：缺少 ${missing(result.missingFields)}`); feeAmount = null; lines.push(line); continue;
      }
      if (rule.inclusion === 'included' || rule.inclusion === 'exempt') {
        line.amount = '0.00'; lines.push(line); continue;
      }
      if (rule.inclusion === 'unknown' || rule.rate === null) {
        reasons.push(`${rule.label}：是否收费或金额待确认`); feeAmount = null; lines.push(line); continue;
      }
      let units: Decimal | null = null;
      if (rule.basis === 'shipment') units = new D(1);
      if (rule.basis === 'piece') units = context.item ? new D(context.item.pieces) : rule.scope === 'shipment' && counted.pieces !== null ? new D(counted.pieces) : null;
      if (['chargeable_quantity', 'chargeable_kg', 'chargeable_cbm'].includes(rule.basis)) {
        if (rule.scope === 'package') { reasons.push(`${rule.label}：逐件按计费量附加费尚需单独核实`); }
        else if (rule.basis === 'chargeable_kg' && billing.basis !== 'kg' || rule.basis === 'chargeable_cbm' && billing.basis !== 'cbm') {
          reasons.push(`${rule.label}：附加费单位与基础运费不同，需单独核实计费数量`);
        }
        else units = counted.value;
      }
      if (rule.basis === 'percentage' && rule.percentBase.length && rule.percentBase.every(ref => amounts.get(ref) !== null)) {
        units = total(rule.percentBase.map(ref => amounts.get(ref)!)).div(100);
      }
      if (units === null) { reasons.push(`${rule.label}：缺少计费数量或费用基数`); feeAmount = null; lines.push(line); continue; }
      let amount = units.mul(rule.rate);
      const applications = rule.scope === 'package' && rule.basis === 'piece' ? context.item!.pieces : 1;
      if (rule.minimum !== null) amount = D.max(amount, new D(rule.minimum).mul(applications));
      if (rule.maximum !== null) amount = D.min(amount, new D(rule.maximum).mul(applications));
      line.quantity = units.toString(); line.amount = money(amount); lines.push(line);
      if (feeAmount !== null) feeAmount = feeAmount.add(line.amount);
    }
    resolved.add(rule.id); amounts.set(rule.id, feeAmount);
  }
  if (rejected) lines.length = 0;
  const subtotal = lines.some(line => line.amount !== null) ? total(lines.filter(line => line.amount !== null).map(line => new D(line.amount!))) : null;
  const complete = !rejected && reasons.length === 0 && lines.some(line => line.ruleId === 'base');
  return { offer, state: rejected ? 'rejected' : complete ? 'complete' : 'partial', trial,
    chargeableQuantity: counted.value?.toString() ?? null, knownSubtotal: subtotal ? money(subtotal) : null,
    total: complete && subtotal ? money(subtotal) : null,
    comparisonKey: complete ? `${trial ? 'example' : 'published'}:${offer.scopeKey}:${offer.currency}:${offer.origin ?? ''}` : null,
    lowest: false, lines, reasons: [...new Set(reasons)],
    measurementNotice: input.measurementStage === 'estimated' ? '按当前提供的数据测算，实际费用以入仓重量、尺寸及适用报价复算。' : '已按填写的入仓数据复算；保留原试算记录。' };
}

export function calculateOffers(rawOffers: unknown[], rawRequest: unknown): QuoteResult[] {
  const input = requestSchema.parse(rawRequest);
  const offers = rawOffers.map(raw => offerSchema.parse(raw));
  const results = offers.filter(offer => offer.country === input.country && input.modes.includes(offer.mode) &&
    (offer.sourceKind !== 'example' || input.includeExamples)).map(offer => calculate(offer, input));
  results.sort((a, b) => {
    const rank = { complete: 0, partial: 1, rejected: 2 };
    const state = rank[a.state] - rank[b.state];
    if (state) return state;
    const group = (a.comparisonKey ?? '').localeCompare(b.comparisonKey ?? '');
    if (group) return group;
    return a.total && b.total ? new D(a.total).comparedTo(b.total) || a.offer.id.localeCompare(b.offer.id) : a.offer.id.localeCompare(b.offer.id);
  });
  const minima = new Map<string, string>();
  for (const result of results) if (result.comparisonKey && result.total) {
    if (!minima.has(result.comparisonKey)) minima.set(result.comparisonKey, result.total);
    result.lowest = new D(result.total).eq(minima.get(result.comparisonKey)!);
  }
  return results;
}
