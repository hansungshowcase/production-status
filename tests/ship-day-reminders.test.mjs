import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHIP_DAY_REMINDER_DEFINITION,
  buildShipDayReminderMessage,
  collectShipDayReminderGroups,
} from '../api/_lib/shipDayReminders.js';
import { handleShipDayRemindersDaily } from '../api/cron/ship-day-reminders-daily.js';
import { buildNotificationCatalog } from '../api/_lib/notificationOverview.js';
import { buildNotificationExample } from '../api/_lib/notificationExamples.js';

const TODAY = '2026-10-22';
const NOW_MS = Date.parse('2026-10-22T00:00:00.000Z');
const KIND = SHIP_DAY_REMINDER_DEFINITION.kind;

function order(id, extra = {}) {
  return {
    id,
    client_name: `거래처 ${id}`,
    sales_person: '이준형',
    status: 'in_production',
    due_date: TODAY,
    ship_scheduled_date: null,
    ship_date: null,
    ...extra,
  };
}

function collect(orders) {
  const savedFallback = process.env.ALERT_FALLBACK;
  delete process.env.ALERT_FALLBACK;
  try {
    return collectShipDayReminderGroups({ orders, today: TODAY });
  } finally {
    if (savedFallback !== undefined) process.env.ALERT_FALLBACK = savedFallback;
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function deps(orders, overrides = {}) {
  return {
    env: { CRON_SECRET: 'secret' },
    db: {},
    nowMs: NOW_MS,
    ensureNotifySchema: async () => {},
    ensureClaimsSchema: async () => {},
    loadInitialSnapshot: async () => ({ orders }),
    loadCurrentSnapshot: async () => ({ orders }),
    claimDailyNotification: async () => true,
    finishDailyNotification: async () => true,
    sendLms: async () => ({ ok: true, msgId: 'stub' }),
    randomUUID: () => 'attempt-1',
    ...overrides,
  };
}

async function invoke(dependencies) {
  const res = response();
  await handleShipDayRemindersDaily({ method: 'GET', headers: { authorization: 'Bearer secret' } }, res, dependencies);
  return res;
}

test('due_date equal to today is included when there is no scheduled ship date', () => {
  const result = collect([order(1), order(2, { due_date: '2026-10-23' })]);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].orders.map(item => item.orderId), [1]);
});

test('ship_scheduled_date takes priority over due_date', () => {
  const result = collect([
    order(1, { due_date: TODAY, ship_scheduled_date: '2026-10-23' }),
    order(2, { due_date: '2026-10-01', ship_scheduled_date: TODAY }),
  ]);
  assert.deepEqual(result.groups[0].orders.map(item => item.orderId), [2]);
});

test('shipped or non-production orders are excluded', () => {
  const result = collect([
    order(1, { ship_date: '2026-10-22' }),
    order(2, { status: 'shipped' }),
    order(3, { status: 'waiting' }),
  ]);
  assert.equal(result.groups.length, 0);
});

test('only 이준형 orders are sent, to 이준형 only, one message', () => {
  const result = collect([
    order(1), order(2),
    order(3, { sales_person: '신은철' }),
    order(4, { sales_person: '황보민수' }),
  ]);
  assert.equal(result.groups.length, 1);
  const lee = result.groups[0];
  assert.equal(lee.recipientName, '이준형');
  assert.equal(lee.toPhone, '01077314237');
  assert.deepEqual(lee.orders.map(item => item.orderId), [1, 2]);
  const message = buildShipDayReminderMessage(lee);
  assert.match(message.subject, /\[생산현황 오늘 출고 예정\]/);
  assert.match(message.text, /거래처 1/);
  assert.match(message.text, /주문번호 2/);
  assert.match(message.text, /오늘 출고 예정입니다/);
  assert.doesNotMatch(message.text, /거래처 3|거래처 4/);
});

test('unassigned or other salespeople never go to a fallback phone', () => {
  const saved = process.env.ALERT_FALLBACK;
  process.env.ALERT_FALLBACK = '010-0000-0000';
  try {
    const result = collectShipDayReminderGroups({ orders: [order(1, { sales_person: '김보수' }), order(2, { sales_person: null })], today: TODAY });
    assert.equal(result.groups.length, 0);
  } finally {
    if (saved === undefined) delete process.env.ALERT_FALLBACK; else process.env.ALERT_FALLBACK = saved;
  }
});

test('handler: already_claimed does not send', async () => {
  let sent = 0;
  const res = await invoke(deps([order(1)], {
    claimDailyNotification: async () => false,
    sendLms: async () => { sent += 1; return { ok: true }; },
  }));
  assert.equal(sent, 0);
  assert.equal(res.body.results[0].status, 'already_claimed');
});

test('handler: dry_run result is reported and send uses kind as tag', async () => {
  const calls = [];
  const res = await invoke(deps([order(1)], {
    sendLms: async (db, payload) => { calls.push(payload); return { ok: true, dryRun: true }; },
  }));
  assert.equal(res.body.dryRun, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tag, KIND);
  assert.equal(calls[0].to, '01077314237');
});

test('handler: rejects missing secret and wrong method', async () => {
  const res = response();
  await handleShipDayRemindersDaily({ method: 'GET', headers: {} }, res, deps([]));
  assert.equal(res.statusCode, 401);
  const res2 = response();
  await handleShipDayRemindersDaily({ method: 'POST', headers: {} }, res2, deps([]));
  assert.equal(res2.statusCode, 405);
});

test('notification list contains the new item with an example', () => {
  const items = buildNotificationCatalog({}, new Date('2026-10-15T03:00:00.000Z')).flatMap(group => group.items);
  const item = items.find(entry => entry.id === KIND);
  assert.ok(item);
  assert.equal(item.name, '오늘 출고 예정 알림');
  assert.ok(buildNotificationExample(item));
});
