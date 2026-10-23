import assert from 'node:assert/strict';
import test from 'node:test';

import { handleNotificationOverview } from '../api/notification-overview.js';
import {
  attachRecentResults,
  buildNotificationCatalog,
  loadNotificationOverview,
} from '../api/_lib/notificationOverview.js';
import {
  OVERDUE_REMINDER_DEFINITIONS,
  OVERDUE_REMINDER_KINDS,
} from '../api/_lib/overdueReminders.js';

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
    ['internal', 10],
  ]);

  const ids = groups.flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(ids, [
    'customer_ordered', 'customer_started', 'customer_packed', 'customer_rescheduled', 'customer_shipped',
    'internal_vcut_completed', 'internal_design_due', 'internal_laser_due', 'internal_welding_due',
    'internal_assembly_due', 'chonbe_alert',
    'sms_delivery_block_admin_alert', 'internal_overdue_unshipped', 'internal_overdue_equipment',
    'internal_overdue_packing',
  ]);
  assert.equal(ids.some(id => id.includes('demo') || id.includes('test_send')), false);
});

test('납기 경과 알림 정의는 전부 자동 카탈로그화되고 기존 평일 알림 일정은 유지한다', () => {
  assert.deepEqual(OVERDUE_REMINDER_KINDS, {
    UNSHIPPED: 'internal_overdue_unshipped',
    EQUIPMENT: 'internal_overdue_equipment',
    PACKING: 'internal_overdue_packing',
  });
  const items = itemsFor(readyEnv());
  for (const definition of Object.values(OVERDUE_REMINDER_DEFINITIONS)) {
    const item = items.find(candidate => candidate.milestone === definition.kind);
    assert.ok(item, definition.kind);
    assert.equal(item.id, definition.kind);
    assert.equal(item.name, definition.overview.name);
    assert.equal(item.trigger, definition.overview.trigger);
    assert.equal(item.target, definition.overview.target);
    assert.equal(item.timing, '매일 08:40 KST');
    assert.equal(item.configuration.status, 'ready');
    assert.match(item.configuration.reason, /매일/);
    assert.doesNotMatch(item.configuration.reason, /평일/);
  }

  assert.equal(itemById(readyEnv(), 'internal_design_due').timing, '월~금 08:40 KST');
  assert.match(itemById(readyEnv(), 'internal_design_due').configuration.reason, /평일/);
  assert.match(itemById(readyEnv(), 'internal_overdue_unshipped').trigger, /납기일/);
  assert.doesNotMatch(itemById(readyEnv(), 'internal_overdue_unshipped').target, /조립 착수자|정영호|최우석|박상규/);
  const equipmentTarget = itemById(readyEnv(), 'internal_overdue_equipment').target;
  assert.match(equipmentTarget, /해당 주문 실제 조립 착수자/);
  for (const name of ['신은철', '이준형', '황보민수', '정영호 팀장', '최우석 이사', '박상규 공장장']) {
    assert.match(equipmentTarget, new RegExp(name));
  }
  const packing = itemById(readyEnv(), 'internal_overdue_packing');
  assert.match(packing.trigger, /납기 3일 전부터 모든 납기 경과일/);
  assert.equal(packing.target, '정영호 팀장 (010****0577)');
  assert.deepEqual(packing.milestones, [
    'internal_overdue_packing', 'internal_packing_due', 'internal_assembly_daily',
  ]);
  assert.doesNotMatch(`${equipmentTarget} ${packing.target}`, /010-\d{4}-\d{4}/);
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

test('사내 수신자는 실제 라우팅을 마스킹해 표시한다', () => {
  const items = itemsFor(readyEnv());
  const serialized = JSON.stringify(items);
  for (const name of ['이시아 부장', '김보수 팀장', '이정섭 부장', '최우석 이사', '박상규 공장장', '정영호 팀장']) {
    assert.match(serialized, new RegExp(name));
  }

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
  assert.equal(itemById(noCron, 'internal_overdue_packing').configuration.status, 'incomplete');
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

test('전달 감시 카드 하나가 차단과 최종 실패 별칭을 함께 집계한다', () => {
  const items = attachRecentResults(buildNotificationCatalog(readyEnv(), NOW), [
    { milestone: 'sms_delivery_block_admin_alert', status: 'success', channel: 'lms', created_at: '2026-10-15T02:00:00Z' },
    { milestone: 'sms_delivery_final_failure_admin_alert', status: 'failed', channel: 'lms', created_at: '2026-10-15T01:00:00Z' },
  ]).flatMap(group => group.items);
  const monitor = items.find(item => item.id === 'sms_delivery_block_admin_alert');
  assert.equal(monitor.name, '문자 전달 이상 감시 알림');
  assert.deepEqual(monitor.milestones, [
    'sms_delivery_block_admin_alert',
    'sms_delivery_final_failure_admin_alert',
  ]);
  assert.equal(monitor.recent.counts.total, 2);
  assert.equal(items.filter(item => item.id === monitor.id).length, 1);
});

test('통합 포장 카드가 이전 두 태그를 함께 집계하고 별도 카드로 되살리지 않는다', () => {
  const groups = buildNotificationCatalog(readyEnv(), NOW);
  const items = attachRecentResults(groups, [
    { milestone: 'internal_overdue_packing', status: 'success', channel: 'lms', created_at: '2026-10-15T03:00:00Z' },
    { milestone: 'internal_packing_due', status: 'success', channel: 'lms', created_at: '2026-10-15T02:00:00Z' },
    { milestone: 'internal_assembly_daily', status: 'failed', channel: 'lms', created_at: '2026-10-15T01:00:00Z' },
  ]).flatMap(group => group.items);
  const packing = items.find(item => item.id === 'internal_overdue_packing');
  assert.equal(packing.recent.counts.total, 3);
  assert.equal(items.some(item => ['internal_packing_due', 'internal_assembly_daily'].includes(item.id)), false);
});

test('전체 이력의 새로운 internal 태그를 발견하고 최근 집계와 안전하게 합친다', async () => {
  const calls = [];
  const result = await loadNotificationOverview({
    async execute(query) {
      calls.push(query);
      if (query.sql.includes('DISTINCT ON')) {
        return { rows: [
          {
            milestone: 'internal_future_example', channel: 'lms', status: 'success', delivery_status_code: '4000',
            created_at: '2026-10-15T02:00:00Z', message_subject: '새 생산 알림', message_text: '최근 실제 본문',
          },
          {
            milestone: 'internal_old_example', channel: 'lms', status: 'success', delivery_status_code: null,
            created_at: '2026-01-01T00:00:00Z', message_subject: '과거 고객명 포함 제목', message_text: '과거 공개 범위 밖 본문',
          },
          {
            milestone: 'internal_no_body', channel: 'lms', status: 'success', delivery_status_code: null,
            created_at: '2026-10-14T00:00:00Z', message_subject: '본문 없는 알림', message_text: null,
          },
          { milestone: 'internal_design_due', created_at: '2026-10-15T00:00:00Z', message_text: 'known duplicate' },
          { milestone: 'internal_packing_due', created_at: '2026-10-15T00:00:00Z', message_text: 'legacy packing' },
          { milestone: 'internal_assembly_daily', created_at: '2026-10-15T00:00:00Z', message_text: 'legacy assembly' },
          { milestone: 'ordered', created_at: '2026-10-15T00:00:00Z', message_text: 'customer must not appear' },
          { milestone: 'sms_delivery_private_admin_alert', created_at: '2026-10-15T00:00:00Z', message_text: 'admin must not appear' },
        ] };
      }
      return { rows: [
        { milestone: 'internal_future_example', status: 'success', delivery_status_code: '4000', channel: 'lms', created_at: '2026-10-15T02:00:00Z' },
        { milestone: 'sms_delivery_final_failure_admin_alert', status: 'success', delivery_status_code: '4000', channel: 'lms', created_at: '2026-10-15T01:00:00Z' },
      ] };
    },
  }, readyEnv(), NOW);

  assert.equal(calls.length, 2);
  const recentQuery = calls.find(call => !call.sql.includes('DISTINCT ON'));
  const discoveryQuery = calls.find(call => call.sql.includes('DISTINCT ON'));
  assert.match(recentQuery.sql, /LEFT\(milestone, 9\) = 'internal_'/);
  assert.doesNotMatch(recentQuery.sql, /milestone LIKE 'internal_%'/);
  assert.match(discoveryQuery.sql, /LIMIT 201/);
  assert.match(discoveryQuery.sql, /LEFT\(milestone, 9\) = 'internal_'/);
  assert.ok(discoveryQuery.args.includes('internal_design_due'));
  assert.ok(discoveryQuery.args.includes('sms_delivery_final_failure_admin_alert'));
  assert.doesNotMatch(discoveryQuery.sql, /internal_future_example/);

  const items = result.groups.find(group => group.id === 'internal').items;
  const discovered = items.find(item => item.milestone === 'internal_future_example');
  assert.ok(discovered);
  assert.equal(discovered.name, '새 생산 알림');
  assert.equal(discovered.policy.status, 'unknown');
  assert.equal(discovered.configuration.status, 'unknown');
  assert.equal(discovered.trigger, '발송 기록만으로 확인할 수 없음');
  assert.equal(discovered.recent.counts.total, 1);
  assert.deepEqual(discovered.example_message, {
    subject: '새 생산 알림', text: '최근 실제 본문', label: '최근 실제 발송 문구', source: 'history',
  });
  const old = items.find(item => item.milestone === 'internal_old_example');
  assert.ok(old);
  assert.equal(old.recent.counts.total, 0);
  assert.equal(old.policy.status, 'unknown');
  assert.equal(old.configuration.status, 'unknown');
  assert.equal(old.name, 'internal_old_example');
  assert.equal(old.example_message, null);
  const noBody = items.find(item => item.milestone === 'internal_no_body');
  assert.equal(noBody.name, '본문 없는 알림');
  assert.equal(noBody.example_message, null);
  assert.equal(items.filter(item => item.milestone === 'internal_design_due').length, 1);
  assert.equal(items.some(item => ['internal_packing_due', 'internal_assembly_daily'].includes(item.id)), false);
  assert.equal(items.some(item => item.milestone === 'ordered' && item.id === 'ordered'), false);
  assert.equal(items.some(item => item.milestone === 'sms_delivery_private_admin_alert'), false);
  assert.equal(result.catalog_status.state, 'available');
});

test('최근 조회와 카탈로그 발견 실패는 서로의 성공 결과를 지우지 않는다', async () => {
  const recentFailed = await loadNotificationOverview({
    async execute(query) {
      if (query.sql.includes('DISTINCT ON')) return { rows: [{
        milestone: 'internal_future_example', channel: 'lms', status: 'success', created_at: '2026-01-01T00:00:00Z',
        message_subject: '발견 알림', message_text: '저장 본문',
      }] };
      throw new Error('recent unavailable');
    },
  }, readyEnv(), NOW);
  assert.equal(recentFailed.log_status.state, 'unavailable');
  assert.equal(recentFailed.catalog_status.state, 'available');
  assert.ok(recentFailed.groups.flatMap(group => group.items).some(item => item.id === 'internal_future_example'));
  assert.ok(recentFailed.groups.flatMap(group => group.items).every(item => item.recent.state === 'unavailable'));

  const discoveryFailed = await loadNotificationOverview({
    async execute(query) {
      if (query.sql.includes('DISTINCT ON')) throw new Error('discovery unavailable');
      return { rows: [{ milestone: 'ordered', status: 'success', channel: 'lms', created_at: '2026-10-15T00:00:00Z' }] };
    },
  }, readyEnv(), NOW);
  assert.equal(discoveryFailed.log_status.state, 'available');
  assert.equal(discoveryFailed.catalog_status.state, 'unavailable');
  assert.equal(discoveryFailed.groups[0].items[0].recent.counts.total, 1);
  assert.equal(discoveryFailed.groups.find(group => group.id === 'internal').items.length, 10);
});

test('발견 항목은 200개로 제한하고 초과 시 카탈로그 상태만 partial로 표시한다', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    milestone: `internal_future_${String(index).padStart(3, '0')}`,
    channel: 'lms', status: 'success', delivery_status_code: null,
    created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
    message_subject: `미래 알림 ${index}`, message_text: `본문 ${index}`,
  }));
  const result = await loadNotificationOverview({
    async execute(query) { return { rows: query.sql.includes('DISTINCT ON') ? rows : [] }; },
  }, readyEnv(), NOW);
  assert.equal(result.catalog_status.state, 'partial');
  assert.equal(result.groups.find(group => group.id === 'internal').items.length, 10 + 200);
});

test('최근 기록과 카탈로그 발견은 읽기 전용 SELECT만 수행하고 모두 실패해도 정책·설정을 반환한다', async () => {
  const calls = [];
  const available = await loadNotificationOverview({
    async execute(query) { calls.push(query); return { rows: [] }; },
  }, readyEnv(), NOW);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /^SELECT /s);
    assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b|ensure/i);
  }
  assert.equal(available.log_status.state, 'available');
  assert.equal(available.recent_period.days, 7);

  const unavailable = await loadNotificationOverview({
    async execute() { throw new Error('db unavailable'); },
  }, readyEnv(), NOW);
  assert.equal(unavailable.log_status.state, 'unavailable');
  assert.equal(unavailable.catalog_status.state, 'unavailable');
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
