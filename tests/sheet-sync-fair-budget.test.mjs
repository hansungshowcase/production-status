import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSheetSyncCron } from '../api/cron/sheet-sync.js';

const EMPTY_SUMMARY = { attempted: 0, synced: 0, failed: 0, skipped: 0, errors: [] };

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function fakeDb() {
  return {
    calls: 0,
    async execute() {
      this.calls += 1;
      return { rows: [] };
    },
  };
}

function authorizedRequest() {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer sheet-budget-secret' },
  };
}

async function withCronSecret(run) {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'sheet-budget-secret';
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
}

test('even UTC minutes give append enough budget first and keep the 25 second total budget', async () => {
  await withCronSecret(async () => {
    let clock = Date.parse('2026-10-22T00:02:00.000Z');
    const events = [];
    let appendCalls = 0;
    const response = responseRecorder();

    await handleSheetSyncCron(authorizedRequest(), response, fakeDb(), {
      now: () => clock,
      retry: async (_db, { limit, deadlineMs }) => {
        events.push(['append', deadlineMs]);
        assert.equal(limit, 25);
        if (deadlineMs >= 16_000) appendCalls += 1;
        clock += 8_000;
        return { ...EMPTY_SUMMARY, attempted: 1, synced: 1 };
      },
      retryShipping: async (_db, { limit, deadlineMs }) => {
        events.push(['shipping', deadlineMs]);
        assert.equal(limit, 25);
        return EMPTY_SUMMARY;
      },
    });

    assert.equal(appendCalls, 1);
    assert.deepEqual(events, [['append', 25_000], ['shipping', 17_000]]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.append.synced, 1);
  });
});

test('odd UTC minutes give shipping first priority and leave append its full minimum reserve', async () => {
  await withCronSecret(async () => {
    let clock = Date.parse('2026-10-22T00:03:00.000Z');
    const events = [];

    await handleSheetSyncCron(authorizedRequest(), responseRecorder(), fakeDb(), {
      now: () => clock,
      retry: async (_db, { deadlineMs }) => {
        events.push(['append', deadlineMs]);
        return EMPTY_SUMMARY;
      },
      retryShipping: async (_db, { deadlineMs }) => {
        events.push(['shipping', deadlineMs]);
        clock += 9_000;
        return EMPTY_SUMMARY;
      },
    });

    assert.deepEqual(events, [['shipping', 25_000], ['append', 16_000]]);
  });
});

test('a first queue that consumes the reserve prevents any call to the under-budget second queue', async () => {
  await withCronSecret(async () => {
    const cases = [
      {
        start: Date.parse('2026-10-22T00:04:00.000Z'),
        appendDuration: 15_000,
        expectedEvents: ['append'],
      },
      {
        start: Date.parse('2026-10-22T00:05:00.000Z'),
        shippingDuration: 10_000,
        expectedEvents: ['shipping'],
      },
    ];

    for (const scenario of cases) {
      let clock = scenario.start;
      const events = [];
      const response = responseRecorder();

      await handleSheetSyncCron(authorizedRequest(), response, fakeDb(), {
        now: () => clock,
        retry: async () => {
          events.push('append');
          clock += scenario.appendDuration || 0;
          return EMPTY_SUMMARY;
        },
        retryShipping: async () => {
          events.push('shipping');
          clock += scenario.shippingDuration || 0;
          return EMPTY_SUMMARY;
        },
      });

      assert.deepEqual(events, scenario.expectedEvents);
      assert.deepEqual(response.body.append, EMPTY_SUMMARY);
      assert.deepEqual(response.body.shipping, EMPTY_SUMMARY);
    }
  });
});
