import { z } from 'zod';
import Decimal from 'decimal.js';
import { conditionSchema, costBasisSchema, decimalSchema, transportModeSchema } from './contracts';

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().min(1).max(500);
const positive = decimalSchema.refine(value => Number(value) > 0 && Number(value) <= 1e12, '必须为正数且不超过 1e12');
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = new Date(value + 'T00:00:00Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}, '日期无效');
export const billingSchema = z.object({
  basis: z.enum(['kg', 'cbm']),
  aggregation: z.enum(['shipment', 'piece']),
  volumetricDivisor: positive.nullable(),
  quantityStep: decimalSchema.nullable(), // zero means explicitly no rounding
  dimensionStepCm: decimalSchema.nullable(),
  volumeStepCbm: decimalSchema.nullable().optional(), // legacy versions did not round shipment volume
  minimumQuantity: decimalSchema,
  minimumPieceKg: decimalSchema,
  // Required only when a per-piece minimum is combined with shipment max.
  minimumPieceApplication: z.literal('actual_before_shipment_max').nullable().optional(),
  densityKgPerCbm: positive.nullable(),
  verified: z.boolean(),
}).strict();
export type Billing = z.infer<typeof billingSchema>;
export const tierSchema = z.object({
  id, min: decimalSchema, max: positive.nullable(),
  minInclusive: z.boolean(), maxInclusive: z.boolean(),
  unitPrice: decimalSchema.nullable(), status: z.enum(['priced', 'inquiry', 'unavailable']),
}).strict().refine(tier => tier.max === null || new Decimal(tier.max).gte(tier.min), '档位上限小于下限');

export const ruleSchema = z.object({
  id, label: text, kind: z.enum(['deny', 'fee']),
  scope: z.enum(['shipment', 'package']), condition: conditionSchema.nullable(),
  inclusion: z.enum(['additional', 'included', 'exempt', 'unknown']),
  basis: z.enum(['shipment', 'piece', 'chargeable_quantity', 'chargeable_kg', 'chargeable_cbm', 'percentage']),
  rate: decimalSchema.nullable(),
  percentBase: z.array(id).max(50),
  minimum: decimalSchema.nullable(), maximum: decimalSchema.nullable(),
  evidence: text,
}).strict();
export type Rule = z.infer<typeof ruleSchema>;
export const offerSchema = z.object({
  id, providerId: id, providerName: text, isOwn: z.boolean(), channelId: id, name: text,
  mode: transportModeSchema, lastMile: z.enum(['express', 'truck', 'other']),
  country: z.string().regex(/^[A-Z]{2}$/), origin: text.nullable(),
  targets: z.array(z.object({ kind: z.enum(['postal', 'postal_prefix', 'postal_range', 'warehouse']), value: text }).strict()
    .refine(target => target.kind !== 'postal_range' || /^\d{5}-\d{5}$/.test(target.value) && target.value.slice(0, 5) <= target.value.slice(6), '邮编区间需使用五位起止邮编，例如 80001-96999')).max(10000),
  scopeKey: text.nullable(), serviceDescription: text,
  currency: z.enum(['CNY', 'USD', 'EUR', 'GBP', 'CAD', 'AUD']), costBasis: costBasisSchema,
  status: z.enum(['draft', 'published', 'revoked']), sourceKind: z.enum(['example', 'workbook', 'manual']),
  validFrom: date.nullable(), validTo: date.nullable(),
  revision: z.number().int().positive().optional(), versionLabel: z.string().nullable().optional(),
  sourceDraftId: id.nullable().optional(), sourceReady: z.boolean().optional(),
  reviewed: z.boolean(), cargoReviewed: z.boolean(), acceptedAttributes: z.array(text).max(100),
  reviewReasons: z.array(text).max(100),
  billing: billingSchema, tiers: z.array(tierSchema).min(1).max(1000),
  rules: z.array(ruleSchema).max(200), notes: z.array(text).max(100),
  transitText: z.string().max(500),
  sourceEvidence: z.array(z.object({ sourceId: id.nullable(), sheet: z.string().max(200).nullable(),
    cells: z.array(z.string().max(30)).max(200), text: text }).strict()).min(1).max(200),
}).strict();
export type Offer = z.infer<typeof offerSchema>;

export const packageSchema = z.object({
  id, pieces: z.number().int().min(1).max(100000),
  actualKg: positive.nullable(), lengthCm: positive.nullable(), widthCm: positive.nullable(), heightCm: positive.nullable(),
}).strict();
export const requestSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/), origin: z.string().max(200),
  postalCode: z.string().trim().toUpperCase().max(30), warehouseCode: z.string().trim().toUpperCase().max(50),
  addressType: z.enum(['residential', 'commercial', 'platform', 'unknown']),
  cargoAttributes: z.array(text).max(100).nullable(),
  intellectualProperty: z.enum(['clear', 'infringing', 'unknown']),
  modes: z.array(transportModeSchema).min(1).max(4), asOf: date,
  measurementStage: z.enum(['estimated', 'warehouse']),
  packages: z.array(packageSchema).max(500),
  actualKg: positive.nullable(), volumeCbm: positive.nullable(), pieces: z.number().int().min(1).max(100000).nullable(),
  includeExamples: z.boolean(),
  // Explicit trial inputs apply only to examples, never to a supplier's published rules.
  trialBilling: billingSchema.nullable(),
}).strict().refine(input => new Set(input.packages.map(item => item.id)).size === input.packages.length, '包装组编号重复');
export type PricingRequest = z.infer<typeof requestSchema>;
export type Package = z.infer<typeof packageSchema>;
export interface CostLine {
  ruleId: string; label: string; packageId: string | null;
  quantity: string | null; unitPrice: string | null; amount: string | null;
  inclusion: Rule['inclusion']; evidence: string;
}
export interface QuoteResult {
  offer: Offer; state: 'complete' | 'partial' | 'rejected'; trial: boolean;
  chargeableQuantity: string | null; knownSubtotal: string | null; total: string | null;
  comparisonKey: string | null; lowest: boolean; lines: CostLine[]; reasons: string[];
  measurementNotice: string;
}
