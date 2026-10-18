import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Decimal from 'decimal.js';
import type { Catalog, Quote } from '../../src/domain/types.ts';
import { MIGRATION_PARSER_VERSION, digest, idFor, money, taxTerms, cargoRules, itemIdentity, sqlLiteral } from './rules.ts';
import { refineHistory } from './refine-history.ts';

type Row = Record<string, string | number | null>;
type Cell = { coord: string; value?: unknown; formula?: unknown; cached?: unknown };
type Sheet = { name: string; head: { row: number; cells: Cell[] }[]; requires_deeper_read?: boolean; rows: number; cols: number };
type Source = { id: string; name: string; path?: string; sha256: string; size_bytes?: number; sheets?: Sheet[]; readable: boolean; status?: string; error?: string };
type SnapshotInput = { name: string; kind: string; observedDate: string | null; dataDir: string; extract: string };
const read = <T>(filename: string): T => JSON.parse(fs.readFileSync(filename, 'utf8'));
const stringify = (value: unknown) => JSON.stringify(value);
const quantity = (value: number | null | undefined) => value == null ? null : new Decimal(value).toString();

export const TABLE_ORDER = ['providers','channels','warehouses','source_files','dataset_snapshots','import_batches','snapshot_batches',
  'quote_rules','quote_items','quote_versions','quote_tiers','quote_targets','quote_cargo_types','quote_charge_rules','charge_rule_targets',
  'import_rows','review_tasks','review_task_quotes','import_issues','app_users','audit_logs'];

export function buildHistory(options: { manifest?: string; database?: string; output?: string; includePublished?: boolean } = {}) {
  const output = path.resolve(options.output ?? '.local/d1-import');
  fs.mkdirSync(output, { recursive: true });
  const databasePath = path.resolve(options.database ?? path.join(output, 'freight-quotes.sqlite'));
  const db = new DatabaseSync(databasePath);
  db.exec(fs.readFileSync('migrations/0001_quote_history.sql', 'utf8'));
  if(!db.prepare('PRAGMA table_info(quote_versions)').all().some(c=>c.name==='semantic_parser_version'))
    db.exec(fs.readFileSync('migrations/0002_semantic_refinement.sql','utf8'));
  const now = new Date().toISOString();
  const manifestPath = options.manifest ?? '.local/history/manifest.json';
  const inputs = fs.existsSync(manifestPath) ? read<{snapshots: SnapshotInput[]}>(manifestPath).snapshots : [];
  if (options.includePublished !== false) inputs.unshift({ name: '已发布网站数据', kind: 'published_json', observedDate: null,
    dataDir: path.resolve('public/data'), extract: path.resolve('analysis/latest-extract.json') });
  if (!inputs.length) throw new Error('No source snapshots');
  const verifiedPaths = new Map<string, string>();
  for (const input of inputs) {
    if (!fs.existsSync(input.extract)) continue;
    for (const file of read<{files:Source[]}>(input.extract).files) {
      if (!file.path || !fs.existsSync(file.path)) continue;
      // Compare raw-byte SHA-256, not the name or the mtime of a workbook.
      const rawHash = createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
      if (rawHash === file.sha256) verifiedPaths.set(file.sha256, file.path);
    }
  }

  const inserts = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const put = (table: string, row: Row, conflict = 'id') => {
    const keys = Object.keys(row);
    const query = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(${conflict}) DO NOTHING`;
    if (!inserts.has(query)) inserts.set(query, db.prepare(query));
    inserts.get(query)!.run(...keys.map(k => row[k]));
  };
  const issue = (batch: string, version: string | null, code: string, message: string, severity = 'review', evidence: unknown = {}) => {
    put('import_issues', { id: idFor('issue', [batch,version,code,message]), batch_id: batch, quote_version_id: version,
      severity, code, message, evidence_json: stringify(evidence) });
  };
  const reconciliation: Record<string, number> = { pricedCells: 0, matchedCells: 0, missingCells: 0, mismatchedCells: 0 };
  const snapshotReports: unknown[] = [];

  for (const input of inputs) {
    const catalog = read<Catalog>(path.join(input.dataDir, 'catalog.json'));
    const coverage = read<Array<Record<string, unknown> & {id: string}>>(path.join(input.dataDir, 'coverage.json'));
    const extract = fs.existsSync(input.extract) ? read<{files: Source[]}>(input.extract) : { files: [] };
    const manifestHash = digest({files:catalog.files.map(f => [f.id,f.sha256]), chunks:catalog.chunks});
    const snapshotId = idFor('snapshot', [input.kind, input.name, manifestHash]);
    db.exec('BEGIN');
    try {
      put('dataset_snapshots', { id: snapshotId, name: input.name, source_kind: input.kind,
        observed_date: input.observedDate, source_version: catalog.version, manifest_hash: manifestHash, imported_at: now });
      const allQuotes: Quote[] = [];
      for (const chunk of catalog.chunks) {
        const rules = read<Record<string,string[]>>(path.join(input.dataDir, chunk.rulesPath!));
        const quotes = read<Array<Quote & {ruleRef?: string}>>(path.join(input.dataDir, chunk.path));
        if (quotes.length !== chunk.count) throw new Error(`Wrong chunk count: ${chunk.path}`);
        for (const q of quotes) {
          if (!q.ruleRef || !rules[q.ruleRef]) throw new Error(`Missing rules: ${q.id}`);
          allQuotes.push({ ...q, notes: [...new Set([...q.notes, ...rules[q.ruleRef]])] });
        }
      }
      if (allQuotes.length !== catalog.stats.quotes || new Set(allQuotes.map(q => q.id)).size !== allQuotes.length) throw new Error(`Invalid catalog: ${input.name}`);
      let snapshotTiers = 0;
      for (const file of catalog.files) {
        const quotes = allQuotes.filter(q => q.source.fileId === file.id);
        if (quotes.length !== file.quoteCount) throw new Error(`Source count mismatch: ${file.name}`);
        const source = extract.files.find(f => f.id === file.id && f.sha256 === file.sha256);
        const fileId = idFor('file', file.sha256);
        put('providers', { id: file.providerId, name: file.providerName, is_own: file.providerId === 'zhonghang' ? 1 : 0,
          active: source?.status === 'excluded_non_quote' ? 0 : 1 });
        put('source_files', { id: fileId, sha256: file.sha256, original_name: file.name,
          byte_size: source?.size_bytes ?? null, local_path: verifiedPaths.get(file.sha256) ?? null,
          archive_status: verifiedPaths.has(file.sha256) ? 'local_only' : 'unavailable' });
        if (verifiedPaths.has(file.sha256)) db.prepare("UPDATE source_files SET local_path=?,archive_status='local_only' WHERE id=?").run(verifiedPaths.get(file.sha256)!,fileId);
        const contentFingerprint = digest(quotes);
        const batchId = idFor('batch', [file.sha256, file.name, MIGRATION_PARSER_VERSION, contentFingerprint]);
        const archived = /备份|加价前/.test(file.name);
        const excluded = source?.status === 'excluded_non_quote';
        const fileCoverage = coverage.find(c => c.id === file.id) ?? file;
        put('import_batches', { id: batchId, source_file_id: fileId, provider_id: file.providerId,
          parser_version: MIGRATION_PARSER_VERSION, idempotency_key: batchId, original_name: file.name,
          status: 'staged', expected_quotes: quotes.length, imported_at: now,
          coverage_json: stringify(fileCoverage), note: archived ? '备份保留为历史，不能作为当前报价' : excluded ? '非报价工作簿' : null });
        put('snapshot_batches', { snapshot_id: snapshotId, batch_id: batchId }, 'snapshot_id,batch_id');
        const sourceSheets = new Map((source?.sheets ?? []).map(sheet => [sheet.name,
          new Map(sheet.head.flatMap(row => row.cells.map(cell => [cell.coord, cell] as const)))]));
        if (!source) issue(batchId, null, 'SOURCE_EXTRACTION_MISSING', '未找到哈希一致的原表提取证据', 'error');
        if (!quotes.length) issue(batchId, null, excluded ? 'NON_QUOTE_FILE' : 'NO_RECOGNIZED_QUOTES',
          excluded ? '货箱明细已登记但不作为报价' : '尚未识别出可导入报价，需要适配该表', excluded ? 'info' : 'review');
        if ((source?.sheets ?? []).some(s => s.requires_deeper_read)) issue(batchId, null, 'SAMPLED_REFERENCE_SHEETS', '部分大型或混合附表只提取了样本，覆盖范围见记录');
        if (archived) issue(batchId, null, 'ARCHIVE_ONLY', '备份文件保留历史，禁止作为当前报价', 'info');

        for (const q of quotes) {
          const tax = taxTerms(q.channelName);
          const cargo = cargoRules(q);
          const channelId = idFor('channel', [q.providerId, q.channelName, q.mode]);
          put('channels', { id: channelId, provider_id: q.providerId, name: q.channelName, transport_mode: q.mode });
          const businessKey = stringify(itemIdentity(q, tax.mode));
          const itemId = idFor('item', businessKey);
          put('quote_items', { id: itemId, channel_id: channelId, business_key: businessKey, origin: q.origin,
            country_code: q.countryCode, destination_label: q.destinationLabel, delivery_type: q.delivery,
            billing_basis: q.billingBasis, currency: q.currency, tax_variant: tax.mode, cargo_variant: stringify([...q.cargoTypes].sort()) });
          const calculations = { volumetricDivisor: q.volumetricDivisor, minShipmentKg: q.minShipmentKg, minPieceKg: q.minPieceKg,
            minCbm: q.minCbm, maxKgPerCbm: q.maxKgPerCbm, densityConversionKgPerCbm: q.densityConversionKgPerCbm ?? null,
            volumeEquivalentKgPerCbm: q.volumeEquivalentKgPerCbm ?? null, reliability: q.reliability };
          const ruleHash = digest({ calculations, notes: q.notes });
          const ruleId = idFor('rule', ruleHash);
          put('quote_rules', { id: ruleId, content_hash: ruleHash, calculation_json: stringify(calculations), notes_json: stringify(q.notes) });
          const versionId = idFor('version', [batchId, q.id]);
          put('quote_versions', { id: versionId, quote_item_id: itemId, batch_id: batchId, legacy_quote_id: q.id,
            content_hash: digest(q), rule_id: ruleId, quoted_on: q.priceDate, valid_from: q.effectiveAt, valid_to: null,
            date_evidence: q.dateKind, tax_mode: tax.mode, duty_inclusion: tax.duty, vat_inclusion: tax.vat,
            tax_settlement: tax.settlement, tax_evidence: tax.evidence, currency: q.currency, currency_evidence: q.currencyEvidence,
            transit_text: q.transitText, legacy_status: q.status,
            pricing_readiness: archived ? 'archive_only' : q.status === 'suspended' ? 'suspended' : q.status === 'needs_review' ? 'needs_review' : 'base_only',
            review_reasons_json: stringify(q.reviewReasons) });
          if (tax.mode === 'unknown') issue(batchId, versionId, tax.conflict ? 'TAX_CONFLICT' : 'TAX_UNKNOWN', '税费口径不能从该报价行可靠确认');
          if (!q.effectiveAt) issue(batchId, versionId, 'EFFECTIVE_DATE_UNCONFIRMED', '无明确生效时刻；未用导入时间替代');
          if (q.notes.some(n => /附加|偏远|派送费|每票|加收|不含|另收|另计/.test(n))) issue(batchId, versionId, 'UNSTRUCTURED_CHARGES', '附加费用原文已保留；未明确适用范围的费用不能当作0');
          if (q.warehouseCodes.length) issue(batchId, versionId, 'WAREHOUSE_PLATFORM_UNVERIFIED', '仓库代码已保留，平台与地址须核验，未沿用仓码即亚马逊的推测');
          let quoteReconciliation = 'matched';
          for (const [ordinal, tier] of q.tiers.entries()) {
            snapshotTiers++;
            const amount = money(tier.price);
            const tierId = idFor('tier', [versionId, ordinal]);
            put('quote_tiers', { id: tierId, quote_version_id: versionId, ordinal, label: tier.label,
              min_quantity: quantity(tier.min), max_quantity: quantity(tier.max),
              min_inclusive: tier.minInclusive === false ? 0 : 1, max_inclusive: tier.maxInclusive === false ? 0 : 1,
              price_micros: amount.micros, price_decimal: amount.decimal, currency: q.currency,
              price_status: tier.status, source_cell: tier.sourceCell });
            if (tier.fixedFee != null) {
              const fixed = money(tier.fixedFee);
              put('quote_charge_rules', { id: idFor('charge', tierId), quote_version_id: versionId, tier_id: tierId,
                fee_code: 'legacy_fixed_fee', label: '原表固定处理费（计费次数待核）', calculation_type: 'fixed', charge_basis: 'unknown',
                amount_micros: fixed.micros, amount_decimal: fixed.decimal, currency: q.currency,
                inclusion: 'additional', stacking: 'unknown', review_status: 'needs_review',
                evidence_text: '历史字段 fixedFee 未可靠区分每件/每票，保留数值但不据此宣称总价完整' });
              issue(batchId, versionId, 'FIXED_FEE_BASIS_UNKNOWN', '固定费用数值已迁移，按件还是按票仍需确认');
            }
            const evidence = sourceSheets.get(q.source.sheet)?.get(tier.sourceCell);
            if (tier.price !== null) {
              reconciliation.pricedCells++;
              const raw = evidence?.formula ? evidence.cached : evidence?.value;
              if (raw === undefined || raw === null || raw === '') {
                reconciliation.missingCells++; quoteReconciliation = 'missing_evidence';
                issue(batchId, versionId, 'PRICE_EVIDENCE_MISSING', `价格单元格缺失：${q.source.sheet}!${tier.sourceCell}`, 'error');
              } else if (!Number.isFinite(Number(raw)) || !new Decimal(String(raw)).eq(tier.price)) {
                reconciliation.mismatchedCells++; quoteReconciliation = 'mismatch';
                issue(batchId, versionId, 'PRICE_MISMATCH', `价格与原表不一致：${q.source.sheet}!${tier.sourceCell}`, 'error', { raw, parsed: tier.price });
              } else reconciliation.matchedCells++;
            }
          }
          const targets: Array<{kind: string; value: string; end?: string}> = [
            ...q.warehouseCodes.map(value => ({kind: 'warehouse', value})),
            ...q.postalPrefixes.map(value => ({kind: 'postal_prefix', value})),
            ...(q.postalCodes ?? []).map(value => ({kind: 'postal_code', value})),
            ...(q.postalRanges ?? []).map(r => ({kind: 'postal_range', value: r.start, end: r.end})),
          ];
          if (!targets.length) targets.push({kind: 'label', value: q.destinationLabel});
          for (const target of targets) {
            let warehouseId: string | null = null;
            if (target.kind === 'warehouse') {
              warehouseId = idFor('warehouse', [q.countryCode, 'unknown', target.value]);
              put('warehouses', { id: warehouseId, country_code: q.countryCode, platform: 'unknown', code: target.value });
            }
            put('quote_targets', { id: idFor('target', [versionId, target]), quote_version_id: versionId, country_code: q.countryCode,
              target_kind: target.kind, warehouse_id: warehouseId, value: target.value, range_end: target.end ?? null });
          }
          for (const c of cargo) {
            put('quote_cargo_types', { quote_version_id: versionId, cargo_type: c.type, acceptance: c.acceptance,
              evidence_kind: c.evidenceKind, conditions_json: stringify(c.conditions), evidence_text: c.evidence }, 'quote_version_id,cargo_type');
          }
          if (cargo.some(c => c.acceptance === 'unknown')) issue(batchId, versionId, 'CARGO_UNCONFIRMED', '历史货品标签缺少该行明确承运依据，未自动确认为可接');
          put('import_rows', { id: idFor('row', versionId), batch_id: batchId, quote_version_id: versionId, legacy_quote_id: q.id,
            sheet_name: q.source.sheet, cells_json: stringify(q.source.cells), hidden: q.source.hidden ? 1 : 0,
            source_quote_json: stringify({...q, notes: []}), reconciliation_status: quoteReconciliation });
        }
        const ambiguousItems = db.prepare('SELECT quote_item_id,count(*) AS n FROM quote_versions WHERE batch_id=? GROUP BY quote_item_id HAVING count(*)>1').all(batchId);
        if (ambiguousItems.length) issue(batchId,null,'ITEM_IDENTITY_AMBIGUOUS',`${ambiguousItems.length} 个业务条件对应多个原表报价，保留全部版本，渠道身份需复核`,'review',ambiguousItems);
        const errorCount = (db.prepare("SELECT count(*) AS n FROM import_issues WHERE batch_id=? AND severity='error' AND resolved_at IS NULL").get(batchId) as {n: number}).n;
        const status = errorCount ? 'failed' : excluded ? 'excluded' : archived ? 'archived' : quotes.length ? 'published' : 'staged';
        db.prepare('UPDATE import_batches SET status=?, published_at=CASE WHEN ?=\'published\' THEN COALESCE(published_at,?) ELSE published_at END WHERE id=?').run(status,status,now,batchId);
        put('audit_logs', { id: idFor('audit', [batchId,'import']), actor: 'history-migration', action: 'import_verified_history',
          entity_type: 'import_batch', entity_id: batchId, occurred_at: now, detail_json: stringify({status,quotes:quotes.length}) });
      }
      db.exec('COMMIT');
      snapshotReports.push({ name: input.name, snapshotId, sourceFiles: catalog.files.length, quotes: allQuotes.length, tiers: snapshotTiers });
      console.log(`${input.name}: ${allQuotes.length} quotes, ${snapshotTiers} tiers`);
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const counts = Object.fromEntries(TABLE_ORDER.map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n]));
  const report = { generatedAt: now, databasePath, snapshots: snapshotReports, counts, reconciliation,
    taxModes: db.prepare('SELECT tax_mode, count(*) AS count FROM quote_versions GROUP BY tax_mode').all(),
    batches: db.prepare('SELECT original_name, status, expected_quotes FROM import_batches ORDER BY original_name').all(),
    issueSummary: db.prepare('SELECT severity, code, count(*) AS count FROM import_issues GROUP BY severity, code ORDER BY severity, code').all(),
    integrity: db.prepare('PRAGMA integrity_check').all(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() };
  fs.writeFileSync(path.join(output,'import-report.json'), JSON.stringify(report,null,2));
  db.close();
  console.log(JSON.stringify({counts,reconciliation,databasePath}));
  return report;
}

export function exportData(databasePath = '.local/d1-import/freight-quotes.sqlite', output = '.local/d1-import') {
  const db = new DatabaseSync(databasePath, {readOnly: true});
  const errors = db.prepare("SELECT count(*) AS n FROM import_issues WHERE severity='error' AND resolved_at IS NULL").get() as {n: number};
  if (errors.n) throw new Error(`Cannot export: ${errors.n} unresolved import errors`);
  const filename = path.join(output,'import.sql');
  const fd = fs.openSync(filename,'w');
  // All rows land as staged. Remote verification must complete before publishing.
  for (const table of TABLE_ORDER) {
    if (table === 'audit_logs') continue;
    for (const data of db.prepare(`SELECT * FROM ${table}`).all()) {
      const row = data as Row;
      if (table === 'import_batches') { row.status = 'staged'; row.published_at = null; }
      const statement = `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sqlLiteral).join(',')}) ON CONFLICT DO NOTHING;\n`;
      if (Buffer.byteLength(statement) > 95_000) throw new Error(`D1 statement exceeds safe size in ${table}`);
      fs.writeSync(fd, statement);
    }
  }
  fs.closeSync(fd);
  const finalize: string[] = [];
  for (const row of db.prepare('SELECT id,status,published_at FROM import_batches').all()) {
    finalize.push(`UPDATE import_batches SET status=${sqlLiteral(row.status)},published_at=${sqlLiteral(row.published_at)} WHERE id=${sqlLiteral(row.id)};`);
  }
  for (const row of db.prepare('SELECT * FROM audit_logs').all()) {
    finalize.push(`INSERT INTO audit_logs (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sqlLiteral).join(',')}) ON CONFLICT DO NOTHING;`);
  }
  fs.writeFileSync(path.join(output,'publish.sql'),finalize.join('\n'));
  db.close();
  return filename;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildHistory();
  refineHistory('.local/d1-import/freight-quotes.sqlite','.local/d1-import');
  console.log('Export:', exportData());
}
