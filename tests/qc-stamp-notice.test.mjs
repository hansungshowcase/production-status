import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { needsQcStampNotice, confirmQcStamp, QC_STAMP_MESSAGE } from '../src/pages/qcStampNotice.js';

test('옛 화면용 확인 창: QC 공정은 [확인]을 눌러야 true, 그 밖의 공정은 묻지 않는다', () => {
  const asked = [];
  const yes = (msg) => { asked.push(msg); return true; };
  const no = (msg) => { asked.push(msg); return false; };
  assert.equal(confirmQcStamp('조립작업', yes), true);
  assert.equal(confirmQcStamp('설비작업', no), false);
  assert.equal(asked.length, 2);
  assert.ok(asked.every((msg) => msg.includes(QC_STAMP_MESSAGE)));
  assert.equal(confirmQcStamp('용접작업', no), true);
  assert.equal(confirmQcStamp('포장', no), true);
  assert.equal(asked.length, 2);
});

test('옛 화면(/worker, /worker/update, /tablet)도 완료 전에 QC 확인 창을 거친다', async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const worker = await read('../src/pages/WorkerPage.jsx');
  assert.match(worker, /if \(!confirmQcStamp\(inProgressProcess\.step_name\)\) \{\s*closeModal\(\);\s*return;\s*\}\s*await completeProcess\(inProgressProcess\.id/);
  const update = await read('../src/pages/WorkerUpdatePage.jsx');
  assert.match(update, /if \(!confirmQcStamp\(inProgressProcess\.step_name\)\) \{\s*closeModal\(\);\s*return;\s*\}\s*setActionLoading\(true\);/);
  const tablet = await read('../src/components/tablet/OrderDetailPanel.jsx');
  assert.match(tablet, /if \(confirmQcStamp\(currentStepName\)\) onCompleteProcess\(currentProcess\.id\);/);
});

test('조립작업·설비작업에서 넘길 때만 QC 도장 알림을 띄운다', () => {
  assert.equal(needsQcStampNotice('조립작업'), true);
  assert.equal(needsQcStampNotice('설비작업'), true);
  assert.equal(needsQcStampNotice(' 설비작업 '), true);
  for (const step of ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '포장', '출고', '', null, undefined]) {
    assert.equal(needsQcStampNotice(step), false, String(step));
  }
});

test('알림 문구에 QC 담당자와 최우석 이사님 도장 안내가 들어 있다', () => {
  assert.match(QC_STAMP_MESSAGE, /QC 담당자 검수/);
  assert.match(QC_STAMP_MESSAGE, /최우석 이사님 도장/);
  assert.match(QC_STAMP_MESSAGE, /다음 작업으로 넘겨/);
});

test('공정 화면의 다음 공정·출고완료 버튼은 QC 공정이면 알림을 먼저 띄운다', async () => {
  const source = await readFile(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
  // 다음 공정 버튼: 바로 executeComplete 를 부르지 않고 QC 공정이면 알림부터
  assert.match(source, /onClick=\{\(\) => \(needsQcStamp \? openQcNotice\(\{ kind: 'complete', nextStep: step \}\) : executeComplete\(step\)\)\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => executeComplete\(step\)\}/);
  // 바로 출고완료 버튼도 같은 알림을 거친다
  assert.match(source, /needsQcStamp \? openQcNotice\(\{ kind: 'ship' \}\) : executeDirectShip\(\)/);
  assert.doesNotMatch(source, /onClick=\{executeDirectShip\}/);
  // 알림의 [확인]만 실제 넘김을 실행한다
  assert.match(source, /onClick=\{confirmQcNotice\}>확인</);
  assert.match(source, /if \(notice\.kind === 'ship'\) executeDirectShip\(\);\s*else executeComplete\(notice\.nextStep\);/);
  // 알림은 완료 확인 창 위에 겹쳐 뜨고(아래 창 버튼이 눌리지 않게 덮개 포함), 빠른 두 번 누름은 무시한다
  assert.match(source, /className="sv-overlay sv-qc-overlay" onClick=\{\(\) => setQcNotice\(null\)\}/);
  assert.match(source, /Date\.now\(\) - qcNotice\.openedAt < 500/);
  const css = await readFile(new URL('../src/pages/WorkerStationViewPage.css', import.meta.url), 'utf8');
  const z = (re) => Number((css.match(re) || [])[1]);
  assert.ok(z(/\.sv-qc-overlay \{\s*z-index: (\d+)/) > z(/\.sv-card-popup \{[^}]*?z-index: (\d+)/));
  assert.ok(z(/\.sv-card-popup\.sv-qc-popup \{\s*z-index: (\d+)/) > z(/\.sv-qc-overlay \{\s*z-index: (\d+)/));
});
