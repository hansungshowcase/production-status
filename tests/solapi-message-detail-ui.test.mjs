import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const jsx = readFileSync(new URL('../src/components/solapi/SolapiMessageDetail.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/solapi/SolapiMessageDetail.css', import.meta.url), 'utf8');

test('탭 4개 이름과 tablist', () => {
  for (const name of ['메시지 정보', '메시지 내용', '그룹 정보', '메시지 이력']) assert.ok(jsx.includes(`'${name}'`), name);
  assert.ok(jsx.includes('role="tablist"'));
});

test('칸 이름 14개', () => {
  const labels = ['발신번호', '수신번호', '상태 (상태코드)', '비고', '문자 타입', '국가코드', '통신사', '자동타입감지',
    '메시지등록일', '최근업데이트', '이동사리포트수신', '단말기문자도착', '문자대체발송', '대체발송된 메시지 여부'];
  assert.equal(labels.length, 14);
  for (const label of labels) assert.ok(jsx.includes(`label="${label}"`), label);
  for (const label of ['구분', '종류', '받는 사람', '발송 출처', '메시지아이디', '그룹아이디']) assert.ok(jsx.includes(label), label);
});

test('접근성·동작', () => {
  assert.ok(jsx.includes('aria-modal="true"'));
  assert.ok(jsx.includes('aria-labelledby'));
  assert.ok(jsx.includes("'Escape'"));
  assert.ok(jsx.includes('navigator.clipboard.writeText'));
  assert.ok(jsx.includes('document.body.style.overflow'));
  assert.ok(jsx.includes('ESC'));
});

test('768 미디어·44px 버튼', () => {
  assert.ok(css.includes('max-width: 768px'));
  assert.ok(css.includes('min-height: 44px'));
});

test('읽기 전용: 재발송·문의 버튼 없음', () => {
  assert.ok(!jsx.includes('재발송'));
  assert.ok(!jsx.includes('문의'));
});

test('대체발송 타입 표기가 겹치지 않고, 목록에 없는 그룹은 이유를 보여 준다', () => {
  assert.match(jsx, /item\.replaced_from && !String\(typeLabel\)\.includes\('→'\)/);
  assert.match(jsx, /이 날짜 요청 목록에 없는 그룹입니다/);
});