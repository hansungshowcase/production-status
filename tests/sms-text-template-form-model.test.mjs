import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSaveBody, imageFromItem, myTextSection, normalizeKind, textFormStopText, validateTextForm } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

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
