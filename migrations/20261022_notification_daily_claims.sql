CREATE TABLE IF NOT EXISTS notification_daily_claims (
  kst_date DATE NOT NULL,
  to_phone TEXT NOT NULL,
  milestone TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 1,
  attempt_token TEXT NOT NULL,
  provider_msgid TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kst_date, to_phone, milestone)
);
