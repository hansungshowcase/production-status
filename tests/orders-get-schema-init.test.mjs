import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ordersSource = readFileSync(new URL('../api/orders/index.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../scripts/migrate.js', import.meta.url), 'utf8');

test('orders GET does not invoke runtime schema initialization', () => {
  const getStart = ordersSource.indexOf('async function handleGet');
  const postStart = ordersSource.indexOf('async function handlePost');

  assert.ok(getStart >= 0, 'handleGet should be present');
  assert.ok(postStart > getStart, 'handlePost should follow handleGet');
  assert.equal(
    ordersSource.slice(getStart, postStart).includes('ensureOrderImageColumn'),
    false,
  );
});

test('explicit migration owns every optional orders column', () => {
  for (const column of [
    'work_order_image_url',
    'delivery_address',
    'sale_amount',
    'balance',
    'freight_payment',
  ]) {
    assert.match(
      migrationSource,
      new RegExp(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${column}`),
    );
  }
});
