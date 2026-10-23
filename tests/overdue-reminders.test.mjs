import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OVERDUE_REMINDER_KINDS,
  buildOverdueReminderMessage,
  collectOverdueReminderGroups,
  normalizeDueDateToKstDay,
} from '../api/_lib/overdueReminders.js';
import { handleOverdueRemindersDaily } from '../api/cron/overdue-reminders-daily.js';
import {
  buildProductionAlertMessage,
  formatProductionDueDay,
  formatProductionDueSentence,
} from '../api/_lib/productionAlertMessage.js';

const TODAY = '2026-10-22';
const NOW_MS = Date.parse('2026-10-22T00:00:00.000Z');
const KINDS = OVERDUE_REMINDER_KINDS;

function order(id, due_date, extra = {}) {
  return {
    id,
    client_name: `거래처 ${id}`,
    sales_person: '신은철',
    due_date,
    status: 'in_production',
    ship_date: null,
    ...extra,
  };
}

function process(order_id, step_name, status = 'waiting', extra = {}) {
  return { order_id, step_name, status, started_by: null, ...extra };
}

function collect(orders, processes = [], options = {}) {
  return collectOverdueReminderGroups({ orders, processes, today: TODAY, ...options });
}

function groupFor(result, kind, name) {
  return result.groups.find(group => group.kind === kind && group.recipientName === name);
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function handlerDeps({ initial, current = initial, sendLms, claimDailyNotification, finishDailyNotification, nowMs = NOW_MS } = {}) {
  return {
    env: { CRON_SECRET: 'secret' },
    db: {},
    nowMs,
    ensureNotifySchema: async () => {},
    ensureClaimsSchema: async () => {},
    loadInitialSnapshot: async () => initial || { orders: [], processes: [] },
    loadCurrentSnapshot: async () => current || { orders: [], processes: [] },
    claimDailyNotification: claimDailyNotification || (async () => true),
    finishDailyNotification: finishDailyNotification || (async () => true),
    sendLms: sendLms || (async () => ({ ok: true, msgId: 'stub-message' })),
    randomUUID: (() => { let id = 0; return () => `attempt-${++id}`; })(),
  };
}

async function invoke(dependencies, req = { method: 'GET', headers: { authorization: 'Bearer secret' } }) {
  const res = response();
  await handleOverdueRemindersDaily(req, res, dependencies);
  return res;
}

test('due_date uses strict calendar validation and normalizes ISO timestamps to a KST day', () => {
  assert.equal(normalizeDueDateToKstDay('2026-12-31'), '2026-12-31');
  assert.equal(normalizeDueDateToKstDay('2026-12-31T15:30:00.000Z'), '2027-01-01');
  assert.equal(normalizeDueDateToKstDay('2026-01-01T00:30:00-10:00'), '2026-01-01');
  assert.equal(normalizeDueDateToKstDay('2026-02-29'), null);
  assert.equal(normalizeDueDateToKstDay('2026-02-30T00:00:00Z'), null);
  assert.equal(normalizeDueDateToKstDay('2026-13-01'), null);
  assert.equal(normalizeDueDateToKstDay('not-a-date'), null);
  assert.equal(normalizeDueDateToKstDay(null), null);
});

test('unshipped reminders start at D+10, ignore ship_scheduled_date, and reject missing dates', () => {
  const result = collect([
    order(1, '2026-10-13'),
    order(2, '2026-10-12'),
    order(3, '2026-10-11'),
    order(4, '2026-10-22'),
    order(5, '2026-10-23'),
    order(6, '2026-02-30'),
    order(7, null),
    order(8, '2026-10-01', { ship_scheduled_date: '2027-01-01' }),
  ]);
  assert.deepEqual(groupFor(result, KINDS.UNSHIPPED, '신은철').orders.map(item => item.orderId), [8, 3, 2]);
  assert.equal(result.categoryCounts[KINDS.UNSHIPPED].eligibleOrders, 3);
  assert.equal(result.missingOrInvalidDue, 2);
});

test('packing starts at D-3, continues every overdue day, and routes only to 정영호 팀장', () => {
  const result = collect([
    order(1, '2026-10-26'), // D-4
    order(2, '2026-10-25'), // D-3
    order(3, '2026-10-23'), // D-1
    order(4, '2026-10-22'), // today
    order(5, '2026-10-21'), // D+1
    order(6, '2026-10-12'), // D+10
    order(7, '2026-10-24T15:00:00.000Z'), // KST 2026-10-25, D-3
    order(8, null),
    order(9, '2026-02-30'),
  ]);
  const packingGroups = result.groups.filter(group => group.kind === KINDS.PACKING);
  assert.equal(result.categoryCounts[KINDS.PACKING].eligibleOrders, 6);
  assert.deepEqual(packingGroups.map(group => group.recipientName), ['정영호 팀장']);
  assert.deepEqual(packingGroups[0].orders.map(item => item.orderId), [6, 5, 4, 3, 2, 7]);
  assert.equal(result.categoryCounts[KINDS.PACKING].unknownAssignments, 0);
  assert.equal(result.missingOrInvalidDue, 2);
});

test('equipment and packing overdue categories are independent and shipped orders are always excluded', () => {
  const orders = [
    order(1, '2026-10-21'),
    order(2, '2026-10-21'),
    order(3, '2026-10-21'),
    order(4, '2026-10-21'),
    order(5, '2026-10-01', { status: 'shipped' }),
    order(6, '2026-10-01', { status: '출고완료' }),
    order(7, '2026-10-01', { ship_date: '2026-10-20T01:00:00Z' }),
  ];
  const processes = [
    process(2, '설비작업', 'completed'),
    process(3, '포장', 'completed'),
    process(4, '설비작업', 'completed'),
    process(4, '포장', 'completed'),
  ];
  const result = collect(orders, processes);
  assert.equal(result.categoryCounts[KINDS.EQUIPMENT].eligibleOrders, 2);
  assert.equal(result.categoryCounts[KINDS.PACKING].eligibleOrders, 2);
  assert.deepEqual(groupFor(result, KINDS.EQUIPMENT, '신은철').orders.map(item => item.orderId), [1, 3]);
  assert.deepEqual(groupFor(result, KINDS.PACKING, '정영호 팀장').orders.map(item => item.orderId), [1, 2]);
});

test('recipients use only sales routes, exact assembly started_by, exact internal contacts, and dedupe overlaps', () => {
  const processes = [
    process(1, '조립작업', 'in_progress', { started_by: '까우사르', completed_by: '백승정' }),
    process(1, '조립작업', 'waiting', { started_by: '이정섭 부장' }),
    process(1, '설비작업', 'waiting', { started_by: '마카라' }),
    process(1, '용접작업', 'completed', { started_by: '까지' }),
    process(2, '조립작업', 'in_progress', { started_by: '박상규 공장장' }),
  ];
  const result = collect([
    order(1, '2026-10-01', { sales_person: '신은절' }),
    order(2, '2026-10-01', { sales_person: '알수없음' }),
  ], processes, { routes: { ...process.env, 신은철: '010-7346-7407', 신은절: '010-7346-7407' } });

  const equipmentNames = result.groups
    .filter(group => group.kind === KINDS.EQUIPMENT)
    .map(group => group.recipientName);
  for (const name of ['신은철', '카우사르', '이정섭 부장', '정영호 팀장', '최우석 이사', '박상규 공장장']) {
    assert.ok(equipmentNames.includes(name), name);
  }
  assert.ok(!equipmentNames.includes('마카라'));
  assert.ok(!equipmentNames.includes('백승정'));
  assert.ok(!equipmentNames.includes('까지'));
  assert.equal(groupFor(result, KINDS.EQUIPMENT, '박상규 공장장').orders.filter(item => item.orderId === 2).length, 1);
  assert.equal(result.unknownAssignments.filter(item => item.orderId === 2 && item.role === 'salesperson').length, 2);
  assert.equal(result.groups.some(group => group.recipientName === '알수없음'), false);
});

test('unknown salesperson and assembly assignments are counted while fixed executives still receive process reminders', () => {
  const result = collect([order(1, '2026-10-01', { sales_person: null })]);
  assert.equal(result.categoryCounts[KINDS.UNSHIPPED].unknownAssignments, 1);
  assert.equal(result.categoryCounts[KINDS.UNSHIPPED].routedOrders, 0);
  assert.equal(result.categoryCounts[KINDS.EQUIPMENT].unknownAssignments, 2);
  assert.equal(result.categoryCounts[KINDS.PACKING].unknownAssignments, 0);
  assert.deepEqual(
    result.groups.filter(group => group.kind === KINDS.PACKING).map(group => group.recipientName),
    ['정영호 팀장'],
  );
});

test('packing and equipment completion remain independent', () => {
  const equipmentDone = collect([order(1, '2026-10-21')], [process(1, '설비작업', 'completed')]);
  assert.equal(equipmentDone.categoryCounts[KINDS.EQUIPMENT].eligibleOrders, 0);
  assert.equal(equipmentDone.categoryCounts[KINDS.PACKING].eligibleOrders, 1);

  const packingDone = collect([order(2, '2026-10-21')], [process(2, '포장', 'completed')]);
  assert.equal(packingDone.categoryCounts[KINDS.EQUIPMENT].eligibleOrders, 1);
  assert.equal(packingDone.categoryCounts[KINDS.PACKING].eligibleOrders, 0);
});

test('messages list at most ten orders, fit 2000 UTF-8 bytes, and report exact totals and omissions', () => {
  const group = {
    kind: KINDS.UNSHIPPED,
    recipientName: '신은철',
    kstDate: TODAY,
    orders: Array.from({ length: 24 }, (_, index) => ({
      orderId: index + 1,
      clientName: '매우긴한글거래처명'.repeat(80),
      dueDay: '2026-01-01',
      overdueDays: 294,
    })),
  };
  const message = buildOverdueReminderMessage(group);
  assert.ok(Buffer.byteLength(message.text, 'utf8') <= 2000);
  assert.ok(message.listedCount <= 10);
  assert.equal(message.totalCount, 24);
  assert.equal(message.omittedCount, 24 - message.listedCount);
  assert.match(message.text, new RegExp(`외 ${message.omittedCount}건`));
  assert.match(message.text, /실제 출고 여부를 확인하시고, 출고된 주문은 출고완료 처리/);
  assert.match(message.text, /https:\/\/production-status\.vercel\.app/);
});

test('mixed packing copy explains before, today, and overdue orders without false delay labels', () => {
  assert.equal(formatProductionDueSentence(null), '납기일 확인이 필요합니다.');
  assert.equal(formatProductionDueSentence(Number.NaN), '납기일 확인이 필요합니다.');
  const message = buildOverdueReminderMessage({
    kind: KINDS.PACKING,
    recipientName: '정영호 팀장',
    kstDate: TODAY,
    orders: [
      { orderId: 1, clientName: '가상 A', dueDay: '2026-10-25', daysLeft: 3, overdueDays: -3 },
      { orderId: 2, clientName: '가상 B', dueDay: TODAY, daysLeft: 0, overdueDays: 0 },
      { orderId: 3, clientName: '가상 C', dueDay: '2026-10-20', daysLeft: -2, overdueDays: 2 },
    ],
  });
  assert.equal(message.subject, '[생산현황 포장 완료 요청]');
  assert.match(message.text, /정영호 팀장님,/);
  assert.match(message.text, /납기 전 1건 · 오늘 납기 1건 · 납기 경과 1건/);
  assert.match(message.text, /납기까지 3일 남았습니다\..*납기에 맞춰 포장을 서둘러/);
  assert.match(message.text, /오늘이 납기일입니다\..*납기에 맞춰 포장을 서둘러/);
  assert.match(message.text, /납기가 2일 지났습니다\..*빠른 출고를 위해 포장을 서둘러/);
  assert.doesNotMatch(message.text, /-3일 지연|납기 지연 포장|모두 납기 경과/);
});

test('display due day is strict KST and overrides contradictory legacy daysLeft only for copy', () => {
  assert.equal(formatProductionDueDay('2026-10-22T15:00:00.000Z'), '2026-10-23');
  assert.equal(formatProductionDueDay('2026-02-30T00:00:00Z'), '확인 필요');
  assert.equal(formatProductionDueDay('2026-10-22T25:00:00Z'), '확인 필요');
  const message = buildProductionAlertMessage({
    subject: '[검증]',
    recipientName: '담당자',
    date: '2026-10-23',
    items: [
      { orderId: 1, clientName: 'KST 경계', dueDay: '2026-10-22T15:00:00.000Z', daysLeft: -1 },
      { orderId: 2, clientName: '잘못된 날짜', dueDay: '2026-02-30T00:00:00Z', daysLeft: 7 },
    ],
  });
  assert.match(message.text, /KST 경계 \| 납기 2026-10-23\n  오늘이 납기일입니다/);
  assert.match(message.text, /잘못된 날짜 \| 납기 확인 필요\n  납기일 확인이 필요합니다/);
  assert.doesNotMatch(message.text, /잘못된 날짜[^]*납기까지 7일 남았습니다/);
});

test('cron rejects missing auth without schema, query, claim, or provider calls', async () => {
  let calls = 0;
  const dependencies = handlerDeps({ initial: { orders: [], processes: [] } });
  for (const key of ['ensureNotifySchema', 'ensureClaimsSchema', 'loadInitialSnapshot', 'claimDailyNotification', 'sendLms']) {
    dependencies[key] = async () => { calls += 1; };
  }
  const res = await invoke(dependencies, { method: 'GET', headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test('cron executes on weekends and no eligible orders create no claim or provider call', async () => {
  let reads = 0;
  let claims = 0;
  let sends = 0;
  const dependencies = handlerDeps({
    initial: { orders: [], processes: [] },
    nowMs: Date.parse('2026-10-24T00:00:00Z'),
    claimDailyNotification: async () => { claims += 1; return true; },
    sendLms: async () => { sends += 1; return { ok: true, msgId: 'x' }; },
  });
  dependencies.loadInitialSnapshot = async () => { reads += 1; return { orders: [], processes: [] }; };
  const res = await invoke(dependencies);
  assert.equal(res.statusCode, 200);
  assert.equal(reads, 1);
  assert.equal(claims, 0);
  assert.equal(sends, 0);
  assert.equal(res.body.skipped, 'no_eligible');
});

test('concurrent same-day cron runs claim and send each recipient/category only once', async () => {
  const snapshot = { orders: [order(1, '2026-10-01')], processes: [process(1, '설비작업', 'completed'), process(1, '포장', 'completed')] };
  const claimed = new Set();
  let sends = 0;
  const dependencies = handlerDeps({
    initial: snapshot,
    claimDailyNotification: async (_db, claim) => {
      const key = `${claim.kstDate}:${claim.toPhone}:${claim.milestone}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    sendLms: async () => { sends += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, msgId: 'stub' }; },
  });
  await Promise.all([invoke(dependencies), invoke(dependencies)]);
  assert.equal(sends, 1);
  assert.equal(claimed.size, 1);
});

test('success, uncertain, and terminal failure claims stay held that day and repeat on the next KST date', async () => {
  const snapshot = { orders: [order(1, '2026-10-01')], processes: [process(1, '설비작업', 'completed'), process(1, '포장', 'completed')] };
  for (const sendResult of [
    { ok: true, msgId: 'success-id' },
    { ok: false, uncertain: true, error: 'timeout' },
    { ok: false, explicitFailure: true, error: 'rejected' },
  ]) {
    const claims = new Set();
    let sends = 0;
    const dependencies = handlerDeps({
      initial: snapshot,
      claimDailyNotification: async (_db, claim) => {
        const key = `${claim.kstDate}:${claim.toPhone}:${claim.milestone}`;
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      },
      sendLms: async () => { sends += 1; return sendResult; },
    });
    await invoke(dependencies);
    await invoke(dependencies);
    assert.equal(sends, 1);
    dependencies.nowMs = Date.parse('2026-10-23T00:00:00Z');
    await invoke(dependencies);
    assert.equal(sends, 2);
  }
});

test('post-claim recheck removes shipped, completed, rescheduled, and reassigned orders before sending', async () => {
  const initial = {
    orders: [order(1, '2026-10-01'), order(2, '2026-10-01'), order(3, '2026-10-01')],
    processes: [],
  };
  const current = {
    orders: [
      order(1, '2026-10-01', { ship_date: '2026-10-22T01:00:00Z' }),
      order(2, '2026-12-01'),
      order(3, '2026-10-01', { sales_person: '이준형' }),
    ],
    processes: [
      process(3, '설비작업', 'completed'),
      process(3, '포장', 'completed'),
    ],
  };
  let sends = 0;
  const finishes = [];
  const res = await invoke(handlerDeps({
    initial,
    current,
    sendLms: async () => { sends += 1; return { ok: true, msgId: 'unexpected' }; },
    finishDailyNotification: async (_db, claim, result) => { finishes.push({ claim, result }); return true; },
  }));
  assert.equal(sends, 0);
  assert.ok(finishes.length > 0);
  assert.ok(finishes.every(item => item.result.explicitFailure && /cancelled_after_recheck/.test(item.result.error)));
  assert.ok(res.body.results.every(item => item.status === 'cancelled_after_recheck'));
});

test('initial query and per-group claim errors are summarized without raw errors, phones, or secrets', async () => {
  const initialFailure = handlerDeps({ initial: { orders: [], processes: [] } });
  initialFailure.loadInitialSnapshot = async () => { throw new Error('secret db detail 010-1234-5678'); };
  const failedQuery = await invoke(initialFailure);
  assert.equal(failedQuery.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(failedQuery.body), /secret db detail|010/);

  const snapshot = { orders: [order(1, '2026-10-01')], processes: [process(1, '설비작업', 'completed'), process(1, '포장', 'completed')] };
  const claimFailure = await invoke(handlerDeps({
    initial: snapshot,
    claimDailyNotification: async () => { throw new Error('private claim error 010-9999-9999'); },
  }));
  assert.equal(claimFailure.body.failed, 1);
  assert.equal(claimFailure.body.results[0].status, 'claim_error');
  assert.doesNotMatch(JSON.stringify(claimFailure.body), /private claim error|0109999|010-9999/);
});
