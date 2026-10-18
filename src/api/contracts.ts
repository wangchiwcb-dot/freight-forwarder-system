import { z } from 'zod';
import { DEFAULT_CRITERIA } from '../domain/search';

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '日期无效');
export const criteriaSchema = z.object({
  country: z.enum(['ALL','US','CA','MX','GB','DE','FR','IT','ES','PL','CZ','EU','BR','AU','OTHER']),
  origin: z.string().trim().max(100).optional(),
  mode: z.enum(['all','sea','air','rail','road','express','parcel','unknown']),
  delivery: z.enum(['all','amazon','commercial','residential']).optional(),
  destination: z.string().trim().max(100),
  cargo: z.enum(['general','battery','magnetic','liquid','powder','pure_battery','sensitive','health_supplement']),
  cargoShape: z.enum(['all','dense','bulky']),
  actualKg: z.number().positive().max(1_000_000).nullable(),
  volumeCbm: z.number().positive().max(100_000).nullable(),
  pieces: z.number().int().positive().max(1_000_000).nullable(),
  providerId: z.union([z.literal(''), idSchema]),
  onlyOwn: z.boolean(), includePending: z.boolean(),
  sort: z.enum(['cost','unit','updated','reliability']), asOf: dateSchema,
}).strict();
export const searchSchema = z.object({
  criteria: criteriaSchema, snapshotId: idSchema.optional(),
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(100).default(15),
}).strict();
export type SearchRequest = z.infer<typeof searchSchema>;
export const defaultSearch = () => ({ ...DEFAULT_CRITERIA, asOf: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()) });
