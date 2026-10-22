import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/pages/TrackPage.jsx', import.meta.url), 'utf8');
const match = source.match(/function customerStage\(data, completed, total\) \{([\s\S]*?)\n\}/);
assert.ok(match, 'TrackPage customerStage function must remain executable by this regression fixture');
const customerStage = new Function('data', 'completed', 'total', match[1]);

test('공정 100%만으로 미출고 주문을 출고완료 단계에 표시하지 않는다', () => {
  assert.equal(
    customerStage({ status: 'in_production' }, 10, 10),
    2,
    'explicit shipped order status is required for the 출고완료 stage',
  );
});

test('명시적으로 출고 처리된 주문은 출고완료 단계에 표시한다', () => {
  assert.equal(customerStage({ status: 'shipped' }, 9, 10), 3);
});

test('포장 완료 주문은 기존 포장완료 단계에 유지한다', () => {
  assert.equal(customerStage({ status: 'in_production' }, 9, 10), 2);
});