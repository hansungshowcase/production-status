import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

let realtime = {};
let loader = {};
try {
  realtime = await import('../src/hooks/realtimeEvents.js');
} catch {}
try {
  loader = await import('../src/pages/salesOrderLoader.js');
} catch {}

const cardSource = readFileSync(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');
const searchSource = readFileSync(new URL('../src/components/common/SearchBar.jsx', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/pages/SalesMyPage.css', import.meta.url), 'utf8');
const summaryCss = readFileSync(new URL('../src/components/sales/SalesSummaryCards.css', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../src/pages/WorkerPage.jsx', import.meta.url), 'utf8');

test('detail loading state cannot cancel its own request effect', () => {
  const effectStart = cardSource.indexOf('useEffect(() => {', cardSource.indexOf('detailError'));
  const effectEnd = cardSource.indexOf('\n  // 상세 조회가 열린 뒤', effectStart);
  const effect = cardSource.slice(effectStart, effectEnd);

  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  assert.doesNotMatch(effect, /\[detailLoading[^\]]*\]/);
  assert.match(effect, /setDetailLoading\(false\)/);
  assert.match(effect, /setDetailOrder\(null\)[\s\S]*?\[order\.id\]/);
});

test('salesperson changes reset the rendered search input and cancel pending debounce', () => {
  assert.match(pageSource, /searchResetKey/);
  assert.match(pageSource, /<SearchBar[\s\S]*?key=\{searchResetKey\}/);
  assert.match(searchSource, /function cancelPendingSearch\(\)/);
  assert.match(searchSource, /handleClear[\s\S]*?cancelPendingSearch\(\)/);
  assert.match(workerSource, /import SearchBar from '\.\.\/components\/common\/SearchBar'/);
  assert.match(workerSource, /<SearchBar[\s\S]*?onSelect=/);
});

test('Korean activity types normalize to the canonical client event contract', () => {
  assert.equal(typeof realtime.normalizeRealtimeEventType, 'function');
  const expected = new Map([
    ['공정시작', 'PROCESS_STARTED'],
    ['공정완료', 'PROCESS_COMPLETED'],
    ['공정되돌리기', 'PROCESS_REVERTED'],
    ['이슈등록', 'ISSUE_REPORTED'],
    ['이슈해결', 'ISSUE_RESOLVED'],
    ['주문등록', 'ORDER_CREATED'],
    ['주문수정', 'ORDER_UPDATED'],
    ['작업지시서수령', 'ORDER_UPDATED'],
    ['주문삭제', 'ORDER_DELETED'],
    ['출고완료', 'ORDER_SHIPPED'],
    ['사전생산수정', 'PRE_PRODUCTION_UPDATED'],
  ]);

  for (const [input, output] of expected) {
    assert.equal(realtime.normalizeRealtimeEventType(input), output);
  }
  assert.equal(realtime.normalizeRealtimeEventType('PROCESS_STARTED'), 'PROCESS_STARTED');
  assert.equal(realtime.normalizeRealtimeEventType('알수없음'), '알수없음');
});

test('newest-first event batches retain every normalized type for refresh decisions', () => {
  assert.equal(typeof realtime.toRealtimeMessage, 'function');
  const message = realtime.toRealtimeMessage({
    events: [
      { id: 2, action_type: '알수없음', created_at: '2026-09-29T02:00:00.000Z' },
      { id: 1, action_type: '주문등록', created_at: '2026-09-29T01:59:00.000Z' },
    ],
  });

  assert.equal(message.type, '알수없음');
  assert.equal(message.data.id, 2);
  assert.deepEqual(message.types, ['알수없음', 'ORDER_CREATED']);
  assert.equal(realtime.toRealtimeMessage({ events: [] }), null);
});

test('Lee and Kim alias requests start together and merge in stable order', async () => {
  assert.equal(typeof loader.loadSalesOrdersForPerson, 'function');
  const calls = [];
  const resolvers = new Map();
  const getOrders = ({ sales_person, offset }) => {
    calls.push({ sales_person, offset });
    return new Promise((resolve) => resolvers.set(`${sales_person}:${offset}`, resolve));
  };

  const resultPromise = loader.loadSalesOrdersForPerson({
    activePerson: '이준형',
    getOrders,
    pageSize: 200,
  });
  await Promise.resolve();

  assert.deepEqual(calls, [
    { sales_person: '이준형', offset: 0 },
    { sales_person: '김보수', offset: 0 },
  ]);

  resolvers.get('김보수:0')({ orders: [{ id: 2 }], total: 1 });
  resolvers.get('이준형:0')({ orders: [{ id: 1 }], total: 1 });
  assert.deepEqual(await resultPromise, [{ id: 1 }, { id: 2 }]);
});

test('alias loading rejects the whole result when either source fails', async () => {
  assert.equal(typeof loader.loadSalesOrdersForPerson, 'function');
  const getOrders = ({ sales_person }) => sales_person === '김보수'
    ? Promise.reject(new Error('alias failed'))
    : Promise.resolve({ orders: [{ id: 1 }], total: 1 });

  await assert.rejects(
    loader.loadSalesOrdersForPerson({ activePerson: '이준형', getOrders, pageSize: 200 }),
    /alias failed/,
  );
});

test('mobile controls keep 44px targets and narrow summary cards keep useful spacing', () => {
  const mobilePage = pageCss.slice(pageCss.indexOf('@media (max-width: 767px)'));
  assert.match(mobilePage, /sales-my-page__person-btn[\s\S]*?min-height:\s*44px/);
  assert.match(mobilePage, /sales-my-page__return-btn[\s\S]*?min-height:\s*44px/);
  assert.match(mobilePage, /sales-my-page__new-order-btn[\s\S]*?min-height:\s*44px/);
  assert.match(mobilePage, /sales-my-page__back-btn[\s\S]*?min-height:\s*44px/);

  const narrowSummary = summaryCss.slice(summaryCss.indexOf('@media (max-width: 479px)'));
  assert.match(narrowSummary, /sales-summary-card[\s\S]*?padding:\s*12px 9px/);
  assert.match(narrowSummary, /sales-summary-card[\s\S]*?gap:\s*8px/);
});

test('출고 처리는 현재 필터·검색·계정·표시 개수를 바꾸거나 출고 탭으로 자동 이동하지 않는다', () => {
  const start = pageSource.indexOf('async function handleShipOrder(order)');
  const end = pageSource.indexOf('\n  function handleEditOrder', start);
  const handler = pageSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /shipOrder\(order\.id, mySalesPerson\)/);
  assert.match(handler, /ordersFetchIdRef\.current \+= 1/);
  assert.match(handler, /setOrders\(prev => prev\.map/);
  assert.match(handler, /status: 'shipped'/);
  assert.match(handler, /Promise\.all\(\[fetchOrders\(\), fetchFeed\(\)\]\)/);
  assert.doesNotMatch(handler, /handleFilterChange|setFilter|setSearchQuery|setViewingPerson|setVisibleOrderCount|scroll/);
});
