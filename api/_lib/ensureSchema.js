const schemaFlags = new Map();

export async function ensureOrderImageColumn(db) {
  if (schemaFlags.get('orders.optional_order_fields')) return;

  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS work_order_image_url TEXT',
    args: [],
  });
  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT',
    args: [],
  });
  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_amount DOUBLE PRECISION',
    args: [],
  });
  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance DOUBLE PRECISION',
    args: [],
  });
  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_payment TEXT',
    args: [],
  });
  schemaFlags.set('orders.optional_order_fields', true);
}
