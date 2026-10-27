CREATE TABLE quotation_v2.draft_note_sets (
  id text PRIMARY KEY, notes jsonb NOT NULL CHECK(jsonb_typeof(notes)='array')
);
ALTER TABLE quotation_v2.price_drafts ADD COLUMN note_set_id text REFERENCES quotation_v2.draft_note_sets(id);
