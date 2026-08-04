export const SHIPPING_SHEET_SYNC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  ship_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  sheet_row INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const schemaInstallations = new WeakMap();

export async function ensureShippingSheetSyncSchema(db) {
  let installation = schemaInstallations.get(db);
  if (!installation) {
    installation = db.execute({ sql: SHIPPING_SHEET_SYNC_SCHEMA_SQL, args: [] })
      .then(() => undefined);
    schemaInstallations.set(db, installation);
  }

  try {
    await installation;
  } catch (error) {
    schemaInstallations.delete(db);
    throw error;
  }
}
