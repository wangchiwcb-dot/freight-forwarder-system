import Decimal from 'decimal.js';
import type {
  CargoType,
  CountryCode,
  Quote,
  QuoteResult,
  RateTier,
  SearchCriteria,
  TransportMode,
} from './types';

/** Country and transport labels are deliberately kept with the domain model. */
export const countryLabels: Record<CountryCode, string> = {
  US: '美国', CA: '加拿大', MX: '墨西哥', GB: '英国', DE: '德国', FR: '法国',
  IT: '意大利', ES: '西班牙', PL: '波兰', CZ: '捷克', EU: '欧洲（未细分）', BR: '巴西',
  AU: '澳大利亚', OTHER: '其他',
};

export const modeLabels: Record<TransportMode, string> = {
  sea: '海运', air: '空运', rail: '铁路', road: '卡航', express: '快递', parcel: '小包', unknown: '未知',
};

export const cargoLabels: Record<CargoType, string> = {
  general: '普货', battery: '带电', magnetic: '带磁', liquid: '液体', powder: '粉末',
  pure_battery: '纯电', sensitive: '敏感货',
};

const chinaDate = (): string => {
  // Intl keeps the default date useful in a browser regardless of the machine's timezone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
};

export const DEFAULT_CRITERIA: SearchCriteria = {
  country: 'US',
  mode: 'all',
  origin: '',
  destination: '',
  cargo: 'general',
  cargoShape: 'all',
  actualKg: null,
  volumeCbm: null,
  pieces: null,
  providerId: '',
  onlyOwn: false,
  includePending: true,
  sort: 'cost',
  asOf: chinaDate(),
};

const asDateOnly = (value: string | null): string | null => {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
};

const isFuture = (quote: Quote, asOf: string, today: string): boolean => {
  if (quote.dateKind === 'filename' && !quote.effectiveAt) return false;
  const date = asDateOnly(quote.effectiveAt) ?? asDateOnly(quote.priceDate);
  if (date == null) return false;
  if (date !== asOf) return date > asOf;
  if (quote.effectiveAt && /[T ]\d{2}:\d{2}/.test(quote.effectiveAt)) {
    const timestamp = quote.effectiveAt.replace(' ', 'T');
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp) ? timestamp : `${timestamp}+08:00`;
    const instant = Date.parse(zoned);
    const cutoff = asOf === today ? Date.now() : Date.parse(`${asOf}T23:59:59.999+08:00`);
    return Number.isFinite(instant) && instant > cutoff;
  }
  return false;
};

const euCountries = new Set<CountryCode>(['DE', 'FR', 'IT', 'ES', 'PL', 'CZ']);
const countryMatches = (quoteCountry: CountryCode, wanted: SearchCriteria['country']): boolean => {
  if (wanted === 'ALL') return true;
  if (quoteCountry === wanted) return true;
  // GB is deliberately absent: an EU quote has no implicit UK coverage.
  return quoteCountry === 'EU' && euCountries.has(wanted as CountryCode);
};

const normalise = (value: string): string => value.trim().toUpperCase();
type Match = { ok: boolean; unknown?: boolean; warning?: string };
const destinationMatches = (quote: Quote, destination: string): Match => {
  const input = normalise(destination);
  if (!input) return { ok: true };
  const warehouses = quote.warehouseCodes.map(normalise).filter(Boolean);
  const prefixes = quote.postalPrefixes.map((value) => normalise(value).replace(/\s/g, '')).filter(Boolean);
  const extended = quote as Quote & { postalCodes?: string[]; postalRanges?: { start: string; end: string }[] };
  const codes = (extended.postalCodes ?? []).map((value) => normalise(value).replace(/\s/g, ''));
  const ranges = extended.postalRanges ?? [];
  const warehouseHit = warehouses.some((code) => code === input);
  const postal = /^\d{5}-\d{4}$/.test(input) ? input.slice(0, 5) : input.replace(/\s/g, '');
  const postalHit = prefixes.some((prefix) => postal.startsWith(prefix)) || codes.includes(postal) ||
    ranges.some(({ start, end }) => /^\d+$/.test(postal) && /^\d+$/.test(start) && /^\d+$/.test(end) &&
      postal.length === start.length && start.length === end.length && postal >= start && postal <= end);
  if (warehouseHit || postalHit) return { ok: true };
  // Numeric postal codes and warehouse-shaped identifiers must match structured
  // evidence. City names can be looked up as a literal substring of the source.
  const isCityText = !/\d/.test(input) && input.length >= 2;
  if (isCityText && normalise(quote.destinationLabel).includes(input)) return { ok: true, warning: '目的地按原表城市文本匹配，具体覆盖范围需核实' };
  if (!warehouses.length && !prefixes.length && !codes.length && !ranges.length) return { ok: false, unknown: true, warning: '该渠道未提供可核验的仓库代码或邮编适用范围' };
  return { ok: false, warning: '目的地未命中该渠道的仓库代码/邮编范围' };
};

const deliveryMatches = (quote: Quote, criteria: SearchCriteria): Match => {
  const wanted = (criteria as SearchCriteria & { delivery?: Quote['delivery'] }).delivery;
  if (!wanted || wanted === 'all') return { ok: true };
  if (quote.delivery === wanted || quote.delivery === 'all') return { ok: true };
  if (quote.delivery === 'unknown') return { ok: false, unknown: true, warning: '派送地址类型未明确，未自动判断适用' };
  return { ok: false, warning: '该渠道未覆盖所选派送地址类型' };
};

const originMatches = (quote: Quote, criteria: SearchCriteria): Match => {
  const wanted = normalise((criteria as SearchCriteria & { origin?: string }).origin ?? '');
  if (!wanted) return { ok: true };
  const origin = normalise(quote.origin);
  if (origin.includes(wanted) || origin === '全国') return { ok: true };
  if (!origin || /按原表|待确认|不详|未知/.test(origin)) return { ok: false, unknown: true, warning: '交仓地未明确，尚未匹配所选交仓地点' };
  return { ok: false, warning: '交仓地点不适用' };
};

const cargoMatches = (quote: Quote, cargo: CargoType): Match => {
  if (quote.cargoCertainty === 'unknown' || quote.cargoTypes.length === 0) {
    return { ok: false, unknown: true, warning: '货品适用性未可靠说明，未自动匹配' };
  }
  if (quote.cargoTypes.includes(cargo)) return { ok: true };
  return { ok: false, warning: `该渠道未明确可接${cargoLabels[cargo]}` };
};

interface QuantityInfo { quantity: Decimal | null; warnings: string[]; blocked?: boolean }
const quantityFor = (quote: Quote, criteria: SearchCriteria): QuantityInfo => {
  const warnings: string[] = [];
  if (quote.billingBasis === 'kg' && quote.tiers.some((tier) => tier.fixedFee != null) && criteria.pieces !== 1) {
    return { quantity: null, warnings: ['该报价含每件/每票固定处理费；请按单件输入重量与箱规，未逐件采集时不按总重或平均重量估算'] };
  }
  const actual = criteria.actualKg == null ? null : new Decimal(criteria.actualKg);
  const volume = criteria.volumeCbm == null ? null : new Decimal(criteria.volumeCbm);
  const pieces = criteria.pieces == null ? null : new Decimal(criteria.pieces);
  let quantity: Decimal | null = null;
  if (quote.billingBasis === 'first_increment') return { quantity: null, warnings: ['首续重计价需要完整首重、续重与进位规则，暂不估算'] };
  if (quote.billingBasis === 'kg') {
    if (actual == null) return { quantity: null, warnings: ['缺少重量，暂不能计算基准运费'] };
    quantity = actual;
    if (quote.volumetricDivisor && volume != null) quantity = Decimal.max(quantity, volume.mul(1_000_000).div(quote.volumetricDivisor));
    else if (quote.volumetricDivisor && volume == null) warnings.push('该渠道可能按材积重计费，缺少体积，基准运费可能偏低');
    else if (!quote.volumetricDivisor) warnings.push('材积/分泡规则未结构化，按已填实重给出基准估算');
    if (quote.minPieceKg != null && pieces != null) quantity = Decimal.max(quantity, new Decimal(quote.minPieceKg).mul(pieces));
    if (quote.minPieceKg != null && pieces == null) warnings.push(`单件最低计费${quote.minPieceKg}kg，缺少件数，未完整计入`);
    if (pieces == null || pieces.gt(1)) warnings.push('缺少每件重量及箱规，整票取大仅为基准，逐件取大和进位可能增加费用');
    if (quote.minShipmentKg != null) quantity = Decimal.max(quantity, quote.minShipmentKg);
  } else if (quote.billingBasis === 'cbm') {
    if (volume == null) return { quantity: null, warnings: ['缺少体积，暂不能计算CBM基准运费'] };
    quantity = volume;
    // Some own-line CBM tariffs settle a heavy shipment by converting actual
    // kg back into CBM (for example max(volume, actual/500)). This is a
    // conversion rule, not a max-density rejection rule.
    const conversion = quote.densityConversionKgPerCbm;
    if (conversion != null && conversion > 0 && actual != null) quantity = Decimal.max(quantity, actual.div(conversion));
    if ((conversion != null || quote.maxKgPerCbm != null) && actual == null) return { quantity: null, warnings: ['该体积渠道有密度规则，需填写实重后估算'] };
    if (quote.minCbm != null) quantity = Decimal.max(quantity, quote.minCbm);
    if (quote.maxKgPerCbm != null && actual != null && volume.gt(0) && actual.div(volume).gt(quote.maxKgPerCbm)) {
      warnings.push(`密度超过该CBM渠道上限${quote.maxKgPerCbm}kg/m³，阻止误估`);
      return { quantity: null, warnings, blocked: true };
    }
  } else if (quote.billingBasis === 'parcel') {
    if (pieces == null) return { quantity: null, warnings: ['缺少件数，暂不能计算每件基准运费'] };
    quantity = pieces;
  } else {
    return { quantity: null, warnings: ['该渠道计费单位未明确，暂不估算价格'] };
  }
  if (quote.minShipmentKg != null && actual != null && actual.lt(quote.minShipmentKg) && quote.billingBasis !== 'kg') {
    warnings.push(`最低计费重为${quote.minShipmentKg}kg`);
  }
  return { quantity, warnings };
};

const inTier = (tier: RateTier, quantity: Decimal): boolean => {
  // Two missing bounds do not mean that a price applies to all weights.
  if (tier.min == null && tier.max == null) return false;
  const minOk = tier.min == null || (tier.minInclusive === false ? quantity.gt(tier.min) : quantity.gte(tier.min));
  const maxOk = tier.max == null || (tier.maxInclusive === false ? quantity.lt(tier.max) : quantity.lte(tier.max));
  return minOk && maxOk;
};

const selectTier = (quote: Quote, quantity: Decimal): { tier: RateTier | null; warning?: string } => {
  const matches = quote.tiers.filter((tier) => inTier(tier, quantity));
  if (matches.length === 0) return { tier: null, warning: '重量/体积未命中明确阶梯，未猜测上下限' };
  if (matches.length > 1) return { tier: null, warning: '报价阶梯存在重叠，无法安全选择价格' };
  return { tier: matches[0] };
};

const shapeCheck = (quote: Quote, criteria: SearchCriteria, warnings: string[]): boolean => {
  if (criteria.cargoShape === 'all') return true;
  if (criteria.actualKg == null || criteria.volumeCbm == null || criteria.volumeCbm <= 0) {
    warnings.push('重货/抛货需要同时填写重量和体积，暂不据此匹配');
    return true;
  }
  if (quote.billingBasis === 'kg' && quote.volumetricDivisor != null && quote.volumetricDivisor > 0) {
    const volumeKg = new Decimal(criteria.volumeCbm).mul(1_000_000).div(quote.volumetricDivisor);
    const isDense = new Decimal(criteria.actualKg).gte(volumeKg);
    return criteria.cargoShape === 'dense' ? isDense : !isDense;
  }
  // CBM's density conversion is a billing formula, not a heavy/bulky eligibility
  // filter. Both dense and bulky shipments can use it within stated limits.
  warnings.push('该渠道未提供重抛分类阈值，按其计费方式保留比较');
  return true;
};

const reliabilityRank = (level: Quote['reliability']['level']): number => ({ verified: 0, concern: 1, unknown: 2 }[level]);
const currencyBasis = (quote: Quote): string => `${quote.currency ?? 'UNKNOWN'}:${quote.billingBasis}`;
const effectiveDate = (quote: Quote): string => asDateOnly(quote.effectiveAt) ?? asDateOnly(quote.priceDate) ?? '';
const nullableCompare = (a: number | null | undefined, b: number | null | undefined): number =>
  a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : a - b;
const sortResults = (results: QuoteResult[], criteria: SearchCriteria): QuoteResult[] => {
  const indexed = results.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => {
    const qa = a.value.quote;
    const qb = b.value.quote;
    let compare = 0;
    if (criteria.sort === 'cost') {
      // Costs of the same shipment are comparable across KG/CBM once calculated,
      // but a CNY amount must not compete with a USD amount without an FX source.
      const group = (qa.currency ?? 'UNKNOWN').localeCompare(qb.currency ?? 'UNKNOWN');
      compare = group || Number(b.value.eligible) - Number(a.value.eligible) || nullableCompare(a.value.estimatedCost, b.value.estimatedCost);
    } else if (criteria.sort === 'unit') {
      const group = currencyBasis(qa).localeCompare(currencyBasis(qb));
      compare = group || nullableCompare(a.value.tier?.price, b.value.tier?.price);
    } else if (criteria.sort === 'updated') compare = effectiveDate(qb).localeCompare(effectiveDate(qa));
    else if (criteria.sort === 'reliability') compare = reliabilityRank(qa.reliability.level) - reliabilityRank(qb.reliability.level);
    return compare || Number(b.value.eligible) - Number(a.value.eligible) || a.index - b.index;
  });
  return indexed.map(({ value }) => value);
};

/** Match and estimate only what the normalized record states explicitly. */
export function searchQuotes(quotes: Quote[], criteria: SearchCriteria): QuoteResult[] {
  const results: QuoteResult[] = [];
  const today = chinaDate();
  const invalid = [criteria.actualKg, criteria.volumeCbm, criteria.pieces]
    .some((value) => value != null && (!Number.isFinite(value) || value <= 0)) ||
    (criteria.pieces != null && !Number.isInteger(criteria.pieces));
  for (const quote of quotes) {
    const warnings: string[] = [];
    if (!countryMatches(quote.countryCode, criteria.country)) continue;
    if (criteria.mode !== 'all' && quote.mode !== criteria.mode) continue;
    if (criteria.providerId && quote.providerId !== criteria.providerId) continue;
    if (criteria.onlyOwn && !quote.isOwn) continue;
    const destination = destinationMatches(quote, criteria.destination);
    const delivery = deliveryMatches(quote, criteria);
    const origin = originMatches(quote, criteria);
    const cargo = cargoMatches(quote, criteria.cargo);
    // Known nonmatches are excluded; incomplete evidence can only be a visibly
    // unconfirmed candidate, never the cheapest usable quote.
    if ((!destination.ok && !destination.unknown) || (!cargo.ok && !cargo.unknown) || (!delivery.ok && !delivery.unknown) || (!origin.ok && !origin.unknown)) continue;
    if (destination.warning) warnings.push(destination.warning);
    if (cargo.warning) warnings.push(cargo.warning);
    if (delivery.warning) warnings.push(delivery.warning);
    if (origin.warning) warnings.push(origin.warning);
    if (!shapeCheck(quote, criteria, warnings)) continue;
    const unknownCountry = quote.countryCode === 'EU' && criteria.country !== 'EU' && criteria.country !== 'ALL';
    if (unknownCountry) warnings.push(`原表仅标欧洲，尚未确认${countryLabels[criteria.country as CountryCode]}覆盖范围`);
    const future = isFuture(quote, criteria.asOf, today);
    if (future) warnings.push(`报价尚未到生效日期/时刻：${quote.effectiveAt ?? quote.priceDate}`);
    if (quote.effectiveAt && /[T ]\d{2}:\d{2}/.test(quote.effectiveAt)) warnings.push(`生效时刻：${quote.effectiveAt}；${criteria.asOf === today ? '今日按当前中国时间判断' : '非今日查询按该日末判断'}`);
    if (!quote.priceDate && !quote.effectiveAt) warnings.push('报价日期缺失，无法确认时效性');
    if (quote.status !== 'reference') warnings.push(quote.status === 'suspended' ? '该渠道已暂停，不能作为当前可用渠道' : '该报价待复核');
    if (quote.dateKind === 'filename') warnings.push('报价日期由文件名推断');
    if (quote.dateKind === 'filename' && (quote.priceDate ?? '') > criteria.asOf) warnings.push('文件名日期晚于查询日期，实际生效时间需确认');
    if (quote.cargoCertainty === 'inferred') warnings.push('货品属性由渠道文本推断，出货前请核实');
    if (quote.currency == null || quote.currencyEvidence === 'unconfirmed') warnings.push('币种未可靠确认，不能与其它币种直接比较');
    if (quote.currencyEvidence === 'context') warnings.push('币种依表内上下文识别，出货前请核实');
    if (quote.reliability.level === 'unknown') warnings.push('尚无实际走货稳定性记录');
    warnings.push(...quote.reviewReasons);
    if (quote.notes.length) warnings.push(`原表含${quote.notes.length}条附加费/限制说明，请在详情核对`);
    warnings.push('仅含已结构化的基础运费与固定费，未确认附加费不视为0');
    const quantity: QuantityInfo = invalid
      ? { quantity: null, blocked: true, warnings: ['重量、体积必须为正数，件数必须为正整数'] }
      : quantityFor(quote, criteria);
    warnings.push(...quantity.warnings);
    let tier: RateTier | null = null;
    let estimatedCost: number | null = null;
    let label = quantity.quantity == null ? '查看档位' : '无法估算';
    let blocked = Boolean(quantity.blocked) || future || quote.status !== 'reference' ||
      !destination.ok || !cargo.ok || !delivery.ok || !origin.ok || unknownCountry;
    if (quantity.quantity != null) {
      const selected = selectTier(quote, quantity.quantity);
      tier = selected.tier;
      if (selected.warning) { warnings.push(selected.warning); blocked = true; }
      if (tier?.status !== 'priced') {
        if (tier) { warnings.push(tier.status === 'inquiry' ? '该阶梯需询价' : '该阶梯不可用'); blocked = true; }
      } else if (tier.price == null || tier.price < 0) { warnings.push('该阶梯未提供有效价格'); blocked = true; }
      else if (quote.currency == null || quote.currencyEvidence === 'unconfirmed') warnings.push('币种不确定，保留档位单价但不估算费用');
      else if (!blocked) {
        const cost = new Decimal(tier.price).mul(quantity.quantity);
        estimatedCost = cost.plus(tier.fixedFee ?? 0).toDecimalPlaces(6).toNumber();
        label = '基准运费（不含未确认费用）';
      }
    }
    const eligible = !blocked;
    if (!eligible) label = future ? '尚未生效' : '待确认/不可计价';
    if (!criteria.includePending && !eligible) continue;
    results.push({ quote, tier, estimatedCost, chargeableQuantity: quantity.quantity?.toNumber() ?? null,
      estimateLabel: label, warnings: [...new Set(warnings)], eligible });
  }
  return sortResults(results, criteria);
}

// Kept as a compatibility export for callers that used the original domain
// seam before the static-data adapter was split into src/data/repository.ts.
export { loadCatalog, loadQuotes } from '../data/repository';
