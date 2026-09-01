import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getKstDateKey,
  groupNotificationsByKstDate,
} from '../src/pages/smsHistoryFilters.js';

test('발송 시각은 한국 시간 날짜를 기준으로 구분한다', () => {
  assert.equal(getKstDateKey('2026-09-01T14:59:59.000Z'), '2026-09-01');
  assert.equal(getKstDateKey('2026-09-01T15:00:00.000Z'), '2026-09-02');
  assert.equal(getKstDateKey('잘못된 날짜'), 'unknown');
});

test('발송내역은 입력 순서를 보존하며 한국 시간 날짜별로 묶인다', () => {
  const groups = groupNotificationsByKstDate([
    { id: 1, sent_at: '2026-09-02T01:00:00.000Z' },
    { id: 2, sent_at: '2026-09-01T15:30:00.000Z' },
    { id: 3, sent_at: '2026-09-01T10:00:00.000Z' },
  ]);

  assert.deepEqual(groups.map(group => group.date), ['2026-09-02', '2026-09-01']);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [[1, 2], [3]]);
  assert.match(groups[0].label, /2026년 9월 2일/);
});
