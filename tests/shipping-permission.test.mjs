import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canShipFromSales } from '../api/_lib/shippingPermission.js';

const SHIN_EUNCHEOL = '신은철';
const LEE_JUNHYEONG = '이준형';
const KIM_BOSU = '김보수';

test('both approved sales managers can ship from sales management at any process stage', () => {
  assert.equal(canShipFromSales(LEE_JUNHYEONG), true);
  assert.equal(canShipFromSales(` ${LEE_JUNHYEONG} `), true);
  assert.equal(canShipFromSales(SHIN_EUNCHEOL), true);
  assert.equal(canShipFromSales(` ${SHIN_EUNCHEOL} `), true);
  assert.equal(canShipFromSales(KIM_BOSU), false);
  assert.equal(canShipFromSales(''), false);
});

test('sales management exposes shipping to both approved sales managers', () => {
  const source = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /const SALES_SHIPPING_MANAGERS = \[/);
  assert.match(source, /const canShipOrders = SALES_SHIPPING_MANAGERS\.includes\(mySalesPerson\)/);
  assert.match(source, /shipOrder\(order\.id, mySalesPerson\)/);
  assert.match(source, /onShip=\{canShipOrders \? handleShipOrder : null\}/);
  assert.doesNotMatch(source, /shipOrder\(order\.id, activePerson \|\| mySalesPerson\)/);
});

test('sales shipping API enforces approved sales-manager permission before shipping', () => {
  const source = readFileSync(new URL('../api/orders/[id]/ship.js', import.meta.url), 'utf8');

  assert.match(source, /import \{ canShipFromSales \}/);
  assert.match(source, /const actor = resolveActor\(req\)/);
  assert.match(source, /if \(!canShipFromSales\(actor\)\)/);
  assert.match(source, /status\(403\)/);
  assert.match(source, /if \(incompleteStep && !canShipFromSales\(actor\)\)/);
});
