CREATE TABLE quotation_v2.comparison_runs (
  id text PRIMARY KEY,
  request jsonb NOT NULL,
  options jsonb NOT NULL,
  summary jsonb NOT NULL,
  engine_version text NOT NULL,
  supersedes text REFERENCES quotation_v2.comparison_runs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quotation_v2.comparison_results (
  run_id text NOT NULL REFERENCES quotation_v2.comparison_runs(id),
  ordinal integer NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(run_id,ordinal)
);
