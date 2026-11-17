import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/components/smsconsole/KakaoTemplateForm.jsx', import.meta.url), 'utf8');

test('기본형 라디오는 이미지형일 때 체크되지 않아 이미지형에서 기본형으로 바꿀 수 있다', () => {
  const line = src.split('\n').find(l => l.includes("emphasizeType: 'NONE'"));
  assert.ok(line, '기본형 라디오 줄이 있어야 한다');
  assert.match(line, /checked=\{!isText && !isImage\}/);
});
