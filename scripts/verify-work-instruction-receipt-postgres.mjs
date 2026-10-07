import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { createDbAdapter } from '../api/_lib/db.js';
import { runMigrationStatements } from './migrate.js';
import { handleWorkInstructionReceipt } from '../api/orders/[id]/work-instruction-receipt.js';
import { handleStartProcess } from '../api/processes/[id]/start.js';
import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { handleProcessesByStep } from '../api/processes/by-step/[stepName].js';
import {
  WORK_INSTRUCTION_RECEIPT_PENDING_MODE,
  WORK_INSTRUCTION_RECEIVERS,
  hasValidWorkInstructionReceipt,
} from '../shared/workInstructionReceipt.js';

const TEST_URL_ENV = 'WORK_INSTRUCTION_RECEIPT_TEST_URL';
const WRITE_ACK_ENV = 'WORK_INSTRUCTION_RECEIPT_TEST_WRITE_ACK';
const TEST_DATABASE_ENV = 'WORK_INSTRUCTION_RECEIPT_TEST_DATABASE';
const WRITE_ACK = 'ISOLATED_TEST_DATABASE_ONLY';
const EXPECTED_ENDPOINT = 'ep-gentle-cloud-anzarmtw-pooler.c-6.us-east-1.aws.neon.tech';
const MAX_RACE_ATTEMPTS = 3;
const MAX_FIXTURE_ORDERS = 20;
const TOTAL_TIMEOUT_MS = 3 * 60 * 1000;
const RECEIVER = WORK_INSTRUCTION_RECEIVERS[0];
const RECEIPT_ACTION = '작업지시서수령';

function refuse(message) {
  console.error(`Refusing database writes. ${message}`);
  process.exit(2);
}

function databaseFromUrl(value) {
  const parsed = new URL(value);
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]');
}

const testUrl = process.env[TEST_URL_ENV];
const expectedDatabase = String(process.env[TEST_DATABASE_ENV] || '').trim();
const originalPostgresUrl = process.env.POSTGRES_URL;
if (!testUrl || process.env[WRITE_ACK_ENV] !== WRITE_ACK || !expectedDatabase) {
  refuse(
    `Set ${TEST_URL_ENV}, ${TEST_DATABASE_ENV}, and `
    + `${WRITE_ACK_ENV}=${WRITE_ACK} for an authorized isolated test database.`,
  );
}

let parsedTestUrl;
try {
  parsedTestUrl = new URL(testUrl);
} catch {
  refuse(`${TEST_URL_ENV} must be a valid PostgreSQL URL.`);
}
if (!['postgres:', 'postgresql:'].includes(parsedTestUrl.protocol)) {
  refuse(`${TEST_URL_ENV} must use the PostgreSQL protocol.`);
}
if (parsedTestUrl.hostname !== EXPECTED_ENDPOINT) {
  refuse(`${TEST_URL_ENV} does not target the approved production-status Neon endpoint.`);
}
if (expectedDatabase === 'neondb' || !expectedDatabase.startsWith('wi_receipt_test_')) {
  refuse(`${TEST_DATABASE_ENV} must name a generated wi_receipt_test_* database, never neondb.`);
}
if (databaseFromUrl(testUrl) !== expectedDatabase) {
  refuse(`${TEST_URL_ENV} database path does not match ${TEST_DATABASE_ENV}.`);
}
if (originalPostgresUrl && testUrl === originalPostgresUrl) {
  refuse(`${TEST_URL_ENV} must not equal the original POSTGRES_URL.`);
}
if (originalPostgresUrl) {
  try {
    if (databaseFromUrl(originalPostgresUrl) === expectedDatabase) {
      refuse('The original POSTGRES_URL must remain distinct from the isolated test database.');
    }
  } catch {
    refuse('The original POSTGRES_URL is not a valid PostgreSQL URL.');
  }
}

const verificationAbort = new AbortController();
const sql = neon(testUrl, {
  fetchOptions: { signal: verificationAbort.signal },
});
const db = createDbAdapter(sql);
let fixtureOrderCount = 0;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return body;
    },
    end() {
      this.headersSent = true;
    },
  };
}

async function invoke(handler, request, dependencies) {
  const req = {
    method: 'GET',
    url: '/',
    headers: {},
    query: {},
    body: {},
    ...request,
  };
  const res = createResponse();
  await handler(req, res, dependencies);
  return res;
}

async function invokeReceipt(orderId, expectedRevision, actor = RECEIVER) {
  return invoke(handleWorkInstructionReceipt, {
    method: 'PATCH',
    url: `/api/orders/${orderId}/work-instruction-receipt`,
    query: { id: String(orderId) },
    body: { actor, expected_revision: expectedRevision },
  }, { db });
}

async function invokeStart(processId, actor = RECEIVER) {
  let notificationCalls = 0;
  const response = await invoke(handleStartProcess, {
    method: 'PATCH',
    url: `/api/processes/${processId}/start`,
    query: { id: String(processId) },
    body: { actor },
  }, {
    db,
    notifyInternalStart: async () => {
      notificationCalls += 1;
    },
  });
  return { response, notificationCalls };
}

async function invokeRevert(processId, actor = RECEIVER) {
  let sheetClearCalls = 0;
  const response = await invoke(handleRevertProcess, {
    method: 'PATCH',
    url: `/api/processes/${processId}/revert`,
    query: { id: String(processId) },
    body: { actor },
  }, {
    db,
    clearShippedSheet: async () => {
      sheetClearCalls += 1;
    },
  });
  return { response, sheetClearCalls };
}

async function invokeByStep(mode = 'actionable') {
  return invoke(handleProcessesByStep, {
    method: 'GET',
    url: `/api/processes/by-step/${encodeURIComponent('레이저작업')}?mode=${mode}`,
    query: { stepName: encodeURIComponent('레이저작업'), mode },
  }, { db });
}

let statsHandler;
async function invokeStats() {
  if (!statsHandler) {
    ({ default: statsHandler } = await import('../api/stats.js'));
  }
  return invoke(statsHandler, {
    method: 'GET',
    url: '/api/stats',
    query: {},
  });
}

function assertStatus(response, expected, label) {
  assert.equal(
    response.statusCode,
    expected,
    `${label}: ${JSON.stringify(response.body?.error || response.body)}`,
  );
}

async function clearFixtures() {
  await sql.query('TRUNCATE TABLE orders RESTART IDENTITY CASCADE');
}

async function createWorkflow({
  drawingStatus = 'completed',
  laserStatus = 'waiting',
  revision = 0,
  received = false,
} = {}) {
  fixtureOrderCount += 1;
  assert.ok(
    fixtureOrderCount <= MAX_FIXTURE_ORDERS,
    `fixture order limit exceeded: ${fixtureOrderCount}/${MAX_FIXTURE_ORDERS}`,
  );

  const now = new Date().toISOString();
  const [order] = await sql.query(
    `INSERT INTO orders (
       order_date, due_date, sales_person, client_name, product_type, quantity, status,
       work_instruction_revision, work_instruction_received_revision,
       work_instruction_received_at, work_instruction_received_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'in_production', $7, $8, $9, $10)
     RETURNING *`,
    [
      '2026-10-07',
      '2099-12-31',
      '신은철',
      `격리 검증 주문 ${fixtureOrderCount}`,
      '쇼케이스',
      1,
      revision,
      received ? revision : null,
      received ? now : null,
      received ? RECEIVER : null,
    ],
  );

  const processes = await sql.query(
    `INSERT INTO processes (
       order_id, step_name, status, started_at, completed_at, completed_date,
       started_by, completed_by
     ) VALUES
       ($1, '도면설계', $2, $3, $4, $5, $6, $7),
       ($1, '레이저작업', $8, $9, NULL, NULL, $10, NULL)
     RETURNING *`,
    [
      order.id,
      drawingStatus,
      drawingStatus === 'waiting' ? null : now,
      drawingStatus === 'completed' ? now : null,
      drawingStatus === 'completed' ? '2026-10-07' : null,
      drawingStatus === 'waiting' ? null : '김보수 팀장',
      drawingStatus === 'completed' ? '김보수 팀장' : null,
      laserStatus,
      laserStatus === 'in_progress' ? now : null,
      laserStatus === 'in_progress' ? RECEIVER : null,
    ],
  );

  return {
    order,
    drawing: processes.find((row) => row.step_name === '도면설계'),
    laser: processes.find((row) => row.step_name === '레이저작업'),
  };
}

async function loadOrder(orderId) {
  const rows = await sql.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0];
}

async function loadProcess(processId) {
  const rows = await sql.query('SELECT * FROM processes WHERE id = $1', [processId]);
  return rows[0];
}

async function countActions(orderId, actionType) {
  const rows = await sql.query(
    'SELECT COUNT(*)::INTEGER AS count FROM activity_feed WHERE order_id = $1 AND action_type = $2',
    [orderId, actionType],
  );
  return Number(rows[0].count);
}

function assertReceiptCleared(order, message) {
  assert.equal(order.work_instruction_received_revision, null, message);
  assert.equal(order.work_instruction_received_at, null, message);
  assert.equal(order.work_instruction_received_by, null, message);
}

async function verifyConnectionAndSchema() {
  const scopeRows = await sql.query(
    `SELECT current_database() AS database_name,
            current_schema() AS schema_name,
            current_setting('statement_timeout') AS statement_timeout,
            current_setting('lock_timeout') AS lock_timeout`,
  );
  assert.equal(scopeRows[0].database_name, expectedDatabase);
  assert.notEqual(scopeRows[0].database_name, 'neondb');
  assert.equal(scopeRows[0].schema_name, 'public');
  assert.equal(scopeRows[0].statement_timeout, '5s');
  assert.equal(scopeRows[0].lock_timeout, '2s');

  const publicTableRows = await sql.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'`,
  );
  assert.equal(Number(publicTableRows[0].count), 0, 'isolated test database public schema must be empty');

  await runMigrationStatements(sql);
  const receiptMigration = await readFile(
    new URL('../migrations/20261007_work_instruction_receipt.sql', import.meta.url),
    'utf8',
  );
  await sql.query(receiptMigration);

  const columnRows = await sql.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'orders'
        AND column_name LIKE 'work_instruction_%'
      ORDER BY column_name`,
  );
  assert.deepEqual(
    columnRows.map((row) => row.column_name),
    [
      'work_instruction_received_at',
      'work_instruction_received_by',
      'work_instruction_received_revision',
      'work_instruction_revision',
    ],
  );
  const revisionColumn = columnRows.find((row) => row.column_name === 'work_instruction_revision');
  assert.equal(revisionColumn.data_type, 'integer');
  assert.equal(revisionColumn.is_nullable, 'NO');
  assert.match(String(revisionColumn.column_default), /0/);
}

async function verifyAdapterRollback() {
  await sql.query(`CREATE TABLE rollback_probe (
    id INTEGER PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value >= 0)
  )`);
  await sql.query('INSERT INTO rollback_probe (id, value) VALUES (1, 0)');

  await assert.rejects(() => db.atomicBatch([
    { sql: 'UPDATE rollback_probe SET value = 1 WHERE id = ?', args: [1] },
    { sql: 'INSERT INTO rollback_probe (id, value) VALUES (?, ?)', args: [2, -1] },
  ]));

  const rows = await sql.query('SELECT value FROM rollback_probe WHERE id = 1');
  assert.equal(rows[0].value, 0, 'a failed batch must roll back every prior statement');
}

async function verifyActualAuthAndReceiverPolicy() {
  await clearFixtures();
  const workflow = await createWorkflow();

  const missingActor = await invoke(handleWorkInstructionReceipt, {
    method: 'PATCH',
    url: `/api/orders/${workflow.order.id}/work-instruction-receipt`,
    query: { id: String(workflow.order.id) },
    body: { expected_revision: 0 },
  }, { db });
  assertStatus(missingActor, 400, 'actual requireWorkerAction must reject a missing actor');

  const designer = await invokeReceipt(workflow.order.id, 0, '김보수 팀장');
  assertStatus(designer, 403, 'designer must not receive work instructions');

  const receiver = await invokeReceipt(workflow.order.id, 0, '이정섭 부장');
  assertStatus(receiver, 200, 'the explicit receiver must be allowed');
  assert.equal(receiver.body.receipt_valid, true);
}

async function verifyReceiptIdempotency() {
  await clearFixtures();
  const workflow = await createWorkflow();

  const first = await invokeReceipt(workflow.order.id, 0);
  assertStatus(first, 200, 'first receipt');
  assert.equal(first.body.idempotent, false);
  const firstOrder = await loadOrder(workflow.order.id);
  const firstActor = firstOrder.work_instruction_received_by;
  const firstTime = String(firstOrder.work_instruction_received_at);

  const duplicate = await invokeReceipt(workflow.order.id, 0);
  assertStatus(duplicate, 200, 'duplicate receipt');
  assert.equal(duplicate.body.idempotent, true);
  const duplicateOrder = await loadOrder(workflow.order.id);
  assert.equal(duplicateOrder.work_instruction_received_by, firstActor, 'first receipt actor must be preserved');
  assert.equal(String(duplicateOrder.work_instruction_received_at), firstTime, 'first receipt time must be preserved');
  assert.equal(await countActions(workflow.order.id, RECEIPT_ACTION), 1, 'duplicate receipt activity');
}

async function verifyMissingReceiptBlocksStart() {
  await clearFixtures();
  const workflow = await createWorkflow();

  const start = await invokeStart(workflow.laser.id);
  assertStatus(start.response, 409, 'laser start without receipt');
  assert.equal(start.notificationCalls, 0);
  assert.equal((await loadProcess(workflow.laser.id)).status, 'waiting');
  assert.equal(await countActions(workflow.order.id, '공정시작'), 0);
}

async function verifyDrawingRevertAndRevisionCas() {
  await clearFixtures();
  const workflow = await createWorkflow();
  assertStatus(await invokeReceipt(workflow.order.id, 0), 200, 'receipt before drawing revert');

  const reverted = await invokeRevert(workflow.drawing.id);
  assertStatus(reverted.response, 200, 'drawing revert');
  assert.equal(reverted.sheetClearCalls, 0);
  const invalidated = await loadOrder(workflow.order.id);
  assert.equal(Number(invalidated.work_instruction_revision), 1);
  assertReceiptCleared(invalidated, 'drawing revert must invalidate the receipt');

  const receiptFeedBeforeStale = await countActions(workflow.order.id, RECEIPT_ACTION);
  const stale = await invokeReceipt(workflow.order.id, 0);
  assertStatus(stale, 409, 'stale receipt revision');
  assertReceiptCleared(await loadOrder(workflow.order.id), 'stale revision must not write a receipt');
  assert.equal(
    await countActions(workflow.order.id, RECEIPT_ACTION),
    receiptFeedBeforeStale,
    'stale receipt revision must not append activity',
  );

  const now = new Date().toISOString();
  await sql.query(
    `UPDATE processes
        SET status = 'completed', completed_at = $1, completed_date = '2026-10-07', completed_by = '김보수 팀장'
      WHERE id = $2`,
    [now, workflow.drawing.id],
  );
  const current = await invokeReceipt(workflow.order.id, 1);
  assertStatus(current, 200, 'receipt after drawing recompletion');
  assert.equal(current.body.work_instruction_revision, 1);
}

async function verifyLaserRevertPreservesReceipt() {
  await clearFixtures();
  const workflow = await createWorkflow({ received: true });

  const firstStart = await invokeStart(workflow.laser.id);
  assertStatus(firstStart.response, 200, 'first laser start');
  assert.equal(firstStart.notificationCalls, 1);

  const reverted = await invokeRevert(workflow.laser.id);
  assertStatus(reverted.response, 200, 'laser-only revert');
  assert.equal(reverted.sheetClearCalls, 0);
  assert.equal((await loadProcess(workflow.laser.id)).status, 'waiting');
  assert.equal(hasValidWorkInstructionReceipt(await loadOrder(workflow.order.id)), true);

  const restarted = await invokeStart(workflow.laser.id);
  assertStatus(restarted.response, 200, 'laser restart after laser-only revert');
}

async function verifyReceiptFeedRollback() {
  await clearFixtures();
  const workflow = await createWorkflow();
  await sql.query(`CREATE OR REPLACE FUNCTION reject_receipt_feed()
    RETURNS TRIGGER AS $reject_receipt_feed$
    BEGIN
      IF NEW.action_type = '${RECEIPT_ACTION}' THEN
        RAISE EXCEPTION 'isolated receipt feed failure';
      END IF;
      RETURN NEW;
    END;
    $reject_receipt_feed$ LANGUAGE plpgsql`);
  await sql.query(`CREATE TRIGGER reject_receipt_feed_trigger
    BEFORE INSERT ON activity_feed
    FOR EACH ROW EXECUTE FUNCTION reject_receipt_feed()`);

  try {
    const response = await invokeReceipt(workflow.order.id, 0);
    assertStatus(response, 500, 'forced receipt feed failure');
    assertReceiptCleared(
      await loadOrder(workflow.order.id),
      'failed receipt feed must roll back the order update',
    );
    assert.equal(await countActions(workflow.order.id, RECEIPT_ACTION), 0);
  } finally {
    await sql.query('DROP TRIGGER IF EXISTS reject_receipt_feed_trigger ON activity_feed');
    await sql.query('DROP FUNCTION IF EXISTS reject_receipt_feed()');
  }

  await sql.query('CREATE SEQUENCE receipt_serialization_attempts START 1');
  await sql.query(`CREATE OR REPLACE FUNCTION reject_receipt_feed()
    RETURNS TRIGGER AS $reject_receipt_feed$
    BEGIN
      IF NEW.action_type = '${RECEIPT_ACTION}' THEN
        PERFORM nextval('receipt_serialization_attempts');
        RAISE EXCEPTION 'isolated serialization retry exhaustion' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $reject_receipt_feed$ LANGUAGE plpgsql`);
  await sql.query(`CREATE TRIGGER reject_receipt_feed_trigger
    BEFORE INSERT ON activity_feed
    FOR EACH ROW EXECUTE FUNCTION reject_receipt_feed()`);

  try {
    const serializationFailure = await invokeReceipt(workflow.order.id, 0);
    assertStatus(serializationFailure, 409, 'serialization retry exhaustion');
    const serializationAttempts = await sql.query(
      'SELECT last_value FROM receipt_serialization_attempts',
    );
    assert.equal(Number(serializationAttempts[0].last_value), 3);
    assertReceiptCleared(
      await loadOrder(workflow.order.id),
      'serialization retry exhaustion must leave receipt fields untouched',
    );
    assert.equal(await countActions(workflow.order.id, RECEIPT_ACTION), 0);
  } finally {
    await sql.query('DROP TRIGGER IF EXISTS reject_receipt_feed_trigger ON activity_feed');
    await sql.query('DROP FUNCTION IF EXISTS reject_receipt_feed()');
    await sql.query('DROP SEQUENCE IF EXISTS receipt_serialization_attempts');
  }
}

async function verifyQueryConsistency() {
  await clearFixtures();
  const workflow = await createWorkflow();

  const pendingBefore = await invokeByStep(WORK_INSTRUCTION_RECEIPT_PENDING_MODE);
  const actionableBefore = await invokeByStep('actionable');
  const statsBefore = await invokeStats();
  assertStatus(pendingBefore, 200, 'pending query before receipt');
  assertStatus(actionableBefore, 200, 'actionable query before receipt');
  assertStatus(statsBefore, 200, 'stats before receipt');
  assert.deepEqual(pendingBefore.body.map((row) => Number(row.order_id)), [Number(workflow.order.id)]);
  assert.equal(actionableBefore.body.length, 0);
  assert.equal(Number(statsBefore.body.work_instruction_receipt_pending), 1);
  assert.equal(
    Number(statsBefore.body.by_step.find((row) => row.step_name === '레이저작업')?.actionable || 0),
    0,
  );

  assertStatus(await invokeReceipt(workflow.order.id, 0), 200, 'receipt for query transition');
  const pendingAfter = await invokeByStep(WORK_INSTRUCTION_RECEIPT_PENDING_MODE);
  const actionableAfter = await invokeByStep('actionable');
  const statsAfter = await invokeStats();
  assert.equal(pendingAfter.body.length, 0);
  assert.deepEqual(actionableAfter.body.map((row) => Number(row.order_id)), [Number(workflow.order.id)]);
  assert.equal(Number(statsAfter.body.work_instruction_receipt_pending), 0);
  assert.equal(
    Number(statsAfter.body.by_step.find((row) => row.step_name === '레이저작업')?.actionable || 0),
    1,
  );

  const started = await invokeStart(workflow.laser.id);
  assertStatus(started.response, 200, 'laser start for query transition');
  const actionableStarted = await invokeByStep('actionable');
  assert.deepEqual(actionableStarted.body.map((row) => Number(row.order_id)), [Number(workflow.order.id)]);
}

async function verifyLegacyLaserUnaffected() {
  await clearFixtures();
  const workflow = await createWorkflow({ laserStatus: 'in_progress' });

  const actionableActive = await invokeByStep('actionable');
  const pendingActive = await invokeByStep(WORK_INSTRUCTION_RECEIPT_PENDING_MODE);
  const statsActive = await invokeStats();
  assert.deepEqual(
    actionableActive.body.map((row) => Number(row.order_id)),
    [Number(workflow.order.id)],
    'legacy active laser work must remain actionable without a historical receipt',
  );
  assert.equal(pendingActive.body.length, 0);
  assert.equal(Number(statsActive.body.work_instruction_receipt_pending), 0);
  assert.equal(
    Number(statsActive.body.by_step.find((row) => row.step_name === '레이저작업')?.in_progress || 0),
    1,
  );

  await sql.query(
    `UPDATE processes
        SET status = 'completed', completed_at = $1, completed_date = '2026-10-07', completed_by = $2
      WHERE id = $3`,
    [new Date().toISOString(), RECEIVER, workflow.laser.id],
  );
  const actionableCompleted = await invokeByStep('actionable');
  const pendingCompleted = await invokeByStep(WORK_INSTRUCTION_RECEIPT_PENDING_MODE);
  const statsCompleted = await invokeStats();
  assert.equal(actionableCompleted.body.length, 0);
  assert.equal(pendingCompleted.body.length, 0);
  assert.equal(Number(statsCompleted.body.work_instruction_receipt_pending), 0);
  assert.equal(
    Number(statsCompleted.body.by_step.find((row) => row.step_name === '레이저작업')?.completed || 0),
    1,
    'legacy completed laser work must remain in the raw completed aggregate',
  );
}

async function verifyConcurrentReceipt() {
  for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt += 1) {
    await clearFixtures();
    const workflow = await createWorkflow();
    const [left, right] = await Promise.all([invokeReceipt(
      workflow.order.id,
      0,
    ), invokeReceipt(workflow.order.id, 0)]);

    assertStatus(left, 200, `concurrent receipt left ${attempt + 1}`);
    assertStatus(right, 200, `concurrent receipt right ${attempt + 1}`);
    assert.deepEqual(
      [left.body.idempotent, right.body.idempotent].sort((a, b) => Number(a) - Number(b)),
      [false, true],
      'concurrent duplicate receipt must have one writer and one idempotent result',
    );
    assert.equal(hasValidWorkInstructionReceipt(await loadOrder(workflow.order.id)), true);
    assert.equal(await countActions(workflow.order.id, RECEIPT_ACTION), 1, 'duplicate receipt activity');
  }
}

async function verifyReceiptStartRace() {
  for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt += 1) {
    await clearFixtures();
    const workflow = await createWorkflow();
    const [receipt, start] = await Promise.all([invokeReceipt(
      workflow.order.id,
      0,
    ), invokeStart(workflow.laser.id)]);

    assertStatus(receipt, 200, `receipt/start receipt ${attempt + 1}`);
    assert.ok([200, 409].includes(start.response.statusCode));
    const order = await loadOrder(workflow.order.id);
    const laser = await loadProcess(workflow.laser.id);
    assert.equal(hasValidWorkInstructionReceipt(order), true);
    if (laser.status === 'in_progress') {
      assert.equal(start.response.statusCode, 200);
    } else {
      assert.equal(laser.status, 'waiting');
      assert.equal(start.response.statusCode, 409);
    }
    assert.equal(await countActions(workflow.order.id, RECEIPT_ACTION), 1);
    assert.ok(await countActions(workflow.order.id, '공정시작') <= 1);
  }
}

async function verifyReceiptRevertRace() {
  for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt += 1) {
    await clearFixtures();
    const workflow = await createWorkflow();
    const [receipt, revert] = await Promise.all([invokeReceipt(
      workflow.order.id,
      0,
    ), invokeRevert(workflow.drawing.id)]);

    assert.ok([200, 409].includes(receipt.statusCode));
    assertStatus(revert.response, 200, `receipt/revert revert ${attempt + 1}`);
    const order = await loadOrder(workflow.order.id);
    assert.equal(Number(order.work_instruction_revision), 1);
    assertReceiptCleared(order, 'receipt/revert race must finish invalidated');
    assert.ok(await countActions(workflow.order.id, RECEIPT_ACTION) <= 1);
  }
}

async function verifyStartRevertRace() {
  for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt += 1) {
    await clearFixtures();
    const workflow = await createWorkflow({ received: true });
    const [start, revert] = await Promise.all([invokeStart(
      workflow.laser.id,
    ), invokeRevert(workflow.drawing.id)]);

    const order = await loadOrder(workflow.order.id);
    const drawing = await loadProcess(workflow.drawing.id);
    const laser = await loadProcess(workflow.laser.id);
    if (laser.status === 'in_progress') {
      assertStatus(start.response, 200, `start/revert start-wins ${attempt + 1}`);
      assertStatus(revert.response, 400, `start/revert revert-blocked ${attempt + 1}`);
      assert.equal(drawing.status, 'completed');
      assert.equal(hasValidWorkInstructionReceipt(order), true);
    } else {
      assert.equal(laser.status, 'waiting');
      assertStatus(start.response, 409, `start/revert start-blocked ${attempt + 1}`);
      assertStatus(revert.response, 200, `start/revert revert-wins ${attempt + 1}`);
      assert.equal(drawing.status, 'in_progress');
      assert.equal(Number(order.work_instruction_revision), 1);
      assertReceiptCleared(order, 'start/revert revert winner must invalidate receipt');
    }
    assert.ok(await countActions(workflow.order.id, '공정시작') <= 1);
  }
}

async function runVerification() {
  await verifyConnectionAndSchema();
  process.env.POSTGRES_URL = testUrl;

  await verifyAdapterRollback();
  await verifyActualAuthAndReceiverPolicy();
  await verifyReceiptIdempotency();
  await verifyMissingReceiptBlocksStart();
  await verifyDrawingRevertAndRevisionCas();
  await verifyLaserRevertPreservesReceipt();
  await verifyReceiptFeedRollback();
  await verifyQueryConsistency();
  await verifyLegacyLaserUnaffected();
  await verifyConcurrentReceipt();
  await verifyReceiptStartRace();
  await verifyReceiptRevertRace();
  await verifyStartRevertRace();

  assert.ok(fixtureOrderCount <= MAX_FIXTURE_ORDERS);
  console.log(
    `PASS: isolated PostgreSQL actual schema/handler/adapter verification `
    + `(${fixtureOrderCount} fixture orders)`,
  );
}

let timeoutId;
try {
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      verificationAbort.abort();
      reject(new Error('isolated PostgreSQL verification exceeded 3 minutes'));
    }, TOTAL_TIMEOUT_MS);
    timeoutId.unref?.();
  });
  await Promise.race([runVerification(), timeout]);
} catch (error) {
  console.error(`FAIL: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeoutId);
  if (originalPostgresUrl === undefined) {
    delete process.env.POSTGRES_URL;
  } else {
    process.env.POSTGRES_URL = originalPostgresUrl;
  }
}
