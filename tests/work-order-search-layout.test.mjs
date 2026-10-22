import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/pages/WorkerSelectPage.css', import.meta.url), 'utf8');
const rule = name => css.match(new RegExp(`\\.worker-select-page__work-order-${name}\\s*\\{([^}]+)\\}`))?.[1] || '';

test('work-order result cards retain their content height inside the scrolling list', () => {
  assert.match(rule('item'), /flex-shrink:\s*0\s*;/);
  assert.match(rule('results'), /max-height:\s*340px\s*;/);
  assert.match(rule('results'), /overflow-y:\s*auto\s*;/);
});

test('work-order badges share the client row instead of creating a clipped third row', () => {
  assert.match(rule('step'), /grid-column:\s*2\s*;/);
  assert.match(rule('step'), /grid-row:\s*1\s*;/);
  assert.match(rule('meta'), /grid-column:\s*1\s*\/\s*-1\s*;/);
  assert.match(rule('client'), /text-overflow:\s*ellipsis\s*;/);
  assert.match(rule('meta'), /text-overflow:\s*ellipsis\s*;/);
});
