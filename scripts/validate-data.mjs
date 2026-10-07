/** Validate the published snapshot; optionally reconcile prices with the local extraction. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

const root = path.resolve('public/data');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const nonempty = z.string().min(1);
const nonnegative = z.number().finite().nonnegative();
const nullableNumber = nonnegative.nullable();
const countries = ['US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'PL', 'CZ', 'EU', 'BR', 'AU', 'OTHER'];
const schema = z.object({
  id: nonempty, providerId: nonempty, providerName: nonempty, channelName: nonempty,
  countryCode: z.enum(countries), isOwn: z.boolean(),
  mode: z.enum(['sea', 'air', 'rail', 'road', 'express', 'parcel', 'unknown']),
  billingBasis: z.enum(['kg', 'cbm', 'parcel', 'first_increment', 'unknown']),
  destinationLabel: nonempty, origin: nonempty,
  warehouseCodes: z.array(z.string()), postalPrefixes: z.array(z.string()),
  cargoTypes: z.array(z.enum(['general', 'battery', 'magnetic', 'liquid', 'powder', 'pure_battery', 'sensitive'])).min(1),
  cargoCertainty: z.enum(['explicit', 'inferred', 'unknown']),
  currency: z.enum(['CNY', 'USD', 'EUR', 'GBP']).nullable(),
  currencyEvidence: z.enum(['explicit', 'context', 'unconfirmed']),
  tiers: z.array(z.object({ label: nonempty, min: nullableNumber, max: nullableNumber,
    price: nullableNumber, status: z.enum(['priced', 'inquiry', 'unavailable']),
    sourceCell: z.string().regex(/^[A-Z]+[1-9]\d*$/), fixedFee: nonnegative.optional(),
  })).min(1),
  volumetricDivisor: z.number().positive().nullable(), minShipmentKg: nullableNumber,
  minPieceKg: nullableNumber, minCbm: nullableNumber, maxKgPerCbm: nullableNumber,
  notes: z.array(z.string()), ruleRef: nonempty,
  status: z.enum(['reference', 'needs_review', 'suspended']), reviewReasons: z.array(z.string()),
  reliability: z.object({level: z.enum(['verified', 'concern', 'unknown']), note: nonempty}),
  source: z.object({ fileId: nonempty, fileName: nonempty, sheet: nonempty,
    cells: z.array(nonempty).min(1), hidden: z.boolean() }),
});
const catalog = read('catalog.json');
check(catalog.schemaVersion === '1.0', 'Unsupported schema version');
const sourceIds = new Set(catalog.files.map(f => f.id));
const bySource = new Map();
const ids = new Set();
const quotes = [];
const extractPath = process.argv[2] || 'analysis/latest-extract.json';
const evidence = new Map();
if (fs.existsSync(extractPath)) {
  for (const file of JSON.parse(fs.readFileSync(extractPath, 'utf8')).files) {
    for (const sheet of file.sheets || []) {
      evidence.set(`${file.id}|${sheet.name}`, new Map(sheet.head.flatMap(row => row.cells.map(c => [c.coord, c]))));
    }
  }
}
for (const chunk of catalog.chunks) {
  for (const filename of [chunk.path, chunk.rulesPath]) {
    check(filename && path.dirname(path.resolve(root, filename)) === root, `Invalid chunk path ${filename}`);
  }
  const rows = read(chunk.path);
  const rules = read(chunk.rulesPath);
  check(rows.length === chunk.count, `Chunk count mismatch: ${chunk.path}`);
  for (const [filename, data] of [[chunk.path, rows], [chunk.rulesPath, rules]]) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
    check(filename.endsWith(`-${hash}.json`), `Content hash mismatch: ${filename}`);
  }
  for (const q of rows) {
    const result = schema.safeParse(q);
    if (!result.success) { failures.push(`${q.id}: ${result.error.message}`); continue; }
    check(!ids.has(q.id), `Duplicate id ${q.id}`); ids.add(q.id);
    check(q.countryCode === chunk.country && q.providerId === chunk.providerId, `Wrong shard ${q.id}`);
    check(sourceIds.has(q.source.fileId), `Missing source ${q.id}`);
    check(Array.isArray(rules[q.ruleRef]) && rules[q.ruleRef].every(n => typeof n === 'string'), `Missing rules ${q.id}`);
    check(!q.source.hidden || q.status !== 'reference', `Hidden sheet cannot be usable ${q.id}`);
    check(!/暂停|关停|停收|停航/.test(q.channelName + q.source.sheet) || q.status !== 'reference', `Suspended channel marked usable ${q.id}`);
    check(q.billingBasis !== 'cbm' || q.minCbm !== null, `CBM minimum missing ${q.id}`);
    for (const t of q.tiers) {
      check(t.min === null || t.max === null || t.max >= t.min, `Reversed tier ${q.id}:${t.sourceCell}`);
      check((t.status === 'priced') === (t.price !== null), `Invalid price status ${q.id}:${t.sourceCell}`);
      check(q.source.cells.includes(t.sourceCell), `Missing price evidence ${q.id}:${t.sourceCell}`);
      if (q.billingBasis === 'cbm' && q.currency === 'CNY' && t.price !== null && t.price < 100) {
        check(q.status !== 'reference', `Implausible CBM rate must be reviewed ${q.id}:${t.sourceCell}`);
      }
      if (evidence.size) {
        const cell = evidence.get(`${q.source.fileId}|${q.source.sheet}`)?.get(t.sourceCell);
        check(Boolean(cell), `Source cell missing ${q.id}:${t.sourceCell}`);
        if (t.price !== null && cell) {
          const raw = cell.formula ? cell.cached : cell.value;
          check(raw !== null && raw !== '' && Number(raw) === t.price, `Price differs from source ${q.id}:${t.sourceCell}`);
        }
      }
    }
    quotes.push(q);
    bySource.set(q.source.fileId, (bySource.get(q.source.fileId) || 0) + 1);
  }
}
for (const f of catalog.files) check(f.quoteCount === (bySource.get(f.id) || 0), `Source count mismatch ${f.name}`);
const actualStats = { quotes: quotes.length, providers: new Set(quotes.map(q => q.providerId)).size,
  countries: new Set(quotes.map(q => q.countryCode)).size, sources: catalog.files.length,
  cbmQuotes: quotes.filter(q => q.billingBasis === 'cbm').length };
for (const [key, value] of Object.entries(actualStats)) check(catalog.stats[key] === value, `Catalog ${key} mismatch`);
if (failures.length) {
  console.error(failures.slice(0, 30).join('\n'));
  console.error(`Data validation failed: ${failures.length} issues`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${quotes.length} quotes, ${catalog.files.length} sources, ${catalog.chunks.length} chunks`);
  console.log(evidence.size ? 'Source cell reconciliation passed' : 'Local extraction absent; structure and snapshot integrity checked');
}
