import { z } from 'zod';
import type { Catalog, CountryCode, Quote } from '../domain/types';

const transportModes = ['sea', 'air', 'rail', 'road', 'express', 'parcel', 'unknown'] as const;
const countries = ['US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'PL', 'CZ', 'EU', 'BR', 'AU', 'OTHER'] as const;
const cargoTypes = ['general', 'battery', 'magnetic', 'liquid', 'powder', 'pure_battery', 'sensitive'] as const;
const billingBases = ['kg', 'cbm', 'parcel', 'first_increment', 'unknown'] as const;
const currencies = ['CNY', 'USD', 'EUR', 'GBP'] as const;
const quoteStatuses = ['reference', 'needs_review', 'suspended'] as const;
const dateKinds = ['explicit', 'filename', 'unknown'] as const;
const reliabilityLevels = ['verified', 'concern', 'unknown'] as const;

const rateTierSchema = z.object({
  label: z.string(), min: z.number().nullable(), max: z.number().nullable(),
  minInclusive: z.boolean().optional(), maxInclusive: z.boolean().optional(),
  price: z.number().nullable(), status: z.enum(['priced', 'inquiry', 'unavailable']),
  sourceCell: z.string(), fixedFee: z.number().optional(),
}).passthrough();

const quoteSchema = z.object({
  id: z.string(), providerId: z.string(), providerName: z.string(), isOwn: z.boolean(),
  channelName: z.string(), countryCode: z.enum(countries), mode: z.enum(transportModes),
  delivery: z.enum(['amazon', 'commercial', 'residential', 'all', 'unknown']), origin: z.string(),
  destinationLabel: z.string(), warehouseCodes: z.array(z.string()), postalPrefixes: z.array(z.string()),
  postalCodes: z.array(z.string()).optional(),
  postalRanges: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
  cargoTypes: z.array(z.enum(cargoTypes)), cargoCertainty: z.enum(['explicit', 'inferred', 'unknown']),
  billingBasis: z.enum(billingBases), currency: z.enum(currencies).nullable(),
  currencyEvidence: z.enum(['explicit', 'context', 'unconfirmed']), tiers: z.array(rateTierSchema),
  volumetricDivisor: z.number().nullable(), minShipmentKg: z.number().nullable(), minPieceKg: z.number().nullable(),
  minCbm: z.number().nullable(), maxKgPerCbm: z.number().nullable(),
  densityConversionKgPerCbm: z.number().nullable().optional(), volumeEquivalentKgPerCbm: z.number().nullable().optional(),
  transitText: z.string(), notes: z.array(z.string()), ruleRef: z.string().optional(),
  priceDate: z.string().nullable(), effectiveAt: z.string().nullable(), dateKind: z.enum(dateKinds),
  status: z.enum(quoteStatuses), reviewReasons: z.array(z.string()),
  reliability: z.object({ level: z.enum(reliabilityLevels), note: z.string(), reviewedAt: z.string().optional() }).passthrough(),
  source: z.object({ fileId: z.string(), fileName: z.string(), sheet: z.string(), cells: z.array(z.string()), hidden: z.boolean() }).passthrough(),
}).passthrough();

const sourceFileSchema = z.object({
  id: z.string(), name: z.string(), providerId: z.string(), providerName: z.string(), sha256: z.string(),
  sheets: z.number(), hiddenSheets: z.number(), quoteCount: z.number(), status: z.enum(['parsed', 'partial', 'failed']), warnings: z.array(z.string()),
}).passthrough();
const catalogSchema = z.object({
  schemaVersion: z.literal('1.0'), version: z.string(), generatedAt: z.string(), files: z.array(sourceFileSchema),
  chunks: z.array(z.object({ country: z.enum(countries), path: z.string(), count: z.number(), rulesPath: z.string().optional() }).passthrough()),
  stats: z.object({ quotes: z.number(), providers: z.number(), countries: z.number(), sources: z.number(), cbmQuotes: z.number() }).passthrough(),
}).passthrough();

const baseUrl = (): string => {
  // import.meta.env is replaced by Vite. The fallback also makes this module usable in Vitest/node.
  const value = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL;
  return value ?? '/';
};
const dataUrl = (path: string): string => {
  const relative = path.replace(/^\//, '');
  return `${baseUrl().replace(/\/$/, '')}/${relative.startsWith('data/') ? relative : `data/${relative}`}`;
};

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`报价数据读取失败（${response.status}）：${url}`);
  return response.json();
}

export async function loadCatalog(): Promise<Catalog> {
  const parsed = catalogSchema.safeParse(await readJson(dataUrl('data/catalog.json')));
  if (!parsed.success) throw new Error(`报价目录格式无效：${parsed.error.message}`);
  return parsed.data as Catalog;
}

export async function loadQuotes(catalog: Catalog, country: CountryCode | 'ALL'): Promise<Quote[]> {
  // EU is a broad source bucket. It can serve continental EU searches, but must never silently serve GB.
  const euCountries: CountryCode[] = ['DE', 'FR', 'IT', 'ES', 'PL', 'CZ'];
  const chunks = catalog.chunks.filter((chunk) => {
    if (country === 'ALL') return true;
    if (chunk.country === country) return true;
    return chunk.country === 'EU' && euCountries.includes(country as CountryCode);
  });
  const loaded = await Promise.all(chunks.map(async (chunk) => {
    const rulesPath = (chunk as typeof chunk & { rulesPath?: string }).rulesPath;
    const [raw, rulesRaw] = await Promise.all([
      readJson(dataUrl(chunk.path)),
      rulesPath ? readJson(dataUrl(rulesPath)) : Promise.resolve(null),
    ]);
    const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { quotes?: unknown }).quotes : null;
    if (!Array.isArray(source)) throw new Error(`报价分片格式无效：${chunk.path}`);
    let rules: Record<string, string[]> = {};
    if (rulesPath) {
      if (!rulesRaw || typeof rulesRaw !== 'object' || Array.isArray(rulesRaw)) throw new Error(`报价规则格式无效：${rulesPath}`);
      for (const [key, value] of Object.entries(rulesRaw as Record<string, unknown>)) {
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`报价规则条目无效：${rulesPath}/${key}`);
        rules[key] = value;
      }
    }
    return source.map((item) => {
      const parsed = quoteSchema.safeParse(item);
      if (!parsed.success) throw new Error(`报价记录格式无效（${chunk.path}）：${parsed.error.message}`);
      const quote = parsed.data as Quote & { ruleRef?: string };
      const ruleNotes = quote.ruleRef ? (rules[quote.ruleRef] ?? []) : [];
      if (quote.ruleRef && !rules[quote.ruleRef]) {
        quote.notes = [...quote.notes, `规则引用${quote.ruleRef}未找到`];
        quote.status = 'needs_review';
      }
      if (ruleNotes.length) quote.notes = quote.notes.length ? [...new Set([...quote.notes, ...ruleNotes])] : ruleNotes;
      return quote as Quote;
    });
  }));
  return loaded.flat();
}
