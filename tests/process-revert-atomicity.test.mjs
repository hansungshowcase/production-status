import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { PROCESS_UNDO_MANAGER } from '../shared/processUndoPermission.js';

const ORDER_ID = 410;
const PROCESS_ID = 9410;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request() {
  return {
    method: 'PATCH',
    query: { id: String(PROCESS_ID) },
    body: { actor: PROCESS_UNDO_MANAGER },
  };
}

function makeDb({
  stepName = '출고',
  status = 'completed',
  atomicRows,
  atomicError,
} = {}) {
  const process = {
    id: PROCESS_ID,
    order_id: ORDER_ID,
    step_name: stepName,
    status,
    started_at: '2026-10-21T00:00:00.000Z',
    completed_at: status === 'completed' ? '2026-10-21T01:00:00.000Z' : null,
  };
  const state = { atomicCalls: [], writesOutsideAtomic: 0 };
  return {
    state,
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (/^(UPDATE|INSERT|DELETE)/i.test(statement)) {
        state.writesOutsideAtomic += 1;
        throw new Error(`write escaped atomicBatch: ${statement}`);
      }
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...process }] };
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') return { rows: [{ ...process }] };
      throw new Error(`unexpected preflight SQL: ${statement}`);
    },
    async atomicBatch(queries) {
      state.atomicCalls.push(queries);
      assert.equal(queries.length, 1);
      const sql = queries[0].sql;
      assert.match(sql, /^WITH claimed_process AS/i);
      assert.match(sql, /UPDATE processes[\s\S]*WHERE p\.id = \?[\s\S]*p\.status =/i);
      assert.match(sql, /reverted_order AS[\s\S]*FROM claimed_process/i);
      assert.match(sql, /deleted_shipping_job AS[\s\S]*FROM reverted_order/i);
      assert.match(sql, /revert_activity AS[\s\S]*FROM claimed_process/i);
      if (atomicError) throw atomicError;
      return [{ rows: atomicRows || [{
        process_row: { ...process, status: status === 'completed' ? 'in_progress' : 'waiting' },
        order_row: { id: ORDER_ID, client_name: '원자 거래처', status: 'in_production', ship_date: null },
        reverted_ship_date: stepName === '출고' && status === 'completed' ? '2026-10-21' : null,
      }] }];
    },
  };
}

function dependencies(db, clearShippedSheet = async () => {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: PROCESS_UNDO_MANAGER }),
    clearShippedSheet,
  };
}

async function run(db, clearShippedSheet) {
  const res = response();
  const previousNow = Date.now;
  Date.now = () => Date.parse('2026-10-21T02:00:00.000Z');
  try {
    await handleRevertProcess(request(), res, dependencies(db, clearShippedSheet));
  } finally {
    Date.now = previousNow;
  }
  return res;
}

test('shipping revert commits process, order, job deletion, and activity in one guarded CTE', async () => {
  const db = makeDb();
  const clearCalls = [];
  const res = await run(db, async (order, shipDate) => clearCalls.push({ order, shipDate }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'in_progress');
  assert.equal(db.state.atomicCalls.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(clearCalls.map((call) => call.shipDate), ['2026-10-21']);
});

test('lost revert CAS returns 409 and invokes no sheet mutation', async () => {
  const db = makeDb({ atomicRows: [] });
  let clearCalls = 0;
  const res = await run(db, async () => { clearCalls += 1; });

  assert.equal(res.statusCode, 409);
  assert.equal(clearCalls, 0);
  assert.equal(db.state.writesOutsideAtomic, 0);
});

test('atomic database failure escapes and invokes no sheet mutation', async () => {
  const db = makeDb({ atomicError: new Error('injected job delete failure') });
  let clearCalls = 0;

  await assert.rejects(run(db, async () => { clearCalls += 1; }), /injected job delete failure/);
  assert.equal(clearCalls, 0);
  assert.equal(db.state.writesOutsideAtomic, 0);
});

test('in-progress revert uses the same guarded CTE without clearing shipment state', async () => {
  const db = makeDb({ stepName: '포장', status: 'in_progress' });
  let clearCalls = 0;
  const res = await run(db, async () => { clearCalls += 1; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'waiting');
  assert.equal(clearCalls, 0);
  assert.equal(db.state.atomicCalls.length, 1);
});
