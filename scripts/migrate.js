import { neon } from '@neondatabase/serverless';

async function migrate() {
  const sql = neon(process.env.POSTGRES_URL);

  const statements = [
    `CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_date TEXT,
      due_date TEXT,
      sales_person TEXT,
      client_name TEXT,
      ship_date TEXT,
      sale_amount DOUBLE PRECISION,
      lead_source TEXT,
      balance DOUBLE PRECISION,
      phone TEXT,
      product_type TEXT,
      door_type TEXT,
      design TEXT,
      width INTEGER,
      depth INTEGER,
      height INTEGER,
      quantity INTEGER,
      color TEXT,
      notes TEXT,
      remarks TEXT,
      etc_notes TEXT,
      ship_scheduled_date TEXT,
      sms_sent INTEGER DEFAULT 0,
      safe_delivery INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_production',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS processes (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      step_name TEXT NOT NULL,
      status TEXT DEFAULT 'waiting',
      started_at TEXT,
      completed_at TEXT,
      completed_date TEXT,
      started_by TEXT,
      completed_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pre_production (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      instruction_check INTEGER DEFAULT 0,
      material_drawing INTEGER DEFAULT 0,
      laser_drawing INTEGER DEFAULT 0,
      material_order_received INTEGER DEFAULT 0,
      material_order_completed INTEGER DEFAULT 0,
      material_received INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS issues (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      process_id INTEGER REFERENCES processes(id),
      issue_type TEXT NOT NULL,
      description TEXT,
      reported_by TEXT,
      reported_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      process_id INTEGER REFERENCES processes(id),
      file_path TEXT NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS activity_feed (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      description TEXT,
      actor TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS workers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_sales_person ON orders(sales_person)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_due_date ON orders(due_date)`,
  ];

  for (const stmt of statements) {
    await sql.query(stmt);
    console.log('OK:', stmt.slice(0, 60) + '...');
  }

  console.log('Migration complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
