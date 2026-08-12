import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const trackApi = readFileSync(new URL('../api/track/[token].js', import.meta.url), 'utf8');

// 이 링크는 그 거래처 본인에게 문자로 나간다. 자기 상호가 '솔*********' 로 보이면
// 고객은 화면이 깨진 것으로 읽는다. (2026-08-12 요청)
test('조회 페이지는 거래처명을 가리지 않는다', () => {
  assert.match(trackApi, /client_name: clientName\(order\.client_name\)/);
  assert.doesNotMatch(trackApi, /maskName/, '이름을 별표로 덮는 함수가 남아 있으면 안 된다');
  assert.doesNotMatch(trackApi, /'\*'\.repeat/, '이름을 별표로 채우면 안 된다');
});

test('거래처명이 비어 있으면 고객으로 표시한다', () => {
  assert.match(trackApi, /return s \|\| '고객'/);
});

// 이름을 열었다고 해서 내부 정보까지 열리면 안 된다. 여기가 무인증 공개 응답이다.
test('내부 정보는 여전히 응답에 담기지 않는다', () => {
  // 주석에 필드 이름이 '왜 뺐는지' 설명으로 등장하므로, 실제로 값을 내보내는
  // `필드: ...` 형태만 본다.
  const responseBody = trackApi
    .slice(trackApi.indexOf('return res.json({'))
    .replace(/\/\/[^\n]*/g, '');

  // 품명(product_type)은 내부 분류·거래처 표기가 섞여 있어 제외한다(2026-08-10).
  for (const field of ['sale_amount', 'balance', 'phone', 'lead_source', 'risk', 'product_type']) {
    assert.doesNotMatch(
      responseBody,
      new RegExp(`\\b${field}\\s*:`),
      `${field} 은 고객 응답에 들어가면 안 된다`,
    );
  }
  // 공정 목록에 작업자 이름이 붙으면 안 된다.
  assert.match(trackApi, /steps: processes\.map\(p => \(\{ name: p\.step_name, status: p\.status \}\)\)/);
});
