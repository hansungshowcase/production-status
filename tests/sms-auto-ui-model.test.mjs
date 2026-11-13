import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoConditionLine, autoConfirmLine, autoStatusLine, buildSaveBody, ensureAutoSection, imageUrlsFromItem, myTextSection,
  formInitialFromItem, normalizeDays, testPhoneDigits, toggleRejectText, validateTextForm,
} from '../src/components/smsconsole/smsTextTemplateFormModel.js';

test('저장 요청: 사진은 images 배열(최대 3), auto 는 일수 1~365', () => {
  const body = buildSaveBody({ name: 'a', body: 'b', images: [{ data: 'A', url: 'x' }, { data: 'B' }, { data: 'C' }, { data: 'D' }], auto: { kind: 'ship_plus_days', days: '20' } });
  assert.deepEqual(body.images, [{ data: 'A' }, { data: 'B' }, { data: 'C' }]);
  assert.deepEqual(body.auto, { kind: 'ship_plus_days', days: 20 });
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', images: [], auto: { kind: '', days: '20' } }), { name: 'a', body: 'b', auto: { kind: '' } });
  assert.equal(normalizeDays('0'), null);
  assert.equal(normalizeDays('366'), null);
  assert.equal(normalizeDays('365'), 365);
  assert.equal(validateTextForm({ name: 'a', body: '가', autoKind: 'ship_plus_days', days: '' }).reason, 'days');
});

test('카드 글: 조건 한 줄·현황 한 줄·켜기 거절 이유·확인 줄', () => {
  const section = myTextSection([{ id: 1, name: 'A', body: 'x', image_count: 2, auto_kind: 'ship_plus_days', auto_days: 20, auto_enabled: false }, { id: 2, name: 'B', body: 'y', has_image: true }]);
  assert.equal(autoConditionLine(section.items[0]), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  assert.equal(section.items[0].imageCount, 2);
  assert.equal(section.items[1].imageCount, 1);
  assert.equal(autoConditionLine(section.items[1]), '');
  assert.equal(autoStatusLine({ enabled: true, today_targets: 3, sent_7d: 12, sent_total: 40, uncertain_total: 0, last_sent_date: '2026-11-20' }), '켜짐 · 오늘 대상 3 · 최근 7일 12 · 누적 40 · 확인 필요 0 · 마지막 11/20');
  assert.match(autoStatusLine({ enabled: false }), /^꺼짐 .*마지막 없음$/);
  assert.match(toggleRejectText('no_ad_prefix'), /\(광고\)/);
  assert.match(toggleRejectText('no_optout_080'), /080/);
  assert.equal(autoConfirmLine({ targets: 3, parts: 2, cost: 1500 }), '오늘 대상 3명 · 1명당 2통 · 예상 비용 1,500원');
});

test('사진 여러 장 조회, 시험 번호, 발송 중 묶음에 자동 문구 칸 만들기', () => {
  assert.deepEqual(imageUrlsFromItem({ images: ['A', 'B'] }), ['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B']);
  assert.deepEqual(imageUrlsFromItem({ image: 'A' }), ['data:image/jpeg;base64,A']);
  assert.equal(testPhoneDigits('010-1234-5678'), '01012345678');
  assert.equal(testPhoneDigits('123'), '');
  const made = ensureAutoSection([{ group: '직원', count: 1, kinds: [] }], 1);
  assert.equal(made.find((aud) => aud.group === '고객').kinds[0].kind, '이벤트·혜택');
  const base = [{ group: '고객', count: 1, kinds: [{ kind: '이벤트·혜택', items: [1] }] }];
  assert.equal(ensureAutoSection(base, 1), base);
  assert.equal(ensureAutoSection(base, 0), base);
});

test('발송 조건 확장: 기본값 카드 글자 유지, 반복·시작일 덧붙임, 주문 기준, 저장 본문, 범위 밖 거절', () => {
  const base = { id: 1, name: 'A', body: 'x', auto_kind: 'ship_plus_days', auto_days: 20, auto_repeat: 1, auto_interval: 30 };
  assert.equal(autoConditionLine(myTextSection([base]).items[0]), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  const more = myTextSection([{ ...base, auto_kind: 'order_plus_days', auto_send_from: '2026-11-20', auto_repeat: 3, auto_interval: 30 }]).items[0];
  assert.equal(more.autoKind, 'order_plus_days');
  assert.equal(autoConditionLine(more), '주문 등록 후 20일 뒤 · 오전 10시 · 고객 · 11/20부터 · 3번(30일 간격)');
  const saved = buildSaveBody({ id: 7, name: 'a', body: 'b', auto: { kind: 'order_plus_days', days: '5', sendFrom: '2026-11-20', repeat: '3', interval: '14' } });
  assert.equal(saved.id, 7);
  assert.deepEqual(saved.auto, { kind: 'order_plus_days', days: 5, send_from: '2026-11-20', repeat: 3, interval: 14 });
  const ok = { name: 'a', body: '가', autoKind: 'ship_plus_days', days: '20' };
  assert.equal(validateTextForm({ ...ok, repeat: '11', interval: '30' }).reason, 'repeat');
  assert.equal(validateTextForm({ ...ok, repeat: '2', interval: '0' }).reason, 'interval');
  assert.equal(validateTextForm({ ...ok, repeat: '1', interval: '0' }).ok, true);
  assert.equal(validateTextForm({ ...ok, sendFrom: '2026-13-40' }).reason, 'sendFrom');
  assert.equal(formInitialFromItem({ id: 7, name: 'n', body: 'b', images: ['A'], auto_kind: 'ship_plus_days', auto_days: 20 }).images[0].url, 'data:image/jpeg;base64,A');
});

test('기준일형: 카드 줄·offset 부호·직원 0명 거절·변수 목록·1단계 줄 불변', async () => {
  const m = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const staffCard = m.myTextSection([{ id: 1, name: 'A', body: 'x', auto_kind: 'due_date', auto_offset: -3, auto_unless_step: '용접작업', auto_audience: 'staff', auto_staff: [1, 2] }]).items[0];
  assert.equal(autoConditionLine(staffCard), '납기일 3일 전 · 오전 10시 · 직원 2명 · 용접작업 미완료만');
  assert.equal(autoConditionLine(m.myTextSection([{ id: 2, name: 'B', body: 'x', auto_kind: 'ship_scheduled', auto_offset: 0 }]).items[0]), '출고예정일 당일 · 오전 10시 · 고객');
  assert.equal(autoConditionLine(m.myTextSection([{ id: 3, name: 'C', body: 'x', auto_kind: 'due_date', auto_offset: 2 }]).items[0]), '납기일 2일 지남 · 오전 10시 · 고객');
  const sent = buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'due_date', offsetDir: 'before', offsetDays: '3', unlessStep: '용접작업', audience: 'staff', staff: [1, 2] } });
  assert.deepEqual(sent.auto, { kind: 'due_date', offset: -3, unless_step: '용접작업', audience: 'staff', staff: [1, 2] });
  assert.equal(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'ship_scheduled', offsetDir: 'same', offsetDays: '9' } }).auto.offset, 0);
  const base = { name: 'a', body: '가', autoKind: 'due_date', offsetDir: 'before', offsetDays: '3', audience: 'staff', staff: [] };
  assert.equal(validateTextForm(base).reason, 'staff');
  assert.equal(validateTextForm({ ...base, staff: [1] }).ok, true);
  assert.equal(validateTextForm({ ...base, audience: 'customer', offsetDays: '366' }).reason, 'offset');
  assert.deepEqual(m.autoVariables('due_date', 'customer'), ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크']);
  assert.equal(m.autoVariables('due_date', 'staff').at(-1), '제품');
  assert.deepEqual(m.autoVariables('ship_plus_days', 'customer'), ['고객명']);
  assert.equal(m.formInitialFromItem({ auto_kind: 'due_date', auto_offset: 4, auto_audience: 'staff', auto_staff: [3] }).offsetDir, 'after');
  assert.match(m.textFormStopText('info_has_ad_words'), /광고 낱말/);
});

test('즉시형: 카드 줄·공정 미선택 거절·저장 본문·변수·기존 줄 불변', async () => {
  const m = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const card = (item) => autoConditionLine(m.myTextSection([{ id: 1, name: 'A', body: 'x', ...item }]).items[0]);
  assert.equal(card({ auto_kind: 'order_created' }), '주문 등록 시 · 고객');
  assert.equal(card({ auto_kind: 'process_completed', auto_step: '포장', auto_audience: 'staff', auto_staff: [1, 2] }), '공정 완료 시(포장) · 직원 2명');
  assert.equal(card({ auto_kind: 'ship_plus_days', auto_days: 20 }), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  const base = { name: 'a', body: '가', autoKind: 'process_started', audience: 'customer', staff: [] };
  assert.equal(validateTextForm(base).reason, 'step');
  assert.equal(validateTextForm({ ...base, step: '포장' }).ok, true);
  assert.equal(validateTextForm({ ...base, autoKind: 'order_created' }).ok, true);
  assert.equal(validateTextForm({ ...base, step: '포장', audience: 'staff' }).reason, 'staff');
  assert.equal(m.textFormStopText('step'), '공정을 골라 주세요');
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'process_completed', step: '포장', audience: 'staff', staff: [1, 2], days: '5' } }).auto, { kind: 'process_completed', step: '포장', audience: 'staff', staff: [1, 2] });
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'order_created', step: '포장', audience: 'customer' } }).auto, { kind: 'order_created', step: '', audience: 'customer', staff: [] });
  assert.equal(m.autoVariables('order_created', 'customer').length, 6);
  assert.equal(m.autoVariables('process_started', 'staff').length, 7);
  assert.equal(m.formInitialFromItem({ auto_kind: 'process_completed', auto_step: '포장' }).step, '포장');
});

test('자사몰 회원가입 시: 카드 줄·저장 본문·변수 없음·거절 글·기존 줄 불변', async () => {
  const m = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const card = (item) => autoConditionLine(m.myTextSection([{ id: 1, name: 'A', body: 'x', ...item }]).items[0]);
  assert.equal(card({ auto_kind: 'member_joined' }), '자사몰 회원가입 시 · 고객');
  assert.equal(card({ auto_kind: 'order_created' }), '주문 등록 시 · 고객');
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'member_joined', days: '5', step: '포장', audience: 'staff', staff: [1] } }).auto, { kind: 'member_joined' });
  assert.deepEqual(m.autoVariables('member_joined', 'customer'), []);
  assert.equal(validateTextForm({ name: 'a', body: '가', autoKind: 'member_joined' }).ok, true);
  assert.equal(m.textFormStopText('cafe24_not_connected'), '카페24 연결이 아직 안 됐습니다');
  assert.equal(toggleRejectText('cafe24_not_connected'), '카페24 연결이 아직 안 됐습니다');
});

test('기준일형 확장: 매일 구간·평일만·미착수·영업담당·출고·납기일, 저장 본문·방향 복원·기존 줄 불변', async () => {
  const m = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const card = (item) => autoConditionLine(m.myTextSection([{ id: 1, name: 'A', body: 'x', ...item }]).items[0]);
  assert.equal(card({ auto_kind: 'due_date', auto_offset: -9, auto_daily: 'until', auto_weekdays: true, auto_unless_step: '용접작업', auto_unless_mode: 'started', auto_audience: 'staff', auto_staff: [1, 2] }), '납기일 9일 전부터 당일까지 매일 · 오전 10시 · 평일만 · 직원 2명 · 용접작업 미착수만');
  assert.equal(card({ auto_kind: 'due_date', auto_offset: 1, auto_daily: 'ongoing', auto_audience: 'sales' }), '납기일 1일 지난 뒤 매일 · 오전 10시 · 영업담당');
  assert.equal(card({ auto_kind: 'ship_or_due', auto_offset: -3 }), '출고·납기일 3일 전 · 오전 10시 · 고객');
  assert.equal(card({ auto_kind: 'due_date', auto_offset: -3, auto_unless_step: '용접작업' }), '납기일 3일 전 · 오전 10시 · 고객 · 용접작업 미완료만');
  const sent = buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'ship_or_due', offsetDir: 'before', offsetDays: '9', daily: true, weekdays: true, unlessStep: '용접작업', unlessMode: 'started', audience: 'sales', staff: [1] } });
  assert.deepEqual(sent.auto, { kind: 'ship_or_due', offset: -9, daily: 'until', weekdays: true, unless_step: '용접작업', unless_mode: 'started', audience: 'sales', staff: [] });
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'due_date', offsetDir: 'same', offsetDays: '5', daily: true, audience: 'customer' } }).auto, { kind: 'due_date', offset: 0, daily: 'ongoing', unless_step: '', audience: 'customer', staff: [] });
  assert.equal(m.formInitialFromItem({ auto_kind: 'due_date', auto_offset: -9, auto_daily: 'until' }).daily, true);
  assert.equal(m.formInitialFromItem({ auto_kind: 'due_date', auto_offset: 2, auto_daily: 'ongoing' }).offsetDir, 'after');
  assert.equal(m.formInitialFromItem({ auto_kind: 'due_date', auto_offset: 0, auto_daily: 'ongoing' }).daily, true);
  assert.equal(m.formInitialFromItem({ auto_kind: 'due_date', auto_offset: -3 }).daily, false);
  const base = { name: 'a', body: '가', autoKind: 'due_date', offsetDir: 'after', offsetDays: '1', daily: true, audience: 'sales', staff: [] };
  assert.equal(validateTextForm(base).ok, true);
  assert.equal(validateTextForm({ ...base, offsetDir: 'before', offsetDays: '0' }).reason, 'offset');
  assert.equal(m.autoVariables('ship_or_due', 'sales').length, 7);
});
