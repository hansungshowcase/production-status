import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplateInput } from '../shared/smsConsole.js';
import {
  emptyFormValues, formValuesFromTemplate, toValidationInput, insertVariable, variableNameError,
  addButton, removeButton, moveButton, updateButton, countChars, extraErrors, firstErrorKey,
  targetKey, parseTargetKey, previewTemplate, missingFieldsText,
} from '../src/components/smsconsole/templateFormModel.js';

const T1 = { kind: 'channel', id: 'KA01', name: '한성 채널' };
const T2 = { kind: 'group', id: 'G-2', name: '한성 그룹' };

test('빈 양식: 대상 1개면 자동 선택, 2개면 비움, 기본값', () => {
  const one = emptyFormValues([T1]);
  assert.equal(one.targetKey, 'channel:KA01');
  assert.equal(emptyFormValues([T1, T2]).targetKey, '');
  assert.equal(one.categoryCode, '999999');
  assert.equal(one.requestInspection, false);
  assert.equal(one.confirmed, false);
  assert.deepEqual(one.buttons, []);
});

test('targetKey 왕복', () => {
  assert.deepEqual(parseTargetKey(targetKey(T2)), { kind: 'group', id: 'G-2' });
  assert.equal(parseTargetKey('x:1'), null);
  assert.equal(parseTargetKey(''), null);
});

test('Template → 양식 값: 지원 밖 유형은 기본으로, 버튼 5개 제한', () => {
  const form = formValuesFromTemplate({
    name: 'a', content: 'b', target: T1, emphasizeType: 'IMAGE', messageType: 'AD', securityFlag: true,
    buttons: Array.from({ length: 7 }, (_, i) => ({ type: 'WL', name: `b${i}`, linkMo: 'https://x.kr' })),
  });
  assert.equal(form.emphasizeType, 'NONE');
  assert.equal(form.messageType, 'BA');
  assert.equal(form.securityFlag, true);
  assert.equal(form.buttons.length, 5);
  assert.equal(form.targetKey, 'channel:KA01');
  assert.equal(formValuesFromTemplate(null).name, '');
});

test('양식 값 → 검증 입력: 숨은 칸은 비우고 통과 값이 나온다', () => {
  const form = {
    ...emptyFormValues([T1]), name: '시험', content: '#{이름}님 안녕하세요',
    emphasizeType: 'NONE', emphasizeTitle: '남은값', messageType: 'BA', extra: '남은부가',
    buttons: [{ type: 'WL', name: '보기', linkMo: 'https://a.kr', linkPc: '' }, { type: 'DS', name: '배송', linkMo: 'x', linkPc: 'y' }],
  };
  const input = toValidationInput(form);
  assert.equal(input.emphasizeTitle, '');
  assert.equal(input.extra, '');
  assert.deepEqual(input.buttons[1], { type: 'DS', name: '배송' });
  const r = validateTemplateInput(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.target, { kind: 'channel', id: 'KA01' });
});

test('대상 미선택·수정 모드 검증', () => {
  const form = { ...emptyFormValues([T1, T2]), name: 'n', content: 'c' };
  const r = validateTemplateInput(toValidationInput(form));
  assert.equal(r.ok, false);
  assert.ok(r.errors.target);
  assert.equal(validateTemplateInput(toValidationInput(form), { requireTarget: false }).ok, true);
});

test('강조표기형·부가정보형은 해당 칸이 필수', () => {
  const form = { ...emptyFormValues([T1]), name: 'n', content: 'c', emphasizeType: 'TEXT', messageType: 'EX' };
  const r = validateTemplateInput(toValidationInput(form));
  assert.ok(r.errors.emphasizeTitle && r.errors.emphasizeSubtitle && r.errors.extra);
});

test('변수 삽입: 커서 위치·선택 영역·범위 밖', () => {
  assert.deepEqual(insertVariable('안녕 님', 2, '이름'), { text: '안녕#{이름} 님', cursor: 7 });
  assert.deepEqual(insertVariable('abc', 99, 'x'), { text: 'abc#{x}', cursor: 7 });
  assert.deepEqual(insertVariable('abcdef', 1, 'v', 4), { text: 'a#{v}ef', cursor: 5 });
  assert.deepEqual(insertVariable('', undefined, ' 값 '), { text: '#{값}', cursor: 4 });
  assert.deepEqual(insertVariable('abc', -5, 'v'), { text: '#{v}abc', cursor: 4 });
});

test('변수 이름 검사', () => {
  assert.equal(variableNameError('이름_1'), '');
  assert.ok(variableNameError(''));
  assert.ok(variableNameError('a b'));
  assert.ok(variableNameError('a'.repeat(21)));
  assert.ok(variableNameError('a}'));
});

test('버튼 추가·삭제·이동·수정, 5개 상한', () => {
  let b = [];
  for (let i = 0; i < 7; i += 1) b = addButton(b, i === 1 ? 'DS' : 'WL');
  assert.equal(b.length, 5);
  assert.equal(b[1].type, 'DS');
  b = updateButton(b, 0, { name: 'A' });
  b = updateButton(b, 1, { name: 'B' });
  b = moveButton(b, 0, 1);
  assert.deepEqual(b.slice(0, 2).map(x => x.name), ['B', 'A']);
  assert.equal(moveButton(b, 0, -1), b);
  assert.equal(moveButton(b, 4, 1), b);
  b = removeButton(b, 0);
  assert.equal(b.length, 4);
  assert.equal(removeButton(b, 9), b);
  assert.equal(addButton([], 'ZZ')[0].type, 'WL');
});

test('글자 수는 이모지·한글 모두 1자', () => {
  assert.equal(countChars('가나다'), 3);
  assert.equal(countChars('😀a'), 2);
  assert.equal(countChars(null), 0);
});

test('확인 체크·검수 의견 오류와 첫 오류 칸 순서', () => {
  assert.ok(extraErrors({ confirmed: false }).confirmed);
  assert.deepEqual(extraErrors({ confirmed: true }), {});
  assert.ok(extraErrors({ confirmed: true, requestInspection: true, comment: 'a'.repeat(501) }).comment);
  assert.deepEqual(extraErrors({ confirmed: true, requestInspection: false, comment: 'a'.repeat(501) }), {});
  assert.equal(firstErrorKey({ confirmed: 'x', content: 'y', name: 'z' }), 'name');
  assert.equal(firstErrorKey({ 'buttons.1': 'a', 'buttons.0': 'b' }), 'buttons.0');
  assert.equal(firstErrorKey({}), null);
});

test('미리보기 모양', () => {
  const form = { ...emptyFormValues([T1, T2]), targetKey: 'group:G-2', name: 'n', content: 'c', emphasizeType: 'NONE', emphasizeTitle: 't', buttons: [{ type: 'WL', name: '링크', linkMo: 'x' }] };
  const p = previewTemplate(form, [T1, T2]);
  assert.equal(p.targetName, '한성 그룹');
  assert.equal(p.emphasizeTitle, '');
  assert.deepEqual(p.buttons, [{ type: 'WL', name: '링크' }]);
});

test('빠진 칸 안내 글: 채널 없음 / 체크 없음 / 둘 다 / 모두 있음', () => {
  assert.equal(missingFieldsText({ target: 'x' }), '채널을 선택해 주세요');
  assert.equal(missingFieldsText({ confirmed: 'x' }), '정보성 메시지 확인에 체크해 주세요');
  assert.equal(
    missingFieldsText({ confirmed: 'x', name: 'x', target: 'x' }),
    '채널을 선택해 주세요, 템플릿 이름을 입력해 주세요, 정보성 메시지 확인에 체크해 주세요',
  );
  assert.equal(missingFieldsText({}), '');
});
