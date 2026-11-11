import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetGuardForTest, isLocked, noteFailure, verifyAdminPassword, writeStatus } from '../api/_lib/smsConsoleGuard.js';

function withEnv(values, fn) {
  const old = {};
  for (const k of Object.keys(values)) { old[k] = process.env[k]; if (values[k] == null) delete process.env[k]; else process.env[k] = values[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}
const dbWith = rows => ({ calls: 0, async execute() { this.calls += 1; return { rows }; } });

test('writeStatus: off 스위치·비밀번호 없음·환경 비밀번호·DB 관리자', async () => {
  await withEnv({ SMS_CONSOLE_WRITE: 'off', ADMIN_PASSWORD: 'x' }, async () => {
    _resetGuardForTest();
    assert.deepEqual(await writeStatus({ db: dbWith([]), nowMs: 1 }), { enabled: false, reason: 'disabled' });
  });
  await withEnv({ SMS_CONSOLE_WRITE: null, ADMIN_PASSWORD: null }, async () => {
    _resetGuardForTest();
    assert.deepEqual(await writeStatus({ db: dbWith([]), nowMs: 1 }), { enabled: false, reason: 'no_admin_password' });
    _resetGuardForTest();
    const failing = { async execute() { throw new Error('db down'); } };
    assert.equal((await writeStatus({ db: failing, nowMs: 1 })).enabled, false);
    _resetGuardForTest();
    const db = dbWith([{ ok: 1 }]);
    assert.equal((await writeStatus({ db, nowMs: 1000 })).enabled, true);
    await writeStatus({ db, nowMs: 2000 });
    assert.equal(db.calls, 1, '5분 캐시');
    await writeStatus({ db, nowMs: 1000 + 5 * 60 * 1000 + 1 });
    assert.equal(db.calls, 2);
  });
  await withEnv({ SMS_CONSOLE_WRITE: null, ADMIN_PASSWORD: 'secret' }, async () => {
    _resetGuardForTest();
    assert.deepEqual(await writeStatus({ db: dbWith([]), nowMs: 1 }), { enabled: true, reason: null });
  });
});

test('verifyAdminPassword: 맞음·틀림·빈값·200자 초과', async () => {
  await withEnv({ ADMIN_PASSWORD: 'secret-pw' }, async () => {
    const db = { async execute() { return { rows: [] }; } };
    assert.equal(await verifyAdminPassword('secret-pw', { db }), true);
    assert.equal(await verifyAdminPassword('wrong', { db }), false);
    assert.equal(await verifyAdminPassword('', { db }), false);
    assert.equal(await verifyAdminPassword(undefined, { db }), false);
    assert.equal(await verifyAdminPassword('a'.repeat(201), { db }), false);
  });
});

test('noteFailure/isLocked: 10회 틀리면 10분 잠금, 시간이 지나면 풀림, IP 별 독립', () => {
  _resetGuardForTest();
  const t = 1_000_000;
  for (let i = 0; i < 9; i += 1) noteFailure('1.1.1.1', t + i);
  assert.equal(isLocked('1.1.1.1', t + 10), false);
  noteFailure('1.1.1.1', t + 10);
  assert.equal(isLocked('1.1.1.1', t + 11), true);
  assert.equal(isLocked('2.2.2.2', t + 11), false);
  assert.equal(isLocked('1.1.1.1', t + 10 + 10 * 60 * 1000 + 1), false);
});

test('noteFailure: 10분 밖의 실패는 세지 않음', () => {
  _resetGuardForTest();
  for (let i = 0; i < 9; i += 1) noteFailure('3.3.3.3', i);
  noteFailure('3.3.3.3', 11 * 60 * 1000);
  assert.equal(isLocked('3.3.3.3', 11 * 60 * 1000 + 1), false);
});

test('여러 IP 를 합쳐 10분에 30회 틀리면 처음 보는 IP 도 잠긴다(전체 잠금 10분)', async () => {
  const guardMod = await import('../api/_lib/smsConsoleGuard.js');
  guardMod._resetGuardForTest();
  const t0 = Date.parse('2026-11-11T03:00:00Z');
  for (let i = 0; i < 29; i += 1) guardMod.noteFailure(`10.0.0.${i}`, t0 + i);
  assert.equal(guardMod.isLocked('8.8.8.8', t0 + 100), false);
  guardMod.noteFailure('10.0.1.1', t0 + 200);
  assert.equal(guardMod.isLocked('8.8.8.8', t0 + 300), true);
  assert.equal(guardMod.isLocked('8.8.8.8', t0 + 200 + 10 * 60 * 1000 + 1), false);
  guardMod._resetGuardForTest();
});
