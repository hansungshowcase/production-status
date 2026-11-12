import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmsItems, defaultSmsFilter, filterSmsItems, smsBadges, smsPills, sortSmsItems,
} from '../src/components/smsconsole/smsTemplateListModel.js';

const mk = (id, total, extra = {}) => ({
  id, name: `문구 ${id}`, trigger: '상황', policy: { status: 'active', label: '정책 사용' },
  configuration: { status: 'ready', label: '발송 설정 완료' }, example_message: { text: '예시' },
  recent: { state: total === null ? 'unavailable' : 'available', counts: { total: total ?? 0 } }, ...extra,
});
const overview = {
  groups: [
    { id: 'customer', items: [mk('c1', 0), mk('c2', 5), mk('c3', 0, { policy: { status: 'paused', label: '정책 중단' } })] },
    { id: 'internal', items: [mk('i1', 5), mk('sms_delivery_block_admin_alert', 2, { configuration: { status: 'incomplete', label: '설정 미완료' } }), mk('i3', null)] },
  ],
};

test('카탈로그 → 목록: 대상 칩·건수', () => {
  const items = buildSmsItems(overview);
  assert.equal(items.length, 6);
  assert.equal(items[0].audience.label, '고객');
  assert.equal(items[3].audience.label, '직원');
  assert.equal(items[4].audience.label, '관리자');
  assert.equal(items[5].count, null);
  assert.deepEqual(buildSmsItems(null), []);
});

test('발송 중 판정·알약·필터·처음 선택', () => {
  const items = buildSmsItems(overview);
  const pills = smsPills(items);
  assert.deepEqual(pills.map((p) => [p.id, p.count]), [['in_use', 3], ['all', 6]]);
  assert.deepEqual(filterSmsItems(items, 'in_use').map((i) => i.id), ['c2', 'i1', 'sms_delivery_block_admin_alert']);
  assert.equal(filterSmsItems(items, 'all').length, 6);
  assert.equal(defaultSmsFilter(items), 'in_use');
  assert.equal(defaultSmsFilter(buildSmsItems({ groups: [{ id: 'customer', items: [mk('x', 0)] }] })), 'all');
});

test('정렬: 7일 건수 많은 순, 같으면 카탈로그 순서', () => {
  const sorted = sortSmsItems(buildSmsItems(overview));
  assert.deepEqual(sorted.map((i) => i.id), ['c2', 'i1', 'sms_delivery_block_admin_alert', 'c1', 'c3', 'i3']);
});

test('배지: 건수·정책 중단·설정 미완료', () => {
  const items = buildSmsItems(overview);
  assert.deepEqual(smsBadges(items[1]), [{ tone: 'warn', text: '최근 7일 5건' }]);
  assert.equal(smsBadges(items[0])[0].text, '최근 7일 0건');
  assert.equal(smsBadges(items[2])[1].text, '정책 중단');
  assert.equal(smsBadges(items[4])[1].text, '설정 미완료');
  assert.equal(smsBadges(items[5])[0].text, '사용 여부 확인 못 함');
});
