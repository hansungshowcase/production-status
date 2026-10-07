import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
const workerCss = await readFile(new URL('../src/pages/WorkerStationViewPage.css', import.meta.url), 'utf8');
const processApiSource = await readFile(new URL('../src/api/processes.js', import.meta.url), 'utf8');
const salesSource = await readFile(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');
const salesCss = await readFile(new URL('../src/components/sales/SalesOrderCard.css', import.meta.url), 'utf8');
const realtimeSource = await readFile(new URL('../src/hooks/realtimeEvents.js', import.meta.url), 'utf8');

test('프런트 API는 별도 수령 대기 조회와 전용 PATCH를 제공한다', () => {
  assert.match(processApiSource, /getWorkInstructionReceiptPending/);
  assert.match(processApiSource, /mode=work_instruction_receipt_pending/);
  assert.match(processApiSource, /receiveWorkInstruction/);
  assert.match(processApiSource, /work-instruction-receipt/);
  assert.match(processApiSource, /expected_revision/);
});

test('레이저 화면은 실제 작업 목록과 분리된 수령 대기 영역의 저장·빈값·오류·권한 상태를 제공한다', () => {
  assert.match(workerSource, /station-view__receipt-pending/);
  assert.match(workerSource, /작업지시서 수령 대기/);
  assert.match(workerSource, /작업지시서 받음/);
  assert.match(workerSource, /받을 작업지시서가 없습니다/);
  assert.match(workerSource, /수령 대기 목록을 불러오지 못했습니다/);
  assert.match(workerSource, /수령 권한이 없습니다/);
  assert.match(workerSource, /identityAsked/);
  assert.match(workerSource, /receiveWorkInstruction/);
  assert.match(workerSource, /getWorkInstructionReceiptPending/);
  assert.match(workerSource, /작업지시서 수령 확인 완료/);
  assert.match(workerSource, /fetchData\(\{ forceStats: true \}\)/);
  assert.match(workerSource, /station-view__receipt-count/);
});

test('수령 버튼은 44px 이상이고 모바일에서 영역 밖으로 넘치지 않는다', () => {
  assert.match(workerCss, /\.station-view__receipt-button[\s\S]*min-height:\s*var\(--control-min-height\)/);
  assert.match(workerCss, /\.station-view__receipt-item[\s\S]*min-width:\s*0/);
  assert.match(workerCss, /@media \(max-width:\s*767px\)[\s\S]*station-view__receipt-item/);
});

test('도면 화면은 다음 공정·건너뛰기 버튼 대신 수령 대기 목적지만 안내한다', () => {
  assert.match(workerSource, /const isDrawingStep = decodedStep === '도면설계'/);
  assert.match(workerSource, /isDrawingStep \? '작업지시서 수령 대기'/);
  assert.match(workerSource, /!isDrawingStep && !isLastStep && nextSteps\.length > 0/);
  assert.match(workerSource, /isDrawingStep &&[\s\S]*executeComplete\(null\)/);
});

test('영업 카드 요약과 상세는 대기 또는 최초 수령자·시간을 읽기 전용으로 표시한다', () => {
  assert.match(salesSource, /getWorkInstructionHandoverState/);
  assert.match(salesSource, /sales-order-card__handover/);
  assert.match(salesSource, /작업지시서 전달 대기/);
  assert.match(salesSource, /작업지시서 수령/);
  assert.doesNotMatch(salesSource, /작업지시서 수령 기록 없음/);
  assert.match(salesSource, /sales-order-card__handover-detail/);
  assert.match(salesSource, /sales-order-card__handover-units/);
  assert.match(salesSource, /sales-order-card__handover-receiver/);
  assert.match(salesSource, /<time[\s\S]*sales-order-card__handover-time/);
  assert.match(salesSource, /timeZone:\s*'Asia\/Seoul'/);
  assert.match(salesSource, /sales-order-card__handover-value/);
  assert.match(salesSource, /detailOrder \? \{ \.\.\.detailOrder, \.\.\.order \} : order/);
  assert.match(salesCss, /\.sales-order-card__handover/);
  assert.match(salesCss, /\.sales-order-card__handover-units[\s\S]*flex-wrap:\s*wrap/);
  assert.match(salesCss, /\.sales-order-card__handover-receiver[\s\S]*white-space:\s*nowrap/);
  assert.match(salesCss, /\.sales-order-card__handover-time[\s\S]*white-space:\s*nowrap/);
  assert.match(salesCss, /margin:\s*0 var\(--space-4\) var\(--space-3\)/);
  assert.match(salesCss, /padding:\s*var\(--space-2\) var\(--space-3\)/);
  assert.match(salesCss, /\.sales-order-card__handover--pending[\s\S]*color:\s*var\(--text-mid\)/);
  assert.match(
    salesCss,
    /@media \(max-width:\s*767px\)[\s\S]*\.sales-order-card__handover\s*\{[\s\S]*margin:\s*0 var\(--space-3\) var\(--space-2\)/,
  );
});

test('작업지시서 수령 활동은 기존 ORDER_UPDATED 실시간 새로고침 경로를 사용한다', () => {
  assert.match(realtimeSource, /'작업지시서수령':\s*'ORDER_UPDATED'/);
});
