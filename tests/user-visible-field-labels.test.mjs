import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  changedFieldKeys,
  describeFieldChanges,
  describeTableColumn,
  fieldLabel,
} from '../src/utils/fieldLabels.js';

const apiRoot = fileURLToPath(new URL('../api', import.meta.url));

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
  };
}

// 영업 수정 모달이 매번 보내는 전 필드 목록 (api/orders/[id]/index.js ORDER_FIELDS 중 모달이 채우는 것들)
const EDIT_MODAL_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name', 'phone',
  'delivery_address', 'freight_payment', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'sale_amount', 'balance', 'notes', 'remarks',
];

const STORED_ORDER = {
  id: 401,
  order_date: '2026-08-01',
  due_date: '2026-08-10',
  sales_person: '이준형',
  client_name: '○○상회',
  phone: '010-1234-5678',
  delivery_address: '서울시 강남구',
  freight_payment: '선불',
  product_type: '쇼케이스',
  door_type: '양문',
  design: '기본',
  width: 1200,
  depth: 600,
  height: 900,
  quantity: 1,
  color: '무광블랙',
  sale_amount: 3500000,
  balance: 0,
  notes: '기존 비고',
  remarks: null,
};

test('활동로그에는 실제로 값이 바뀐 필드만 한국어 라벨로 남는다', () => {
  // 모달이 19개 필드를 전부 보냈지만 납기일과 수량만 실제로 바뀐 저장 결과
  const updated = { ...STORED_ORDER, due_date: '2026-08-14', quantity: 3 };

  const changed = changedFieldKeys(STORED_ORDER, updated, EDIT_MODAL_FIELDS);
  assert.deepEqual(changed, ['due_date', 'quantity']);

  const description = describeFieldChanges(`${STORED_ORDER.client_name} 주문이 수정되었습니다.`, changed);
  assert.equal(description, '○○상회 주문이 수정되었습니다. (납기일, 수량)');
});

test('값이 그대로인 필드는 활동로그에서 빠진다', () => {
  const updated = { ...STORED_ORDER, notes: '새 비고' };
  const changed = changedFieldKeys(STORED_ORDER, updated, EDIT_MODAL_FIELDS);

  assert.deepEqual(changed, ['notes']);
  for (const untouched of EDIT_MODAL_FIELDS.filter(field => field !== 'notes')) {
    assert.equal(changed.includes(untouched), false, `${untouched} 는 안 바뀌었으므로 빠져야 한다`);
  }

  // 표기만 다른 숫자('1200' vs 1200)는 변경으로 보지 않는다 — 폼이 문자열로 보내기 때문.
  assert.deepEqual(
    changedFieldKeys(STORED_ORDER, { ...STORED_ORDER, width: '1200', quantity: '1' }, EDIT_MODAL_FIELDS),
    [],
  );
});

test('바뀐 게 없으면 필드 나열 자체가 붙지 않는다', () => {
  const changed = changedFieldKeys(STORED_ORDER, { ...STORED_ORDER }, EDIT_MODAL_FIELDS);
  assert.deepEqual(changed, []);

  const description = describeFieldChanges(`${STORED_ORDER.client_name} 주문이 수정되었습니다.`, changed);
  assert.equal(description, '○○상회 주문이 수정되었습니다.');
  assert.doesNotMatch(description, /[()]/);
});

test('활동로그 문구에는 DB 컬럼명이 절대 들어가지 않는다', () => {
  const updated = { ...STORED_ORDER, due_date: '2026-08-14', sales_person: '신은철', work_order_image_url: 'https://example.com/a.jpg' };
  const description = describeFieldChanges(
    `${STORED_ORDER.client_name} 주문이 수정되었습니다.`,
    changedFieldKeys(STORED_ORDER, updated, [...EDIT_MODAL_FIELDS, 'work_order_image_url']),
  );

  assert.equal(description, '○○상회 주문이 수정되었습니다. (납기일, 담당자, 작업지시서)');
  for (const column of [...EDIT_MODAL_FIELDS, 'work_order_image_url']) {
    assert.equal(description.includes(column), false, `${column} 컬럼명이 노출되면 안 된다`);
  }
});

test('사전생산 체크리스트도 실제로 토글된 항목만 한국어 라벨로 남는다', () => {
  const PRE_PROD_FIELDS = [
    'instruction_check', 'material_drawing', 'laser_drawing',
    'material_order_received', 'material_order_completed', 'material_received',
  ];
  const before = { instruction_check: 1, material_drawing: 0, laser_drawing: 0, material_order_received: 0, material_order_completed: 0, material_received: 0 };
  // 요청은 6개를 전부 보냈지만 실제로 바뀐 건 laser_drawing 하나
  const after = { ...before, laser_drawing: 1 };

  const changed = changedFieldKeys(before, after, PRE_PROD_FIELDS);
  assert.deepEqual(changed, ['laser_drawing']);
  assert.equal(
    describeFieldChanges('○○상회 사전생산 체크리스트가 수정되었습니다.', changed),
    '○○상회 사전생산 체크리스트가 수정되었습니다. (레이저 도면)',
  );
  assert.equal(
    describeFieldChanges('○○상회 사전생산 체크리스트가 수정되었습니다.', changedFieldKeys(before, before, PRE_PROD_FIELDS)),
    '○○상회 사전생산 체크리스트가 수정되었습니다.',
  );
});

test('주문 수정·사전생산 수정 핸들러가 변경 필드 비교 결과를 활동로그에 배선한다', async () => {
  const orderSource = await readFile(new URL('../api/orders/[id]/index.js', import.meta.url), 'utf8');
  assert.match(
    orderSource,
    /const changedFields = changedFieldKeys\(order, updated, Object\.keys\(mutation\)\);/,
    '저장 전(order)/후(updated)를 비교해 실제 변경 필드만 골라야 한다',
  );
  assert.match(orderSource, /describeFieldChanges\(`\$\{order\.client_name\} 주문이 수정되었습니다\.`, changedFields\)/);
  assert.doesNotMatch(orderSource, /changedFields = Object\.keys\(mutation\)/);
  assert.doesNotMatch(orderSource, /changedFields\.join/);

  const preProdSource = await readFile(new URL('../api/pre-production/[orderId].js', import.meta.url), 'utf8');
  assert.match(preProdSource, /changedFieldKeys\(beforeRow, updatedResult\.rows\[0\], touchedFields\)/);
  assert.match(preProdSource, /describeFieldChanges\(`\$\{order\.client_name\} 사전생산 체크리스트가 수정되었습니다\.`, changedFields\)/);
  assert.doesNotMatch(preProdSource, /changedFields\.join/);
});

// ---- (c) 사용자에게 보이는 에러 메시지 ----

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

test('api 가 내려주는 사용자 노출 메시지에는 DB 컬럼명·영문 식별자가 없다', () => {
  const messageLiteral = /message:\s*(?:'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`|"((?:\\.|[^"\\])*)")/g;
  const snakeCaseIdentifier = /\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/;
  const offenders = [];

  for (const file of walkJs(apiRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(messageLiteral)) {
      const text = match[1] ?? match[2] ?? match[3] ?? '';
      const hit = snakeCaseIdentifier.exec(text);
      if (hit) offenders.push(`${path.relative(apiRoot, file)}: "${text}" → ${hit[0]}`);
    }
  }

  assert.deepEqual(offenders, [], `사용자 메시지에 컬럼명이 새고 있다:\n${offenders.join('\n')}`);
});

test('필수값 누락 400 응답은 상태코드를 유지한 채 한국어 라벨로 안내한다', async () => {
  const originalPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;

  try {
    const { default: ordersHandler } = await import('../api/orders/index.js');
    const ordersRes = mockResponse();
    await ordersHandler(
      { method: 'POST', url: '/api/orders', headers: {}, socket: { remoteAddress: 'label-orders' }, body: {} },
      ordersRes,
    );
    assert.equal(ordersRes.statusCode, 400);
    assert.equal(ordersRes.body.error.status, 400);
    assert.match(ordersRes.body.error.message, /거래처/);
    assert.doesNotMatch(ordersRes.body.error.message, /client_name/);

    const { default: workersHandler } = await import('../api/workers/index.js');
    const workerNameRes = mockResponse();
    await workersHandler(
      { method: 'POST', url: '/api/workers', headers: {}, socket: { remoteAddress: 'label-worker-1' }, body: {} },
      workerNameRes,
    );
    assert.equal(workerNameRes.statusCode, 400);
    assert.match(workerNameRes.body.error.message, /이름/);
    assert.doesNotMatch(workerNameRes.body.error.message, /\bname\b/);

    const workerDeptRes = mockResponse();
    await workersHandler(
      { method: 'POST', url: '/api/workers', headers: {}, socket: { remoteAddress: 'label-worker-2' }, body: { name: '홍길동', department: '없는부서' } },
      workerDeptRes,
    );
    assert.equal(workerDeptRes.statusCode, 400);
    assert.match(workerDeptRes.body.error.message, /부서는 다음 중 하나여야 합니다/);
    assert.doesNotMatch(workerDeptRes.body.error.message, /department/);

    const { default: issuesHandler } = await import('../api/issues/index.js');
    const issueCases = [
      [{}, /주문 번호/, 'order_id'],
      [{ order_id: 1 }, /이슈 유형/, 'issue_type'],
      [{ order_id: 1, issue_type: '없는유형' }, /이슈 유형은 다음 중 하나여야 합니다/, 'issue_type'],
      [{ order_id: 1, issue_type: '기타' }, /등록자/, 'reported_by'],
    ];
    for (const [index, [body, expected, column]] of issueCases.entries()) {
      const res = mockResponse();
      await issuesHandler(
        { method: 'POST', url: '/api/issues', headers: {}, socket: { remoteAddress: `label-issue-${index}` }, body },
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.status, 400);
      assert.match(res.body.error.message, expected);
      assert.equal(res.body.error.message.includes(column), false, `${column} 컬럼명이 노출되면 안 된다`);
    }
  } finally {
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});

test('공정 시작 400 안내는 영문 식별자 대신 한국어를 쓴다', async () => {
  const originalPostgresUrl = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = 'postgres://user:pass@example.invalid/db';

  try {
    const { default: startHandler } = await import('../api/processes/[id]/start.js');
    for (const [index, [body, expected, identifier]] of [
      [{ actor: '작업자', assigned_worker: 5 }, /담당 작업자/, 'assigned_worker'],
      [{ actor: '작업자', assigned_team: 5 }, /담당 팀/, 'assigned_team'],
    ].entries()) {
      const res = mockResponse();
      await startHandler(
        {
          method: 'PATCH',
          url: '/api/processes/1/start',
          headers: {},
          query: { id: '1' },
          socket: { remoteAddress: `label-start-${index}` },
          body,
        },
        res,
      );
      assert.equal(res.statusCode, 400, '기존 400 판정은 그대로 유지되어야 한다');
      assert.equal(res.body.error.status, 400);
      assert.match(res.body.error.message, expected);
      assert.equal(res.body.error.message.includes(identifier), false);
      assert.doesNotMatch(res.body.error.message, /must be a string/);
    }
  } finally {
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});

test('작업지시서 검증 메시지는 컬럼명 없이 한국어 라벨만 쓴다', async () => {
  const { normalizeOrderCreateInput } = await import('../api/_lib/orderCreateInput.js');
  const validImageBackedOrder = {
    client_name: '한성 거래처',
    order_date: '2026-07-24',
    due_date: '2026-07-31',
    sales_person: '이준형',
    product_type: '쇼케이스',
    quantity: 1,
    work_order_image_url: 'https://example.com/work-order.jpg',
  };

  for (const [field, value, expected] of [
    ['client_name', '  ', /거래처/],
    ['order_date', '2026-02-29', /발주일/],
    ['due_date', '2026-04-31', /납기일/],
    ['product_type', ' ', /사양/],
    ['quantity', 0, /수량/],
  ]) {
    let thrown = null;
    try {
      normalizeOrderCreateInput({ ...validImageBackedOrder, [field]: value });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `${field} 는 거절되어야 한다`);
    assert.match(thrown.message, expected);
    assert.doesNotMatch(thrown.message, /\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/);
  }
});

// ---- (d) 관리자 진단 화면 ----

test('진단 화면 제목은 테이블.컬럼명 대신 한국어로 표시된다', async () => {
  assert.equal(describeTableColumn('activity_feed.description'), '활동 로그 · 내용');
  assert.equal(describeTableColumn('orders.client_name'), '주문 · 거래처');
  assert.equal(describeTableColumn('orders.notes'), '주문 · 비고');
  assert.equal(describeTableColumn('orders.remarks'), '주문 · 특이사항');
  assert.equal(describeTableColumn('issues.description'), '이슈 · 내용');

  for (const key of ['activity_feed.description', 'orders.client_name', 'orders.notes', 'orders.remarks', 'issues.description']) {
    assert.doesNotMatch(describeTableColumn(key), /[a-z_]{3,}/);
  }

  const source = await readFile(new URL('../src/components/admin/DiagnosticsSection.jsx', import.meta.url), 'utf8');
  assert.match(source, /describeTableColumn\(key\)/, '진단 화면은 원시 키를 그대로 뿌리면 안 된다');
  assert.doesNotMatch(source, /group-title">\{key\}</);
});

test('라벨 매핑은 한 곳에 모여 있고 주요 컬럼을 모두 덮는다', () => {
  const expected = {
    order_date: '발주일',
    due_date: '납기일',
    sales_person: '담당자',
    client_name: '거래처',
    phone: '전화번호',
    product_type: '사양',
    width: '가로',
    depth: '세로',
    height: '높이',
    quantity: '수량',
    color: '색상',
    notes: '비고',
    work_order_image_url: '작업지시서',
  };
  for (const [field, label] of Object.entries(expected)) {
    assert.equal(fieldLabel(field), label, `${field} 라벨`);
  }
});
