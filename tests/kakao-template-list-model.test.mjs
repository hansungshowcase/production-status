import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultStatusFilter, filterTemplates, statusCounts, statusPills, usageCount, usageBadge, availableActions,
  deleteDecision, deleteConfirmed, formatDate, isValidRename, splitVariables,
} from '../src/components/smsconsole/templateListModel.js';

const items = [
  { id: 'KA01A', name: '배송 안내', status: 'APPROVED', supported: true, editable: false },
  { id: 'KA01B', name: '견적 Quote', status: 'PENDING', supported: true, editable: true },
  { id: 'KA01C', name: '반려됨', status: 'REJECTED', supported: false, editable: false },
  { id: 'KA01D', name: '검수중', status: 'INSPECTING' },
];

test('검색은 이름·ID, 대소문자 무시, 상태 거르기와 함께', () => {
  assert.equal(filterTemplates(items, { query: 'quote' }).length, 1);
  assert.equal(filterTemplates(items, { query: 'ka01' }).length, 4);
  assert.equal(filterTemplates(items, { query: '', status: 'APPROVED' }).length, 1);
  assert.equal(filterTemplates(items, { query: '배송', status: 'PENDING' }).length, 0);
  assert.deepEqual(filterTemplates(null), []);
});

test('상태 건수와 알약', () => {
  assert.deepEqual(statusCounts(items), { all: 4, APPROVED: 1, INSPECTING: 1, PENDING: 1, REJECTED: 1 });
  const pills = statusPills(items);
  assert.equal(pills[0].label, '전체');
  assert.equal(pills[1].label, '승인');
  assert.equal(pills.length, 5);
});

test('사용량 건수·배지', () => {
  const usage = { partial: false, by_template: { KA01A: { count: 3 } } };
  assert.equal(usageCount(usage, 'KA01A'), 3);
  assert.equal(usageCount(usage, 'KA01B'), 0);
  assert.equal(usageCount(null, 'KA01A'), null);
  assert.equal(usageBadge(usage, 'KA01A').text, '최근 7일 3건');
  assert.equal(usageBadge(usage, 'KA01B'), null);
  assert.equal(usageBadge(null, 'KA01B').text, '사용 여부 확인 못 함');
  assert.equal(usageCount({ partial: true, by_template: {} }, 'X'), null);
});

test('⋮ 동작은 상태별', () => {
  assert.deepEqual(availableActions(items[0]), ['rename', 'today_log', 'delete']);
  assert.deepEqual(availableActions(items[1]), ['inspect', 'edit', 'rename', 'today_log', 'delete']);
  assert.deepEqual(availableActions(items[2]), ['inspect', 'rename', 'today_log', 'delete']);
  assert.deepEqual(availableActions(items[3]), ['cancel_inspect', 'rename', 'today_log', 'delete']);
  assert.deepEqual(availableActions(null), []);
});

test('삭제 판정', () => {
  const ok = { by_template: {} };
  assert.equal(deleteDecision(items[1], ok).allowed, true);
  assert.equal(deleteDecision(items[1], { by_template: { KA01B: { count: 1 } } }).reason, 'in_use');
  assert.equal(deleteDecision(items[1], null).reason, 'unknown');
  assert.equal(deleteConfirmed(items[0], '배송 안내'), true);
  assert.equal(deleteConfirmed(items[0], '배송안내'), false);
  assert.equal(deleteConfirmed(null, 'x'), false);
});

test('날짜는 한국 시간 YYYY.MM.DD', () => {
  assert.equal(formatDate('2026-11-10T16:00:00Z'), '2026.11.11');
  assert.equal(formatDate('2026-11-10T14:00:00.000Z'), '2026.11.10');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('abc'), '');
});

test('이름 변경 길이와 변수 쪼개기', () => {
  assert.equal(isValidRename(''), false);
  assert.equal(isValidRename('a'.repeat(100)), true);
  assert.equal(isValidRename('a'.repeat(101)), false);
  assert.deepEqual(splitVariables('안녕 #{이름}님'), [
    { text: '안녕 ', variable: false }, { text: '#{이름}', variable: true }, { text: '님', variable: false }]);
  assert.deepEqual(splitVariables(''), []);
});

test('deleteDecision: 프로그램 알림에 쓰는 템플릿(program_use)은 사용량 0이어도 지울 수 없다', async () => {
  const { deleteDecision } = await import('../src/components/smsconsole/templateListModel.js');
  const usage = { by_template: {}, partial: false };
  assert.deepEqual(deleteDecision({ id: 'A', program_use: true }, usage), { allowed: false, reason: 'program', count: 0 });
  assert.equal(deleteDecision({ id: 'A' }, usage).allowed, true);
});

test('발송 중 알약·필터(최근 7일 1건 이상)', () => {
  const usage = { partial: false, by_template: { KA01A: { count: 3 }, KA01B: { count: 0 } } };
  const pills = statusPills(items, usage);
  assert.equal(pills[0].id, 'in_use');
  assert.equal(pills[0].label, '발송 중');
  assert.equal(pills[0].count, 1);
  assert.equal(pills[1].id, 'all');
  assert.deepEqual(filterTemplates(items, { status: 'in_use', usage }).map((i) => i.id), ['KA01A']);
  assert.equal(defaultStatusFilter(pills), 'in_use');
  // 사용량을 모르면 알약이 없고, 발송 중이 0개면 전체가 처음 선택
  assert.equal(statusPills(items, null)[0].id, 'all');
  assert.equal(defaultStatusFilter(statusPills(items, null)), 'all');
  assert.equal(defaultStatusFilter(statusPills(items, { by_template: {} })), 'all');
});

test('주소에 tpl 이 있고 발송 중이 아니면 전체로 시작', () => {
  const usage = { partial: false, by_template: { KA01A: { count: 3 } } };
  const pills = statusPills(items, usage);
  assert.equal(defaultStatusFilter(pills, '', usage), 'in_use');
  assert.equal(defaultStatusFilter(pills, 'KA01A', usage), 'in_use');
  assert.equal(defaultStatusFilter(pills, 'KA01B', usage), 'all');
});

// ---------- 대상(고객 전용 / 직원 전용) 묶기 ----------
import { templateAudienceKind, templateAudienceSections, readOnlyAudienceSections } from '../src/components/smsconsole/templateListModel.js';
import { KAKAO_TEMPLATE_AUDIENCE } from '../shared/smsTemplateKinds.js';

test('알림톡 대상 묶기: 합계 = 입력 수, 모르는 템플릿은 분류 안 됨, 빈 묶음 없음', () => {
  const tpls = [
    { id: 'KA01TP260708084934111VLwWvP3SNic' }, // 제작현황 고객 표
    { id: 'KA01TP260106022745294EhNvcRBVHm1' }, // EXTERNAL 직원
    { id: Object.keys(KAKAO_TEMPLATE_AUDIENCE)[0] }, // 새 표
    { id: 'KA01TPunknown' },
  ];
  const sections = templateAudienceSections(tpls);
  assert.equal(sections.reduce((n, s) => n + s.count, 0), tpls.length);
  assert.deepEqual(sections.map((s) => s.group), ['고객 전용', '직원 전용', '분류 안 됨']);
  assert.ok(sections.every((s) => s.kinds.every((k) => k.items.length > 0)));
  const unassigned = sections.find((s) => s.group === '분류 안 됨');
  assert.deepEqual(unassigned.kinds, [{ kind: '', items: [{ id: 'KA01TPunknown' }] }]);
  assert.deepEqual(templateAudienceSections([tpls[3]]).map((s) => s.group), ['분류 안 됨']);
  assert.deepEqual(templateAudienceSections([]), []);
});

test('알림톡 대상·종류 순서: 보낸 묶음 > 표 > 새 표 > 없음, 출고 문의 안내는 고객', () => {
  assert.deepEqual(templateAudienceKind('KA01TP260701025852899CSGPYIaCwGQ'), { audience: '고객', kind: '주문·출고 안내' });
  assert.deepEqual(templateAudienceKind('KA01TP260701025852899CSGPYIaCwGQ', [{ key: 'ship_inquiry', audience: '직원', kind: '직원 작업 알림' }]), { audience: '직원', kind: '직원 작업 알림' });
  assert.deepEqual(templateAudienceKind('nope'), { audience: '', kind: '' });
  for (const row of Object.values(KAKAO_TEMPLATE_AUDIENCE)) assert.ok(['고객', '직원'].includes(row.audience));
});

test('읽기 전용 구역 대상 나누기: 순서 유지', () => {
  const rows = [{ id: 'a', audience: '직원' }, { id: 'b', audience: '고객' }, { id: 'c', audience: '고객' }];
  assert.deepEqual(readOnlyAudienceSections(rows).map((s) => [s.group, s.items.map((i) => i.id)]), [['고객 전용', ['b', 'c']], ['직원 전용', ['a']]]);
});
