import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCompleteProcess } from '../api/processes/[id]/complete.js';

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
    body: { actor: '공정 작업자', ...body },
  };
}

function completionDb({
  process = { id: 73, order_id: 173, step_name: '레이저작업', status: 'in_progress' },
  forward = [],
  atomicRows,
  atomicError = null,
  photoExists = true,
} = {}) {
  const state = { batches: [], writesOutsideAtomic: 0 };
  return {
    state,
    async execute({ sql }) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(statement)) state.writesOutsideAtomic += 1;
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...process }] };
      if (statement.startsWith('SELECT id, step_name, status FROM processes WHERE order_id = ?')) {
        return { rows: forward.map((row) => ({ ...row })) };
      }
      if (statement === 'SELECT id FROM photos WHERE process_id = ? LIMIT 1') {
        return { rows: photoExists ? [{ id: 9 }] : [] };
      }
      if (/^(?:CREATE|ALTER)\b/i.test(statement)) return { rows: [] };
      throw new Error(`Unexpected completion preflight SQL: ${statement}`);
    },
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 1);
      const sql = queries[0].sql;
      assert.match(sql, /^WITH claimed_process AS/i);
      assert.match(sql, /UPDATE processes[\s\S]*status = 'completed'[\s\S]*status = 'in_progress'/i);
      assert.match(sql, /completed_intermediates AS/i);
      assert.match(sql, /started_existing_next AS/i);
      assert.match(sql, /process_activity AS/i);
      assert.match(sql, /FROM claimed_process/i);
      if (atomicError) throw atomicError;
      return [{ rows: atomicRows || [] }];
    },
  };
}

function dependencies(db, external, overrides = {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '공정 작업자' }),
    notify: async (_db, order, milestone) => external.push(['customer', order.id, milestone]),
    notifyInternalCompletion: async (_db, payload) => external.push([
      'internal',
      payload.order.id,
      payload.completedStepNames.join(','),
    ]),
    ensureShippingProcessUniqueIndex: async () => {},
    ensureShippingSheetSyncSchema: async () => {},
    ...overrides,
  };
}

test('single process completion performs every database write inside one guarded CTE', async () => {
  const completedProcess = {
    id: 73,
    order_id: 173,
    step_name: '레이저작업',
    status: 'completed',
    completed_by: '공정 작업자',
  };
  const db = completionDb({
    atomicRows: [{
      claimed_process_id: 73,
      process_row: completedProcess,
      order_row: { id: 173, client_name: '원자 완료 거래처', status: 'in_production' },
      completed_intermediate_processes: [],
      started_next_process_id: null,
      shipped_order: null,
    }],
  });
  const external = [];
  const res = response();

  await handleCompleteProcess(request(), res, dependencies(db, external));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'completed');
  assert.deepEqual(res.body.completed_intermediate_processes, []);
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(external, []);
});

test('lost completion CAS returns 409 and invokes zero external hooks', async () => {
  const db = completionDb({ atomicRows: [] });
  const external = [];
  const res = response();

  await handleCompleteProcess(request(), res, dependencies(db, external));

  assert.equal(res.statusCode, 409);
  assert.deepEqual(external, []);
  assert.equal(db.state.writesOutsideAtomic, 0);
});

test('skipped V-cut and next step are derived from committed CTE return rows', async () => {
  const forward = [
    { id: 74, step_name: 'V-커팅작업', status: 'waiting' },
    { id: 75, step_name: '절곡작업', status: 'waiting' },
  ];
  const db = completionDb({
    forward,
    atomicRows: [{
      claimed_process_id: 73,
      process_row: { id: 73, order_id: 173, step_name: '레이저작업', status: 'completed' },
      order_row: { id: 173, client_name: '건너뛰기 거래처', status: 'in_production' },
      completed_intermediate_processes: [{
        id: 74,
        step_name: 'V-커팅작업',
        was_waiting_before_complete: true,
      }],
      started_next_process_id: 75,
      shipped_order: null,
    }],
  });
  const external = [];
  const res = response();

  await handleCompleteProcess(
    request({ start_next_step: '절곡작업', assigned_worker: '다음 작업자' }),
    res,
    dependencies(db, external),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.started_next_process_id, 75);
  assert.deepEqual(res.body.completed_intermediate_processes, [{
    id: 74,
    was_waiting_before_complete: true,
  }]);
  assert.deepEqual(external, [['internal', 173, 'V-커팅작업']]);
});

test('shipping completion commits order and outbox in the guarded CTE before its disabled hook', async () => {
  const process = { id: 73, order_id: 173, step_name: '출고', status: 'in_progress' };
  const shipped = { id: 173, client_name: '출고 거래처', status: 'shipped', ship_date: '2026-10-22' };
  const db = completionDb({
    process,
    atomicRows: [{
      claimed_process_id: 73,
      process_row: { ...process, status: 'completed' },
      order_row: shipped,
      completed_intermediate_processes: [],
      started_next_process_id: null,
      shipped_order: shipped,
    }],
  });
  const external = [];
  const res = response();

  await handleCompleteProcess(request(), res, dependencies(db, external));

  const sql = db.state.batches[0][0].sql;
  assert.match(sql, /shipped_order AS/i);
  assert.match(sql, /queued_sheet_sync AS/i);
  assert.match(sql, /INSERT INTO sheet_shipping_sync_jobs/i);
  assert.match(sql, /SELECT id, \?, 'pending' FROM shipped_order/i);
  assert.deepEqual(external, [['customer', 173, 'shipped']]);
});

test('any guarded CTE database failure rolls back before notifications', async () => {
  const db = completionDb({ atomicError: new Error('simulated intermediate CTE failure') });
  const external = [];

  await assert.rejects(
    handleCompleteProcess(request(), response(), dependencies(db, external)),
    /simulated intermediate CTE failure/,
  );

  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(external, []);
});

test('packing without a photo rejects before the atomic mutation and external hooks', async () => {
  const db = completionDb({
    process: { id: 73, order_id: 173, step_name: '포장', status: 'in_progress' },
    photoExists: false,
  });
  const external = [];
  const res = response();

  await handleCompleteProcess(request(), res, dependencies(db, external));

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /사진 첨부/);
  assert.equal(db.state.batches.length, 0);
  assert.deepEqual(external, []);
});
