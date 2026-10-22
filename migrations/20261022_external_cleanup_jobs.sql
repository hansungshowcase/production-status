CREATE TABLE IF NOT EXISTS external_cleanup_jobs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('blob_delete', 'sheet_delete')),
  target_key TEXT NOT NULL UNIQUE,
  source_order_id INTEGER,
  source_photo_id INTEGER,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sending', 'completed', 'failed', 'held_shared', 'held_host', 'held_manual')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_external_cleanup_jobs_ready
  ON external_cleanup_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_external_cleanup_jobs_lease
  ON external_cleanup_jobs (leased_until)
  WHERE status = 'sending';
