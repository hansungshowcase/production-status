import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmsItems, defaultSmsFilter, filterSmsItems, paginateRows, smsBadges, smsPills, sortSmsItems,
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

// ---------- 대상(고객 전용 / 직원 전용) 묶기 · 받는 사람 한 줄 ----------
import { audienceSections, buildKindedItems, conditionLine, staffRecipientsPhrase } from '../src/components/smsconsole/smsTemplateListModel.js';

const person = (name, tail) => ({ name, tail });

test('대상 묶기: 모든 카드가 한 묶음에 한 번, 고객 안에 직원 0·직원 안에 고객 0', () => {
  const all = buildKindedItems(overview, null);
  for (const status of ['all', 'in_use']) {
    const sections = audienceSections(all, status);
    const shown = status === 'in_use' ? all.filter((i) => (i.count ?? 0) > 0) : all;
    const ids = sections.flatMap((s) => s.kinds.flatMap((k) => k.items.map((i) => i.id)));
    assert.equal(ids.length, shown.length);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(sections.reduce((n, s) => n + s.count, 0), shown.length);
    for (const s of sections) {
      for (const k of s.kinds) for (const i of k.items) {
        if (s.group === '고객 전용') assert.equal(i.audience.label, '고객');
        if (s.group === '직원 전용') assert.notEqual(i.audience.label, '고객');
      }
      assert.ok(s.kinds.length > 0 && s.kinds.every((k) => k.items.length > 0));
    }
  }
  assert.deepEqual(audienceSections(all, 'all').map((s) => s.group).slice(0, 2), ['고객 전용', '직원 전용']);
});

test('받는 직원 글: 0명·1명·3명·5명', () => {
  assert.equal(staffRecipientsPhrase([]), '받는 직원 없음');
  assert.equal(staffRecipientsPhrase([person('이시아 부장', '4237')]), '이시아 부장 (4237)');
  assert.equal(staffRecipientsPhrase([person('가', '1'), person('나', '2'), person('다', '3')]), '가, 나, 다');
  assert.equal(staffRecipientsPhrase([1, 2, 3, 4, 5].map((n) => person(`직원${n}`, `000${n}`))), '직원1 (0001), 직원2 (0002), 직원3 (0003) 외 2명');
});

test('조건 한 줄: 고객 who·trigger 조합, 직원 등록 현황', () => {
  const ext = (who, trigger) => ({ audience: { id: 'customer' }, external: true, who, trigger });
  assert.equal(conditionLine(ext('스마트스토어 구매 고객', '구매확정 시')), '스마트스토어 구매 고객 · 구매확정 시');
  assert.equal(conditionLine(ext('', '구매확정 시')), '구매확정 시');
  assert.equal(conditionLine(ext('스마트스토어 구매 고객', '')), '스마트스토어 구매 고객');
  assert.equal(conditionLine(ext('', '')), '');
  assert.equal(conditionLine({ audience: { id: 'customer' }, external: false, trigger: '포장 공정 완료 시' }), '제작 주문 고객 · 포장 공정 완료 시');
  const staff = (target) => ({ audience: { id: 'staff' }, external: false, trigger: 'V-커팅 완료 시', target });
  const registry = [person('이시아 부장', ''), person('최우석 이사', '')].map((p) => ({ name: p.name, phone_tail: p.name.startsWith('이') ? '4237' : '5110' }));
  assert.equal(conditionLine(staff('이시아 부장 (010****4237)'), registry), '이시아 부장 (4237)에게 발송 중 · V-커팅 완료 시');
  assert.equal(conditionLine(staff('아무도 없음'), registry), '받는 직원 없음 · V-커팅 완료 시');
  assert.equal(conditionLine(staff('관리자 지정 번호 (010****4237)'), registry), '관리자 지정 번호 (4237)로 발송 중 · V-커팅 완료 시');
  assert.equal(conditionLine(staff('이시아 부장 (010****4237)'), null), 'V-커팅 완료 시');
  assert.equal(conditionLine({ audience: { id: 'staff' }, external: true, who: '공장장', trigger: '3일 전' }), '공장장에게 발송 · 3일 전');
});

test('paginateRows: 10행씩 쪽 나누기, 쪽 번호는 범위로 고정', () => {
  const rows = Array.from({ length: 11 }, (_, i) => i);
  assert.deepEqual(paginateRows(rows, 1), { page: 1, pages: 2, rows: rows.slice(0, 10) });
  assert.deepEqual(paginateRows(rows, 2), { page: 2, pages: 2, rows: [10] });
  assert.equal(paginateRows(rows, 0).page, 1);
  assert.equal(paginateRows(rows, 9).page, 2);
  assert.deepEqual(paginateRows(rows.slice(0, 10), 5), { page: 1, pages: 1, rows: rows.slice(0, 10) });
  assert.deepEqual(paginateRows([], 3), { page: 1, pages: 1, rows: [] });
});
