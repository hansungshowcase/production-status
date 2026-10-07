import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runnerUrl = new URL('../scripts/verify-work-instruction-receipt-postgres.mjs', import.meta.url);
const runnerPath = fileURLToPath(runnerUrl);
const source = await readFile(runnerUrl, 'utf8');

test('격리 PostgreSQL runner는 명시적 URL·쓰기 승인·DB 이름 없이는 fail closed 한다', () => {
  const env = { ...process.env };
  delete env.WORK_INSTRUCTION_RECEIPT_TEST_URL;
  delete env.WORK_INSTRUCTION_RECEIPT_TEST_WRITE_ACK;
  delete env.WORK_INSTRUCTION_RECEIPT_TEST_DATABASE;
  delete env.POSTGRES_URL;

  const result = spawnSync(process.execPath, [runnerPath], { env, encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing database writes/);
  assert.doesNotMatch(result.stderr, /postgres(?:ql)?:\/\//i);
});

test('runner는 production-status endpoint와 빈 격리 DB public schema·timeout을 교차 검증한다', () => {
  assert.match(source, /WORK_INSTRUCTION_RECEIPT_TEST_URL/);
  assert.match(source, /WORK_INSTRUCTION_RECEIPT_TEST_WRITE_ACK/);
  assert.match(source, /ISOLATED_TEST_DATABASE_ONLY/);
  assert.match(source, /WORK_INSTRUCTION_RECEIPT_TEST_DATABASE/);
  assert.match(source, /ep-gentle-cloud-anzarmtw-pooler\.c-6\.us-east-1\.aws\.neon\.tech/);
  assert.match(source, /current_database\(\)/);
  assert.match(source, /current_schema\(\)/);
  assert.match(source, /scopeRows\[0\]\.schema_name, 'public'/);
  assert.match(source, /table_schema = 'public'/);
  assert.match(source, /Number\(publicTableRows\[0\]\.count\), 0/);
  assert.match(source, /expectedDatabase === 'neondb'/);
  assert.match(source, /expectedDatabase\.startsWith\('wi_receipt_test_'\)/);
  assert.match(source, /scopeRows\[0\]\.statement_timeout, '5s'/);
  assert.match(source, /scopeRows\[0\]\.lock_timeout, '2s'/);
  assert.match(source, /TOTAL_TIMEOUT_MS = 3 \* 60 \* 1000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /fetchOptions:\s*\{\s*signal:/);
  assert.match(source, /verificationAbort\.abort\(\)/);
  assert.match(source, /timeoutId\.unref/);
  assert.doesNotMatch(source, /testUrl\s*=\s*process\.env\.POSTGRES_URL/);
  assert.match(source, /testUrl === originalPostgresUrl/);
  assert.doesNotMatch(source, /search_path=/);
  assert.doesNotMatch(source, /CREATE SCHEMA/);
  assert.doesNotMatch(source, /DROP SCHEMA/);
});

test('runner는 실제 schema migration과 실제 receipt/start/revert/by-step/stats handler를 실행한다', () => {
  assert.match(source, /runMigrationStatements/);
  assert.match(source, /20261007_work_instruction_receipt\.sql/);
  assert.match(source, /handleWorkInstructionReceipt/);
  assert.match(source, /handleStartProcess/);
  assert.match(source, /handleRevertProcess/);
  assert.match(source, /handleProcessesByStep/);
  assert.match(source, /api\/stats\.js/);
  assert.match(source, /createDbAdapter/);
  assert.doesNotMatch(source, /CREATE TABLE[^`]*workflow/is);
  assert.doesNotMatch(source, /CREATE TABLE[^`]*\.feed/is);
  assert.doesNotMatch(source, /requireWorkerAction\s*:/);
  assert.match(source, /notifyInternalStart:\s*async/);
  assert.match(source, /clearShippedSheet:\s*async/);
});

test('runner는 실제 rollback·멱등·CAS·권한·race·조회 일관성을 bounded하게 검증한다', () => {
  assert.match(source, /MAX_RACE_ATTEMPTS = 3/);
  assert.match(source, /MAX_FIXTURE_ORDERS = 20/);
  assert.match(source, /Promise\.all\(\[invokeReceipt/);
  assert.match(source, /Promise\.all\(\[invokeReceipt[\s\S]*invokeStart/);
  assert.match(source, /Promise\.all\(\[invokeReceipt[\s\S]*invokeRevert/);
  assert.match(source, /Promise\.all\(\[invokeStart[\s\S]*invokeRevert/);
  assert.match(source, /first receipt actor must be preserved/);
  assert.match(source, /first receipt time must be preserved/);
  assert.match(source, /stale revision must not write a receipt/);
  assert.match(source, /failed receipt feed must roll back the order update/);
  assert.match(source, /ERRCODE = '40001'/);
  assert.match(source, /CREATE SEQUENCE receipt_serialization_attempts/);
  assert.match(source, /serialization retry exhaustion/);
  assert.match(source, /serializationAttempts\[0\]\.last_value/);
  assert.match(source, /assertStatus\(serializationFailure, 409/);
  assert.match(source, /duplicate receipt activity/);
  assert.match(source, /work_instruction_receipt_pending/);
  assert.match(source, /verifyLegacyLaserUnaffected/);
  assert.match(source, /left\.body\.idempotent/);
  assert.doesNotMatch(source, /process\.env\.(?:AUTH_REQUIRED|SALES_PASSWORD|ADMIN_PASSWORD)\s*=/);
  assert.match(source, /김보수 팀장/);
  assert.match(source, /이정섭 부장/);
});
