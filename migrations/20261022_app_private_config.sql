CREATE TABLE IF NOT EXISTS app_private_config (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
