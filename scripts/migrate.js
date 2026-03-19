import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const migrations = [
  // ── orders ──
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_date TEXT,
    due_date TEXT,
    sales_person TEXT,
    client_name TEXT,
    ship_date TEXT,
    sale_amount REAL,
    lead_source TEXT,
    balance REAL,
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
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_sales_person ON orders(sales_person)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_due_date ON orders(due_date)`,

  // ── processes ──
  `CREATE TABLE IF NOT EXISTS processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
    status TEXT DEFAULT 'waiting',
    started_at TEXT,
    completed_at TEXT,
    completed_date TEXT,
    started_by TEXT,
    completed_by TEXT
  )`,

  // ── pre_production ──
  `CREATE TABLE IF NOT EXISTS pre_production (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    instruction_check INTEGER DEFAULT 0,
    material_drawing INTEGER DEFAULT 0,
    laser_drawing INTEGER DEFAULT 0,
    material_order_received INTEGER DEFAULT 0,
    material_order_completed INTEGER DEFAULT 0,
    material_received INTEGER DEFAULT 0
  )`,

  // ── issues ──
  `CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    process_id INTEGER REFERENCES processes(id),
    issue_type TEXT NOT NULL,
    description TEXT,
    reported_by TEXT,
    reported_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
  )`,

  // ── photos ──
  `CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    process_id INTEGER REFERENCES processes(id),
    file_path TEXT NOT NULL,
    uploaded_by TEXT,
    uploaded_at TEXT DEFAULT (datetime('now','localtime'))
  )`,

  // ── activity_feed ──
  `CREATE TABLE IF NOT EXISTS activity_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    description TEXT,
    actor TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`,

  // ── workers ──
  `CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
];

async function migrate() {
  console.log('Starting database migration...');
  console.log(`Database URL: ${process.env.TURSO_DATABASE_URL}`);

  for (const sql of migrations) {
    const label = sql.trim().substring(0, 60).replace(/\s+/g, ' ');
    try {
      await db.execute(sql);
      console.log(`  OK: ${label}...`);
    } catch (err) {
      console.error(`  FAIL: ${label}...`);
      console.error(`        ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\nMigration complete – ${migrations.length} statements executed.`);
  process.exit(0);
}

migrate();
