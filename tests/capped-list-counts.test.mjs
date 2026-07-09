import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const salesSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');
const workerSearchSource = readFileSync(new URL('../src/pages/WorkerSearchPage.jsx', import.meta.url), 'utf8');
const tabletWorkerSource = readFileSync(new URL('../src/pages/TabletWorkerPage.jsx', import.meta.url), 'utf8');
const workerPageSource = readFileSync(new URL('../src/pages/WorkerPage.jsx', import.meta.url), 'utf8');
const adminPageSource = readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const dataOverviewSource = readFileSync(new URL('../src/components/admin/DataOverview.jsx', import.meta.url), 'utf8');
const mojibakeScanSource = readFileSync(new URL('../api/admin/mojibake-scan.js', import.meta.url), 'utf8');

test('sales order status loads all paginated orders before calculating summary counts', () => {
  assert.equal(salesSource.includes('async function fetchAllSalesOrders'), true);
  assert.equal(salesSource.includes('offset += page.length'), true);
  assert.equal(salesSource.includes('if (page.length === 0 || loaded.length >= total)'), true);
});

test('worker search total display uses the API total instead of the capped first page length', () => {
  assert.equal(workerSearchSource.includes('async function fetchAllWorkerSearchOrders'), true);
  assert.equal(workerSearchSource.includes("getOrders({ status: 'in_production', limit: WORKER_SEARCH_PAGE_SIZE, offset })"), true);
  assert.equal(workerSearchSource.includes('if (page.length === 0 || loaded.length >= total)'), true);
  assert.equal(workerSearchSource.includes('allOrdersTotalCount'), true);
  assert.equal(workerSearchSource.includes('total = Array.isArray(data) ? loaded.length : Number(data.total ?? loaded.length);'), true);
  assert.equal(workerSearchSource.includes('return { orders: loaded, total };'), true);
  assert.equal(workerSearchSource.includes("const res = await getOrders({ status: 'in_production', limit: 100 });"), false);
  assert.equal(workerSearchSource.includes('${allOrders.length}'), false);
});

test('tablet worker list loads every active order instead of deriving counts from the default capped page', () => {
  assert.equal(tabletWorkerSource.includes('async function fetchAllActiveOrders'), true);
  assert.equal(tabletWorkerSource.includes("getOrders({ status: 'in_production', limit: TABLET_ORDER_PAGE_SIZE, offset })"), true);
  assert.equal(tabletWorkerSource.includes('if (page.length === 0 || loaded.length >= total)'), true);
  assert.equal(tabletWorkerSource.includes('const data = await getOrders();'), false);
});

test('worker main task list loads every active order instead of the first capped page', () => {
  assert.equal(workerPageSource.includes('async function fetchAllWorkerPageOrders'), true);
  assert.equal(workerPageSource.includes("getOrders({ status: 'in_production', limit: WORKER_PAGE_ORDER_PAGE_SIZE, offset })"), true);
  assert.equal(workerPageSource.includes('if (page.length === 0 || loaded.length >= total)'), true);
  assert.equal(workerPageSource.includes("getOrders({ status: 'in_production', limit: 20 })"), false);
});

test('admin sales person export filter loads every order page before deriving names', () => {
  assert.equal(adminPageSource.includes('async function fetchAllAdminOrders'), true);
  assert.equal(adminPageSource.includes('ADMIN_ORDER_PAGE_SIZE'), true);
  assert.equal(adminPageSource.includes('offset += page.length'), true);
  assert.equal(adminPageSource.includes('if (page.length === 0 || loaded.length >= total)'), true);
  assert.equal(adminPageSource.includes("const res = await request('/orders');"), false);
});

test('admin data overview does not show zero totals before a valid stats response', () => {
  assert.equal(dataOverviewSource.includes('useState(null)'), true);
  assert.equal(dataOverviewSource.includes("statsRes.total_orders || 0"), false);
  assert.equal(dataOverviewSource.includes("stats?.total ?? '-'"), true);
});

test('mojibake scan counts all suspect rows separately from limited samples', () => {
  assert.equal(mojibakeScanSource.includes('COUNT(*) AS count'), true);
  assert.equal(mojibakeScanSource.includes('suspectCount: Number(countRows[0]?.count || 0)'), true);
  assert.equal(mojibakeScanSource.includes('suspectCount: rows.length'), false);
});
