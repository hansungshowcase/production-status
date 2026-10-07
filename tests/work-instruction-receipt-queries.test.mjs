import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { handleProcessesByStep } from '../api/processes/by-step/[stepName].js';
import { handleGet as handleOrdersGet } from '../api/orders/index.js';

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

function recordingDb(rows = []) {
  const statements = [];
  return {
    statements,
    async execute(query) {
      statements.push(query);
      if (/SELECT COUNT\(\*\) AS count FROM orders o/i.test(query.sql)) {
        return { rows: [{ count: rows.length }] };
      }
      return { rows };
    },
  };
}

test('레이저 기본 조회는 유효 수령 waiting과 기존 in_progress만 실제 작업 목록에 둔다', async () => {
  const db = recordingDb([]);
  const res = response();
  await handleProcessesByStep({
    method: 'GET',
    query: { stepName: encodeURIComponent('레이저작업') },
  }, res, { db });

  assert.equal(res.statusCode, 200);
  const query = db.statements[0].sql;
  assert.match(query, /p\.status = 'in_progress'[\s\S]*work_instruction_received_revision = o\.work_instruction_revision/i);
  assert.match(query, /work_instruction_received_at IS NOT NULL/i);
  assert.match(query, /work_instruction_received_by/i);
});

test('별도 수령 대기 조회는 도면 완료·레이저 단일 waiting·미수령·무후속진행을 모두 요구한다', async () => {
  const db = recordingDb([]);
  const res = response();
  await handleProcessesByStep({
    method: 'GET',
    query: {
      stepName: encodeURIComponent('레이저작업'),
      mode: 'work_instruction_receipt_pending',
    },
  }, res, { db });

  assert.equal(res.statusCode, 200);
  const query = db.statements[0].sql;
  assert.match(query, /p\.status = 'waiting'/i);
  assert.match(query, /p_draw\.step_name = '도면설계'/i);
  assert.match(query, /COUNT\(\*\)[\s\S]*p_laser[\s\S]*p_laser\.step_name = '레이저작업'/i);
  assert.match(query, /NOT COALESCE\(\([\s\S]*work_instruction_received_revision = o\.work_instruction_revision[\s\S]*FALSE\)/i);
  assert.match(query, /p_after\.status IN \('in_progress', 'completed'\)/i);
  assert.match(query, /o\.status = 'in_production'/i);
});

test('수령 대기 모드는 레이저 공정 외에는 허용하지 않는다', async () => {
  const db = recordingDb([]);
  const res = response();
  await handleProcessesByStep({
    method: 'GET',
    query: {
      stepName: encodeURIComponent('도면설계'),
      mode: 'work_instruction_receipt_pending',
    },
  }, res, { db });

  assert.equal(res.statusCode, 400);
  assert.equal(db.statements.length, 0);
});

test('주문 목록 SELECT는 수령 네 필드를 명시적으로 공급한다', async () => {
  const db = recordingDb([]);
  const res = response();
  await handleOrdersGet({ method: 'GET', query: { limit: '20', offset: '0' } }, res, db);

  assert.equal(res.statusCode, 200);
  const query = db.statements[0].sql;
  assert.match(query, /o\.work_instruction_revision/i);
  assert.match(query, /o\.work_instruction_received_revision/i);
  assert.match(query, /o\.work_instruction_received_at/i);
  assert.match(query, /o\.work_instruction_received_by/i);
});

test('통계는 기존 raw 집계명을 보존하면서 레이저 actionable에서 미수령을 빼고 pending 수를 분리한다', async () => {
  const source = await readFile(new URL('../api/stats.js', import.meta.url), 'utf8');

  assert.match(source, /process_stats:\s*\{\s*waiting,\s*in_progress,\s*completed\s*\}/);
  assert.match(source, /work_instruction_receipt_pending/);
  assert.match(source, /p\.step_name != '레이저작업'[\s\S]*work_instruction_received_revision = o\.work_instruction_revision/);
  assert.match(source, /AS work_instruction_receipt_pending/);
  assert.match(source, /NOT COALESCE\(\([\s\S]*work_instruction_received_revision = o\.work_instruction_revision[\s\S]*FALSE\)/);
});
