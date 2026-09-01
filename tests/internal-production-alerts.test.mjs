import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { STEPS } from '../api/_lib/steps.js';

const moduleUrl = new URL('../api/_lib/internalProductionAlerts.js', import.meta.url);

async function loadAlertsModule() {
  return import(`${moduleUrl.href}?cacheBust=${Date.now()}-${Math.random()}`).catch(() => ({}));
}

test('내부 생산 알림 수신자와 조립팀 작업자 별칭을 정확히 연결한다', async () => {
  const alerts = await loadAlertsModule();

  assert.deepEqual(alerts.INTERNAL_ALERT_CONTACTS, {
    material: { name: '이시아 부장', phone: '010-4186-4237' },
    welding: { name: '최우석 이사', phone: '010-8308-5110' },
    laser: { name: '이정섭 부장', phone: '010-3240-5938' },
    design: { name: '김보수 팀장', phone: '010-9097-4034' },
    assembly: { name: '박상규 공장장', phone: '010-9322-3904' },
    packing: { name: '정영호 팀장', phone: '010-9095-0577' },
  });

  assert.equal(alerts.assemblyWorkerPhone('강종효'), '010-9606-0873');
  assert.equal(alerts.assemblyWorkerPhone('카우사르'), '010-8302-2576');
  assert.equal(alerts.assemblyWorkerPhone('까우사르'), '010-8302-2576');
  assert.equal(alerts.assemblyWorkerPhone('나타왓'), '010-2157-9396');
  assert.equal(alerts.assemblyWorkerPhone('마카라'), '010-2356-8947');
  assert.equal(alerts.assemblyWorkerPhone('백승정'), '010-8725-4464');
  assert.equal(alerts.assemblyWorkerPhone('까지'), '010-8470-4537');
  assert.equal(alerts.assemblyWorkerPhone('거니'), '');
});

function order(id, dueDate, over = {}) {
  return {
    id,
    client_name: `거래처 ${id}`,
    product_type: '쇼케이스',
    door_type: '뒷문',
    width: 1200,
    depth: 750,
    height: 1870,
    due_date: dueDate,
    ship_scheduled_date: null,
    status: 'in_production',
    ...over,
  };
}

function processes(orderId, statusMap = {}, starterMap = {}) {
  return STEPS.map((stepName, index) => ({
    id: orderId * 100 + index,
    order_id: orderId,
    step_name: stepName,
    status: statusMap[stepName] || 'waiting',
    started_by: starterMap[stepName] || null,
  }));
}

function typesFor(items, orderId) {
  return items.filter(item => item.orderId === orderId).map(item => item.type).sort();
}

test('납기 단계별 담당자 알림은 기준일에 미완료된 공정만 고른다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.collectInternalDailyAlerts, 'function');

  const orders = [
    order(1, '2026-09-10'), // D-9: 도면
    order(2, '2026-09-09'), // D-8: 도면 완료, 레이저
    order(3, '2026-09-07'), // D-6: 용접 미착수
    order(4, '2026-09-05'), // D-4: 조립 미완료
    order(5, '2026-09-04'), // D-3: 포장 미완료
  ];
  const allProcesses = [
    ...processes(1),
    ...processes(2, { '도면설계': 'completed' }),
    ...processes(3, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
    }),
    ...processes(4, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
      '용접작업': 'completed', '분체작업': 'completed',
    }),
    ...processes(5, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
      '용접작업': 'completed', '분체작업': 'completed', '조립작업': 'completed', '설비작업': 'completed',
    }),
  ];

  const items = alerts.collectInternalDailyAlerts({ orders, processes: allProcesses, today: '2026-09-01' });

  assert.deepEqual(typesFor(items, 1), ['design_due']);
  assert.deepEqual(typesFor(items, 2), ['laser_due']);
  assert.deepEqual(typesFor(items, 3), ['welding_due']);
  assert.deepEqual(typesFor(items, 4), ['assembly_due']);
  assert.deepEqual(typesFor(items, 5), ['packing_due']);
});

test('기준일이 주말이었거나 주문이 늦게 등록되어도 첫 평일에 한 번 확인한다', async () => {
  const alerts = await loadAlertsModule();
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(6, '2026-09-09')], // 오늘 D-8: D-9 도면 경보도 아직 미완료면 회수
    processes: processes(6),
    today: '2026-09-01',
  });

  assert.deepEqual(typesFor(items, 6), ['design_due', 'laser_due']);
  assert.equal(items.every(item => item.daysLeft === 8), true);
});

test('용접이 시작되면 D-6 경보를 제외하고 조립·포장 완료 상태도 정확히 존중한다', async () => {
  const alerts = await loadAlertsModule();
  const allProcesses = [
    ...processes(7, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
      '용접작업': 'in_progress',
    }),
    ...processes(8, Object.fromEntries(STEPS.map(step => [step, 'completed']))),
  ];
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(7, '2026-09-07'), order(8, '2026-09-04')],
    processes: allProcesses,
    today: '2026-09-01',
  });

  assert.deepEqual(typesFor(items, 7), []);
  assert.deepEqual(typesFor(items, 8), []);
});

test('조립팀 문자는 포장 미완료 주문을 시작한 각 작업자 본인에게만 만든다', async () => {
  const alerts = await loadAlertsModule();
  const started = processes(9, {
    '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
    '용접작업': 'in_progress',
  }, {
    '절곡작업': '강종효',
    '용접작업': '까우사르',
  });
  const packed = processes(10, Object.fromEntries(STEPS.map(step => [step, 'completed'])), {
    '용접작업': '백승정',
  });
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(9, '2026-09-12'), order(10, '2026-09-12')],
    processes: [...started, ...packed],
    today: '2026-09-01',
  });
  const daily = items.filter(item => item.type === 'assembly_daily');

  assert.deepEqual(daily.map(item => item.recipientName).sort(), ['강종효', '카우사르']);
  assert.deepEqual(daily.map(item => item.phone).sort(), ['010-8302-2576', '010-9606-0873']);
  assert.equal(daily.every(item => item.orderId === 9 && item.alertDate === '2026-09-01'), true);
  assert.equal(daily.some(item => item.orderId === 10), false);
});

test('출고 완료·납기 경과·납기 미입력 주문에는 새 내부 알림을 만들지 않는다', async () => {
  const alerts = await loadAlertsModule();
  const orders = [
    order(11, '2026-08-31'),
    order(12, null),
    order(13, '2026-09-03', { status: 'shipped' }),
  ];
  const items = alerts.collectInternalDailyAlerts({
    orders,
    processes: orders.flatMap(row => processes(row.id)),
    today: '2026-09-01',
  });

  assert.deepEqual(items, []);
});

test('같은 수신자의 여러 주문은 한 문자 묶음으로 만든다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.groupInternalAlerts, 'function');
  assert.equal(typeof alerts.buildInternalAlertMessage, 'function');
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(20, '2026-09-10'), order(21, '2026-09-10')],
    processes: [...processes(20), ...processes(21)],
    today: '2026-09-01',
  }).filter(item => item.type === 'design_due');

  const groups = alerts.groupInternalAlerts(items);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].recipientName, '김보수 팀장');
  assert.equal(groups[0].items.length, 2);
  const message = alerts.buildInternalAlertMessage(groups[0]);
  assert.equal(message.subject, '[한성쇼케이스 도면 작업 요청]');
  assert.match(message.text, /김보수 팀장님/);
  assert.match(message.text, /거래처 20/);
  assert.match(message.text, /거래처 21/);
  assert.match(message.text, /도면설계가 아직 완료되지 않은 작업 2건/);
  assert.match(message.text, /후속 생산공정이 일정대로 시작될 수 있도록 도면 작업을 서둘러 진행해 주세요/);
});

test('용접·조립·포장 알림은 승인된 책임 문구와 실제 공정 상태를 담는다', async () => {
  const alerts = await loadAlertsModule();
  const allProcesses = [
    ...processes(22, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'in_progress',
    }),
    ...processes(23, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
      '용접작업': 'completed', '분체작업': 'completed',
    }),
    ...processes(24, {
      '도면설계': 'completed', '레이저작업': 'completed', 'V-커팅작업': 'completed', '절곡작업': 'completed',
      '용접작업': 'completed', '분체작업': 'completed', '조립작업': 'completed', '설비작업': 'in_progress',
    }),
  ];
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(22, '2026-09-07'), order(23, '2026-09-05'), order(24, '2026-09-04')],
    processes: allProcesses,
    today: '2026-09-01',
  });
  const groups = alerts.groupInternalAlerts(items);
  const textFor = type => alerts.buildInternalAlertMessage(groups.find(group => group.type === type)).text;

  assert.match(textFor('welding_due'), /V-커팅 완료 · 절곡 진행중 · 용접 대기/);
  assert.match(textFor('welding_due'), /용접작업이 지체 없이 시작될 수 있도록 V-커팅과 절곡 진행 상황을 확인하고 담당자를 지정해 주세요/);
  assert.match(textFor('assembly_due'), /조립작업이 아직 완료되지 않은 작업/);
  assert.match(textFor('assembly_due'), /조립 담당자 지정 및 완료 일정을 점검해 주세요/);
  assert.match(textFor('packing_due'), /설비 진행중 · 포장 대기/);
  assert.match(textFor('packing_due'), /설비작업에서 끝나지 않고 포장 완료까지 이어질 수 있도록/);
});

test('V-커팅 완료 즉시 자재 입고 요청 문구를 만든다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.createVcutCompletionAlert, 'function');
  const item = alerts.createVcutCompletionAlert({
    order: order(25, '2026-09-10'),
    today: '2026-09-01',
    completedBy: '거니',
  });
  const message = alerts.buildInternalAlertMessage(alerts.groupInternalAlerts([item])[0]);

  assert.equal(item.phone, '010-4186-4237');
  assert.equal(item.stateKey, 'internal:vcut_completed');
  assert.equal(message.subject, '[한성쇼케이스 자재 입고 요청]');
  assert.match(message.text, /V-커팅 작업이 완료되었습니다/);
  assert.match(message.text, /현장 작업이 지체되지 않도록 해당 작업의 자재가 바로 입고될 수 있게 확인해 주세요/);
});

test('조립팀 시작 문자는 평일에 시작 버튼을 누른 본인에게만 만들고 주말에는 만들지 않는다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.createAssemblyStartAlert, 'function');
  const targetOrder = order(26, '2026-09-10');
  const process = { order_id: 26, step_name: '용접작업', status: 'in_progress', started_by: '강종효' };
  const weekday = Date.parse('2026-09-01T00:00:00.000Z'); // KST 화요일
  const weekend = Date.parse('2026-09-05T00:00:00.000Z'); // KST 토요일

  const item = alerts.createAssemblyStartAlert({ order: targetOrder, process, workerName: '강종효', today: '2026-09-01', nowMs: weekday });
  assert.equal(item.recipientName, '강종효');
  assert.equal(item.phone, '010-9606-0873');
  assert.equal(item.alertDate, '2026-09-01');
  assert.equal(item.stateKey, 'internal:assembly_daily:강종효');
  assert.equal(alerts.createAssemblyStartAlert({ order: targetOrder, process, workerName: '거니', today: '2026-09-01', nowMs: weekday }), null);
  assert.equal(alerts.createAssemblyStartAlert({ order: targetOrder, process, workerName: '강종효', today: '2026-09-05', nowMs: weekend }), null);

  const message = alerts.buildInternalAlertMessage(alerts.groupInternalAlerts([item])[0]);
  assert.match(message.text, /강종효님/);
  assert.match(message.text, /포장이 아직 완료되지 않았습니다/);
  assert.match(message.text, /납기는 한성 팀원 모두의 책임입니다/);
});

test('V-커팅 완료 훅만 자재 담당자에게 즉시 알림을 전달한다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.notifyInternalProcessCompletion, 'function');
  const groups = [];
  const options = {
    sendGroup: async (_db, group) => {
      groups.push(group);
      return { sent: 1, failed: 0, skipped: 0 };
    },
  };

  const skipped = await alerts.notifyInternalProcessCompletion({}, {
    order: order(27, '2026-09-10'),
    completedStepNames: ['레이저작업'],
    completedBy: '거니',
    today: '2026-09-01',
  }, options);
  const sent = await alerts.notifyInternalProcessCompletion({}, {
    order: order(27, '2026-09-10'),
    completedStepNames: ['레이저작업', 'V-커팅작업'],
    completedBy: '거니',
    today: '2026-09-01',
  }, options);

  assert.deepEqual(skipped, { sent: 0, failed: 0, skipped: 'not_vcut' });
  assert.equal(sent.sent, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'vcut_completed');
  assert.equal(groups[0].phone, '010-4186-4237');
});

test('공정 시작 훅은 평일에 시작한 조립팀 본인에게만 즉시 알림을 전달한다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.notifyInternalProcessStart, 'function');
  const groups = [];
  const sendGroup = async (_db, group) => {
    groups.push(group);
    return { sent: 1, failed: 0, skipped: 0 };
  };
  const targetOrder = order(28, '2026-09-10');
  const targetProcess = { order_id: 28, step_name: '용접작업', status: 'in_progress' };

  const unknown = await alerts.notifyInternalProcessStart({}, {
    order: targetOrder,
    process: targetProcess,
    workerName: '거니',
    today: '2026-09-01',
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
  }, { sendGroup });
  const weekend = await alerts.notifyInternalProcessStart({}, {
    order: targetOrder,
    process: targetProcess,
    workerName: '강종효',
    today: '2026-09-05',
    nowMs: Date.parse('2026-09-05T00:00:00.000Z'),
  }, { sendGroup });
  const sent = await alerts.notifyInternalProcessStart({}, {
    order: targetOrder,
    process: targetProcess,
    workerName: '강종효',
    today: '2026-09-01',
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
  }, { sendGroup });

  assert.deepEqual(unknown, { sent: 0, failed: 0, skipped: 'not_target' });
  assert.deepEqual(weekend, { sent: 0, failed: 0, skipped: 'not_target' });
  assert.equal(sent.sent, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].recipientName, '강종효');
  assert.equal(groups[0].phone, '010-9606-0873');
});

function makeInternalStateDb() {
  const notifyState = new Map();
  const statements = [];
  return {
    notifyState,
    statements,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if (!statement.startsWith('UPDATE orders SET notify_state')) {
        throw new Error(`Unexpected SQL: ${statement}`);
      }
      const [key, payloadJson, orderId] = args;
      const payload = JSON.parse(payloadJson);
      const orderState = notifyState.get(Number(orderId)) || {};
      if (statement.includes('RETURNING id')) {
        const previous = orderState[key];
        const staleBefore = args.at(-1);
        const staleSending = previous?.status === 'internal_sending' && String(previous?.at || '') < staleBefore;
        const eligible = payload.date
          ? previous?.date !== payload.date || previous?.status === 'internal_failed' || staleSending
          : !['internal_success', 'internal_dry_run'].includes(previous?.status) && (previous?.status !== 'internal_sending' || staleSending);
        if (!eligible) return { rows: [] };
        notifyState.set(Number(orderId), { ...orderState, [key]: payload });
        return { rows: [{ id: Number(orderId) }] };
      }
      notifyState.set(Number(orderId), { ...orderState, [key]: payload });
      return { rows: [] };
    },
  };
}

test('주문 알림 상태를 원자적으로 선점해 같은 내부 문자를 중복 발송하지 않는다', async () => {
  const alerts = await loadAlertsModule();
  assert.equal(typeof alerts.sendInternalAlertGroup, 'function');
  const items = alerts.collectInternalDailyAlerts({
    orders: [order(30, '2026-09-10'), order(31, '2026-09-10')],
    processes: [...processes(30), ...processes(31)],
    today: '2026-09-01',
  }).filter(item => item.type === 'design_due');
  const group = alerts.groupInternalAlerts(items)[0];
  const db = makeInternalStateDb();
  const sends = [];
  const sendLms = async (_db, message) => {
    sends.push(message);
    return { ok: true, channel: 'lms', msgId: 'internal-1' };
  };
  const options = { sendLms, ensureSchema: async () => {}, nowMs: Date.parse('2026-09-01T00:00:00.000Z') };

  const first = await alerts.sendInternalAlertGroup(db, group, options);
  const second = await alerts.sendInternalAlertGroup(db, group, options);

  assert.equal(first.sent, 2);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 2);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].recipientName, '김보수 팀장');
  assert.match(sends[0].text, /거래처 30/);
  assert.match(sends[0].text, /거래처 31/);
  assert.equal(db.notifyState.get(30)['internal:design_due'].status, 'internal_success');
  assert.equal(db.notifyState.get(31)['internal:design_due'].status, 'internal_success');
  assert.ok(db.statements.some(statement => statement.includes('RETURNING id')));
});

test('조립팀 일일 문자는 같은 날 한 번만 보내고 다음 평일에는 다시 보낸다', async () => {
  const alerts = await loadAlertsModule();
  const targetOrder = order(32, '2026-09-12');
  const targetProcess = { order_id: 32, step_name: '용접작업', status: 'in_progress', started_by: '강종효' };
  const dayOne = alerts.createAssemblyStartAlert({
    order: targetOrder,
    process: targetProcess,
    workerName: '강종효',
    today: '2026-09-01',
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
  });
  const dayTwo = { ...dayOne, alertDate: '2026-09-02', daysLeft: dayOne.daysLeft - 1 };
  const db = makeInternalStateDb();
  let sendCount = 0;
  const options = {
    ensureSchema: async () => {},
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
    sendLms: async () => ({ ok: true, channel: 'lms', msgId: `daily-${++sendCount}` }),
  };

  await alerts.sendInternalAlertGroup(db, alerts.groupInternalAlerts([dayOne])[0], options);
  await alerts.sendInternalAlertGroup(db, alerts.groupInternalAlerts([dayOne])[0], options);
  await alerts.sendInternalAlertGroup(db, alerts.groupInternalAlerts([dayTwo])[0], {
    ...options,
    nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
  });

  assert.equal(sendCount, 2);
  assert.equal(db.notifyState.get(32)['internal:assembly_daily:강종효'].date, '2026-09-02');
});

test('내부 문자 발송 실패는 실패 상태로 남겨 같은 대상의 다음 시도에서 재전송한다', async () => {
  const alerts = await loadAlertsModule();
  const item = alerts.createVcutCompletionAlert({ order: order(33, '2026-09-10'), today: '2026-09-01' });
  const group = alerts.groupInternalAlerts([item])[0];
  const db = makeInternalStateDb();
  let attempts = 0;
  const options = {
    ensureSchema: async () => {},
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
    sendLms: async () => (++attempts === 1
      ? { ok: false, channel: 'lms', error: 'temporary failure' }
      : { ok: true, channel: 'lms', msgId: 'retry-ok' }),
  };

  const failed = await alerts.sendInternalAlertGroup(db, group, options);
  const retried = await alerts.sendInternalAlertGroup(db, group, options);

  assert.equal(failed.failed, 1);
  assert.equal(retried.sent, 1);
  assert.equal(attempts, 2);
  assert.equal(db.notifyState.get(33)['internal:vcut_completed'].status, 'internal_success');
});

function mockResponse() {
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

test('내부 생산 알림 크론은 인증되지 않은 요청과 주말 실행을 발송 전에 차단한다', async () => {
  const cron = await import(`../api/cron/internal-production-daily.js?cacheBust=${Date.now()}-${Math.random()}`).catch(() => ({}));
  assert.equal(typeof cron.handleInternalProductionDaily, 'function');
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'internal-alert-secret';
  let dbCalls = 0;
  let sendCalls = 0;
  const dependencies = {
    db: { async execute() { dbCalls += 1; return { rows: [] }; } },
    ensureSchema: async () => { dbCalls += 1; },
    sendGroup: async () => { sendCalls += 1; return { sent: 0 }; },
  };

  try {
    const unauthorized = mockResponse();
    await cron.handleInternalProductionDaily({ method: 'GET', headers: {} }, unauthorized, {
      ...dependencies,
      nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
    });
    assert.equal(unauthorized.statusCode, 401);

    const weekend = mockResponse();
    await cron.handleInternalProductionDaily({
      method: 'GET',
      headers: { authorization: 'Bearer internal-alert-secret' },
    }, weekend, {
      ...dependencies,
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'),
    });
    assert.equal(weekend.statusCode, 200);
    assert.deepEqual(weekend.body, { ok: true, sent: 0, skipped: 'weekend' });
    assert.equal(dbCalls, 0);
    assert.equal(sendCalls, 0);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('내부 생산 알림 크론은 평일 주문·공정을 조회해 수신자별 한 묶음씩 발송한다', async () => {
  const { handleInternalProductionDaily } = await import(`../api/cron/internal-production-daily.js?cacheBust=${Date.now()}-${Math.random()}`);
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'internal-alert-secret';
  const queries = [];
  const db = {
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push(statement);
      if (statement.startsWith('SELECT id, client_name')) {
        return { rows: [order(40, '2026-09-10'), order(41, '2026-09-10')] };
      }
      if (statement.startsWith('SELECT p.order_id')) {
        return { rows: [...processes(40), ...processes(41)] };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  const sentGroups = [];
  let schemaCalls = 0;

  try {
    const res = mockResponse();
    await handleInternalProductionDaily({
      method: 'POST',
      headers: { authorization: 'Bearer internal-alert-secret' },
    }, res, {
      db,
      ensureSchema: async receivedDb => {
        assert.equal(receivedDb, db);
        schemaCalls += 1;
      },
      today: '2026-09-01',
      nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
      sendGroup: async (_db, group) => {
        sentGroups.push(group);
        return { sent: group.items.length, failed: 0, skipped: 0 };
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.groups, 1);
    assert.equal(res.body.sent, 2);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.counts.scanned, 2);
    assert.equal(res.body.counts.alerts, 2);
    assert.equal(sentGroups.length, 1);
    assert.equal(sentGroups[0].type, 'design_due');
    assert.equal(sentGroups[0].phone, '010-9097-4034');
    assert.deepEqual(sentGroups[0].items.map(item => item.orderId), [40, 41]);
    assert.equal(schemaCalls, 1);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /ship_scheduled_date/);
    assert.match(queries[1], /started_by/);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('내부 생산 알림 크론은 기존 영업 알림과 같은 평일 08:40 KST에 별도 실행된다', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    config.crons.find(cron => cron.path === '/api/cron/risk-daily'),
    { path: '/api/cron/risk-daily', schedule: '40 23 * * 0-4' },
  );
  assert.deepEqual(
    config.crons.find(cron => cron.path === '/api/cron/internal-production-daily'),
    { path: '/api/cron/internal-production-daily', schedule: '40 23 * * 0-4' },
  );
});
