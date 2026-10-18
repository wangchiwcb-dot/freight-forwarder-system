import { z } from 'zod';

const count = z.number().int().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).nullable();
export const qualityFlags = ['missing_channel', 'unverified_warehouse', 'warehouse_conflict', 'warehouse_operator_unconfirmed', 'missing_departure', 'missing_delivery', 'negative_total', 'reversed_stage', 'lookup_error', 'duplicate_candidate'] as const;
export const flagLabels: Record<QualityFlag, string> = {
  missing_channel: '渠道未填写', unverified_warehouse: '仓库映射待核', warehouse_conflict: '仓库字典冲突',
  warehouse_operator_unconfirmed: '亚马逊/沃尔玛同码，运营商待核',
  missing_departure: '开船日期缺失', missing_delivery: '到仓日期未回填', negative_total: '到仓早于开船',
  reversed_stage: '节点顺序待核', lookup_error: '原表组合公式错误', duplicate_candidate: '疑似重复记录',
};
export const nodeLabels = { departure: '开船', arrival: '到港', unloaded: '卸船', pickup: '提柜', devanning: '拆柜', delivered: '实际到仓' } as const;
export const recordSchema = z.object({
  id: z.string().regex(/^tr_[a-f0-9]{20}$/), containerTripId: z.string().regex(/^ct_[a-f0-9]{20}$/).nullable(),
  channel: z.string(), warehouse: z.string(), region: z.string(), group: z.string(), channelGroup: z.string(),
  nodes: z.object({ departure: timestamp, arrival: timestamp, unloaded: timestamp, pickup: timestamp, devanning: timestamp, delivered: timestamp }).strict(),
  status: z.enum(['arrived', 'unknown', 'invalid']), flags: z.array(z.enum(qualityFlags)),
  duplicateGroup: z.string().nullable(), source: z.object({ sheet: z.enum(['2025', '2026数据源']), row: z.number().int().min(2) }).strict(),
}).strict();
export const warehouseSchema = z.object({
  code: z.string(), city: z.string(), state: z.string(), region: z.string(), group: z.string(), sourceRow: count.nullable(),
  verifiedUS: z.boolean(), mappingConflict: z.boolean(),
  country: z.string(), stateNameZh: z.string(), postalCode: z.string(), address: z.string(),
  mappingStatus: z.enum(['matched', 'pending']), addressSource: z.enum(['workbook', 'web', 'pending']),
  referenceUrls: z.array(z.url()), reviewedAt: date.nullable(), reviewNote: z.string(),
}).strict();
export const ruleSchema = z.object({ group: z.string(), reminderDays: z.number().nonnegative(), compensationDays: z.number().nonnegative(),
  effectiveFrom: date.nullable(), effectiveTo: date.nullable(), sourceRow: count }).strict();
export const manifestSchema = z.object({
  schemaVersion: z.literal(2), metricsVersion: z.literal('elapsed-naive-seconds_nearest-rank_v1'), version: z.string(),
  sourceFile: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), generatedAt: z.string(), dataThrough: date,
  warehouseReviewSha256: z.string().regex(/^[a-f0-9]{64}$/), warehouseReviewedAt: date,
  exclusions: z.object({ records: count, codes: count, byCategory: z.record(z.string(), count) }),
  departureRange: z.tuple([date, date]),
  counts: z.object({ records: count, arrived: count, unknown: count, invalid: count, warehouseCodes: count, duplicateGroups: count, duplicateExtraRows: count }),
  flags: z.record(z.string(), count), sheets: z.array(z.object({ sheet: z.string(), inputRows: count, businessRows: count, includedRows: count, excludedRows: count, skippedRows: count })),
  files: z.array(z.object({ kind: z.enum(['records', 'warehouses', 'rules']), file: z.string().regex(/^[a-z0-9-]+\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: count, count })),
});
export type QualityFlag = typeof qualityFlags[number];
export type TransitRecord = z.infer<typeof recordSchema>;
export type TransitManifest = z.infer<typeof manifestSchema>;
export type TransitWarehouse = z.infer<typeof warehouseSchema>;
export type TransitRule = z.infer<typeof ruleSchema>;
export interface TransitDataset { manifest: TransitManifest; records: TransitRecord[]; warehouses: TransitWarehouse[]; rules: TransitRule[] }

export async function loadTransit(signal?: AbortSignal, fetcher: typeof fetch = fetch, base = import.meta.env.BASE_URL): Promise<TransitDataset> {
  const root = `${base.endsWith('/') ? base : base + '/'}transit/`;
  const response = await fetcher(root + 'manifest.json', { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`时效数据版本读取失败（${response.status}）`);
  const parsed = manifestSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('时效数据版本格式无效，请重新生成数据');
  const manifest = parsed.data;
  const dataset: TransitDataset = { manifest, records: [], warehouses: [], rules: [] };
  const parts = await Promise.all(manifest.files.map(async descriptor => {
    const part = await fetcher(root + descriptor.file, { signal, cache: 'force-cache' });
    if (!part.ok) throw new Error(`时效数据分片读取失败（${part.status}），请重试`);
    const bytes = await part.arrayBuffer();
    if (bytes.byteLength !== descriptor.bytes) throw new Error('时效文件长度校验失败，请刷新后重试');
    if (globalThis.crypto?.subtle) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== descriptor.sha256) throw new Error('时效文件版本校验失败，请刷新后重试');
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const schema = descriptor.kind === 'records' ? recordSchema : descriptor.kind === 'warehouses' ? warehouseSchema : ruleSchema;
    const records = z.array(schema).safeParse(value);
    if (!records.success || records.data.length !== descriptor.count) throw new Error('时效记录格式或数量校验失败');
    return { kind: descriptor.kind, values: records.data };
  }));
  for (const part of parts) {
    if (part.kind === 'records') dataset.records.push(...part.values as TransitRecord[]);
    else if (part.kind === 'warehouses') dataset.warehouses.push(...part.values as TransitWarehouse[]);
    else dataset.rules.push(...part.values as TransitRule[]);
  }
  if (dataset.records.length !== manifest.counts.records || dataset.warehouses.length !== manifest.counts.warehouseCodes ||
      !dataset.rules.length || new Set(dataset.records.map(r => r.id)).size !== dataset.records.length) {
    throw new Error('时效数据不完整或存在重复 ID，请重新生成数据');
  }
  return dataset;
}
