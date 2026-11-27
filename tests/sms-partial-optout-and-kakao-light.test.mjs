import assert from 'node:assert/strict';
import test from 'node:test';
import { getSendProvider } from '../api/_lib/sendProvider.js';
import {
  _resetAutoSchemaForTest,
  autoStatus,
  phoneHash,
  reconcilePartialAutoSends,
  runAutoSend,
} from '../api/_lib/smsAutoSend.js';
import { _resetEventSchemaForTest, runEventSend } from '../api/_lib/smsEventSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { ataLightState } from '../src/components/smsconsole/templateListModel.js';
import { handleCompleteProcess } from '../api/processes/[id]/complete.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';

const NOW = Date.parse('2026-11-27T03:35:00Z'); // KST 2026-11-27 12:35
const ENV = { SMS_SENDER: '0212345678', SMS_PART_DELAY_MS: '0' };
const AD_BODY = '(광고) 한성쇼케이스 #{고객명}님 안내\n무료수신거부 080-880-0080';

function makeAutoDb({ orders = [], sends = [], template = {} } = {}) {
  const tpl = {
    id: 21,
    name: 'SNS 리뷰 이벤트(출고+3일)',
    body: AD_BODY,
    image: null,
    images: JSON.stringify(['IMG1', 'IMG2']),
    auto_kind: 'ship_plus_days',
    auto_days: 3,
    auto_enabled: true,
    auto_start_date: '2026-11-20',
    auto_repeat: 2,
    auto_interval: 30,
    auto_msg_type: 'ad',
    auto_copy_to: '01077314237',
    ...template,
  };
  const state = {
    tpl,
    orders: [...orders],
    sends: [...sends],
    optouts: [],
    optoutRows: [],
    skips: [],
    failMark: 0,
    copyDate: '',
    nextId: sends.length + 1,
  };
  return {
    state,
    async execute({ sql, args = [] }) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind')) {
        return { rows: args[0] === state.tpl.id ? [state.tpl] : [] };
      }
      if (t.includes('FROM orders')) {
        return {
          rows: state.orders
            .filter(o => o.status === 'shipped' && o.ship_date >= args[0] && o.ship_date <= args[1])
            .map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date })),
        };
      }
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) {
        return { rows: state.optouts.map(h => ({ phone_hash: h })) };
      }
      if (t.startsWith('INSERT INTO sms_optouts')) {
        if (state.optouts.includes(args[0])) return { rows: [] };
        state.optouts.push(args[0]);
        state.optoutRows.push({ id: state.optouts.length, phone_last4: args[1] });
        return { rows: [{ id: state.optouts.length }] };
      }
      if (t.startsWith('SELECT phone_hash, order_id')) {
        return { rows: state.sends.filter(r => r.template_id === args[0]) };
      }
      if (t.startsWith('SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date')) {
        return { rows: state.sends.filter(r => r.kst_date === args[0] && r.status !== 'failed').map(r => ({ phone_hash: r.phone_hash })) };
      }
      if (t.startsWith('SELECT DISTINCT e.phone_hash FROM sms_event_sends')) return { rows: [] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date')) {
        return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && r.kind !== 'catchup').length }] };
      }
      if (t.startsWith("DELETE FROM sms_auto_sends WHERE template_id = ? AND status = 'failed'")) {
        const n = (args.length - 1) / 2;
        const hs = args.slice(1, 1 + n);
        const os = args.slice(1 + n);
        state.sends = state.sends.filter(r => !(r.template_id === args[0] && r.status === 'failed' && (hs.includes(r.phone_hash) || os.includes(r.order_id))));
        return { rows: [] };
      }
      if (t.startsWith('INSERT INTO sms_auto_sends')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 7) {
          const [template_id, phone_hash, phone_last4, order_id, ship_date, kst_date, round] = args.slice(i, i + 7);
          if (state.sends.some(r => r.template_id === template_id && (r.round || 1) === round && (r.phone_hash === phone_hash || r.order_id === order_id))) continue;
          const row = { id: state.nextId++, template_id, phone_hash, phone_last4, order_id, ship_date, kst_date, status: 'claimed', round };
          state.sends.push(row);
          rows.push({ id: row.id, phone_hash, round });
        }
        return { rows };
      }
      if (t.startsWith("DELETE FROM sms_auto_sends WHERE status = 'claimed'")) {
        state.sends = state.sends.filter(r => !args.includes(r.id));
        return { rows: [] };
      }
      if (t.startsWith('UPDATE sms_auto_sends SET status = ?, part_status')) {
        const [status, part_status, reason, group_ids, ...ids] = args;
        for (const r of state.sends.filter(x => ids.includes(x.id))) {
          Object.assign(r, { status, part_status, reason, group_ids });
        }
        return { rows: [] };
      }
      if (t.startsWith("SELECT id, phone_hash, group_ids, part_status FROM sms_auto_sends WHERE status = 'uncertain'")) {
        return { rows: state.sends.filter(r => r.status === 'uncertain' && r.reason === '일부만 실패') };
      }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = ?')) {
        state.skips.push(args[0]);
        return { rows: [{ id: args[1] }] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = NULL')) return { rows: [{ id: args[0] }] };
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = CASE')) {
        state.failMark += 1;
        return { rows: [{ id: args[0] }] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET auto_copy_date = ? WHERE id = ?')) {
        if (state.copyDate === args[0]) return { rows: [] };
        state.copyDate = args[0];
        return { rows: [{ id: args[1] }] };
      }
      if (t.startsWith('SELECT status, COUNT(*) AS n, MAX(kst_date) AS last FROM sms_auto_sends')) {
        const by = {};
        for (const r of state.sends.filter(x => x.template_id === args[0])) {
          by[r.status] = by[r.status] || { status: r.status, n: 0, last: '' };
          by[r.status].n += 1;
          if (r.kst_date > by[r.status].last) by[r.status].last = r.kst_date;
        }
        return { rows: Object.values(by) };
      }
      if (t.startsWith("SELECT status, COUNT(*) AS n FROM sms_auto_sends WHERE template_id = ? AND status IN ('sent', 'failed')")) {
        const by = {};
        for (const r of state.sends.filter(x => x.template_id === args[0] && (x.status === 'sent' || x.status === 'failed') && x.kst_date >= args[1])) {
          by[r.status] = by[r.status] || { status: r.status, n: 0 };
          by[r.status].n += 1;
        }
        return { rows: Object.values(by) };
      }
      if (t.startsWith('SELECT MAX(last_run)')) return { rows: [{ last_run: new Date(NOW).toISOString() }] };
      throw new Error(`예상 못 한 SQL: ${t}`);
    },
  };
}

test('solapi.sendEach 및 groupMessages: 1061 수신거부 번호(failedTo·optoutTo) 추출 및 빈 실패 목록 호환성', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k';
  process.env.SOLAPI_API_SECRET = 's';
  try {
    const solapi = getSendProvider('solapi');
    const partialRes = await solapi.sendEach(
      {
        from: '0212345678',
        messages: [
          { to: '01011112222', text: 'A', fileId: 'F1' },
          { to: '01099990525', text: 'B', fileId: 'F1' },
        ],
      },
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            groupInfo: { groupId: 'G_PARTIAL', count: { registeredFailed: 1 } },
            failedMessageList: [{ to: '010-9999-0525', statusCode: '1061', statusMessage: '080 무료 수신 거부 사유로 발송하지 못했습니다.' }],
          }),
        }),
      },
    );
    assert.deepEqual(partialRes, {
      accepted: 1,
      failed: 1,
      groupId: 'G_PARTIAL',
      uncertain: false,
      error: '',
      failedTo: ['01099990525'],
      optoutTo: ['01099990525'],
    });

    const groupMsgs = await solapi.groupMessages('G_PARTIAL', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          messageList: {
            M1: { to: '01011112222', statusCode: '4000' },
            M2: { to: '01099990525', statusCode: '1061', statusMessage: '080 무료 수신 거부' },
          },
        }),
      }),
    });
    assert.deepEqual(groupMsgs, {
      hasMore: false,
      messages: [
        { to: '01011112222', statusCode: '4000', optout: false },
        { to: '01099990525', statusCode: '1061', optout: true },
      ],
    });
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

test('runAutoSend: 일부 수신자가 1061 수신거부여도 나머지 수신자는 다회 통(사진 2장+본문)까지 완주해 sent 기록 및 수신거부 자동 등록', async () => {
  _resetAutoSchemaForTest();
  _resetEventSchemaForTest();
  _resetTextTemplateSchemaForTest();

  const db = makeAutoDb({
    orders: [
      { id: 1, phone: '010-1111-2222', client_name: '정상고객A', ship_date: '2026-11-24', status: 'shipped' },
      { id: 2, phone: '010-9999-0525', client_name: '거부고객B', ship_date: '2026-11-24', status: 'shipped' },
      { id: 3, phone: '010-3333-4444', client_name: '정상고객C', ship_date: '2026-11-24', status: 'shipped' },
    ],
  });

  const sentCalls = [];
  const vendor = {
    estimate: () => ({ unit: 110, total: 110 }),
    async uploadImage() { return { fileId: 'F_IMG' }; },
    async sendEach({ messages }) {
      sentCalls.push(messages);
      if (sentCalls.length === 1) {
        return {
          accepted: 2,
          failed: 1,
          groupId: 'G_PART1',
          uncertain: false,
          error: '',
          failedTo: ['01099990525'],
          optoutTo: ['01099990525'],
        };
      }
      return {
        accepted: messages.length,
        failed: 0,
        groupId: `G_PART${sentCalls.length}`,
        uncertain: false,
        error: '',
      };
    },
  };

  const tpl = {
    ...db.state.tpl,
    images: ['IMG1', 'IMG2'],
    auto_chain: null,
  };
  const out = await runAutoSend(tpl, { db, provider: vendor, env: ENV, nowMs: NOW, kakao: { getBalance: async () => 100000 } });

  assert.equal(out.sent, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.uncertain, 0);
  assert.equal(sentCalls.length, 4, '사진 2통 + 본문 1통 + 관리자 확인 단문 1통');
  assert.deepEqual(sentCalls[0].map(m => m.to), ['01011112222', '01099990525', '01033334444']);
  assert.deepEqual(sentCalls[1].map(m => m.to), ['01011112222', '01033334444'], '2번째 통부터는 거절된 번호 제외');
  assert.deepEqual(sentCalls[2].map(m => m.to), ['01011112222', '01033334444']);
  assert.deepEqual(sentCalls[3].map(m => m.to), ['01077314237'], '관리자 확인 문자 정상 발송');
  assert.match(sentCalls[3][0].text, /정상고객A/);
  assert.doesNotMatch(sentCalls[3][0].text, /거부고객B/);

  assert.ok(db.state.optouts.includes(phoneHash('01099990525')), '1061 번호가 sms_optouts 에 자동 등록됨');

  // 5분 뒤 다시 실행해도 이미 보낸 정상고객·수신거부 고객 모두 재발송되지 않음
  const again = await runAutoSend(tpl, { db, provider: vendor, env: ENV, nowMs: NOW + 300000, kakao: { getBalance: async () => 100000 } });
  assert.equal(again.claimed, 0);

  // 30일 뒤 2회차에서는 1회차 sent 인 정상고객 2명이 정상적으로 대상이 됨
  const round2 = await runAutoSend(tpl, {
    db,
    provider: vendor,
    env: ENV,
    nowMs: NOW + 30 * 86400000,
    kakao: { getBalance: async () => 100000 },
  });
  assert.equal(round2.sent, 2);
});

test('runAutoSend: 단독 대상이 1061 수신거부(accepted=0)면 1시간 대기·막힘을 걸지 않고 수신거부만 등록', async () => {
  _resetAutoSchemaForTest();
  _resetEventSchemaForTest();
  _resetTextTemplateSchemaForTest();

  const db = makeAutoDb({
    orders: [{ id: 10, phone: '010-9999-0525', client_name: '단독거부고객', ship_date: '2026-11-24', status: 'shipped' }],
  });
  const vendor = {
    estimate: () => ({ unit: 110, total: 110 }),
    async uploadImage() { return { fileId: 'F_IMG' }; },
    async sendEach() {
      return {
        accepted: 0,
        failed: 1,
        groupId: 'G_SOLO_OPTOUT',
        uncertain: false,
        error: '',
        failedTo: ['01099990525'],
        optoutTo: ['01099990525'],
      };
    },
  };
  const tpl = { ...db.state.tpl, images: ['IMG1'], auto_chain: null };
  const out = await runAutoSend(tpl, { db, provider: vendor, env: ENV, nowMs: NOW, kakao: { getBalance: async () => 100000 } });
  assert.equal(out.sent, 0);
  assert.equal(out.failed, 1);
  assert.equal(db.state.failMark, 0, '1시간 백오프를 걸지 않음');
  assert.deepEqual(db.state.skips, [], '막힘 사유를 남기지 않음');
  assert.ok(db.state.optouts.includes(phoneHash('01099990525')));
});

test('reconcilePartialAutoSends: 과거 "일부만 실패" uncertain 그룹을 쏠라피 결과로 자동 복구해 sent_7d 와 last_sent_date 를 정상화', async () => {
  _resetAutoSchemaForTest();
  _resetEventSchemaForTest();
  _resetTextTemplateSchemaForTest();

  const goodPhone = '01011112222';
  const optoutPhone = '01099990525';
  const db = makeAutoDb({
    template: { images: JSON.stringify(['IMG1']) },
    sends: [
      {
        id: 1,
        template_id: 21,
        phone_hash: phoneHash(goodPhone),
        phone_last4: '2222',
        order_id: 101,
        ship_date: '2026-11-24',
        kst_date: '2026-11-27',
        status: 'uncertain',
        part_status: '["uncertain"]',
        reason: '일부만 실패',
        group_ids: '["G4V_TODAY"]',
        round: 1,
      },
      {
        id: 2,
        template_id: 21,
        phone_hash: phoneHash(optoutPhone),
        phone_last4: '0525',
        order_id: 102,
        ship_date: '2026-11-24',
        kst_date: '2026-11-27',
        status: 'uncertain',
        part_status: '["uncertain"]',
        reason: '일부만 실패',
        group_ids: '["G4V_TODAY"]',
        round: 1,
      },
    ],
  });

  const rec = await reconcilePartialAutoSends(db, {
    provider: {
      async groupMessages(gid) {
        assert.equal(gid, 'G4V_TODAY');
        return {
          hasMore: false,
          messages: [
            { to: goodPhone, statusCode: '4000', optout: false },
            { to: optoutPhone, statusCode: '1061', optout: true },
          ],
        };
      },
    },
  });

  assert.deepEqual(rec, { checked: 1, sent: 1, failed: 1, optouts: 1 });
  assert.equal(db.state.sends[0].status, 'sent');
  assert.equal(db.state.sends[0].reason, null);
  assert.equal(db.state.sends[1].status, 'failed');
  assert.equal(db.state.sends[1].reason, '080 수신거부');
  assert.ok(db.state.optouts.includes(phoneHash(optoutPhone)));

  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k';
  process.env.SOLAPI_API_SECRET = 's';
  try {
    const st = await autoStatus(db, { id: 21, nowMs: NOW, env: ENV });
    assert.equal(st.status, 200);
    assert.equal(st.body.sent_7d, 1);
    assert.equal(st.body.last_sent_date, '2026-11-27');
    assert.equal(st.body.uncertain_total, 0);
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

test('ataLightState: 정책상 중지된 출고완료안내·꺼진 DB 자동발송·무실적 외부 템플릿은 켜짐으로 표시하지 않는다', () => {
  // 1) 정책상 중지된 제작현황 알림톡(출고완료안내: cardExtras.off === true)은 목록·상세 모두 꺼짐
  const pausedShipped = ataLightState(
    { id: 'KA01TP260709074214799PHhwnXRp2sM', status: 'APPROVED', program_use: false },
    { cardExtras: { off: true, count7: 0 }, usage: { partial: false, by_template: {} }, sent: [] },
  );
  assert.deepEqual(pausedShipped, { tone: 'off', label: '꺼짐', detailLabel: '꺼짐', active: false });

  // 2) DB 자동발송이 연결되어 있는데 모두 꺼져 있으면 최근 7일 이력이 남아 있어도 꺼짐
  const disabledLinked = ataLightState(
    { id: 'KA01TP_YOUTUBE', status: 'APPROVED', program_use: false },
    {
      linkedCount: 1,
      activeLinkedCount: 0,
      usage: { partial: false, by_template: { KA01TP_YOUTUBE: { count: 5 } } },
      sent: [],
    },
  );
  assert.deepEqual(disabledLinked, { tone: 'off', label: '꺼짐', detailLabel: '꺼짐', active: false });

  // 3) DB 자동발송이 켜져 있으면 최근 발송 건수가 0이어도 켜짐
  const enabledLinked = ataLightState(
    { id: 'KA01TP_DUE', status: 'APPROVED', program_use: false },
    { linkedCount: 2, activeLinkedCount: 1, usage: { partial: false, by_template: {} }, sent: [] },
  );
  assert.deepEqual(enabledLinked, { tone: 'on', label: '켜짐', detailLabel: '켜짐 1/2', active: true });

  // 4) 제작현황 고객 알림(program_use: true)은 최근 7일 0건이어도 켜짐
  const programUse = ataLightState(
    { id: 'KA01TP_PACKED', status: 'APPROVED', program_use: true },
    { cardExtras: { off: false, count7: 0 }, usage: { partial: false, by_template: {} }, sent: [] },
  );
  assert.deepEqual(programUse, { tone: 'on', label: '켜짐', detailLabel: '켜짐', active: true });

  // 5) 외부 연동(스마트스토어·쏠라피 앱)은 최근 7일 성공 건수가 있을 때만 켜짐, 0건이면 확인 안 됨
  const activeExt = ataLightState(
    { id: 'KA01TP_EXT', status: 'APPROVED', program_use: false },
    { cardExtras: { off: false, count7: 6 }, usage: { partial: false, by_template: { KA01TP_EXT: { count: 6 } } }, sent: [] },
  );
  assert.equal(activeExt.tone, 'on');
  assert.equal(activeExt.active, true);

  const idleExt = ataLightState(
    { id: 'KA01TP_EXT_IDLE', status: 'APPROVED', program_use: false },
    { cardExtras: { off: false, count7: 0 }, usage: { partial: false, by_template: {} }, sent: [] },
  );
  assert.deepEqual(idleExt, { tone: 'unknown', label: '확인 안 됨', detailLabel: '확인 안 됨', active: false });
});

test('handleCompleteProcess: 중간 공정으로 포장이 함께 완료될 때도 packed 고객 알림이 호출된다', async () => {
  const external = [];
  const db = {
    async execute({ sql }) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ id: 73, order_id: 173, step_name: '설비작업', status: 'in_progress' }] };
      }
      if (s.startsWith('SELECT id, step_name, status FROM processes WHERE order_id = ?')) {
        return {
          rows: [
            { id: 74, step_name: '포장', status: 'waiting' },
            { id: 75, step_name: '출고', status: 'waiting' },
          ],
        };
      }
      return { rows: [] };
    },
    async atomicBatch() {
      return [{
        rows: [{
          claimed_process_id: 73,
          process_row: { id: 73, order_id: 173, step_name: '설비작업', status: 'completed' },
          order_row: { id: 173, client_name: '중간포장 거래처', status: 'in_production' },
          completed_intermediate_processes: [{ id: 74, step_name: '포장', was_waiting_before_complete: true }],
          started_next_process_id: 75,
          shipped_order: null,
        }],
      }];
    },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handleCompleteProcess(
    { method: 'PATCH', query: { id: '73' }, body: { actor: '작업자', start_next_step: '출고' } },
    res,
    {
      db,
      rateLimitCheck: () => true,
      requireWorkerAction: () => ({ actor: '작업자' }),
      notify: async (_db, order, milestone) => external.push(['customer', order.id, milestone]),
      notifyInternalCompletion: async () => {},
      ensureShippingProcessUniqueIndex: async () => {},
      ensureShippingSheetSyncSchema: async () => {},
    },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(external, [['customer', 173, 'packed']]);
});
