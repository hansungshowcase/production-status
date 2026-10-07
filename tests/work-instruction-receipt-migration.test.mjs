import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../migrations/20261007_work_instruction_receipt.sql', import.meta.url);

test('작업지시서 수령 마이그레이션은 네 열만 추가하고 이력 수령자를 채우지 않는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /work_instruction_revision\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/i);
  assert.match(sql, /work_instruction_received_revision\s+INTEGER/i);
  assert.match(sql, /work_instruction_received_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /work_instruction_received_by\s+TEXT/i);
  assert.doesNotMatch(sql, /UPDATE\s+orders/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO/i);
});
