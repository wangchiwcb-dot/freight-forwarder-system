CREATE SCHEMA IF NOT EXISTS quotation_v2;
CREATE TABLE IF NOT EXISTS quotation_v2.schema_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quotation_v2.providers (
  id text PRIMARY KEY, name text NOT NULL, is_own boolean NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE quotation_v2.channels (
  id text PRIMARY KEY, provider_id text NOT NULL REFERENCES quotation_v2.providers(id),
  name text NOT NULL, mode text NOT NULL CHECK (mode IN ('sea','rail','road','air')),
  last_mile text NOT NULL CHECK(last_mile IN ('express','truck','other')),
  active boolean NOT NULL DEFAULT true, UNIQUE(id, provider_id)
);
CREATE TABLE quotation_v2.source_files (
  id text PRIMARY KEY, sha256 text NOT NULL UNIQUE CHECK(length(sha256)=64),
  original_name text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>=0),
  storage_path text NOT NULL, evidence_path text NOT NULL,
  extraction_status text NOT NULL CHECK(extraction_status IN ('extracted','failed')),
  metadata jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quotation_v2.import_batches (
  id text PRIMARY KEY, manifest_hash text NOT NULL UNIQUE, imported_at timestamptz NOT NULL DEFAULT now(),
  source_count integer NOT NULL CHECK(source_count>=0), status text NOT NULL CHECK(status IN ('staged','reviewed'))
);
CREATE TABLE quotation_v2.import_batch_sources (
  batch_id text NOT NULL REFERENCES quotation_v2.import_batches(id),
  source_id text NOT NULL REFERENCES quotation_v2.source_files(id), original_name text NOT NULL,
  PRIMARY KEY(batch_id,source_id,original_name)
);
CREATE TABLE quotation_v2.channel_releases (
  id text PRIMARY KEY, channel_id text NOT NULL, provider_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), name text NOT NULL,
  country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'), origin text, scope_key text,
  service_description text NOT NULL, currency text NOT NULL CHECK(currency IN ('CNY','USD','EUR','GBP','CAD','AUD')),
  cost_basis text NOT NULL CHECK(cost_basis IN ('internal_settlement','supplier_purchase','customer_sale','unknown')),
  status text NOT NULL CHECK(status IN ('draft','published','revoked')),
  source_kind text NOT NULL CHECK(source_kind IN ('example','workbook','manual')),
  valid_from date, valid_to date, reviewed boolean NOT NULL, cargo_reviewed boolean NOT NULL,
  accepted_attributes jsonb NOT NULL, review_reasons jsonb NOT NULL, billing jsonb NOT NULL,
  notes jsonb NOT NULL, transit_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  FOREIGN KEY(channel_id,provider_id) REFERENCES quotation_v2.channels(id,provider_id),
  UNIQUE(channel_id,revision),
  CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>valid_from),
  CHECK(status<>'published' OR (source_kind<>'example' AND reviewed AND cargo_reviewed
    AND origin IS NOT NULL AND scope_key IS NOT NULL AND valid_from IS NOT NULL
    AND cost_basis IN ('internal_settlement','supplier_purchase')))
);
CREATE TABLE quotation_v2.release_targets (
  release_id text NOT NULL REFERENCES quotation_v2.channel_releases(id),
  kind text NOT NULL CHECK(kind IN ('postal','warehouse')), value text NOT NULL,
  PRIMARY KEY(release_id,kind,value)
);
CREATE TABLE quotation_v2.rate_tiers (
  release_id text NOT NULL REFERENCES quotation_v2.channel_releases(id), id text NOT NULL,
  min_quantity numeric(30,10) NOT NULL CHECK(min_quantity>=0), max_quantity numeric(30,10),
  min_inclusive boolean NOT NULL, max_inclusive boolean NOT NULL,
  unit_price numeric(30,10), price_status text NOT NULL CHECK(price_status IN ('priced','inquiry','unavailable')),
  PRIMARY KEY(release_id,id), CHECK(max_quantity IS NULL OR max_quantity>=min_quantity),
  CHECK((price_status='priced' AND unit_price>=0) OR (price_status<>'priced' AND unit_price IS NULL))
);
CREATE TABLE quotation_v2.release_rules (
  release_id text NOT NULL REFERENCES quotation_v2.channel_releases(id), id text NOT NULL,
  ordinal integer NOT NULL, definition jsonb NOT NULL,
  PRIMARY KEY(release_id,id), UNIQUE(release_id,ordinal), CHECK(id<>'base')
);
CREATE TABLE quotation_v2.source_evidence (
  id text PRIMARY KEY, release_id text NOT NULL REFERENCES quotation_v2.channel_releases(id),
  source_id text REFERENCES quotation_v2.source_files(id), sheet text, cells jsonb NOT NULL DEFAULT '[]',
  evidence_text text NOT NULL
);
CREATE TABLE quotation_v2.review_tasks (
  id text PRIMARY KEY, source_id text REFERENCES quotation_v2.source_files(id),
  release_id text REFERENCES quotation_v2.channel_releases(id), code text NOT NULL, detail text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quotation_v2.quote_runs (
  id text PRIMARY KEY, request jsonb NOT NULL, engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), supersedes text REFERENCES quotation_v2.quote_runs(id)
);
CREATE TABLE quotation_v2.quote_run_items (
  run_id text NOT NULL REFERENCES quotation_v2.quote_runs(id), ordinal integer NOT NULL,
  release_id text NOT NULL REFERENCES quotation_v2.channel_releases(id), result jsonb NOT NULL,
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,release_id)
);
CREATE TABLE quotation_v2.audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL, entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), detail jsonb NOT NULL
);
CREATE INDEX idx_releases_lookup ON quotation_v2.channel_releases(country,status,valid_from,valid_to);
CREATE INDEX idx_channels_mode ON quotation_v2.channels(mode,active);
CREATE INDEX idx_targets_value ON quotation_v2.release_targets(kind,value,release_id);
CREATE INDEX idx_reviews_status ON quotation_v2.review_tasks(status,source_id);
CREATE INDEX idx_runs_created ON quotation_v2.quote_runs(created_at DESC);

-- Publishing locks the channel to serialize competing overlapping releases.
CREATE FUNCTION quotation_v2.guard_release() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT EXISTS(SELECT 1 FROM quotation_v2.rate_tiers WHERE release_id=NEW.id) THEN
      RAISE EXCEPTION 'No price tiers';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM quotation_v2.source_evidence WHERE release_id=NEW.id) THEN
      RAISE EXCEPTION 'No source evidence';
    END IF;
    IF EXISTS(SELECT 1 FROM quotation_v2.channel_releases other WHERE other.id<>NEW.id
      AND other.channel_id=NEW.channel_id AND other.country=NEW.country AND other.scope_key=NEW.scope_key
      AND other.status='published' AND daterange(other.valid_from,other.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
      RAISE EXCEPTION 'Overlapping published release';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.channel_releases FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_release();

CREATE FUNCTION quotation_v2.guard_release_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id text; new_id text;
BEGIN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.release_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.release_id; END IF;
  IF EXISTS(SELECT 1 FROM quotation_v2.channel_releases WHERE id IN (old_id,new_id) AND status<>'draft') THEN
    RAISE EXCEPTION 'Published release contents are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tier_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.rate_tiers FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_release_child();
CREATE TRIGGER rule_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.release_rules FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_release_child();
CREATE TRIGGER target_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.release_targets FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_release_child();
CREATE TRIGGER evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_v2.source_evidence FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_release_child();
