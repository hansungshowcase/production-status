import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMessage, maybeNotify } from '../api/_lib/notify.js';
import * as customerShippingDate from '../src/utils/customerShippingDate.js';

// 고객이 받은 실제 문자에 '하나로냉장' 같은 내부 분류·거래처 표기가 품명으로 나갔다.
// (2026-08-10 확인) 고객 문자 본문에서는 품명을 빼고 규격만 남긴다.
const ORDER = {
  id: 419,
  client_name: '박주필/법인',
  order_date: '2026-08-10',
  due_date: '2026-08-21',
  product_type: '하나로냉장',
  door_type: '뒷문',
  width: 650,
  depth: 590,
  height: 1850,
  quantity: 1,
  ship_date: '2026-08-20',
  ship_scheduled_date: '2026-08-21',
};

const MILESTONES = ['ordered', 'started', 'packed', 'shipped', 'rescheduled'];

test('모든 고객 문자 본문에 품명이 들어가지 않는다', () => {
  for (const milestone of MILESTONES) {
    const { text } = buildMessage(ORDER, milestone, 'https://example.com/track/tok', { date: '2026-08-25' });
    assert.doesNotMatch(text, /하나로냉장/, `${milestone} 문자에 품명이 남아 있으면 안 된다`);
    assert.doesNotMatch(text, /제품\/규격/, `${milestone} 문자에 '제품/규격' 라벨이 남아 있으면 안 된다`);
  }
});

test('규격 줄에는 문형과 치수가 남는다', () => {
  const { text } = buildMessage(ORDER, 'ordered', 'https://example.com/track/tok');
  assert.match(text, /- 규격: 뒷문 650×590×1850mm/);
});

test('문형이 없으면 치수만 남는다', () => {
  const { text } = buildMessage({ ...ORDER, door_type: null }, 'ordered', '');
  assert.match(text, /- 규격: 650×590×1850mm/);
});

test('치수가 없으면 규격 줄이 비어도 다른 항목은 그대로다', () => {
  const { text } = buildMessage(
    { ...ORDER, width: null, depth: null, height: null, door_type: null, ship_scheduled_date: null },
    'ordered',
    '',
  );
  assert.match(text, /- 규격:/);
  assert.match(text, /- 수량: 1대/);
  assert.match(text, /- 예상 출고일: 2026-08-24/);
});

test('고객 예상 출고일은 작업지시서 납기보다 3일 뒤로 안내한다', () => {
  const order = { ...ORDER, ship_scheduled_date: null };

  for (const milestone of ['ordered', 'started', 'packed']) {
    const { text, variables } = buildMessage(order, milestone, '');
    assert.match(text, /- 예상 출고일: 2026-08-24/, `${milestone} 문자는 납기+3일이어야 한다`);
    assert.equal(variables.예상출고일, '2026-08-24');
  }

  const rollover = buildMessage(
    { ...order, due_date: '2026-12-30' },
    'ordered',
    '',
  );
  assert.match(rollover.text, /- 예상 출고일: 2027-01-02/);

  const leapYear = buildMessage(
    { ...order, due_date: '2028-02-27' },
    'ordered',
    '',
  );
  assert.match(leapYear.text, /- 예상 출고일: 2028-03-01/);
});

test('명시적으로 조정된 출고일과 실제 출고일에는 3일을 더하지 않는다', () => {
  const scheduled = { ...ORDER, ship_scheduled_date: '2026-08-25' };

  for (const milestone of ['ordered', 'started', 'packed']) {
    const { text, variables } = buildMessage(scheduled, milestone, '');
    assert.match(text, /- 예상 출고일: 2026-08-25/);
    assert.equal(variables.예상출고일, '2026-08-25');
  }

  assert.match(
    buildMessage(scheduled, 'rescheduled', '', { date: '2026-08-28' }).text,
    /- 출고 예정일: 2026-08-28/,
  );
  assert.match(buildMessage(scheduled, 'shipped', '').text, /- 출고일: 2026-08-20/);
});

test('고객 조회는 납기+3일이 지나기 전까지 조정 중으로 바뀌지 않는다', () => {
  assert.equal(typeof customerShippingDate.customerDeliveryStatus, 'function');

  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'in_production',
    due_date: '2026-09-29',
    ship_scheduled_date: null,
  }, '2026-09-30'), 'on_track');
  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'in_production',
    due_date: '2026-09-27',
    ship_scheduled_date: null,
  }, '2026-09-30'), 'on_track');
  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'in_production',
    due_date: '2026-09-27',
    ship_scheduled_date: null,
  }, '2026-10-01'), 'adjusting');
  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'in_production',
    due_date: '2026-09-27',
    ship_scheduled_date: '2026-10-03',
  }, '2026-10-01'), 'rescheduled');
  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'in_production',
    due_date: '2026-09-27',
    ship_scheduled_date: '2026-09-30',
  }, '2026-10-01'), 'adjusting');
  assert.equal(customerShippingDate.customerDeliveryStatus({
    status: 'shipped',
    due_date: '2026-09-27',
  }, '2026-10-01'), 'shipped');
});

test('알림톡 템플릿 변수는 그대로 유지된다', () => {
  // 카카오에 등록된 서식과 변수명·구성이 맞아야 하므로 본문만 바꾸고 variables 는 건드리지 않는다.
  const { variables } = buildMessage(ORDER, 'ordered', 'https://example.com/track/tok');
  assert.equal(variables.제품, '하나로냉장');
  assert.match(variables.규격, /하나로냉장 \(뒷문\) 650×590×1850mm/);
  for (const key of ['고객명', '주문번호', '수량', '예상출고일', '조회링크', '토큰']) {
    assert.ok(key in variables, `${key} 변수가 있어야 한다`);
  }
});

test('주문번호·수량·출고일·조회링크는 종전대로 들어간다', () => {
  const { text, subject } = buildMessage(ORDER, 'shipped', 'https://example.com/track/tok');
  assert.equal(subject, '[한성쇼케이스] 출고 완료 안내');
  assert.match(text, /- 주문번호: HS-2026-0419/);
  assert.match(text, /- 수량: 1대/);
  assert.match(text, /- 출고일: 2026-08-20/);
  assert.match(text, /https:\/\/example\.com\/track\/tok/);
});

test('유효한 수량은 그대로 표시하고 잘못된 수량은 1대로 바꾸지 않는다', () => {
  assert.match(buildMessage({ ...ORDER, quantity: 2 }, 'ordered', '').text, /- 수량: 2대/);
  for (const quantity of [undefined, null, '', 0, '0', -1, 1.5, '2대', 2147483648]) {
    assert.throws(
      () => buildMessage({ ...ORDER, quantity }, 'ordered', ''),
      /수량 확인.*발송하지 않았/,
      `invalid quantity ${String(quantity)} must not become 1대`,
    );
  }
});

test('잘못된 수량 주문은 고객 알림을 발송하지 않는다', async () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SOLAPI_API_KEY: process.env.SOLAPI_API_KEY,
    SOLAPI_API_SECRET: process.env.SOLAPI_API_SECRET,
    SMS_SENDER: process.env.SMS_SENDER,
  };
  let fetchCalls = 0;
  Date.now = () => Date.parse('2026-09-21T03:00:00.000Z');
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('customer send must not be reached');
  };
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
  process.env.SMS_SENDER = '0212345678';
  const calls = [];
  const db = {
    async execute(query) {
      calls.push(query);
      if (/RETURNING id/.test(query.sql)) return { rows: [{ id: ORDER.id }] };
      if (/SELECT COUNT\(\*\)::int AS n/.test(query.sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  };

  try {
    const result = await maybeNotify(db, {
      ...ORDER,
      quantity: null,
      phone: '01012345678',
      track_token: 'test-token',
    }, 'ordered');
    assert.equal(result.ok, false);
    assert.match(result.error, /수량 확인.*발송하지 않았/);
    assert.equal(fetchCalls, 0);
    assert.ok(calls.some(({ args = [] }) => args.some((value) => (
      typeof value === 'string' && value.includes('수량 확인')
    ))));
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// 고객 조회 페이지(/track/:token)에도 품명이 나가지 않아야 한다.
// 화면에서 빼는 것만으로는 API 응답에 남아 링크로 값이 보인다.
test('고객 조회 API 응답에 품명이 들어가지 않는다', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../api/track/[token].js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('return res.json({'));

  assert.doesNotMatch(body, /^\s*product_type:/m, '응답에 품명을 담으면 안 된다');
  assert.match(body, /door_type: order\.door_type \|\| null/, '문형은 그대로 내려준다');
  assert.match(body, /size: \{ width: order\.width/, '규격은 그대로 내려준다');
});

test('고객 조회 화면과 문의 복사 텍스트에 품명이 없다', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../src/pages/TrackPage.jsx', import.meta.url), 'utf8');
  const code = page.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('{/*')).join('\n');

  assert.doesNotMatch(code, /data\.product_type/, '화면이 품명을 읽으면 안 된다');
  assert.doesNotMatch(code, /data\?\.product_type/, '문의 복사 텍스트도 품명을 읽으면 안 된다');
});

test('고객 조회 API와 화면은 내부 납기 대신 고객 예상 출고일을 사용한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const api = await readFile(new URL('../api/track/[token].js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/pages/TrackPage.jsx', import.meta.url), 'utf8');
  const responseBody = api.slice(api.indexOf('return res.json({'));

  assert.match(api, /customerExpectedShipDate\(order\)/, '조회 API가 공통 고객 출고일 계산을 써야 한다');
  assert.match(responseBody, /^\s*expected_ship_date:/m, '고객 예상 출고일을 별도 필드로 내려야 한다');
  assert.match(
    responseBody,
    /^\s*due_date: delivery_status === 'adjusting' \? null : expected_ship_date,/m,
    '구형 화면 호환 필드에도 내부 납기가 아닌 고객 예상 출고일을 내려야 한다',
  );
  assert.match(page, /data\.expected_ship_date \|\| data\.due_date/, '조회 화면은 새 필드를 우선하고 구형 API도 허용해야 한다');
  assert.doesNotMatch(page, /예상 출고\(납기\)일/, '고객 화면에서 내부 납기 용어를 제거해야 한다');
});
