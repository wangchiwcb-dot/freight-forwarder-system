import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import type { Database } from './database';
import { offerSchema, type Offer } from '../../src/domain/v2/pricing-contracts';
import type { PriceDraftRecord, Readiness } from '../../src/domain/v2/review-contracts';
import type { TransportMode } from '../../src/domain/v2/contracts';
import { date } from '../../src/domain/v2/pricing-contracts';
import { pricePeriodFields, pricePeriodJoins, todayInChina, visiblePriceSql } from './periods';

export const draftQuerySchema = z.object({
  country: z.string().regex(/^[A-Z]{2,5}$/).optional(), provider: z.string().max(200).optional(),
  mode: z.enum(['sea','rail','road','air','unknown']).optional(),
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(15),
  asOf: date.optional(), history: z.enum(['true','false']).default('false'),
}).strict();

export async function readiness(db: Database): Promise<Readiness> {
  const counts = (await db.query<any>(`SELECT
    (SELECT count(*)::int FROM quotation_v2.source_files) AS sources,
    (SELECT count(*)::int FROM quotation_v2.price_drafts) AS "priceDrafts",
    (SELECT count(*)::int FROM quotation_v2.channel_releases WHERE status='published') AS published,
    (SELECT count(*)::int FROM quotation_v2.channel_releases WHERE source_kind='example') AS examples,
    (SELECT count(*)::int FROM quotation_v2.channel_releases WHERE source_kind<>'example' AND status='draft') AS "ruleDrafts"`)).rows[0];
  const countries = (await db.query<any>('SELECT country_hint AS value,count(*)::int AS count FROM quotation_v2.price_drafts GROUP BY country_hint ORDER BY country_hint')).rows;
  const providers = (await db.query<any>('SELECT provider_hint AS value,count(*)::int AS count FROM quotation_v2.price_drafts GROUP BY provider_hint ORDER BY provider_hint')).rows;
  return { ...counts, countries, providers };
}

export async function searchDrafts(db: Database, raw: unknown) {
  const query = draftQuerySchema.parse(raw);
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.history !== 'true') { values.push(query.asOf ?? todayInChina()); where.push(visiblePriceSql(`$${values.length}`)); }
  const term = (column: string, value?: string) => { if (value) { values.push(value); where.push(`${column}=$${values.length}`); } };
  term('d.country_hint', query.country); term('d.provider_hint', query.provider);
  if (query.mode === 'unknown') where.push("d.mode_hint NOT IN ('sea','rail','road','air')");
  else term('d.mode_hint', query.mode);
  if (query.q) { values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(d.channel_hint ILIKE $${values.length} OR d.proposed_data->>'destinationLabel' ILIKE $${values.length} OR d.proposed_data->>'origin' ILIKE $${values.length} OR s.original_name ILIKE $${values.length})`); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id ${pricePeriodJoins} ${filter}`, values)).rows[0].count;
  const rows = await db.query<PriceDraftRecord>(`SELECT d.id,d.source_id,s.original_name AS source_name,d.provider_hint,d.channel_hint,d.country_hint,d.mode_hint,d.status,
    d.proposed_data - 'notes' AS proposed_data,${pricePeriodFields} FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id ${pricePeriodJoins}
    ${filter} ORDER BY d.provider_hint,d.channel_hint,d.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize]);
  return { items: rows.rows, total, page: query.page, pageSize: query.pageSize };
}

export async function getPriceDraft(db: Database, id: string) {
  return (await db.query<PriceDraftRecord>(`SELECT d.id,d.source_id,s.original_name AS source_name,d.provider_hint,d.channel_hint,d.country_hint,d.mode_hint,d.status,
    d.proposed_data || jsonb_build_object('notes',coalesce(n.notes,d.proposed_data->'notes','[]'::jsonb)) AS proposed_data,${pricePeriodFields}
    FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id LEFT JOIN quotation_v2.draft_note_sets n ON n.id=d.note_set_id ${pricePeriodJoins} WHERE d.id=$1`, [id])).rows[0] ?? null;
}

const decimal = (value: number | null | undefined, fallback: string | null = null) => value == null ? fallback : new Decimal(value).toFixed();
const splitNotes = (notes: string[]) => notes.flatMap(note => note.match(/[\s\S]{1,480}/g) ?? []);
export function prepareOffer(draft: PriceDraftRecord, selection: { mode: TransportMode; country: string }): Offer {
  const quote = draft.proposed_data;
  if (!['kg','cbm'].includes(quote.billingBasis)) throw new Error('本条原表使用首续重或其他计费单位，需单独整理，不能转换为公斤/方单价');
  const ownSea = selection.mode === 'sea' && selection.country === 'US' && draft.source_id === '97ea96986ab72065d60b6707adf3d6502ba4be724b5e72c38b7d5aa78981caf3' && quote.source.sheet === '美国海派';
  const ownMatson = ownSea && quote.channelName === '美森限时达海派';
  const reviewReasons = [...new Set([
    '核对原表价格档位、币种及有效期', '补齐交仓点及服务、税费范围', ...(!ownSea ? ['核对最低起运量与单件最低计费'] : []),
    '核对承运产品、附加费及优惠规则', ...(quote.reviewReasons ?? []),
    ...(quote.source.hidden ? ['隐藏工作表的渠道可用性尚待确认'] : []),
  ])];
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const notes = splitNotes(quote.notes ?? []);
  if (notes.length > 98) throw new Error('本条备注过长，请先拆分为独立渠道规则；原件备注仍完整保留');
  const targets: Offer['targets'] = [
    ...(quote.warehouseCodes ?? []).map(value => ({ kind: 'warehouse' as const, value })),
    ...(quote.postalCodes ?? []).map(value => ({ kind: 'postal' as const, value })),
    ...(quote.postalPrefixes ?? []).map(value => ({ kind: 'postal_prefix' as const, value })),
    ...(quote.postalRanges ?? []).map(range => ({ kind: 'postal_range' as const, value: `${range.start}-${range.end}` })),
  ];
  const name = `${quote.channelName} · ${quote.destinationLabel}`.slice(0,500);
  const offer = offerSchema.parse({
    id: randomUUID(), providerId: `provider_${hash(quote.providerId + ':' + quote.providerName)}`,
    providerName: quote.providerName, isOwn: quote.isOwn, channelId: `channel_${hash(draft.id + ':' + selection.mode + ':' + selection.country)}`,
    name, mode: selection.mode, lastMile: /卡派|直送/.test(quote.channelName) ? 'truck' : /海派|空派|快递/.test(quote.channelName) ? 'express' : 'other',
    country: selection.country, origin: !quote.origin || /按原表|待核|未知/.test(quote.origin) ? null : quote.origin,
    targets, scopeKey: null, serviceDescription: '服务与税费范围待核实', currency: quote.currency ?? 'CNY',
    costBasis: quote.isOwn ? 'internal_settlement' : 'supplier_purchase', status: 'draft', sourceKind: 'workbook',
    validFrom: quote.effectiveAt?.slice(0,10) ?? null, validTo: null, reviewed: false, cargoReviewed: false,
    acceptedAttributes: [], reviewReasons,
    billing: { basis: quote.billingBasis, aggregation: 'shipment', volumetricDivisor: ownSea ? '6000' : decimal(quote.volumetricDivisor),
      quantityStep: ownSea ? '1' : null, dimensionStepCm: ownSea ? '0' : null, volumeStepCbm: ownSea ? '0.1' : null,
      minimumQuantity: ownSea ? ownMatson ? '0' : '12' : decimal(quote.billingBasis === 'cbm' ? quote.minCbm : quote.minShipmentKg, '0'),
      minimumPieceKg: ownMatson ? '12' : decimal(quote.minPieceKg, '0'),
      minimumPieceApplication: ownMatson ? 'actual_before_shipment_max' : null,
      densityKgPerCbm: decimal(quote.densityConversionKgPerCbm), verified: ownSea },
    tiers: quote.tiers.map((tier, index) => ({ id: `tier_${index+1}`, min: decimal(tier.min, '0'), max: decimal(tier.max),
      minInclusive: tier.minInclusive ?? true, maxInclusive: tier.maxInclusive ?? false,
      unitPrice: decimal(tier.price), status: tier.price === null ? tier.status === 'unavailable' ? 'unavailable' : 'inquiry' : 'priced' })),
    rules: [], notes: [...notes, ...(ownSea ? ['2026-10-26 用户确认自有美国海派：整票体积向上进位到0.1方，除以6000换算材积重，与整票实重取大后向上进位到1kg。',
      '2026-10-26 用户确认最低计费：无特殊说明按单票最低12kg；美森原表B11明确单件最低12kg，先将每箱实重补足12kg后合计，再与进位后的整票材积重取大。30kg和5kg两箱、整票0.15方，计费42kg。'] : [])],
    transitText: (quote.transitText ?? '').slice(0,500),
    sourceEvidence: [{ sourceId: draft.source_id, sheet: quote.source.sheet, cells: quote.source.cells,
      text: `${draft.source_name}；${quote.destinationLabel}；原表单价及备注待逐项复核。`.slice(0,500) }],
  });
  return offer;
}
