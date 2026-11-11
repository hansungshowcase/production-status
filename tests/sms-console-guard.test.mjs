import assert from 'node:assert/strict';
import test from 'node:test';
import * as guardModule from '../api/_lib/smsConsoleGuard.js';

// 2026-11-11 사장님 결정: 관리자 비밀번호 잠금 없음. 남은 것은 서버 스위치(SMS_CONSOLE_WRITE=off) 하나.
async function withWriteEnv(value, fn) {
  const old = process.env.SMS_CONSOLE_WRITE;
  if (value == null) delete process.env.SMS_CONSOLE_WRITE; else process.env.SMS_CONSOLE_WRITE = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env.SMS_CONSOLE_WRITE; else process.env.SMS_CONSOLE_WRITE = old; }
}

test('writeStatus: 기본은 켜짐, SMS_CONSOLE_WRITE=off 일 때만 꺼짐(비밀번호 설정과 무관)', async () => {
  await withWriteEnv(null, async () => assert.deepEqual(await guardModule.writeStatus(), { enabled: true, reason: null }));
  await withWriteEnv('off', async () => assert.deepEqual(await guardModule.writeStatus(), { enabled: false, reason: 'disabled' }));
});

test('비밀번호 확인·잠금 함수가 남아 있지 않다', () => {
  for (const name of ['verifyAdminPassword', 'noteFailure', 'isLocked']) assert.equal(guardModule[name], undefined, name);
});
