import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMessage } from '../api/_lib/notify.js';

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
    { ...ORDER, width: null, depth: null, height: null, door_type: null },
    'ordered',
    '',
  );
  assert.match(text, /- 규격:/);
  assert.match(text, /- 수량: 1대/);
  assert.match(text, /- 예상 출고일: 2026-08-21/);
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
