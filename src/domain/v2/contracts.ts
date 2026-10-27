import { z } from 'zod';

// Main transport and last-mile delivery are separate dimensions in V2.
export const TRANSPORT_MODES = ['sea', 'rail', 'road', 'air'] as const;
export const transportModeSchema = z.enum(TRANSPORT_MODES);
export type TransportMode = z.infer<typeof transportModeSchema>;
export const transportLabels: Record<TransportMode, string> = {
  sea: '海运', rail: '铁路', road: '卡航', air: '空运',
};
export const costBasisSchema = z.enum([
  'internal_settlement', 'supplier_purchase', 'customer_sale', 'unknown',
]);

// Keep decimal input as text. Missing facts must never turn into zero.
export const decimalSchema = z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const numericFields = [
  'shipment.actualKg', 'shipment.volumeCbm', 'shipment.pieces',
  'package.actualKg', 'package.lengthCm', 'package.widthCm', 'package.heightCm',
  'package.longestCm', 'package.secondCm', 'package.girthCm',
] as const;
export const textFields = [
  'cargo.category', 'destination.countryCode', 'destination.postalCode',
  'destination.warehouseCode', 'destination.addressType',
  'cargo.intellectualProperty',
] as const;
type NumericField = typeof numericFields[number];
type TextField = typeof textFields[number];
export type FactField = NumericField | TextField | 'cargo.attributes';

export type Condition =
  | { op: 'all' | 'any'; conditions: Condition[] }
  | { op: 'not'; condition: Condition }
  | { op: 'eq'; field: TextField; value: string }
  | { op: 'in'; field: TextField; values: string[] }
  | { op: 'contains'; field: 'cargo.attributes'; value: string }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: NumericField; value: string };

const term = z.string().min(1).max(200);
const conditionAtDepth = (depth: number): z.ZodType<Condition> => {
  const leaf = [
    z.object({ op: z.literal('eq'), field: z.enum(textFields), value: term }).strict(),
    z.object({ op: z.literal('in'), field: z.enum(textFields), values: z.array(term).min(1).max(100) }).strict(),
    z.object({ op: z.literal('contains'), field: z.literal('cargo.attributes'), value: term }).strict(),
    z.object({ op: z.enum(['gt', 'gte', 'lt', 'lte']), field: z.enum(numericFields), value: decimalSchema }).strict(),
  ] as const;
  if (depth === 0) return z.union(leaf);
  const child = conditionAtDepth(depth - 1);
  return z.union([
    ...leaf,
    z.object({ op: z.enum(['all', 'any']), conditions: z.array(child).min(1).max(20) }).strict(),
    z.object({ op: z.literal('not'), condition: child }).strict(),
  ]);
};

// Bounded, declarative rules; no eval, arbitrary expressions or field access.
export const conditionSchema = conditionAtDepth(8);
export const factsSchema = z.object({
  'shipment.actualKg': decimalSchema.nullable().optional(),
  'shipment.volumeCbm': decimalSchema.nullable().optional(),
  'shipment.pieces': z.string().regex(/^(0|[1-9]\d*)$/).max(20).nullable().optional(),
  'package.actualKg': decimalSchema.nullable().optional(),
  'package.lengthCm': decimalSchema.nullable().optional(),
  'package.widthCm': decimalSchema.nullable().optional(),
  'package.heightCm': decimalSchema.nullable().optional(),
  'package.longestCm': decimalSchema.nullable().optional(),
  'package.secondCm': decimalSchema.nullable().optional(),
  'package.girthCm': decimalSchema.nullable().optional(),
  'cargo.category': term.nullable().optional(),
  'cargo.intellectualProperty': term.nullable().optional(),
  'cargo.attributes': z.array(term).max(100).nullable().optional(),
  'destination.countryCode': term.nullable().optional(),
  'destination.postalCode': term.nullable().optional(),
  'destination.warehouseCode': term.nullable().optional(),
  'destination.addressType': term.nullable().optional(),
}).strict();
export type Facts = z.infer<typeof factsSchema>;
