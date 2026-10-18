-- D1 / SQLite. Business data is private until an authenticated API is added.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_own INTEGER NOT NULL CHECK(is_own IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id),
  name TEXT NOT NULL, transport_mode TEXT NOT NULL,
  UNIQUE(provider_id, name, transport_mode)
);
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY, country_code TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'unknown'
    CHECK(platform IN ('amazon','walmart','other','unknown')),
  code TEXT NOT NULL, address TEXT, postal_code TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','verified')),
  UNIQUE(country_code, platform, code)
);
CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
  byte_size INTEGER, local_path TEXT, storage_key TEXT,
  archive_status TEXT NOT NULL DEFAULT 'local_only' CHECK(archive_status IN ('local_only','stored','unavailable'))
);
CREATE TABLE IF NOT EXISTS dataset_snapshots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source_kind TEXT NOT NULL,
  observed_date TEXT, source_version TEXT, manifest_hash TEXT NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, source_file_id TEXT NOT NULL REFERENCES source_files(id),
  provider_id TEXT NOT NULL REFERENCES providers(id), parser_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','published','archived','excluded','failed','revoked')),
  expected_quotes INTEGER NOT NULL CHECK(expected_quotes >= 0), imported_at TEXT NOT NULL,
  published_at TEXT, coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)), note TEXT
);
CREATE TABLE IF NOT EXISTS snapshot_batches (
  snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  PRIMARY KEY(snapshot_id, batch_id)
);
CREATE TABLE IF NOT EXISTS quote_rules (
  id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
  calculation_json TEXT NOT NULL CHECK(json_valid(calculation_json)),
  notes_json TEXT NOT NULL CHECK(json_valid(notes_json))
);
CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id),
  business_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, country_code TEXT NOT NULL,
  destination_label TEXT NOT NULL, delivery_type TEXT NOT NULL,
  billing_basis TEXT NOT NULL, currency TEXT,
  tax_variant TEXT NOT NULL, cargo_variant TEXT NOT NULL,
  identity_status TEXT NOT NULL DEFAULT 'provisional' CHECK(identity_status IN ('provisional','confirmed'))
);
CREATE TABLE IF NOT EXISTS quote_versions (
  id TEXT PRIMARY KEY, quote_item_id TEXT NOT NULL REFERENCES quote_items(id),
  batch_id TEXT NOT NULL REFERENCES import_batches(id), legacy_quote_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, rule_id TEXT NOT NULL REFERENCES quote_rules(id),
  quoted_on TEXT, valid_from TEXT, valid_to TEXT,
  date_evidence TEXT NOT NULL CHECK(date_evidence IN ('explicit','filename','unknown')),
  tax_mode TEXT NOT NULL CHECK(tax_mode IN ('included','excluded','partial','conditional','unknown')),
  duty_inclusion TEXT NOT NULL DEFAULT 'unknown' CHECK(duty_inclusion IN ('included','excluded','conditional','not_applicable','unknown')),
  vat_inclusion TEXT NOT NULL DEFAULT 'unknown' CHECK(vat_inclusion IN ('included','excluded','conditional','not_applicable','unknown')),
  tax_settlement TEXT NOT NULL DEFAULT 'unknown', tax_evidence TEXT NOT NULL,
  currency TEXT, currency_evidence TEXT NOT NULL,
  transit_text TEXT NOT NULL, legacy_status TEXT NOT NULL,
  pricing_readiness TEXT NOT NULL CHECK(pricing_readiness IN ('base_only','complete','needs_review','suspended','archive_only')),
  review_reasons_json TEXT NOT NULL CHECK(json_valid(review_reasons_json)),
  UNIQUE(batch_id, legacy_quote_id), CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE TABLE IF NOT EXISTS quote_tiers (
  id TEXT PRIMARY KEY, quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  ordinal INTEGER NOT NULL, label TEXT NOT NULL,
  min_quantity TEXT, max_quantity TEXT, min_inclusive INTEGER NOT NULL CHECK(min_inclusive IN (0,1)),
  max_inclusive INTEGER NOT NULL CHECK(max_inclusive IN (0,1)),
  price_micros INTEGER, price_decimal TEXT, currency TEXT,
  price_status TEXT NOT NULL CHECK(price_status IN ('priced','inquiry','unavailable')),
  source_cell TEXT NOT NULL,
  UNIQUE(quote_version_id, ordinal),
  CHECK(price_micros IS NULL OR price_micros >= 0),
  CHECK((price_status = 'priced' AND price_micros IS NOT NULL AND price_decimal IS NOT NULL)
     OR (price_status <> 'priced' AND price_micros IS NULL AND price_decimal IS NULL)),
  CHECK(min_quantity IS NULL OR max_quantity IS NULL OR CAST(max_quantity AS REAL) >= CAST(min_quantity AS REAL))
);
CREATE TABLE IF NOT EXISTS quote_targets (
  id TEXT PRIMARY KEY, quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  country_code TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('warehouse','postal_code','postal_prefix','postal_range','label')),
  warehouse_id TEXT REFERENCES warehouses(id), value TEXT NOT NULL, range_end TEXT,
  effect TEXT NOT NULL DEFAULT 'include' CHECK(effect IN ('include','exclude')),
  CHECK((target_kind = 'warehouse' AND warehouse_id IS NOT NULL) OR (target_kind <> 'warehouse' AND warehouse_id IS NULL)),
  CHECK((target_kind = 'postal_range' AND range_end IS NOT NULL) OR (target_kind <> 'postal_range' AND range_end IS NULL)),
  UNIQUE(quote_version_id, target_kind, value, range_end)
);
CREATE TABLE IF NOT EXISTS quote_cargo_types (
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id), cargo_type TEXT NOT NULL,
  acceptance TEXT NOT NULL CHECK(acceptance IN ('allowed','forbidden','conditional','unknown')),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('explicit','inferred','unknown')),
  conditions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conditions_json)), evidence_text TEXT NOT NULL,
  PRIMARY KEY(quote_version_id, cargo_type)
);
CREATE TABLE IF NOT EXISTS quote_charge_rules (
  id TEXT PRIMARY KEY, quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  tier_id TEXT REFERENCES quote_tiers(id), fee_code TEXT NOT NULL, label TEXT NOT NULL,
  calculation_type TEXT NOT NULL CHECK(calculation_type IN ('fixed','per_unit','percentage','tiered','unknown')),
  charge_basis TEXT NOT NULL CHECK(charge_basis IN ('shipment','piece','pallet','kg','cbm','container','unknown')),
  amount_micros INTEGER, amount_decimal TEXT, currency TEXT,
  minimum_micros INTEGER, maximum_micros INTEGER,
  inclusion TEXT NOT NULL DEFAULT 'unknown' CHECK(inclusion IN ('included','additional','unknown')),
  stacking TEXT NOT NULL DEFAULT 'unknown' CHECK(stacking IN ('add','exclusive','unknown')),
  exclusive_group TEXT, calculation_base TEXT,
  conditions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(conditions_json)),
  review_status TEXT NOT NULL CHECK(review_status IN ('verified','needs_review')),
  evidence_text TEXT NOT NULL,
  CHECK(amount_micros IS NULL OR amount_micros >= 0)
);
CREATE TABLE IF NOT EXISTS charge_rule_targets (
  id TEXT PRIMARY KEY, charge_rule_id TEXT NOT NULL REFERENCES quote_charge_rules(id),
  country_code TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('warehouse','postal_code','postal_prefix','postal_range','address_type')),
  value TEXT NOT NULL, range_end TEXT, effect TEXT NOT NULL CHECK(effect IN ('include','exclude'))
);
CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
  quote_version_id TEXT NOT NULL UNIQUE REFERENCES quote_versions(id), legacy_quote_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL, cells_json TEXT NOT NULL CHECK(json_valid(cells_json)),
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)), source_quote_json TEXT NOT NULL CHECK(json_valid(source_quote_json)),
  reconciliation_status TEXT NOT NULL CHECK(reconciliation_status IN ('matched','missing_evidence','mismatch')),
  UNIQUE(batch_id, legacy_quote_id)
);
CREATE TABLE IF NOT EXISTS import_issues (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
  quote_version_id TEXT REFERENCES quote_versions(id),
  severity TEXT NOT NULL CHECK(severity IN ('info','review','error')),
  code TEXT NOT NULL, message TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  resolution TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY, identity_subject TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
);

CREATE INDEX IF NOT EXISTS idx_channels_provider ON channels(provider_id);
CREATE INDEX IF NOT EXISTS idx_items_search ON quote_items(country_code, billing_basis, channel_id);
CREATE INDEX IF NOT EXISTS idx_versions_item_date ON quote_versions(quote_item_id, valid_from, quoted_on);
CREATE INDEX IF NOT EXISTS idx_versions_batch ON quote_versions(batch_id);
CREATE INDEX IF NOT EXISTS idx_versions_tax ON quote_versions(tax_mode, pricing_readiness);
CREATE INDEX IF NOT EXISTS idx_targets_warehouse ON quote_targets(warehouse_id, quote_version_id);
CREATE INDEX IF NOT EXISTS idx_targets_postal ON quote_targets(country_code, target_kind, value);
CREATE INDEX IF NOT EXISTS idx_cargo_search ON quote_cargo_types(cargo_type, acceptance, quote_version_id);
CREATE INDEX IF NOT EXISTS idx_charges_version ON quote_charge_rules(quote_version_id);
CREATE INDEX IF NOT EXISTS idx_issues_batch ON import_issues(batch_id, severity, code);

-- This view deliberately does NOT choose MAX(imported_at) as the current price.
-- API selection must use explicit business validity, not the upload date.
CREATE VIEW IF NOT EXISTS published_quote_versions AS
SELECT v.* FROM quote_versions v JOIN import_batches b ON b.id = v.batch_id
WHERE b.status = 'published' AND v.pricing_readiness <> 'archive_only';

CREATE TRIGGER IF NOT EXISTS guard_publish_batch BEFORE UPDATE OF status ON import_batches
WHEN NEW.status = 'published' AND OLD.status <> 'published'
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM quote_versions WHERE batch_id = NEW.id) <> NEW.expected_quotes
    THEN RAISE(ABORT, 'incomplete quote batch') END;
  SELECT CASE WHEN (SELECT count(*) FROM import_rows WHERE batch_id = NEW.id) <> NEW.expected_quotes
    THEN RAISE(ABORT, 'incomplete source evidence') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM import_issues WHERE batch_id = NEW.id AND severity = 'error' AND resolved_at IS NULL)
    THEN RAISE(ABORT, 'unresolved import errors') END;
END;
