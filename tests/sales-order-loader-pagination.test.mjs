import assert from 'node:assert/strict';
import test from 'node:test';

import { countSalesOrders } from '../src/pages/salesOrderFilters.js';
import { fetchAllSalesOrders } from '../src/pages/salesOrderLoader.js';

test('1005 orders keep offset order when five remaining pages finish out of order with at most two requests active', async () => {
  const expected = Array.from({ length: 1005 }, (_, index) => ({
    id: index + 1,
    client_name: `client-${index + 1}`,
    status: index % 3 === 0 ? 'shipped' : 'in_production',
    phone: `phone-${index + 1}`,
    nested: { marker: `field-${index + 1}` },
  }));
  const calls = [];
  const pending = new Map();
  const completionOrder = [];
  let activeRequests = 0;
  let maxConcurrentRequests = 0;

  const getOrders = ({ limit, offset, ...params }) => {
    calls.push({ limit, offset, ...params });
    if (offset === 0) {
      return Promise.resolve({ orders: expected.slice(0, limit), total: expected.length });
    }
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    return new Promise((resolve) => {
      pending.set(offset, () => {
        pending.delete(offset);
        completionOrder.push(offset);
        activeRequests -= 1;
        resolve({ orders: expected.slice(offset, offset + limit), total: expected.length });
      });
    });
  };

  const resultPromise = fetchAllSalesOrders({
    getOrders,
    params: { sales_person: '신은철' },
    pageSize: 200,
  });

  const complete = async (offset) => {
    assert.equal(pending.has(offset), true, `offset ${offset} should be active`);
    pending.get(offset)();
    await new Promise((resolve) => setImmediate(resolve));
  };

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...pending.keys()], [200, 400]);
  for (const offset of [400, 600, 800, 1000, 200]) {
    await complete(offset);
  }
  const actual = await resultPromise;

  assert.deepEqual(calls.slice(0, 3), [
    { limit: 200, offset: 0, sales_person: '신은철' },
    { limit: 200, offset: 200, sales_person: '신은철' },
    { limit: 200, offset: 400, sales_person: '신은철' },
  ]);
  assert.deepEqual(calls.map(({ offset }) => offset), [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(completionOrder, [400, 600, 800, 1000, 200]);
  assert.equal(maxConcurrentRequests, 2);
  assert.deepEqual(actual, expected);
  assert.deepEqual(countSalesOrders(actual), {
    totalCount: 1005,
    shippedCount: 335,
    inProductionCount: 670,
    overdueCount: 0,
    packingCompletedCount: 0,
  });
});

test('an unexpectedly short page falls back to sequential offsets without omitting orders', async () => {
  const expected = Array.from({ length: 405 }, (_, index) => ({ id: index + 1 }));
  const offsets = [];
  let activeRequests = 0;
  let maxConcurrentRequests = 0;

  const getOrders = async ({ limit, offset }) => {
    offsets.push(offset);
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    await new Promise((resolve) => setImmediate(resolve));
    activeRequests -= 1;
    const responseLimit = offset === 200 || offset === 275 ? 75 : limit;
    return { orders: expected.slice(offset, offset + responseLimit), total: expected.length };
  };

  const actual = await fetchAllSalesOrders({ getOrders, params: {}, pageSize: 200 });

  assert.deepEqual(offsets, [0, 200, 400, 275, 350]);
  assert.ok(maxConcurrentRequests <= 2);
  assert.deepEqual(actual, expected);
});

test('page errors reject the entire load instead of returning partial orders', async () => {
  const getOrders = async ({ offset }) => {
    if (offset === 200) throw new Error('page failed');
    return {
      orders: Array.from({ length: Math.min(200, 405 - offset) }, (_, index) => ({ id: offset + index + 1 })),
      total: 405,
    };
  };

  await assert.rejects(
    fetchAllSalesOrders({ getOrders, params: {}, pageSize: 200 }),
    /page failed/,
  );
});

test('a known nonzero total never resolves as an empty partial result', async () => {
  await assert.rejects(
    fetchAllSalesOrders({
      getOrders: async () => ({ orders: [], total: 405 }),
      params: {},
      pageSize: 200,
    }),
    /expected 405, received 0/,
  );
});

test('legacy array responses retain their single-response fallback', async () => {
  const expected = [{ id: 1 }, { id: 2 }];
  let calls = 0;
  const getOrders = async () => {
    calls += 1;
    return expected;
  };

  assert.deepEqual(
    await fetchAllSalesOrders({ getOrders, params: {}, pageSize: 200 }),
    expected,
  );
  assert.equal(calls, 1);
});
