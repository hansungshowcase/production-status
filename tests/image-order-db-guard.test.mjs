import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('migration installs a database guard for image-backed order essentials only', async () => {
  const source = await readFile(new URL('../scripts/migrate.js', import.meta.url), 'utf8');

  assert.match(source, /CREATE OR REPLACE FUNCTION enforce_image_backed_order_integrity\(\)/);
  assert.match(source, /RETURNS TRIGGER/);
  assert.match(source, /IF TG_OP = 'UPDATE'/);
  assert.match(source, /OLD\.client_name IS NOT DISTINCT FROM NEW\.client_name/);
  assert.match(source, /OLD\.order_date IS NOT DISTINCT FROM NEW\.order_date/);
  assert.match(source, /OLD\.due_date IS NOT DISTINCT FROM NEW\.due_date/);
  assert.match(source, /OLD\.sales_person IS NOT DISTINCT FROM NEW\.sales_person/);
  assert.match(source, /OLD\.product_type IS NOT DISTINCT FROM NEW\.product_type/);
  assert.match(source, /OLD\.quantity IS NOT DISTINCT FROM NEW\.quantity/);
  assert.match(source, /OLD\.work_order_image_url IS NOT DISTINCT FROM NEW\.work_order_image_url/);
  assert.match(source, /NULLIF\(BTRIM\(NEW\.work_order_image_url\), ''\) IS NOT NULL/);
  assert.match(source, /NULLIF\(BTRIM\(NEW\.client_name\), ''\) IS NULL/);
  assert.match(source, /NEW\.order_date !~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'/);
  assert.match(source, /to_char\(to_date\(NEW\.order_date, 'YYYY-MM-DD'\), 'YYYY-MM-DD'\) <> NEW\.order_date/);
  assert.match(source, /NEW\.sales_person NOT IN \('\uC2E0\uC740\uCCA0', '\uC774\uC900\uD615'\)/);
  assert.match(source, /NEW\.due_date !~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'/);
  assert.match(source, /to_char\(to_date\(NEW\.due_date, 'YYYY-MM-DD'\), 'YYYY-MM-DD'\) <> NEW\.due_date/);
  assert.match(source, /NULLIF\(BTRIM\(NEW\.product_type\), ''\) IS NULL/);
  assert.match(source, /NEW\.quantity <= 0/);
  assert.match(source, /DROP TRIGGER IF EXISTS image_backed_order_integrity_guard ON orders/);
  assert.match(
    source,
    /CREATE TRIGGER image_backed_order_integrity_guard\s+BEFORE INSERT OR UPDATE OF client_name, order_date, due_date, sales_person, product_type, quantity, work_order_image_url\s+ON orders/s,
  );
});
