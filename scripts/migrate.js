import { neon } from '@neondatabase/serverless';
import { pathToFileURL } from 'node:url';

function migrationStatements() {
  return [
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
      work_order_image_url TEXT,
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
      process_id INTEGER REFERENCES processes(id) ON DELETE SET NULL,
      issue_type TEXT NOT NULL,
      description TEXT,
      reported_by TEXT,
      reported_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      process_id INTEGER REFERENCES processes(id) ON DELETE SET NULL,
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
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS work_order_image_url TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_amount DOUBLE PRECISION`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance DOUBLE PRECISION`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_payment TEXT`,
    `CREATE OR REPLACE FUNCTION enforce_image_backed_order_integrity()
      RETURNS TRIGGER AS $image_order_guard$
      BEGIN
        IF TG_OP = 'UPDATE'
          AND OLD.client_name IS NOT DISTINCT FROM NEW.client_name
          AND OLD.order_date IS NOT DISTINCT FROM NEW.order_date
          AND OLD.due_date IS NOT DISTINCT FROM NEW.due_date
          AND OLD.sales_person IS NOT DISTINCT FROM NEW.sales_person
          AND OLD.product_type IS NOT DISTINCT FROM NEW.product_type
          AND OLD.quantity IS NOT DISTINCT FROM NEW.quantity
          AND OLD.work_order_image_url IS NOT DISTINCT FROM NEW.work_order_image_url THEN
          RETURN NEW;
        END IF;

        IF NULLIF(BTRIM(NEW.work_order_image_url), '') IS NOT NULL THEN
          IF NULLIF(BTRIM(NEW.client_name), '') IS NULL THEN
            RAISE EXCEPTION 'Image-backed orders require a client name';
          END IF;

          IF NEW.order_date IS NULL
            OR NEW.order_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            OR to_char(to_date(NEW.order_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> NEW.order_date THEN
            RAISE EXCEPTION 'Image-backed orders require a canonical order date';
          END IF;

          IF NEW.sales_person IS NULL OR NEW.sales_person NOT IN ('신은철', '이준형') THEN
            RAISE EXCEPTION 'Image-backed orders require an assigned sales person';
          END IF;

          IF NEW.due_date IS NULL
            OR NEW.due_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            OR to_char(to_date(NEW.due_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> NEW.due_date THEN
            RAISE EXCEPTION 'Image-backed orders require a canonical due date';
          END IF;

          IF NULLIF(BTRIM(NEW.product_type), '') IS NULL THEN
            RAISE EXCEPTION 'Image-backed orders require a product type';
          END IF;

          IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
            RAISE EXCEPTION 'Image-backed orders require a positive quantity';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $image_order_guard$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS image_backed_order_integrity_guard ON orders`,
    `CREATE TRIGGER image_backed_order_integrity_guard
      BEFORE INSERT OR UPDATE OF client_name, order_date, due_date, sales_person, product_type, quantity, work_order_image_url
      ON orders
      FOR EACH ROW
      EXECUTE FUNCTION enforce_image_backed_order_integrity()`,
    // FK 컬럼 인덱스 (Postgres는 FK에 자동 인덱스 안 만듦 — orders 목록 풀스캔 방지)
    `CREATE INDEX IF NOT EXISTS idx_processes_order_id ON processes(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_processes_step_status ON processes(step_name, status)`,
    `CREATE INDEX IF NOT EXISTS idx_issues_order_id ON issues(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_issues_resolved ON issues(resolved_at)`,
    `CREATE INDEX IF NOT EXISTS idx_photos_order_id ON photos(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_feed_order ON activity_feed(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(created_at DESC)`,
    // 검색/필터 자주 사용
    `CREATE INDEX IF NOT EXISTS idx_orders_client_name ON orders(client_name)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status_due ON orders(status, due_date)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_ship_date ON orders(ship_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_processes_order_status ON processes(order_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_processes_order_step_status ON processes(order_id, step_name, status)`,
    `CREATE INDEX IF NOT EXISTS idx_photos_order_uploaded ON photos(order_id, uploaded_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_photos_process_id ON photos(process_id)`,
    `CREATE INDEX IF NOT EXISTS idx_issues_order_resolved ON issues(order_id, resolved_at)`,
  ];
}

export async function runMigrationStatements(sql) {
  for (const stmt of migrationStatements()) {
    await sql.query(stmt);
    console.log('OK:', stmt.slice(0, 60) + '...');
  }
}

async function migrate() {
  const sql = neon(process.env.POSTGRES_URL);
  await runMigrationStatements(sql);
  console.log('Migration complete!');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
