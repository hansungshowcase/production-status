import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { shouldAskWorkerIdentity, DEFAULT_WORKER_NAME } from '../src/pages/workerIdentityConfirm.js';

test('작업자를 고르고 처음 진입하면 본인 확인을 묻는다', () => {
  assert.equal(shouldAskWorkerIdentity('강종효', null), true);
  assert.equal(shouldAskWorkerIdentity('강종효', ''), true);
});

test('같은 작업자가 공정 사이를 오갈 때는 다시 묻지 않는다', () => {
  assert.equal(shouldAskWorkerIdentity('강종효', '강종효'), false);
});

test('다른 작업자로 바뀌면 다시 묻는다', () => {
  assert.equal(shouldAskWorkerIdentity('이먼', '강종효'), true);
});

test('작업자를 고르지 않고 들어온 경우는 묻지 않는다', () => {
  assert.equal(shouldAskWorkerIdentity(DEFAULT_WORKER_NAME, null), false);
  assert.equal(shouldAskWorkerIdentity('', null), false);
  assert.equal(shouldAskWorkerIdentity(null, null), false);
  assert.equal(shouldAskWorkerIdentity(undefined, undefined), false);
});

test('앞뒤 공백은 같은 사람으로 본다', () => {
  assert.equal(shouldAskWorkerIdentity(' 강종효 ', '강종효'), false);
  assert.equal(shouldAskWorkerIdentity('강종효', ' 강종효 '), false);
});

test('작업자 선택 화면을 거치면 같은 사람을 다시 골라도 확인을 다시 받는다', async () => {
  const source = await readFile(new URL('../src/pages/WorkerSelectPage.jsx', import.meta.url), 'utf8');

  // finishSelection 이 확인 기록을 지워야 선택 직후 공정 화면에서 다시 묻는다.
  assert.match(
    source,
    /function finishSelection[\s\S]*?sessionStorage\.removeItem\(WORKER_CONFIRMED_KEY\)/,
  );
});

test('확인 화면은 이름을 그대로 보여주고 확인·재선택 두 가지를 제공한다', async () => {
  const source = await readFile(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /작업자 \{workerName\} 님이 맞으실까요\?/);
  assert.match(source, />\s*확인\s*</);
  assert.match(source, />\s*재선택\s*</);
  // 재선택은 작업자 선택 화면으로 되돌려야 한다.
  assert.match(source, /navigate\('\/worker\/select'/);
  // 오버레이 클릭으로 닫히면 확인 없이 작업할 수 있게 되므로 onClick 이 없어야 한다.
  assert.match(source, /<div className="sv-overlay sv-identity-overlay" \/>/);
});
