ALTER TABLE quotation_v2.rate_tiers ALTER COLUMN min_quantity TYPE numeric;
ALTER TABLE quotation_v2.rate_tiers ALTER COLUMN max_quantity TYPE numeric;
ALTER TABLE quotation_v2.rate_tiers ALTER COLUMN unit_price TYPE numeric;
CREATE TABLE quotation_v2.price_drafts (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES quotation_v2.source_files(id),
  source_quote_id text NOT NULL, parser_version text NOT NULL,
  provider_hint text NOT NULL, channel_hint text NOT NULL,
  country_hint text NOT NULL, mode_hint text NOT NULL,
  proposed_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review','mapped','excluded')),
  UNIQUE(source_id,source_quote_id,parser_version)
);
CREATE INDEX idx_price_drafts_source ON quotation_v2.price_drafts(source_id,status);

CREATE FUNCTION quotation_v2.guard_channel_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.provider_id,NEW.mode,NEW.last_mile) IS DISTINCT FROM (OLD.provider_id,OLD.mode,OLD.last_mile)
    AND EXISTS(SELECT 1 FROM quotation_v2.channel_releases WHERE channel_id=OLD.id AND status<>'draft') THEN
    RAISE EXCEPTION 'Published channel identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_identity_guard BEFORE UPDATE ON quotation_v2.channels FOR EACH ROW EXECUTE FUNCTION quotation_v2.guard_channel_identity();
