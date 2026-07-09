import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canShipFromSales } from '../api/_lib/shippingPermission.js';

test('only Lee Junhyeong can ship from sales management at any process stage', () => {
  assert.equal(canShipFromSales('이준형'), true);
  assert.equal(canShipFromSales(' 이 준 형 '), true);
  assert.equal(canShipFromSales('신은철'), false);
  assert.equal(canShipFromSales('김보수'), false);
  assert.equal(canShipFromSales(''), false);
});

test('sales management exposes shipping only to the logged-in Lee Junhyeong account', () => {
  const source = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /const canShipOrders = mySalesPerson === '이준형'/);
  assert.match(source, /shipOrder\(order\.id, mySalesPerson\)/);
  assert.match(source, /onShip=\{canShipOrders \? handleShipOrder : null\}/);
  assert.doesNotMatch(source, /shipOrder\(order\.id, activePerson \|\| mySalesPerson\)/);
});

test('sales shipping API enforces Lee Junhyeong permission before shipping', () => {
  const source = readFileSync(new URL('../api/orders/[id]/ship.js', import.meta.url), 'utf8');

  assert.match(source, /import \{ canShipFromSales \}/);
  assert.match(source, /const actor = resolveActor\(req\)/);
  assert.match(source, /if \(!canShipFromSales\(actor\)\)/);
  assert.match(source, /status\(403\)/);
  assert.match(source, /if \(incompleteStep && !canShipFromSales\(actor\)\)/);
});
