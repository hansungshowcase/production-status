import assert from 'node:assert/strict';
import test from 'node:test';

function response() {
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

function request(body = {}) {
  return {
    method: 'PATCH',
    query: { id: '73' },
    body: { actor: '강종효', ...body },
  };
}

function dependencies(db, extra = {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '강종효' }),
    notify: async () => {},
    ...extra,
  };
}

function makeCompletionDb({ stepName = 'V-커팅작업', claimSucceeds = true } = {}) {
  const state = {
    process: { id: 73, order_id: 173, step_name: stepName, status: 'in_progress' },
    order: {
      id: 173,
      client_name: '공정 알림 거래처',
      due_date: '2026-09-10',
      ship_scheduled_date: null,
      status: 'in_production',
    },
  };
  return {
    state,
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...state.process }] };
      if (statement.startsWith("UPDATE processes SET status = 'completed'")) {
        if (!claimSucceeds) return { rows: [] };
        state.process.status = 'completed';
        return { rows: [{ id: 73 }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...state.order }] };
      if (statement.startsWith('INSERT INTO activity_feed')) return { rows: [] };
      throw new Error(`Unexpected completion SQL: ${statement}`);
    },
  };
}

function makeStartDb({ claimSucceeds = true } = {}) {
  const state = {
    process: { id: 73, order_id: 173, step_name: '용접작업', status: 'waiting' },
    order: {
      id: 173,
      client_name: '공정 시작 거래처',
      due_date: '2026-09-10',
      ship_scheduled_date: null,
      status: 'in_production',
    },
  };
  const previous = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업'].map((step_name, index) => ({
    id: 10 + index,
    order_id: 173,
    step_name,
    status: 'completed',
  }));
  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...state.process }] };
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') return { rows: [...previous, { ...state.process }] };
      if (statement.startsWith("UPDATE processes SET status = 'in_progress'")) {
        if (!claimSucceeds) return { rows: [] };
        state.process.status = 'in_progress';
        state.process.started_at = args[0];
        state.process.started_by = args[1];
        return { rows: [{ id: 73 }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...state.order }] };
      if (statement.startsWith('INSERT INTO activity_feed')) return { rows: [] };
      throw new Error(`Unexpected start SQL: ${statement}`);
    },
  };
}

function makeForwardCompletionDb() {
  const current = { id: 73, order_id: 173, step_name: '레이저작업', status: 'in_progress' };
  const forward = [
    { id: 74, order_id: 173, step_name: 'V-커팅작업', status: 'waiting' },
    { id: 75, order_id: 173, step_name: '절곡작업', status: 'waiting' },
  ];
  const orderRow = {
    id: 173,
    client_name: '공정 건너뛰기 거래처',
    due_date: '2026-09-10',
    ship_scheduled_date: null,
    status: 'in_production',
  };
  return {
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...current }] };
      if (statement.startsWith('SELECT id, step_name, status FROM processes WHERE order_id = ?')) {
        return { rows: forward.map(row => ({ ...row })) };
      }
      if (statement.startsWith("UPDATE processes SET status = 'completed', completed_at")) {
        current.status = 'completed';
        return { rows: [{ id: 73 }] };
      }
      if (statement.startsWith('UPDATE processes SET status = \'completed\', started_at')) {
        forward[0].status = 'completed';
        return { rows: [] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'in_progress'")) {
        forward[1].status = 'in_progress';
        return { rows: [{ id: 75 }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...orderRow }] };
      if (statement.startsWith('INSERT INTO activity_feed')) return { rows: [] };
      throw new Error(`Unexpected forward completion SQL: ${statement}`);
    },
  };
}

test('V-커팅 공정 완료 성공 뒤에만 자재 알림 훅을 호출한다', async () => {
  const { handleCompleteProcess } = await import('../api/processes/[id]/complete.js');
  const db = makeCompletionDb();
  const res = response();
  const calls = [];

  await handleCompleteProcess(request(), res, dependencies(db, {
    notifyInternalCompletion: async (receivedDb, payload) => calls.push({ receivedDb, payload }),
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedDb, db);
  assert.equal(calls[0].payload.order.id, 173);
  assert.deepEqual(calls[0].payload.completedStepNames, ['V-커팅작업']);
  assert.equal(calls[0].payload.completedBy, '강종효');
});

test('앞 공정 완료와 함께 V-커팅을 자동 완료한 경우에도 자재 알림 훅을 호출한다', async () => {
  const { handleCompleteProcess } = await import('../api/processes/[id]/complete.js');
  const db = makeForwardCompletionDb();
  const res = response();
  const calls = [];

  await handleCompleteProcess(request({ start_next_step: '절곡작업' }), res, dependencies(db, {
    notifyInternalCompletion: async (_receivedDb, payload) => calls.push(payload),
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].completedStepNames, ['V-커팅작업']);
  assert.deepEqual(res.body.completed_intermediate_processes, [{
    id: 74,
    was_waiting_before_complete: true,
  }]);
});

test('V-커팅 완료 알림 실패는 공정 완료 성공을 막지 않고, 원자적 완료 실패에는 알림을 호출하지 않는다', async () => {
  const { handleCompleteProcess } = await import('../api/processes/[id]/complete.js');
  const oldError = console.error;
  console.error = () => {};
  try {
    const successfulDb = makeCompletionDb();
    const successfulRes = response();
    await handleCompleteProcess(request(), successfulRes, dependencies(successfulDb, {
      notifyInternalCompletion: async () => { throw new Error('SMS unavailable'); },
    }));
    assert.equal(successfulRes.statusCode, 200);
    assert.equal(successfulDb.state.process.status, 'completed');

    const lostDb = makeCompletionDb({ claimSucceeds: false });
    const lostRes = response();
    let calls = 0;
    await handleCompleteProcess(request(), lostRes, dependencies(lostDb, {
      notifyInternalCompletion: async () => { calls += 1; },
    }));
    assert.equal(lostRes.statusCode, 409);
    assert.equal(calls, 0);
  } finally {
    console.error = oldError;
  }
});

test('공정 시작 성공 뒤에 시작 버튼을 누른 작업자 정보로 내부 알림 훅을 호출한다', async () => {
  const module = await import('../api/processes/[id]/start.js');
  assert.equal(typeof module.handleStartProcess, 'function');
  const db = makeStartDb();
  const res = response();
  const calls = [];

  await module.handleStartProcess(request(), res, dependencies(db, {
    notifyInternalStart: async (receivedDb, payload) => calls.push({ receivedDb, payload }),
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedDb, db);
  assert.equal(calls[0].payload.order.id, 173);
  assert.equal(calls[0].payload.workerName, '강종효');
  assert.equal(calls[0].payload.process.step_name, '용접작업');
  assert.equal(calls[0].payload.process.status, 'in_progress');
});

test('공정 시작 알림 실패는 시작 성공을 막지 않고, 원자적 시작 실패에는 알림을 호출하지 않는다', async () => {
  const { handleStartProcess } = await import('../api/processes/[id]/start.js');
  const oldError = console.error;
  console.error = () => {};
  try {
    const successfulDb = makeStartDb();
    const successfulRes = response();
    await handleStartProcess(request(), successfulRes, dependencies(successfulDb, {
      notifyInternalStart: async () => { throw new Error('SMS unavailable'); },
    }));
    assert.equal(successfulRes.statusCode, 200);
    assert.equal(successfulDb.state.process.status, 'in_progress');

    const lostDb = makeStartDb({ claimSucceeds: false });
    const lostRes = response();
    let calls = 0;
    await handleStartProcess(request(), lostRes, dependencies(lostDb, {
      notifyInternalStart: async () => { calls += 1; },
    }));
    assert.equal(lostRes.statusCode, 409);
    assert.equal(calls, 0);
  } finally {
    console.error = oldError;
  }
});
