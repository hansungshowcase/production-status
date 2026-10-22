import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNotificationCatalog } from '../api/_lib/notificationOverview.js';
import { buildNotificationExample } from '../api/_lib/notificationExamples.js';
import { OVERDUE_REMINDER_DEFINITIONS } from '../api/_lib/overdueReminders.js';

const NOW = new Date('2026-10-15T03:00:00.000Z');

test('알려진 모든 알림은 실제 순수 빌더의 비어 있지 않은 가상 문자 예시를 제공한다', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('example generation must not send'); };
  try {
    const items = buildNotificationCatalog({}, NOW).flatMap(group => group.items);
    for (const item of items) {
      assert.ok(item.example_message, item.id);
      assert.equal(item.example_message.source, 'sample');
      assert.ok(item.example_message.subject.trim(), item.id);
      assert.ok(item.example_message.text.trim(), item.id);
    }
    assert.equal(items.find(item => item.id === 'customer_shipped').example_message.label, '중단된 알림의 문구 예시');
    for (const item of items.filter(item => item.id !== 'customer_shipped')) {
      assert.equal(item.example_message.label, '문자 예시 · 가상 정보');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('예시는 실제 전화번호·인증값 없이 가상 주문 1건과 안전한 조회 자리표시자만 사용한다', () => {
  const serialized = JSON.stringify(buildNotificationCatalog({}, NOW).flatMap(group => group.items).map(item => item.example_message));
  assert.match(serialized, /가상/);
  assert.match(serialized, /1대/);
  assert.match(serialized, /EXAMPLE-NOT-A-REAL-TOKEN/);
  assert.doesNotMatch(serialized, /010[- ]?\d{4}[- ]?\d{4}/);
  for (const secret of ['configured', '010-7346-7407', '010-7731-4237', '010-4221-4237']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test('정의에 추가된 납기 경과 종류는 별도 예시 목록 수정 없이 기존 빌더로 생성된다', () => {
  for (const definition of Object.values(OVERDUE_REMINDER_DEFINITIONS)) {
    const example = buildNotificationExample({ milestone: definition.kind, policy: { status: 'active' } }, NOW);
    assert.match(example.subject, new RegExp(definition.title));
    assert.match(example.text, /가상 거래처/);
    assert.match(example.text, /주문 #1001/);
  }
  const unshipped = buildNotificationExample({
    milestone: OVERDUE_REMINDER_DEFINITIONS.UNSHIPPED.kind,
    policy: { status: 'active' },
  }, NOW);
  assert.match(unshipped.text, /납기 2026-10-20 \| 11일 지연/);
});
