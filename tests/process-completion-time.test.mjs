import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatProcessCompletionTime } from '../src/utils/dateUtils.js';

const salesOrderCardSource = readFileSync(
  new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url),
  'utf8',
);

test('process completion timestamps are displayed in Korea time', () => {
  assert.equal(formatProcessCompletionTime('2026-09-01T00:05:00.000Z'), '09/01 09:05');
  assert.equal(formatProcessCompletionTime('not-a-date'), '');
  assert.equal(formatProcessCompletionTime(null), '');
});

test('completed time is rendered beside the process and worker name', () => {
  assert.match(
    salesOrderCardSource,
    /className="sales-order-card__process-name"[\s\S]*?sales-order-card__process-worker-inline[\s\S]*?formatProcessCompletionTime\(completedTime\)[\s\S]*?<span className=\{statusCls\}>/,
  );
  assert.match(salesOrderCardSource, /stepTimeMap\[p\.step_name\] = p\.completed_at/);
  assert.match(salesOrderCardSource, /stepTimeMap\[step\] = summary\.completed_at/);
});
