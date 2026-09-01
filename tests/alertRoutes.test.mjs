// 담당자별 지연경보 라우팅 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAlertRecipientName,
  routeAlerts,
  ALERT_ROUTES,
} from '../api/_lib/alertRoutes.js';

const R = { '신은철': '010-5879-2438', '신은절': '010-5879-2438', '이준형': '010-7731-4237' };
const mk = (sales_person, client_name, days_left = 3) => ({ sales_person, client_name, days_left, current_step: '용접작업' });

test('신은철 → 5879, 이준형 → 7731 로 분리', () => {
  const { byPhone, unrouted } = routeAlerts([mk('신은철', 'A'), mk('이준형', 'B')], R, '');
  assert.equal(unrouted.length, 0);
  assert.deepEqual(byPhone.get('01058792438').items.map(i => i.client_name), ['A']);
  assert.deepEqual(byPhone.get('01077314237').items.map(i => i.client_name), ['B']);
});

test('오타 "신은절" → 신은철 번호로', () => {
  const { byPhone } = routeAlerts([mk('신은절', 'C')], R, '');
  assert.equal(byPhone.get('01058792438').items.length, 1);
});

test('분체 미착수 이력에는 영업담당자 이름을 정규화해 저장한다', () => {
  assert.equal(canonicalAlertRecipientName('신은철'), '신은철');
  assert.equal(canonicalAlertRecipientName('신은절'), '신은철');
  assert.equal(canonicalAlertRecipientName('이준형'), '이준형');
  assert.equal(canonicalAlertRecipientName('김보수'), '');
});

test('앞뒤 공백 이름도 매칭 (trim)', () => {
  const { byPhone } = routeAlerts([mk(' 신은철 ', 'D')], R, '');
  assert.ok(byPhone.has('01058792438'));
});

test('미매핑 담당자 + fallback 없음 → unrouted (오발송 방지)', () => {
  const { byPhone, unrouted } = routeAlerts([mk('김보수', 'E')], R, '');
  assert.equal(byPhone.size, 0);
  assert.equal(unrouted.length, 1);
  assert.equal(unrouted[0].person, '김보수');
});

test('미지정(null) + fallback 있음 → fallback 번호', () => {
  const { byPhone, unrouted } = routeAlerts([mk(null, 'F')], R, '010-1111-2222');
  assert.equal(unrouted.length, 0);
  assert.ok(byPhone.has('01011112222'));
  assert.equal([...byPhone.get('01011112222').persons][0], '(미지정)');
});

test('같은 담당자 여러 건 그룹화', () => {
  const { byPhone } = routeAlerts([mk('신은철', 'A'), mk('신은철', 'B')], R, '');
  assert.equal(byPhone.get('01058792438').items.length, 2);
});

// 실제 운영 설정값 가드 — 번호가 잘못 바뀌면 여기서 잡힌다
test('운영 라우팅표: 신은철 → 010-7346-7407, 이준형 → 010-7731-4237', () => {
  assert.equal(ALERT_ROUTES['신은철'], '010-7346-7407');
  assert.equal(ALERT_ROUTES['신은절'], '010-7346-7407'); // 오타 표기도 같은 번호
  assert.equal(ALERT_ROUTES['이준형'], '010-7731-4237');
});
