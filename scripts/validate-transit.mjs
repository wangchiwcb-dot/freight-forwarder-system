import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { manifestSchema, recordSchema, warehouseSchema, ruleSchema } from '../src/features/transit/data.ts';
import { summarize, thresholdShare, totalDays } from '../src/features/transit/metrics.ts';

const root = new URL('../public/transit/', import.meta.url);
const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')));
const reviewBytes = await readFile(new URL('./transit-warehouse-review.json', import.meta.url));
const review = JSON.parse(reviewBytes);
// Match Python's universal newline reading, including Windows Git checkouts.
assert.equal(createHash('sha256').update(reviewBytes.toString('utf8').replace(/\r\n?/g, '\n')).digest('hex'), manifest.warehouseReviewSha256);
const activeFiles = new Set(manifest.files.map(part => part.file));
for (const file of await readdir(root)) {
  if (/^(?:records-[\w-]+|warehouses|rules)-[0-9a-f]{12}\.json$/.test(file)) {
    assert.ok(activeFiles.has(file), `obsolete shard must be archived outside public: ${file}`);
  }
}
const records = [], warehouses = [], rules = [];
for (const part of manifest.files) {
  const bytes = await readFile(new URL(part.file, root));
  assert.equal(bytes.byteLength, part.bytes, `file size: ${part.file}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256, `hash: ${part.file}`);
  const values = JSON.parse(bytes.toString('utf8'));
  assert.equal(values.length, part.count);
  const schema = part.kind === 'records' ? recordSchema : part.kind === 'warehouses' ? warehouseSchema : ruleSchema;
  for (const row of values) schema.parse(row);
  (part.kind === 'records' ? records : part.kind === 'warehouses' ? warehouses : rules).push(...values);
}
assert.equal(records.length, manifest.counts.records);
assert.equal(new Set(records.map(r => r.id)).size, records.length);
assert.equal(warehouses.length, manifest.counts.warehouseCodes);
assert.equal(new Set(warehouses.map(w => w.code)).size, warehouses.length);
const byCode = new Map(warehouses.map(w => [w.code, w]));
for (const warehouse of warehouses) {
  assert.ok(!(warehouse.code in review.excludedCodes));
  if (warehouse.country === 'US') {
    assert.ok(warehouse.stateNameZh);
    assert.match(warehouse.postalCode, /^(?:\d{5}(?:-\d{4})?)?$/);
  }
  if (warehouse.addressSource === 'web') assert.ok(warehouse.referenceUrls.length && warehouse.reviewedAt);
}
assert.ok(rules.length > 0);
const flagCounts = {}, duplicates = new Map(), sources = new Set();
for (const record of records) {
  const key = `${record.source.sheet}:${record.source.row}`;
  assert.ok(!sources.has(key), `duplicate source row ${key}`); sources.add(key);
  for (const value of Object.values(record.nodes)) if (value) {
    assert.equal(new Date(value + 'Z').toISOString().slice(0, 19), value, `invalid timestamp ${key}`);
  }
  assert.ok(record.warehouse === record.warehouse.trim().toUpperCase());
  assert.ok(!(record.warehouse in review.excludedCodes));
  const warehouse = byCode.get(record.warehouse);
  assert.equal(record.flags.includes('unverified_warehouse'), warehouse?.mappingStatus !== 'matched');
  assert.equal(record.flags.includes('warehouse_operator_unconfirmed'), review.operatorAmbiguousCodes.includes(record.warehouse));
  assert.equal(record.region, warehouse?.region ?? '');
  assert.equal(record.group, warehouse?.group ?? '');
  for (const flag of record.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
  if (record.status === 'arrived') assert.ok(totalDays(record) !== null, `invalid arrived record ${key}`);
  if (record.status === 'invalid') assert.ok(record.flags.some(f => ['negative_total', 'missing_departure'].includes(f)));
  if (record.status === 'unknown') assert.ok(!record.nodes.delivered);
  if (record.duplicateGroup) duplicates.set(record.duplicateGroup, (duplicates.get(record.duplicateGroup) ?? 0) + 1);
}
assert.deepEqual(flagCounts, manifest.flags);
assert.equal(duplicates.size, manifest.counts.duplicateGroups);
assert.equal([...duplicates.values()].reduce((a, n) => a + n - 1, 0), manifest.counts.duplicateExtraRows);
for (const status of ['arrived', 'unknown', 'invalid']) assert.equal(records.filter(r => r.status === status).length, manifest.counts[status]);
assert.equal(manifest.counts.arrived + manifest.counts.unknown + manifest.counts.invalid, records.length);
for (const sheet of manifest.sheets) {
  assert.equal(sheet.inputRows, sheet.businessRows + sheet.skippedRows);
  assert.equal(sheet.businessRows, sheet.includedRows + sheet.excludedRows);
  assert.equal(records.filter(r => r.source.sheet === sheet.sheet).length, sheet.includedRows);
}
assert.equal(manifest.sheets.reduce((sum, sheet) => sum + sheet.excludedRows, 0), manifest.exclusions.records);
assert.equal(manifest.sheets.reduce((sum, sheet) => sum + sheet.businessRows, 0), records.length + manifest.exclusions.records);
const arrived = records.filter(r => totalDays(r) !== null);
assert.equal(arrived.map(r => r.nodes.delivered).sort().at(-1).slice(0, 10), manifest.dataThrough);
assert.deepEqual([arrived.map(r => r.nodes.departure).sort()[0].slice(0, 10), arrived.map(r => r.nodes.departure).sort().at(-1).slice(0, 10)], manifest.departureRange);
const sample = records.filter(r => r.channel === '美森' && r.warehouse === 'ONT8');
console.log(JSON.stringify({ ok: true, records: records.length, warehouses: warehouses.length, sample: { warehouse: 'ONT8', channel: '美森', ...summarize(sample), within20: thresholdShare(sample, 20) } }));
