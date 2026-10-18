import type { Catalog, CargoAcceptance, HistoryEntry, Quote, RateTier, SourceFile, TaxTerms } from '../src/domain/types';
import { ApiError, rows, type Database, type Row } from './db';

export const visible = `b.status = 'published' AND v.pricing_readiness <> 'archive_only' AND p.active = 1`;
export const joins = `FROM quote_versions v JOIN import_batches b ON b.id=v.batch_id
  JOIN quote_items i ON i.id=v.quote_item_id JOIN channels c ON c.id=i.channel_id
  JOIN providers p ON p.id=c.provider_id`;
export const deliverySql = `CASE WHEN i.delivery_type='amazon' AND EXISTS (
  SELECT 1 FROM quote_targets t LEFT JOIN warehouses w ON w.id=t.warehouse_id
  WHERE t.quote_version_id=v.id AND t.target_kind='warehouse' AND (w.platform<>'amazon' OR w.verification_status<>'verified')
) THEN 'unknown' ELSE i.delivery_type END`;

export async function resolveSnapshot(db: Database, id?: string): Promise<Row> {
  const [snapshot] = await rows(db, `SELECT s.* FROM dataset_snapshots s WHERE ${id ? 's.id=?' : "s.source_kind='published_json'"}
    AND EXISTS (SELECT 1 FROM snapshot_batches sb JOIN import_batches b ON b.id=sb.batch_id WHERE sb.snapshot_id=s.id AND b.status='published')
    ORDER BY s.id LIMIT 1`, id ? [id] : []);
  if (!snapshot) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', '报价资料集不存在或尚未发布');
  return snapshot;
}

export async function getCatalog(db: Database, id?: string): Promise<Catalog> {
  const snapshot = await resolveSnapshot(db, id);
  const [snapshots, stats, files] = await Promise.all([
    rows(db, `SELECT s.id,s.name,s.observed_date,s.source_kind FROM dataset_snapshots s WHERE EXISTS
      (SELECT 1 FROM snapshot_batches sb JOIN import_batches b ON b.id=sb.batch_id WHERE sb.snapshot_id=s.id AND b.status='published')
      ORDER BY (s.source_kind='published_json') DESC, s.observed_date DESC,s.id`),
    rows(db, `SELECT count(*) quotes,count(DISTINCT p.id) providers,count(DISTINCT i.country_code) countries,
      count(DISTINCT b.id) sources,coalesce(sum(i.billing_basis='cbm'),0) cbmQuotes ${joins}
      JOIN snapshot_batches sb ON sb.batch_id=b.id WHERE ${visible} AND sb.snapshot_id=?`, [snapshot.id]),
    rows(db, `SELECT b.id,b.original_name,b.coverage_json,p.id provider_id,p.name provider_name,f.sha256,
      (SELECT count(*) FROM quote_versions v WHERE v.batch_id=b.id AND v.pricing_readiness<>'archive_only') quote_count
      FROM snapshot_batches sb JOIN import_batches b ON b.id=sb.batch_id JOIN providers p ON p.id=b.provider_id
      JOIN source_files f ON f.id=b.source_file_id WHERE sb.snapshot_id=? AND b.status='published' AND p.active=1 ORDER BY p.name,b.original_name,b.id`, [snapshot.id]),
  ]);
  return {
    schemaVersion: '1.0', version: `${snapshot.name} · ${snapshot.source_version}`, generatedAt: snapshot.imported_at,
    snapshotId: snapshot.id, snapshots: snapshots.map(s => ({ id: s.id, name: s.name, observedDate: s.observed_date, sourceKind: s.source_kind })),
    chunks: [], stats: stats[0] as Catalog['stats'],
    files: files.map(file => {
      const coverage = JSON.parse(file.coverage_json);
      return { id: file.id, name: file.original_name, providerId: file.provider_id, providerName: file.provider_name,
        sha256: file.sha256, quoteCount: file.quote_count, sheets: coverage.sheets ?? 0,
        hiddenSheets: coverage.hiddenSheets ?? 0, status: coverage.status ?? 'partial', warnings: coverage.warnings ?? [] } as SourceFile;
    }),
  };
}

function tax(row: Row): TaxTerms {
  return { mode: row.tax_mode, duty: row.duty_inclusion, vat: row.vat_inclusion, settlement: row.tax_settlement,
    evidenceKind: row.tax_evidence_kind, evidence: row.tax_evidence };
}
function tier(row: Row, fees: Row[]): RateTier {
  const fee = fees.find(f => f.tier_id === row.id && f.fee_code === 'legacy_fixed_fee');
  const conditions = fee ? JSON.parse(fee.conditions_json) : {};
  return { id: row.id, label: row.label, min: row.min_quantity == null ? null : Number(row.min_quantity),
    max: row.max_quantity == null ? null : Number(row.max_quantity), minInclusive: !!row.min_inclusive,
    maxInclusive: !!row.max_inclusive, price: row.price_decimal == null ? null : Number(row.price_decimal),
    status: row.price_status, sourceCell: row.source_cell, tax: tax(row),
    ...(fee ? { fixedFee: Number(fee.amount_decimal), fixedFeeBasis: ['shipment','piece'].includes(fee.charge_basis) ? fee.charge_basis : 'unknown',
      fixedFeeConfirmed: fee.review_status === 'verified' && ['shipment','piece'].includes(fee.charge_basis) &&
        !conditions.delivery_zone && fee.currency === row.currency } : {}),
  };
}

export async function getQuotes(db: Database, ids: string[]): Promise<Quote[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const [versions, tiers, targets, cargo, fees] = await Promise.all([
    rows(db, `SELECT v.*,i.origin,i.country_code,i.destination_label,i.billing_basis,${deliverySql} delivery,
      c.name channel_name,c.transport_mode,p.id provider_id,p.name provider_name,p.is_own,
      r.calculation_json,r.notes_json,ir.sheet_name,ir.cells_json,ir.hidden,b.original_name,b.source_file_id
      ${joins} JOIN quote_rules r ON r.id=v.rule_id JOIN import_rows ir ON ir.quote_version_id=v.id
      WHERE ${visible} AND v.id IN (${marks})`, ids),
    rows(db, `SELECT * FROM quote_tiers WHERE quote_version_id IN (${marks}) ORDER BY quote_version_id,ordinal`, ids),
    rows(db, `SELECT * FROM quote_targets WHERE quote_version_id IN (${marks})`, ids),
    rows(db, `SELECT * FROM quote_cargo_types WHERE quote_version_id IN (${marks})`, ids),
    rows(db, `SELECT * FROM quote_charge_rules WHERE quote_version_id IN (${marks}) ORDER BY id`, ids),
  ]);
  const quotes = versions.map(v => {
    const rules = JSON.parse(v.calculation_json);
    const qTargets = targets.filter(t => t.quote_version_id === v.id && t.effect === 'include');
    const qFees = fees.filter(f => f.quote_version_id === v.id);
    const qCargo: CargoAcceptance[] = cargo.filter(c => c.quote_version_id === v.id).map(c => ({
      type: c.cargo_type, acceptance: c.acceptance, evidenceKind: c.evidence_kind,
      conditions: JSON.parse(c.conditions_json), evidence: c.evidence_text,
    }));
    return {
      ...rules, id: v.id, itemId: v.quote_item_id, providerId: v.provider_id, providerName: v.provider_name, isOwn: !!v.is_own,
      channelName: v.channel_name, countryCode: v.country_code, mode: v.transport_mode, delivery: v.delivery,
      origin: v.origin, destinationLabel: v.destination_label,
      warehouseCodes: qTargets.filter(t => t.target_kind === 'warehouse').map(t => t.value),
      postalPrefixes: qTargets.filter(t => t.target_kind === 'postal_prefix').map(t => t.value),
      postalCodes: qTargets.filter(t => t.target_kind === 'postal_code').map(t => t.value),
      postalRanges: qTargets.filter(t => t.target_kind === 'postal_range').map(t => ({ start: t.value, end: t.range_end })),
      cargoAcceptance: qCargo, cargoTypes: qCargo.filter(c => c.acceptance === 'allowed').map(c => c.type),
      cargoCertainty: qCargo.some(c => c.acceptance === 'allowed') ? 'explicit' : 'unknown',
      billingBasis: v.billing_basis, currency: v.currency, currencyEvidence: v.currency_evidence,
      tiers: tiers.filter(t => t.quote_version_id === v.id).map(t => tier(t, qFees)),
      transitText: v.transit_text, notes: JSON.parse(v.notes_json), priceDate: v.quoted_on,
      effectiveAt: v.valid_from, validTo: v.valid_to, dateKind: v.date_evidence,
      status: ['suspended','needs_review'].includes(v.pricing_readiness) ? v.pricing_readiness : v.legacy_status,
      reviewReasons: JSON.parse(v.review_reasons_json), tax: tax(v),
      charges: qFees.map(f => ({ id: f.id, label: f.label, amount: f.amount_decimal, currency: f.currency,
        basis: f.charge_basis, reviewStatus: f.review_status, conditions: JSON.parse(f.conditions_json), evidence: f.evidence_text })),
      source: { fileId: v.source_file_id, fileName: v.original_name, sheet: v.sheet_name, cells: JSON.parse(v.cells_json), hidden: !!v.hidden },
    } as Quote;
  });
  const byId = new Map(quotes.map(q => [q.id,q]));
  return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}

export async function requireQuote(db: Database, id: string): Promise<Quote> {
  const [quote] = await getQuotes(db, [id]);
  if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', '报价不存在或尚未发布');
  return quote;
}

export async function getHistory(db: Database, id: string, page: number, pageSize: number) {
  const quote = await requireQuote(db, id);
  const [count] = await rows(db, `SELECT count(*) total ${joins} WHERE ${visible} AND v.quote_item_id=?`, [quote.itemId]);
  const versions = await rows(db, `SELECT v.id ${joins} WHERE ${visible} AND v.quote_item_id=?
    ORDER BY coalesce(v.valid_from,v.quoted_on,'') DESC,v.id LIMIT ? OFFSET ?`, [quote.itemId,pageSize,(page-1)*pageSize]);
  const quotes = await getQuotes(db, versions.map(v => v.id));
  const names = versions.length ? await rows(db, `SELECT v.id,s.name FROM quote_versions v JOIN snapshot_batches sb ON sb.batch_id=v.batch_id
    JOIN dataset_snapshots s ON s.id=sb.snapshot_id WHERE v.id IN (${versions.map(() => '?').join(',')}) ORDER BY s.name`, versions.map(v => v.id)) : [];
  const items: HistoryEntry[] = quotes.map(q => ({ id: q.id, quotedOn: q.priceDate, validFrom: q.effectiveAt,
    validTo: q.validTo ?? null, dateEvidence: q.dateKind, fileName: q.source.fileName, sheet: q.source.sheet,
    taxMode: q.tax!.mode, snapshots: names.filter(n => n.id === q.id).map(n => n.name), tiers: q.tiers }));
  return { items, total: count.total, page, pageSize, identityNote: '按暂定业务条件关联；同条件多来源均保留，不自动认定最新导入记录为当前价。' };
}
