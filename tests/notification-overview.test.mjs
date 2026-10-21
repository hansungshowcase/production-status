import assert from 'node:assert/strict';
import test from 'node:test';

import { handleNotificationOverview } from '../api/notification-overview.js';
import {
  attachRecentResults,
  buildNotificationCatalog,
  loadNotificationOverview,
} from '../api/_lib/notificationOverview.js';

const NOW = new Date('2026-10-15T03:00:00.000Z');

function readyEnv(overrides = {}) {
  return {
    POSTGRES_URL: 'configured',
    SOLAPI_API_KEY: 'configured',
    SOLAPI_API_SECRET: 'configured',
    SMS_SENDER: '0212345678',
    KAKAO_PF_ID: 'configured',
    SOLAPI_TPL_ORDERED: 'configured',
    SOLAPI_TPL_STARTED: 'configured',
    SOLAPI_TPL_PACKED: 'configured',
    SOLAPI_TPL_RESCHEDULED: 'configured',
    NOTIFY_STARTED: '1',
    CRON_SECRET: 'configured',
    ALERT_FALLBACK: 'configured',
    ...overrides,
  };
}

function itemsFor(env) {
  return buildNotificationCatalog(env, NOW).flatMap(group => group.items);
}

function itemById(env, id) {
  return itemsFor(env).find(item => item.id === id);
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('실제 자동 알림 규칙만 고객과 사내·관리 그룹에 공개한다', () => {
  const groups = buildNotificationCatalog(readyEnv(), NOW);
  assert.deepEqual(groups.map(group => [group.id, group.items.length]), [
    ['customer', 5],
    ['internal', 9],
  ]);

  const ids = groups.flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(ids, [
    'customer_ordered', 'customer_started', 'customer_packed', 'customer_rescheduled', 'customer_shipped',
    'internal_vcut_completed', 'internal_design_due', 'internal_laser_due', 'internal_welding_due',
    'internal_assembly_due', 'internal_packing_due', 'internal_assembly_daily', 'chonbe_alert',
    'sms_delivery_block_admin_alert',
  ]);
  assert.equal(ids.some(id => id.includes('demo') || id.includes('test_send')), false);
});
test('고객 알림은 실제 실행 설정과 정책 중단을 구분한다', () => {
  const ready = readyEnv();
  assert.equal(itemById(ready, 'customer_ordered').configuration.status, 'ready');
  assert.equal(itemById(ready, 'customer_ordered').configuration.channel, '알림톡 우선 · 문자 대체');
  assert.equal(itemById({ ...ready, NOTIFY_STARTED: '0' }, 'customer_started').configuration.status, 'incomplete');
  assert.equal(itemById({ ...ready, CRON_SECRET: '' }, 'customer_packed').configuration.status, 'conditional');
  assert.equal(itemById({ ...ready, SOLAPI_API_KEY: '', SOLAPI_API_SECRET: '' }, 'customer_ordered').configuration.status, 'test');
  assert.equal(itemById({ ...ready, KAKAO_PF_ID: '', SMS_SENDER: '' }, 'customer_ordered').configuration.status, 'incomplete');
  assert.equal(itemById({ ...ready, KAKAO_PF_ID: '', SMS_SENDER: 'abc' }, 'customer_ordered').configuration.status, 'incomplete');
  assert.equal(itemById({ ...ready, POSTGRES_URL: '' }, 'customer_ordered').configuration.status, 'incomplete');

  const shipped = itemById(ready, 'customer_shipped');
  assert.equal(shipped.policy.status, 'paused');
  assert.match(shipped.trigger, /발송 전에 중단/);
  assert.match(shipped.timing, /신규·재시도·누락 복구 모두 제외/);
});

test('사내 수신자는 실제 라우팅을 마스킹해 표시하고 과거 조립팀원은 제외한다', () => {
  const items = itemsFor(readyEnv());
  const serialized = JSON.stringify(items);
  for (const name of ['이시아 부장', '김보수 팀장', '이정섭 부장', '최우석 이사', '박상규 공장장', '정영호 팀장']) {
    assert.match(serialized, new RegExp(name));
  }

  const assembly = items.find(item => item.id === 'internal_assembly_daily');
  for (const name of ['카우사르', '나타왓', '마카라', '백승정', '까지']) {
    assert.match(assembly.target, new RegExp(name));
  }
  assert.doesNotMatch(assembly.target, /강종효|까우사르/);
  assert.doesNotMatch(serialized, /010-\d{4}-\d{4}/);

  const vcut = items.find(item => item.id === 'internal_vcut_completed');
  assert.match(vcut.timing, /요일 제한 없음/);
  const monitor = items.find(item => item.id === 'sms_delivery_block_admin_alert');
  assert.equal(monitor.target, '관리자 지정 번호 (010****4237)');
  assert.doesNotMatch(monitor.target, /이시아|이준형/);
});

test('예약·혼합·영업 대체 라우팅 설정을 각각 판정한다', () => {
  const noCron = readyEnv({ CRON_SECRET: '' });
  assert.equal(itemById(noCron, 'internal_design_due').configuration.status, 'incomplete');
  assert.equal(itemById(noCron, 'internal_assembly_daily').configuration.status, 'conditional');
  assert.equal(itemById(noCron, 'sms_delivery_block_admin_alert').configuration.status, 'incomplete');

  const noFallback = readyEnv({ ALERT_FALLBACK: '' });
  const chonbe = itemById(noFallback, 'chonbe_alert');
  assert.equal(chonbe.configuration.status, 'conditional');
  assert.match(chonbe.target, /신은철.*이준형.*황보민수.*미매핑 담당자는 제외/);

  const injectedFallback = itemById(readyEnv({ ALERT_FALLBACK: '010 1111 2222' }), 'chonbe_alert');
  assert.match(injectedFallback.target, /미매핑 담당자는 대체 수신번호 \(010\*{4}2222\)/);
  assert.doesNotMatch(injectedFallback.target, /010 1111 2222/);
});

test('영업 대체 수신자 판정은 주입한 env만 사용한다', () => {
  const savedFallback = process.env.ALERT_FALLBACK;
  process.env.ALERT_FALLBACK = '010-9999-9999';
  try {
    const chonbe = itemById(readyEnv({ ALERT_FALLBACK: '' }), 'chonbe_alert');
    assert.match(chonbe.target, /미매핑 담당자는 제외/);
    assert.doesNotMatch(chonbe.target, /9999/);
  } finally {
    if (savedFallback === undefined) delete process.env.ALERT_FALLBACK;
    else process.env.ALERT_FALLBACK = savedFallback;
  }
});

test('최근 7일 결과는 4000만 수신 확인이며 접수·처리중·실패를 구분한다', () => {
  const groups = buildNotificationCatalog(readyEnv(), NOW);
  const rows = [
    { milestone: 'ordered', status: 'success', delivery_status_code: '4000', channel: 'alimtalk', created_at: '2026-10-15T02:00:00Z' },
    { milestone: 'ordered', status: 'success', delivery_status_code: '2000', channel: 'alimtalk', created_at: '2026-10-15T01:00:00Z' },
    { milestone: 'ordered', status: 'success', delivery_status_code: null, channel: 'lms', created_at: '2026-10-15T00:00:00Z' },
    { milestone: 'ordered', status: 'failed', delivery_status_code: null, channel: 'lms', created_at: '2026-10-14T23:00:00Z' },
    { milestone: 'ordered', status: 'success', delivery_status_code: '2061', channel: 'lms', created_at: '2026-10-14T22:30:00Z' },
    { milestone: 'ordered', status: 'success', delivery_status_code: '9000', channel: 'lms', created_at: '2026-10-14T22:15:00Z' },
    { milestone: 'rescheduled:2026-10-20', status: 'dry_run', delivery_status_code: null, channel: 'lms', created_at: '2026-10-14T22:00:00Z' },
    { milestone: 'unrelated', status: 'success', delivery_status_code: '4000', channel: 'lms', created_at: '2026-10-14T21:00:00Z' },
  ];
  const items = attachRecentResults(groups, rows).flatMap(group => group.items);
  const ordered = items.find(item => item.id === 'customer_ordered');
  assert.deepEqual(ordered.recent.counts, {
    total: 6, received: 1, processing: 1, accepted: 1, failed: 2, dry_run: 0, other: 1,
  });
  assert.deepEqual(ordered.recent.latest, {
    status: 'received', label: '수신 확인', channel: 'alimtalk', occurred_at: '2026-10-15T02:00:00Z',
  });
  assert.equal(items.find(item => item.id === 'customer_rescheduled').recent.counts.dry_run, 1);
});

test('최근 기록 조회는 SELECT 한 번만 수행하고 실패해도 정책·설정을 반환한다', async () => {
  const calls = [];
  const available = await loadNotificationOverview({
    async execute(query) { calls.push(query); return { rows: [] }; },
  }, readyEnv(), NOW);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT milestone/s);
  assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b|ensure/i);
  assert.equal(available.log_status.state, 'available');
  assert.equal(available.recent_period.days, 7);

  const unavailable = await loadNotificationOverview({
    async execute() { throw new Error('db unavailable'); },
  }, readyEnv(), NOW);
  assert.equal(unavailable.log_status.state, 'unavailable');
  assert.equal(unavailable.groups.length, 2);
  assert.equal(unavailable.groups[0].items[0].recent.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /db unavailable/);
});

test('현황 API는 GET·rate limit·no-store 계약을 지키고 조회 실패도 200으로 반환한다', async () => {
  const res = mockResponse();
  await handleNotificationOverview({ method: 'GET', headers: {}, url: '/api/notification-overview' }, res, {
    rateLimitCheck: () => true,
    env: readyEnv({ POSTGRES_URL: '' }),
    now: NOW,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store');
  assert.equal(res.headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.equal(res.body.log_status.state, 'unavailable');

  const methodRes = mockResponse();
  await handleNotificationOverview({ method: 'POST', headers: {}, url: '/api/notification-overview' }, methodRes, {
    rateLimitCheck: () => true,
  });
  assert.equal(methodRes.statusCode, 405);
});
