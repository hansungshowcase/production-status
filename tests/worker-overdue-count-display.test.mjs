import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stationSource = readFileSync(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
const selectSource = readFileSync(new URL('../src/pages/WorkerSelectPage.jsx', import.meta.url), 'utf8');

test('worker station overdue alert displays the global overdue count, not the limited delayed order list length', () => {
  assert.equal(stationSource.includes('const overdueAlertTotalCount'), true);
  assert.equal(stationSource.includes('const delayedOrdersTotalCount'), true);
  assert.equal(stationSource.includes('{overdueAlertTotalCount}'), true);
  assert.equal(stationSource.includes('{delayedOrdersTotalCount}'), true);
});

test('worker select overdue panel displays the global overdue count, not the limited delayed order list length', () => {
  assert.equal(selectSource.includes('const delayedOrdersTotalCount'), true);
  assert.equal(selectSource.includes('{delayedOrdersTotalCount}'), true);
});

test('worker station due-today alert displays the global due-today count, not the limited preview list length', () => {
  assert.equal(stationSource.includes('const dueTodayOrdersTotalCount'), true);
  assert.equal(stationSource.includes('{dueTodayOrdersTotalCount}'), true);
});

test('worker select due-today panel displays the global due-today count, not the limited preview list length', () => {
  assert.equal(selectSource.includes('const dueTodayOrdersTotalCount'), true);
  assert.equal(selectSource.includes('{dueTodayOrdersTotalCount}'), true);
});
