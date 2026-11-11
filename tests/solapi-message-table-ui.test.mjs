import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const jsx = readFileSync(new URL('../src/components/solapi/SolapiMessageTable.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/solapi/SolapiMessageTable.css', import.meta.url), 'utf8');

test('열 이름 9개', () => {
  for (const name of ['생성일', '구분', '타입', '발신번호', '수신번호', '상태코드', '비고', '종류', '내용']) {
    assert.ok(jsx.includes(`'${name}'`), name);
  }
});

test('onOpen·상태 색·키보드', () => {
  assert.match(jsx, /onOpen/);
  assert.match(jsx, /STATUS_COLOR/);
  assert.match(jsx, /onKeyDown/);
  assert.match(jsx, /'Enter'/);
  assert.match(jsx, /' '/);
});

test('768/769 미디어와 말줄임', () => {
  assert.match(css, /max-width:\s*768px/);
  assert.match(css, /min-width:\s*769px/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /table-layout:\s*fixed/);
  assert.match(css, /rgb\(48, 45, 178\)/);
});
