// 켜짐 실제 판정(서버 쪽, 2026-11-18): auto_status 응답의 새 필드와 건너뜀 사유 기록. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음).
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventStatus, runEventSend } from '../api/_lib/smsEventSend.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z');
const ENV = { SMS_SENDER: '0212345678' };
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); };

function fakeDb({ rows7 = [] } = {}) {
  const state = { sql: [], skips: [], clears: 0, nextId: 1, sends: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint') || t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.startsWith('SELECT status, COUNT(*) AS n, MAX(kst_date)')) return { rows: [{ status: 'sent', n: 5, last: '2026-11-19' }] };
      if (t.startsWith('SELECT status, COUNT(*) AS n FROM sms_event_sends') && t.includes('GROUP BY status')) return { rows: rows7 };
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = ?')) { state.skips.push({ why: args[0], id: args[1] }); return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = NULL WHERE id = ?')) { state.skipClears = (state.skipClears || 0) + 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = NULL, auto_skip_reason = NULL')) { state.clears += 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_paused_at')) return { rows: [{ id: args[1] }] };
      return { rows: [] };
    },
  };
}
const tpl = (extra = {}) => ({ id: 41, name: '시험', body: '안녕하세요 #{고객명}님', images: [], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'KA01TP1', auto_bms: '', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_catchup_from: '', auto_catchup_at: '', auto_enabled_at: new Date(NOW - 3600000).toISOString(), auto_skip_reason: '', auto_ata_fail_at: '', ...extra });

test('eventStatus 응답에 실제 발송 판정 필드가 있다', async () => {
  reset();
  const db = fakeDb({ rows7: [{ status: 'sent', n: 2 }, { status: 'failed', n: 9 }] });
  const out = await eventStatus(db, tpl({ auto_skip_reason: '잔액 부족: 필요 300원, 잔액 250원' }), { nowMs: NOW, env: ENV });
  for (const key of ['effective', 'blocked', 'no_provider', 'ata_backoff', 'failed_7d', 'auto_skip_reason']) assert.ok(key in out.body, key);
  assert.equal(out.body.failed_7d, 9); assert.equal(out.body.sent_7d, 2);
  assert.equal(out.body.auto_skip_reason, '잔액 부족: 필요 300원, 잔액 250원');
  assert.equal(out.body.effective, false); assert.ok(out.body.blocked);
  assert.equal(typeof out.body.no_provider, 'boolean');
});

test('eventStatus: 연속 실패 쉼 중이면 ata_backoff, 꺼져 있으면 effective 아님', async () => {
  reset();
  const future = new Date(NOW + 3600000).toISOString();
  const out = await eventStatus(fakeDb(), tpl({ auto_ata_fail_at: future }), { nowMs: NOW, env: ENV });
  assert.equal(out.body.ata_backoff, true);
  reset();
  const off = await eventStatus(fakeDb(), tpl({ auto_enabled: false }), { nowMs: NOW, env: ENV });
  assert.equal(off.body.effective, false); assert.equal(off.body.blocked, '');
});

test('eventStatus: 7일 집계는 쿼리 1번(GROUP BY)이다', async () => {
  reset();
  const db = fakeDb();
  await eventStatus(db, tpl(), { nowMs: NOW, env: ENV });
  assert.equal(db.state.sql.filter(s => s.includes('FROM sms_event_sends') && s.includes('kst_date >= ?') && s.includes('GROUP BY status')).length, 1);
});

test('제공사 없음으로 건너뛰면 사유가 DB 에 1번 기록된다', async () => {
  reset();
  const db = fakeDb();
  const out = await runEventSend(tpl(), { db, provider: null, env: {}, nowMs: NOW, warn: () => {} });
  assert.equal(out.reason, 'no_provider');
  assert.deepEqual(db.state.skips, [{ why: '발송 업체 설정 없음', id: 41 }]);
});

test('제공사 확인을 통과하면 남은 건너뜀 사유를 지운다(1회)', async () => {
  reset();
  const db = fakeDb();
  const provider = { sendKakaoEach: async () => [], sendEach: async () => [] };
  await runEventSend(tpl({ auto_skip_reason: '발송 업체 설정 없음' }), { db, provider, env: ENV, nowMs: NOW, warn: () => {} });
  assert.equal(db.state.skipClears, 1);
  reset();
  const db2 = fakeDb();
  await runEventSend(tpl({ auto_skip_reason: '' }), { db: db2, provider, env: ENV, nowMs: NOW, warn: () => {} });
  assert.equal(db2.state.skipClears || 0, 0);
});
