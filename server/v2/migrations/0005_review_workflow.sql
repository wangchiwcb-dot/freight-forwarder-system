ALTER TABLE quotation_v2.release_targets DROP CONSTRAINT release_targets_kind_check;
ALTER TABLE quotation_v2.release_targets ADD CONSTRAINT release_targets_kind_check
  CHECK(kind IN ('postal','postal_prefix','postal_range','warehouse'));
CREATE INDEX idx_price_drafts_filter ON quotation_v2.price_drafts(country_hint,mode_hint,provider_hint);
CREATE TABLE quotation_v2.draft_release_links (
  price_draft_id text NOT NULL REFERENCES quotation_v2.price_drafts(id),
  release_id text NOT NULL UNIQUE REFERENCES quotation_v2.channel_releases(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(price_draft_id,release_id)
);
