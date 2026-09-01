import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(
  new URL('../src/pages/OrderEntryPage.jsx', import.meta.url),
  'utf8',
);

test('작업 등록 전에 실제 납기보다 2일 빠른 날짜인지 확인한다', () => {
  assert.match(pageSource, /실제 납기일보다 2일 앞당긴 날짜/);
  assert.match(pageSource, /이대로 작업을 등록하시겠습니까/);

  const handlerStart = pageSource.indexOf('const handleSubmit = async');
  const handlerEnd = pageSource.indexOf('const handleContinue', handlerStart);
  const handlerSource = pageSource.slice(handlerStart, handlerEnd);
  const validationIndex = handlerSource.indexOf('missingMessages.length > 0');
  const confirmationIndex = handlerSource.indexOf('window.confirm(DUE_DATE_BUFFER_CONFIRM_MESSAGE)');
  const submittingIndex = handlerSource.indexOf('setSubmitting(true)');
  const createOrderIndex = handlerSource.indexOf('await createOrder(payload)');

  assert.ok(validationIndex >= 0, '기존 입력값 검증을 유지해야 한다');
  assert.ok(confirmationIndex > validationIndex, '유효한 입력에만 납기 확인창을 띄워야 한다');
  assert.ok(confirmationIndex < submittingIndex, '확인 전에는 등록 중 상태로 바꾸면 안 된다');
  assert.ok(confirmationIndex < createOrderIndex, '확인 전에는 주문 생성 요청을 보내면 안 된다');
  assert.match(
    handlerSource,
    /if \(!window\.confirm\(DUE_DATE_BUFFER_CONFIRM_MESSAGE\)\) \{\s*return;\s*\}/,
    '취소하면 등록을 중단해야 한다',
  );
});
