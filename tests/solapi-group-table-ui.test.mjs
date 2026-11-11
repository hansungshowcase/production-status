import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const jsx = readFileSync(new URL('../src/components/solapi/SolapiGroupTable.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/solapi/SolapiGroupTable.css', import.meta.url), 'utf8');

test('열 이름 6개', () => {
  for (const name of ['생성일', '구분', '상태', '타입', '현황', '최근 업데이트']) {
    assert.ok(jsx.includes(`<span>${name}</span>`), name);
  }
});

test('행 클릭이 onOpenGroup 으로 연결되고 키보드로도 동작', () => {
  assert.match(jsx, /onOpenGroup/);
  assert.match(jsx, /role="button"/);
  assert.match(jsx, /Enter/);
  assert.match(jsx, /' '/);
});

test('solapiFormat 공용 함수를 import', () => {
  assert.match(jsx, /from '\.\/solapiFormat\.js'/);
  for (const n of ['fmtShort', 'fmtRelative', 'typeKey', 'SOURCE_BADGE', 'TYPE_BADGE', 'AUDIENCE_LABEL', 'BAR_COLOR']) {
    assert.ok(jsx.includes(n), n);
  }
});

test('현황 막대와 문구', () => {
  assert.match(jsx, /sgt-bar/);
  assert.match(jsx, /실패 \{/);
  assert.match(jsx, /발송중/);
  assert.match(css, /\.sgt-bar\s*\{[^}]*width: 100px/);
});

test('768/769 미디어 쿼리와 말줄임', () => {
  assert.match(css, /max-width: 768px/);
  assert.match(css, /min-width: 769px/);
  assert.match(css, /text-overflow: ellipsis/);
  assert.match(css, /rgb\(48, 45, 178\)/);
  assert.match(css, /cursor: pointer/);
});
