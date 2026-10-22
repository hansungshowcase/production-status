import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShippingDocumentData } from '../src/components/sales/shippingDocuments.js';
import { getKstToday } from '../src/utils/dateUtils.js';

test('getKstToday returns the Korean calendar date across day, month, and year boundaries', () => {
  const cases = [
    ['2026-10-21T15:00:00.000Z', '2026-10-22'],
    ['2026-10-21T15:30:00.000Z', '2026-10-22'],
    ['2026-10-21T23:59:00.000Z', '2026-10-22'],
    ['2026-10-22T00:00:00.000Z', '2026-10-22'],
    ['2026-10-22T14:59:00.000Z', '2026-10-22'],
    ['2026-01-31T15:00:00.000Z', '2026-02-01'],
    ['2026-12-31T15:30:00.000Z', '2027-01-01'],
  ];

  for (const [instant, expected] of cases) {
    assert.equal(getKstToday(new Date(instant)), expected, instant);
  }
});

test('shipping document defaults use KST today while explicit dates keep priority', () => {
  const RealDate = globalThis.Date;
  const fixedNow = new RealDate('2026-10-22T00:30:00+09:00').valueOf();
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow;
    }
  }

  globalThis.Date = FixedDate;
  try {
    const fallback = buildShippingDocumentData({ quantity: 1 }, 'shipping');
    assert.equal(fallback.orderDate, '26-10-22');
    assert.equal(fallback.shipDate, '26-10-22');

    const persisted = buildShippingDocumentData({
      quantity: 1,
      order_date: '2026-10-20',
      ship_date: '2026-10-21',
    }, 'shipping', { today: '2026-10-19' });
    assert.equal(persisted.orderDate, '26-10-20');
    assert.equal(persisted.shipDate, '26-10-21');

    const override = buildShippingDocumentData({ quantity: 1 }, 'shipping', { today: '2026-10-19' });
    assert.equal(override.orderDate, '26-10-19');
    assert.equal(override.shipDate, '26-10-19');
  } finally {
    globalThis.Date = RealDate;
  }
});
