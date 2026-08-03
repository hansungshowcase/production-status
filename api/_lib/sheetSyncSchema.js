export const SHEET_SYNC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sheet_sync_jobs (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  sheet_row INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

let schemaReady = false;

export async function ensureSheetSyncSchema(db) {
  if (schemaReady) return;
  await db.execute({ sql: SHEET_SYNC_SCHEMA_SQL, args: [] });
  schemaReady = true;
}
