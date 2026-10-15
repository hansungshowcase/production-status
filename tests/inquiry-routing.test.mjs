import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInquiryRoute } from '../src/pages/inquiryRouting.js';

test('Given 이준형 담당자 When 라우팅을 결정하면 Then 카카오 경로를 선택한다', () => {
  const route = resolveInquiryRoute('  이준형  ');

  assert.equal(route.kind, 'kakao');
  assert.equal(route.manager, '이준형');
  assert.equal(route.href, 'http://pf.kakao.com/_vxmpfn/chat');
});

test('Given 신은철 담당자 When 라우팅을 결정하면 Then SMS 경로와 번호를 제공한다', () => {
  const route = resolveInquiryRoute('신은철');

  assert.equal(route.kind, 'sms');
  assert.equal(route.manager, '신은철');
  assert.equal(route.href, 'sms:01058792438');
  assert.equal(route.phone, '010-5879-2438');
});

test('Given 승인된 담당자가 아닌 값 When 라우팅을 결정하면 Then 특정 연락처 없이 담당자 확인 경로를 선택한다', () => {
  for (const value of [null, undefined, 0, '   ', '김보수', '신 은철', '이준', '이준형 팀장', '다른 담당자']) {
    const route = resolveInquiryRoute(value);

    assert.equal(route.kind, 'manager');
    assert.equal(route.href, null);
    assert.equal(route.phone, null);
  }
});
