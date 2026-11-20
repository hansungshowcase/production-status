import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITION_GROUPS, buildSmsItems, compactLightLabel, conditionGroup, defaultSmsFilter, filterSmsItems, flowStepText, groupFlows, isAtaEntry, matchesSmsQuery, paginateRows, smsBadges, smsPills, sortByNameNumeric, sortSmsItems, splitMessageVars,
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
  assert.deepEqual(pills.map((p) => [p.id, p.count]), [['all', 6], ['in_use', 3]]);
  assert.deepEqual(filterSmsItems(items, 'in_use').map((i) => i.id), ['c2', 'i1', 'sms_delivery_block_admin_alert']);
  assert.equal(filterSmsItems(items, 'all').length, 6);
  assert.equal(defaultSmsFilter(items), 'all');
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
  assert.equal(conditionLine(staff('이시아 부장 (010****4237)'), registry), '이시아 부장 (4237)에게 · V-커팅 완료 시');
  assert.equal(conditionLine(staff('아무도 없음'), registry), '받는 직원 없음 · V-커팅 완료 시');
  assert.equal(conditionLine(staff('관리자 지정 번호 (010****4237)'), registry), '관리자 지정 번호 (4237)로 · V-커팅 완료 시');
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

test('sortByNameNumeric: 내 문구는 숫자 인식 순서', () => {
  const names = ['40일', '20일', '2일', '0일', '3일', '10일'].map((name) => ({ name }));
  assert.deepEqual(sortByNameNumeric(names).map((e) => e.name), ['0일', '2일', '3일', '10일', '20일', '40일']);
});

test('조건 거르기 분류: 내 문구는 autoKind, 항목은 조건 글·이름 낱말', () => {
  assert.equal(conditionGroup({ autoKind: 'lead_plus_days', autoDays: 0, name: 'a' }), '가입·문의');
  assert.equal(conditionGroup({ autoKind: 'member_joined', name: 'a' }), '가입·문의');
  assert.equal(conditionGroup({ autoKind: 'order_created', name: 'a', autoAudience: 'staff' }), '주문 등록');
  assert.equal(conditionGroup({ autoKind: 'process_completed', autoStep: '조립작업', name: 'a' }), '공정');
  assert.equal(conditionGroup({ autoKind: 'ship_or_due', autoOffset: -1, name: 'a' }), '납기·출고예정일');
  assert.equal(conditionGroup({ autoKind: 'ship_plus_days', autoDays: 20, name: 'a' }), '출고 완료');
  assert.equal(conditionGroup({ name: '일반', preview: '안녕' }), '조건 없음');
  assert.equal(conditionGroup({ name: '출고 완료 안내', trigger: '출고 완료 시', audience: { id: 'customer' } }), '출고 완료');
  assert.equal(conditionGroup({ name: '기타', trigger: '', audience: { id: 'customer' } }), '조건 없음');
  // '주문의'는 문의가 아니고, '작업지시서'는 공정이 아니고, 날짜 기준 알림은 공정 조건이 붙어도 날짜 묶음
  assert.equal(conditionGroup({ name: '제작 시작 안내', trigger: '주문의 첫 공정인 도면설계가 실제 시작될 때' }), '공정');
  assert.equal(conditionGroup({ name: '주문 접수 안내', trigger: '주문 생성 또는 작업지시서 등록 시 멱등 발송' }), '주문 등록');
  assert.equal(conditionGroup({ name: '조립 작업 납기 알림', trigger: '생산중 · 납기 0~4일 · 조립작업 미완료' }), '납기·출고예정일');
  assert.equal(CONDITION_GROUPS.at(-1), '조건 없음');
});

test('흐름 묶기: 대상이 다른 가입·문의 문구는 다른 흐름 — 회원가입 후·견적 문의 후, 대상이 없으면 예전 이름', () => {
  const mkLead = (id, source) => ({ id, name: id, autoKind: 'lead_plus_days', autoDays: 0, autoAudience: 'customer', autoLeadSource: source });
  const flows = groupFlows([mkLead('a', 'cafe24'), mkLead('b', 'airtable'), mkLead('c', '')]);
  assert.deepEqual(flows.map((f) => f.label), ['회원가입 후', '견적 문의 후', '가입·문의 후']);
  assert.equal(new Set(flows.map((f) => f.key)).size, 3);
});

test('흐름 묶기: 가입·문의 10 + 출고 2 + 조건 없음 1 → 흐름 2 + 단일 1, 일수 순, 켜짐 수', () => {
  const lead = [40, 0, 2, 3, 4, 5, 6, 7, 8, 20].map((d) => ({ id: `l${d}`, name: `${d}일`, autoKind: 'lead_plus_days', autoDays: d, autoAudience: 'customer', autoEnabled: d === 2, autoAtaTemplate: d === 3 ? 'T' : '' }));
  const ship = [20, 3].map((d) => ({ id: `s${d}`, name: `출고 ${d}`, autoKind: 'ship_plus_days', autoDays: d, autoAudience: 'customer', autoEnabled: false }));
  const plain = { id: 'p1', name: '일반', preview: '안녕' };
  const flows = groupFlows([lead[0], plain, ...lead.slice(1), ...ship]);
  assert.equal(flows.length, 3);
  assert.equal(flows.filter((f) => f.single).length, 1);
  const [f1, , f2] = [flows[0], flows[1], flows[2]];
  assert.equal(f1.label, '가입·문의 후');
  assert.deepEqual(f1.steps.map((s) => flowStepText(s)), ['당일', '2일', '3일', '4일', '5일', '6일', '7일', '8일', '20일', '40일']);
  assert.equal(f1.total, 10);
  assert.equal(f1.on, 1);
  assert.equal(f1.via, '알림톡');
  assert.equal(f2.label, '출고 완료 후');
  assert.deepEqual(f2.steps.map((s) => s.id), ['s3', 's20']);
  assert.equal(groupFlows(ship, () => true)[0].on, 2);
  assert.equal(flowStepText({ autoKind: 'due_date', autoOffset: -3 }), '3일 전');
  assert.equal(flowStepText({ autoKind: 'ship_or_due', autoOffset: 2 }), '2일 지남');
  assert.equal(flowStepText({ autoKind: 'process_completed', autoStep: '조립작업' }), '조립작업');
  assert.equal(flowStepText({ autoKind: 'order_created' }), '즉시');
  assert.equal(isAtaEntry({ autoKind: 'member_joined', autoAtaTemplate: 'KA01' }), true);
  assert.equal(isAtaEntry({ autoKind: 'member_joined', autoAtaTemplate: '' }), false);
  assert.equal(isAtaEntry({ autoKind: '', autoAtaTemplate: '' }), false);
  assert.equal(isAtaEntry({ autoKind: 'ship_plus_days', autoAtaTemplate: 'BMS_FREE' }), false); // 브랜드메시지는 문자 목록에 보인다
});

test('matchesSmsQuery: 이름·본문·조건·보내는 곳 대소문자 무시 검색', () => {
  const autoRow = {
    name: '소개 혜택 안내',
    body: '안녕하세요 #{고객명} 대표님\n계약금액의 10% 지급',
    autoKind: 'ship_plus_days',
    autoDays: 20,
    autoAudience: 'customer',
  };
  const extRow = {
    name: '주의사항 안내(이미지 문자)',
    sender: '메이크',
    trigger: '매일 18:00 · 구글시트에 새 행이 올라오면',
    who: '고객',
    audience: { id: 'customer', label: '고객' },
    external: true,
    body: '[사진 첨부] 한성쇼케이스 주의사항 안내',
    scenario: '한성쇼케이스 주의사항 안내문자',
  };
  assert.equal(matchesSmsQuery(autoRow, ''), true);
  assert.equal(matchesSmsQuery(autoRow, '  소개  '), true);
  assert.equal(matchesSmsQuery(autoRow, '10% 지급'), true);
  assert.equal(matchesSmsQuery(autoRow, '출고 완료 후'), true);
  assert.equal(matchesSmsQuery(autoRow, '없는단어'), false);
  assert.equal(matchesSmsQuery(extRow, '메이크'), true);
  assert.equal(matchesSmsQuery(extRow, '구글시트'), true);
  assert.equal(matchesSmsQuery(extRow, '없는단어'), false);
});

test('splitMessageVars: #{변수} 조각 분리 및 빈 문자열 처리', () => {
  assert.deepEqual(splitMessageVars(''), []);
  assert.deepEqual(splitMessageVars('안녕 #{고객명}님, 주문 #{주문번호} 확인'), [
    { text: '안녕 ', isVar: false },
    { text: '#{고객명}', isVar: true },
    { text: '님, 주문 ', isVar: false },
    { text: '#{주문번호}', isVar: true },
    { text: ' 확인', isVar: false },
  ]);
  assert.deepEqual(splitMessageVars('변수 없음'), [{ text: '변수 없음', isVar: false }]);
});

test('compactLightLabel: 목록 신호등 짧은 라벨 반환', () => {
  assert.equal(compactLightLabel({ tone: 'on', text: '켜짐' }), '켜짐');
  assert.equal(compactLightLabel({ tone: 'off', text: '꺼짐' }), '꺼짐');
  assert.equal(compactLightLabel({ tone: 'part', text: '켜짐 · 080 수신거부 줄 필요(발송은 계속)' }), '켜짐(주의)');
  assert.equal(compactLightLabel({ tone: 'blocked', text: '켜짐(막힘: 발송 업체 설정 없음)' }), '발송 막힘');
  assert.equal(compactLightLabel({ tone: 'unknown', text: '확인 중' }), '확인 중');
  assert.equal(compactLightLabel(null), '확인 안 됨');
});
