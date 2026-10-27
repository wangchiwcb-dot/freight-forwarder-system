-- Existing prices keep their current behavior. Newly imported files are staged.
ALTER TABLE quotation_v2.source_files ADD COLUMN pricing_state text NOT NULL DEFAULT 'legacy'
  CHECK (pricing_state IN ('legacy','pending','versioned'));

CREATE TABLE quotation_v2.quote_updates (
  id text PRIMARY KEY, source_id text NOT NULL UNIQUE REFERENCES quotation_v2.source_files(id),
  previous_source_id text REFERENCES quotation_v2.source_files(id), series_id text NOT NULL,
  label text NOT NULL, effective_from date NOT NULL, request_hash text NOT NULL,
  summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(series_id,effective_from)
);
CREATE TABLE quotation_v2.price_periods (
  draft_id text PRIMARY KEY REFERENCES quotation_v2.price_drafts(id), family_id text NOT NULL,
  series_id text NOT NULL, update_id text REFERENCES quotation_v2.quote_updates(id),
  valid_from date, valid_to date,
  CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX one_current_price_per_family ON quotation_v2.price_periods(family_id) WHERE valid_to IS NULL;
CREATE INDEX price_period_series ON quotation_v2.price_periods(series_id,valid_to);

-- End dates are recorded separately: published prices and rules remain immutable.
CREATE TABLE quotation_v2.release_successions (
  predecessor_id text PRIMARY KEY REFERENCES quotation_v2.channel_releases(id),
  successor_id text NOT NULL UNIQUE REFERENCES quotation_v2.channel_releases(id),
  effective_from date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(predecessor_id<>successor_id)
);
CREATE VIEW quotation_v2.release_periods AS
SELECT r.id AS release_id, greatest(r.valid_from,p.valid_from) AS valid_from,
  least(r.valid_to,p.valid_to,x.effective_from) AS valid_to,
  l.price_draft_id AS source_draft_id, coalesce(s.pricing_state,'legacy') AS source_state,
  u.label AS version_label
FROM quotation_v2.channel_releases r
LEFT JOIN LATERAL (
  SELECT link.price_draft_id FROM quotation_v2.draft_release_links link
  JOIN quotation_v2.channel_releases linked ON linked.id=link.release_id
  WHERE linked.channel_id=r.channel_id AND linked.revision<=r.revision
  ORDER BY linked.revision DESC LIMIT 1
) l ON true
LEFT JOIN quotation_v2.price_drafts d ON d.id=l.price_draft_id
LEFT JOIN quotation_v2.source_files s ON s.id=d.source_id
LEFT JOIN quotation_v2.price_periods p ON p.draft_id=d.id
LEFT JOIN quotation_v2.quote_updates u ON u.id=p.update_id
LEFT JOIN quotation_v2.release_successions x ON x.predecessor_id=r.id;

CREATE OR REPLACE FUNCTION quotation_v2.guard_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Published release cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
    IF NEW.status<>'revoked' OR OLD.status<>'published'
      OR (to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status') THEN
      RAISE EXCEPTION 'Published release is immutable';
    END IF;
  END IF;
  IF NEW.status='published' AND (TG_OP='INSERT' OR OLD.status<>'published') THEN
    PERFORM 1 FROM quotation_v2.channels WHERE id=NEW.channel_id FOR UPDATE;
    IF NOT coalesce((NEW.billing->>'verified')::boolean,false) OR NEW.billing->>'quantityStep' IS NULL
      OR (NEW.billing->>'basis'='kg' AND NEW.billing->>'volumetricDivisor' IS NULL) THEN
      RAISE EXCEPTION 'Billing rules incomplete';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM quotation_v2.rate_tiers WHERE release_id=NEW.id) THEN RAISE EXCEPTION 'No price tiers'; END IF;
    IF NOT EXISTS(SELECT 1 FROM quotation_v2.source_evidence WHERE release_id=NEW.id) THEN RAISE EXCEPTION 'No source evidence'; END IF;
    IF EXISTS(SELECT 1 FROM quotation_v2.channel_releases other
      JOIN quotation_v2.release_periods period ON period.release_id=other.id
      WHERE other.id<>NEW.id AND other.channel_id=NEW.channel_id AND other.country=NEW.country
      AND other.scope_key=NEW.scope_key AND other.status='published'
      AND (period.valid_to IS NULL OR period.valid_from IS NULL OR period.valid_to>period.valid_from)
      AND daterange(period.valid_from,CASE WHEN period.valid_to<period.valid_from THEN period.valid_from ELSE period.valid_to END,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
      RAISE EXCEPTION 'Overlapping published release';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION quotation_v2.guard_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Release succession is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM quotation_v2.channel_releases prior_release
    JOIN quotation_v2.channel_releases next_release ON next_release.id=NEW.successor_id
    WHERE prior_release.id=NEW.predecessor_id AND prior_release.status='published' AND next_release.status='draft'
      AND prior_release.channel_id=next_release.channel_id AND prior_release.country=next_release.country AND prior_release.scope_key=next_release.scope_key
      AND prior_release.valid_from<NEW.effective_from AND next_release.valid_from=NEW.effective_from) THEN
    RAISE EXCEPTION 'Invalid release succession';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER succession_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.release_successions
  FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_succession();
