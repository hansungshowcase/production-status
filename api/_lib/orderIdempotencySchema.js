export const ORDER_IDEMPOTENCY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS order_create_idempotency (
  request_key TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;

let schemaReady = false;

export function _resetOrderIdempotencySchemaForTest() {
  schemaReady = false;
}

export function normalizeClientRequestId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return CLIENT_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
}

export async function ensureOrderIdempotencySchema(db) {
  if (schemaReady) return;
  await db.execute({ sql: ORDER_IDEMPOTENCY_SCHEMA_SQL, args: [] });
  schemaReady = true;
}
