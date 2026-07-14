// OCR 응답 JSON 견고 파서 검증 — 깨진/잘린 JSON 에서도 담당자·납기 복구
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkOrderJson, extractFieldsLoose } from '../api/_lib/ocrParse.js';

test('정상 JSON 파싱', () => {
  const r = parseWorkOrderJson('{"sales_person":"신은철","due_date":"2026-07-27","width":900}');
  assert.equal(r.sales_person, '신은철');
  assert.equal(r.due_date, '2026-07-27');
  assert.equal(r.width, 900);
});

test('코드펜스로 감싼 JSON', () => {
  const r = parseWorkOrderJson('```json\n{"sales_person":"이준형","due_date":"2026-07-20"}\n```');
  assert.equal(r.sales_person, '이준형');
});

test('트레일링 콤마', () => {
  const r = parseWorkOrderJson('{"sales_person":"신은철","due_date":"2026-07-27",}');
  assert.equal(r.sales_person, '신은철');
});

test('★ notes 미종료(잘림)여도 담당자·납기 복구 — 실제 버그 케이스', () => {
  // notes 문자열이 닫히지 않고 잘린 응답 (position 353 unterminated string 재현)
  const broken = '{"client_name":"신현섭 / 법인","order_date":"2026-06-24","due_date":"2026-07-27",'
    + '"phone":"010-9551-4991","sales_person":"신은철","product_type":"오픈",'
    + '"width":900,"depth":750,"height":1900,"quantity":1,"color":"화이트",'
    + '"notes":"상부 가습기 부착 >> 가습기 안보이돌고 깔끔하게';  // 닫는 따옴표/중괄호 없음
  const r = parseWorkOrderJson(broken);
  assert.equal(r.sales_person, '신은철');
  assert.equal(r.due_date, '2026-07-27');
  assert.equal(r.client_name, '신현섭 / 법인');
  assert.equal(r.width, 900);
});

test('문자열 내부 원시 개행(제어문자)이 있어도 파싱', () => {
  const raw = '{"sales_person":"신은철","due_date":"2026-07-27","notes":"1줄\n2줄"}';
  const r = parseWorkOrderJson(raw);
  assert.equal(r.sales_person, '신은철');
  assert.equal(r.due_date, '2026-07-27');
});

test('extractFieldsLoose: 앞부분 텍스트 잡음이 있어도 필드 추출', () => {
  const r = extractFieldsLoose('여기 결과입니다: {"sales_person":"신은철","quantity":2, ...');
  assert.equal(r.sales_person, '신은철');
  assert.equal(r.quantity, 2);
});

test('완전 쓰레기 응답 → 예외', () => {
  assert.throws(() => parseWorkOrderJson('인식 실패했습니다 죄송합니다'));
});
