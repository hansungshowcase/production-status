// [내 번호로 시험]: 수단이 알림톡이면 알림톡으로 1건, 승인 전이면 0건·안내 문구, 문자 수단은 기존 그대로. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음).
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, autoTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z');
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 구글 리뷰 안내드립니다.';

function fakeDb(template) {
  const state = { manual: [] };
  const row = { id: 7, name: '리뷰 안내', body: BODY, image: null, images: '[]', auto_kind: 'ship_plus_days', auto_days: 3, auto_enabled: false, auto_start_date: '', auto_msg_type: 'info', auto_audience: 'customer', ...template };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t) || t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind')) return { rows: args[0] === row.id ? [row] : [] };
      if (t.includes('FROM sms_manual_sends WHERE sent_at')) return { rows: [{ n: 0 }] };
      if (t.startsWith('INSERT INTO sms_manual_sends')) { state.manual.push({ idem_key: args[0], msg_type: args[1], recipient_count: args[2] }); return { rows: [{ id: state.manual.length }] }; }
      if (t.startsWith('UPDATE sms_manual_sends')) return { rows: [] };
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function fakeProvider() {
  const calls = { each: [], kakao: [] };
  return {
    calls,
    estimate: () => ({ unit: 45, total: 45 }),
    estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }),
    async uploadImage() { return { fileId: 'F1' }; },
    async sendEach(input) { calls.each.push(input); return { accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' }; },
    async sendKakaoEach(input) { calls.kakao.push(input); return { accepted: input.messages.length, failed: 0, groupId: 'K1', uncertain: false, error: '' }; },
  };
}
const fakeKakao = (status = 'APPROVED') => ({ async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status, variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' } }; } });
const reset = () => { _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); };
const body = { id: 7, to: '010-1234-4237', idempotencyKey: 'key-ata-0001' };

test('내 번호로 시험: 알림톡 수단이면 sendKakaoEach 로 1건(문자 발송기는 호출 안 됨), 확인 줄도 알림톡', async () => {
  reset();
  const provider = fakeProvider();
  const deps = { db: fakeDb({ auto_ata_template: 'KA01TP1' }), provider, env: ENV, nowMs: NOW, kakao: fakeKakao() };
  const dry = await autoTest({ ...body, dry_run: true }, deps);
  assert.deepEqual({ ata: dry.body.ata, parts: dry.body.parts, cost: dry.body.cost }, { ata: true, parts: 1, cost: 13 });
  assert.equal(provider.calls.kakao.length, 0);
  const sent = await autoTest(body, deps);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.part_status, ['sent']);
  assert.equal(provider.calls.each.length, 0);
  assert.equal(provider.calls.kakao.length, 1);
  const call = provider.calls.kakao[0];
  assert.deepEqual([call.from, call.pfId, call.disableSms], ['0212345678', 'PF1', true]);
  assert.deepEqual(call.messages, [{ to: '01012344237', templateId: 'KA01TP1', variables: { 고객명: '고객' } }]);
  assert.deepEqual(deps.db.state.manual.map(r => [r.msg_type, r.recipient_count]), [['ATA', 1]]);
});

test('내 번호로 시험: 알림톡이 승인 전이면 0건 발송하고 안내 문구', async () => {
  reset();
  const provider = fakeProvider();
  const deps = { db: fakeDb({ auto_ata_template: 'KA01TP1' }), provider, env: ENV, nowMs: NOW, kakao: fakeKakao('REQUESTED') };
  for (const input of [{ ...body, dry_run: true }, body]) {
    const out = await autoTest(input, deps);
    assert.equal(out.status, 400);
    assert.equal(out.body.error.message, '카카오 승인 전에는 알림톡 시험을 보낼 수 없습니다(현재 상태: REQUESTED).');
  }
  assert.equal(provider.calls.kakao.length + provider.calls.each.length, 0);
  assert.equal(deps.db.state.manual.length, 0);
});

test('내 번호로 시험: 문자 수단은 기존처럼 문자로만 나간다', async () => {
  reset();
  const provider = fakeProvider();
  const deps = { db: fakeDb({}), provider, env: ENV, nowMs: NOW, kakao: fakeKakao() };
  const dry = await autoTest({ ...body, dry_run: true }, deps);
  assert.equal(dry.body.ata, undefined);
  const sent = await autoTest(body, deps);
  assert.deepEqual(sent.body.part_status, ['sent']);
  assert.equal(provider.calls.each.length, 1);
  assert.equal(provider.calls.each[0].messages[0].text, BODY.replace('#{고객명}', '고객'));
  assert.equal(provider.calls.kakao.length, 0);
});
