import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('migration installs a database guard for image-backed order essentials only', async () => {
  const source = await readFile(new URL('../scripts/migrate.js', import.meta.url), 'utf8');

  assert.match(source, /CREATE OR REPLACE FUNCTION enforce_image_backed_order_integrity\(\)/);
  assert.match(source, /RETURNS TRIGGER/);
  assert.match(source, /NULLIF\(BTRIM\(NEW\.work_order_image_url\), ''\) IS NOT NULL/);
  assert.match(source, /NEW\.sales_person NOT IN \('\uC2E0\uC740\uCCA0', '\uC774\uC900\uD615'\)/);
  assert.match(source, /NEW\.due_date !~ '\^\\\\d\{4\}-\\\\d\{2\}-\\\\d\{2\}\$'/);
  assert.match(source, /to_char\(to_date\(NEW\.due_date, 'YYYY-MM-DD'\), 'YYYY-MM-DD'\) <> NEW\.due_date/);
  assert.match(source, /NEW\.quantity <= 0/);
  assert.match(source, /DROP TRIGGER IF EXISTS image_backed_order_integrity_guard ON orders/);
  assert.match(
    source,
    /CREATE TRIGGER image_backed_order_integrity_guard\s+BEFORE INSERT OR UPDATE OF work_order_image_url, sales_person, due_date, quantity\s+ON orders/s,
  );
});
