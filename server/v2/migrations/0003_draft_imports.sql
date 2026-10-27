CREATE TABLE quotation_v2.price_draft_imports (
  id text PRIMARY KEY, parser_version text NOT NULL, row_count integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
