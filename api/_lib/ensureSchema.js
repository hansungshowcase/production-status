const schemaFlags = new Map();

export async function ensureOrderImageColumn(db) {
  if (schemaFlags.get('orders.work_order_image_url')) return;

  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS work_order_image_url TEXT',
    args: [],
  });
  schemaFlags.set('orders.work_order_image_url', true);
}
