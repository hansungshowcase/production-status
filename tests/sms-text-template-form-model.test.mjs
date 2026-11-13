import assert from 'node:assert/strict';
import test from 'node:test';
import { autoConditionLine, autoConditionParts, buildSaveBody, mergeLayout, imageFromItem, myTextSection, normalizeKind, textFormStopText, validateTextForm } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

test('종류: 없거나 모르는 값은 문자, kakao 만 알림톡', () => {
  assert.equal(normalizeKind(undefined), 'sms');
  assert.equal(normalizeKind(null), 'sms');
  assert.equal(normalizeKind('x'), 'sms');
  assert.equal(normalizeKind('kakao'), 'kakao');
});

test('양식 검사: 이름 1~40자, 내용 있음, SMS/LMS 판정은 보내기 화면과 같다', () => {
  assert.equal(validateTextForm({ name: '', body: '가' }).ok, false);
  assert.equal(validateTextForm({ name: 'a'.repeat(41), body: '가' }).ok, false);
  assert.equal(validateTextForm({ name: 'a', body: '  ' }).ok, false);
  const sms = validateTextForm({ name: 'a', body: '가'.repeat(45) });
  assert.equal(sms.ok, true);
  assert.equal(sms.info.type, 'SMS');
  assert.equal(validateTextForm({ name: 'a', body: '가'.repeat(46) }).info.type, 'LMS');
  assert.equal(validateTextForm({ name: 'a', body: '가'.repeat(1001) }).ok, false);
});

test('저장 본문: 사진이 없으면 image 칸이 없다', () => {
  assert.deepEqual(buildSaveBody({ name: ' 이름 ', body: '내용' }), { name: '이름', body: '내용' });
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', image: { data: 'AAA', url: 'blob:x' } }), { name: 'a', body: 'b', image: { data: 'AAA' } });
});

test('내 문구 묶음: 0개면 없음, 미리보기 한 줄 60자, 사진 표시', () => {
  assert.equal(myTextSection([]), null);
  assert.equal(myTextSection(undefined), null);
  const section = myTextSection([{ id: 1, name: 'A', body: `첫 줄\n둘째 줄 ${'가'.repeat(80)}`, has_image: true }, { id: 2, name: 'B', body: 'x' }]);
  assert.equal(section.count, 2);
  assert.equal(section.items[0].hasImage, true);
  assert.equal(section.items[1].hasImage, false);
  assert.ok(!section.items[0].preview.includes('\n'));
  assert.ok([...section.items[0].preview].length <= 60);
});

test('단건 사진 → 미리보기 주소', () => {
  assert.equal(imageFromItem({ id: 1 }), null);
  const photo = imageFromItem({ image: 'QUJD' });
  assert.equal(photo.url, 'data:image/jpeg;base64,QUJD');
  assert.equal(photo.data, 'QUJD');
});

test('등록 막힘 안내: name·body·long 에 문구, 그 밖은 빈 글', () => {
  assert.equal(textFormStopText('name'), '이름을 입력해 주세요');
  assert.equal(textFormStopText('body'), '내용을 입력해 주세요');
  assert.equal(textFormStopText('long'), '내용이 너무 깁니다');
  assert.equal(textFormStopText(''), '');
  assert.equal(textFormStopText(undefined), '');
  assert.equal(textFormStopText('x'), '');
});

test('광고 표기: (광고)·080 수신거부 줄이 없을 때만 붙이고 서버 광고 검사 모양을 맞춘다', async () => {
  const { withAdFormat, moveImageEarlier, isAdKind, autoConfirmLine } = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const out = withAdFormat('안녕하세요 #{고객명}님');
  assert.equal(out, '(광고) 안녕하세요 #{고객명}님\n\n무료수신거부 080-500-4233');
  assert.equal(withAdFormat(out), out);
  assert.equal(withAdFormat('(광고) 본문\n무료 수신거부 080-123-4567'), '(광고) 본문\n무료 수신거부 080-123-4567');
  assert.equal(withAdFormat('  '), '  ');
  assert.equal(isAdKind('ship_plus_days'), true);
  assert.equal(isAdKind('due_date'), false);
  assert.match(autoConfirmLine({ parts: 2, cost: 220 }, 2), /1명당 2통\(사진 2장\)/);
  assert.match(autoConfirmLine({ parts: 1, cost: 110 }, 1), /1명당 1통 ·/);
  const a = { data: 'a' }; const b = { data: 'b' }; const c = { data: 'c' };
  assert.deepEqual(moveImageEarlier([a, b, c], 2), [a, c, b]);
  assert.deepEqual(moveImageEarlier([a, b, c], 0), [a, b, c]);
  const body = buildSaveBody({ name: 'n', body: 'x', images: moveImageEarlier([a, b], 1) });
  assert.deepEqual(body.images, [{ data: 'b' }, { data: 'a' }]);
});

test('사진 합치기 배치: 세로 사진은 가로 나란히·높이 같음, 가로 사진이 있으면 세로 쌓기, 한도 안', () => {
  const row = mergeLayout([{ width: 1000, height: 1414 }, { width: 1000, height: 1414 }], { maxEdge: 1500 });
  assert.equal(row.mode, 'row');
  assert.equal(row.rects[0].h, row.rects[1].h);
  assert.equal(row.rects[1].x, row.rects[0].w);
  assert.ok(row.width <= 1500 && row.height <= 1500);
  const col = mergeLayout([{ width: 1000, height: 1414 }, { width: 1500, height: 800 }], { maxEdge: 1500 });
  assert.equal(col.mode, 'column');
  assert.equal(col.rects[0].w, col.rects[1].w);
  assert.equal(col.rects[1].y, col.rects[0].h);
  assert.ok(col.width <= 1500 && col.height <= 1500);
});

test('발송 조건 조각: 11가지 조건 모두 조각을 이으면 autoConditionLine 과 같다', () => {
  const entries = [
    { autoKind: 'ship_plus_days', autoDays: 20, autoSendFrom: '2026-12-05', autoRepeat: 3, autoInterval: 30 },
    { autoKind: 'order_plus_days', autoDays: 7 },
    { autoKind: 'due_date', autoOffset: -3, autoDaily: '', autoAudience: 'customer' },
    { autoKind: 'ship_scheduled', autoOffset: 0, autoWeekdays: true, autoAudience: 'staff', autoStaffCount: 2 },
    { autoKind: 'ship_or_due', autoOffset: 2, autoDaily: 'ongoing', autoAudience: 'sales', autoUnlessStep: '조립작업', autoUnlessMode: 'started' },
    { autoKind: 'order_created', autoAudience: 'staff', autoStaffCount: 1 },
    { autoKind: 'process_started', autoStep: '재단' },
    { autoKind: 'process_completed', autoStep: '조립작업', autoAudience: 'staff', autoStaffCount: 3 },
    { autoKind: 'member_joined' },
    { autoKind: 'lead_plus_days', autoDays: 0 },
    { autoKind: 'lead_plus_days', autoDays: 3, autoAtaTemplate: 'tpl_1' },
  ];
  entries.forEach((entry) => {
    const parts = autoConditionParts(entry);
    const joined = [parts.when, parts.who, parts.via, ...parts.extras].filter(Boolean).sort();
    assert.deepEqual(joined, autoConditionLine(entry).split(' · ').sort());
    assert.ok(parts.when);
  });
  const lead = autoConditionParts(entries[10]);
  assert.deepEqual(lead, { when: '가입·문의 후 3일 뒤', who: '고객', via: '알림톡', extras: ['오전 9시 30분'] });
  const staff = autoConditionParts(entries[3]);
  assert.equal(staff.who, '직원 2명');
  assert.deepEqual(staff.extras, ['오전 10시', '평일만']);
  assert.deepEqual(autoConditionParts({ autoKind: 'x' }), { when: '', who: '', via: '', extras: [] });
});

test('발송 시각: 저장 본문 auto_send_time(날짜형은 값, 즉시형·빈 값은 빈 값)과 조건 글의 시각', async () => {
  const { sendTimeLabel, SEND_TIMES } = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  assert.equal(SEND_TIMES.length, 23);
  assert.equal(sendTimeLabel('09:00'), '오전 9:00');
  assert.equal(sendTimeLabel('14:30'), '오후 2:30');
  const lead = { kind: 'lead_plus_days', days: '3', sendTime: '14:30' };
  assert.equal(buildSaveBody({ name: 'a', body: 'b', auto: lead }).auto.auto_send_time, '14:30');
  assert.equal(buildSaveBody({ name: 'a', body: 'b', auto: { ...lead, days: '0' } }).auto.auto_send_time, '');
  assert.equal(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'due_date', offsetDir: 'before', offsetDays: '3', sendTime: '' } }).auto.auto_send_time, '');
  assert.equal(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'process_started', step: '용접', sendTime: '10:00' } }).auto.auto_send_time, '');
  const base = { autoKind: 'ship_plus_days', autoDays: 20 };
  assert.equal(autoConditionLine(base), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  assert.equal(autoConditionLine({ ...base, autoSendTime: '15:00' }), '출고 완료 후 20일 뒤 · 오후 3:00 · 고객');
  assert.equal(autoConditionLine({ autoKind: 'lead_plus_days', autoDays: 2 }), '가입·문의 후 2일 뒤 · 오전 9시 30분 · 고객');
});

test('단계: 같은 일수 중복 판정과 팝업 시작 상태', async () => {
  const { duplicateStages, bootStages, formValuesFromItem, stageLabel } = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const mk = (id, days) => ({ id, name: `n${id}`, body: 'b', autoKind: 'lead_plus_days', days: String(days) });
  assert.deepEqual([...duplicateStages([mk(1, 0), mk(2, 3), mk(3, 3)].map(formValuesFromItem))], [1, 2]);
  assert.equal(duplicateStages([mk(1, 0), mk(2, 3)].map(formValuesFromItem)).size, 0);
  assert.equal(stageLabel(formValuesFromItem(mk(1, 0))), '당일');
  assert.equal(stageLabel(formValuesFromItem(mk(1, 7))), '7일');
  const single = bootStages(undefined, undefined, false);
  assert.equal(single.stages.length, 1);
  assert.equal(single.stages[0].base, null);
  const boot = bootStages(mk(2, 3), [mk(1, 0), mk(2, 3)], false);
  assert.equal(boot.stages.length, 2);
  assert.equal(boot.activeKey, 's2');
  const added = bootStages(undefined, [mk(1, 0), mk(2, 3)], true);
  assert.equal(added.stages.length, 3);
  assert.equal(added.values.autoKind, 'lead_plus_days');
  assert.equal(added.values.name, '');
});
