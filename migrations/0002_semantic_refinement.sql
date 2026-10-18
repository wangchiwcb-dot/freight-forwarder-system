-- Semantic corrections retain immutable imported source JSON and prices.
ALTER TABLE quote_versions ADD COLUMN semantic_parser_version TEXT NOT NULL DEFAULT 'history-migration/1';
ALTER TABLE quote_versions ADD COLUMN tax_evidence_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE quote_versions ADD COLUMN semantic_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(semantic_evidence_json));
ALTER TABLE quote_tiers ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE quote_tiers ADD COLUMN duty_inclusion TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE quote_tiers ADD COLUMN vat_inclusion TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE quote_tiers ADD COLUMN tax_settlement TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE quote_tiers ADD COLUMN tax_evidence_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE quote_tiers ADD COLUMN tax_evidence TEXT NOT NULL DEFAULT '';

CREATE TABLE review_tasks (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('parsing','business','reference')),
  scope_key TEXT NOT NULL UNIQUE, source_file_id TEXT REFERENCES source_files(id), sheet_name TEXT,
  title TEXT NOT NULL, detail TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE review_task_quotes (
  task_id TEXT NOT NULL REFERENCES review_tasks(id), quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  PRIMARY KEY(task_id,quote_version_id)
);
ALTER TABLE import_issues ADD COLUMN review_task_id TEXT REFERENCES review_tasks(id);
CREATE INDEX idx_review_tasks_status ON review_tasks(status,category,code);
CREATE INDEX idx_review_quotes_version ON review_task_quotes(quote_version_id);
CREATE INDEX IF NOT EXISTS idx_issues_quote_version ON import_issues(quote_version_id);
CREATE INDEX IF NOT EXISTS idx_issues_review_task ON import_issues(review_task_id);
CREATE INDEX IF NOT EXISTS idx_charge_targets_rule ON charge_rule_targets(charge_rule_id);
CREATE INDEX idx_tiers_tax ON quote_tiers(tax_mode,tax_settlement);
CREATE VIEW open_review_tasks AS
SELECT t.*, (SELECT count(*) FROM review_task_quotes q WHERE q.task_id=t.id) AS affected_quotes
FROM review_tasks t WHERE t.status='open';
