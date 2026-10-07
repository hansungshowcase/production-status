import assert from 'node:assert/strict';
import test from 'node:test';

import { createDbAdapter } from '../api/_lib/db.js';

function makeNeonSql({ serializationFailures = 0 } = {}) {
  const calls = [];
  const sql = {
    async query(text, args) {
      return [{ text, args }];
    },
    async transaction(buildQueries, options) {
      const transactionQueries = buildQueries({
        query(text, args) {
          return { text, args };
        },
      });
      calls.push({ transactionQueries, options });
      if (calls.length <= serializationFailures) {
        const error = new Error('could not serialize access due to concurrent update');
        error.code = '40001';
        throw error;
      }
      return transactionQueries.map((query, index) => [{ index, ...query }]);
    },
  };
  return { sql, calls };
}

test('atomicBatch는 물음표 쿼리를 실제 Neon Serializable 단일 트랜잭션에 순서대로 제출한다', async () => {
  const neon = makeNeonSql();
  const db = createDbAdapter(neon.sql);

  const results = await db.atomicBatch([
    { sql: 'SELECT * FROM orders WHERE id = ? FOR UPDATE', args: [17] },
    { sql: 'UPDATE orders SET work_instruction_revision = ? WHERE id = ?', args: [3, 17] },
  ]);

  assert.equal(neon.calls.length, 1);
  assert.deepEqual(neon.calls[0].options, { isolationLevel: 'Serializable' });
  assert.deepEqual(neon.calls[0].transactionQueries, [
    { text: 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', args: [17] },
    { text: 'UPDATE orders SET work_instruction_revision = $1 WHERE id = $2', args: [3, 17] },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].rows[0].index, 0);
});

test('직렬화 충돌은 제한 횟수 안에서 전체 배치를 다시 실행한다', async () => {
  const neon = makeNeonSql({ serializationFailures: 2 });
  const db = createDbAdapter(neon.sql);

  const results = await db.atomicBatch([{ sql: 'SELECT ? AS value', args: [1] }]);

  assert.equal(neon.calls.length, 3);
  assert.equal(results[0].rows[0].index, 0);
});

test('직렬화 충돌이 세 번 계속되면 부분 성공 없이 409 충돌로 끝낸다', async () => {
  const neon = makeNeonSql({ serializationFailures: 3 });
  const db = createDbAdapter(neon.sql);

  await assert.rejects(
    () => db.atomicBatch([{ sql: 'UPDATE orders SET updated_at = NOW() WHERE id = ?', args: [17] }]),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.publicMessage, /다른 작업/);
      return true;
    },
  );
  assert.equal(neon.calls.length, 3);
});

test('기존 transaction 호환 래퍼는 그대로 유지한다', async () => {
  const neon = makeNeonSql();
  const db = createDbAdapter(neon.sql);
  const tx = await db.transaction('write');

  assert.equal(typeof tx.execute, 'function');
  assert.equal(typeof tx.commit, 'function');
  assert.equal(typeof tx.rollback, 'function');
});
