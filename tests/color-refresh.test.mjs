import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const variablesCss = readFileSync(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
const salesPageCss = readFileSync(new URL('../src/pages/SalesMyPage.css', import.meta.url), 'utf8');
const workerStationCss = readFileSync(new URL('../src/pages/WorkerStationViewPage.css', import.meta.url), 'utf8');
const salesSummaryCss = readFileSync(new URL('../src/components/sales/SalesSummaryCards.css', import.meta.url), 'utf8');
const salesOrderCardCss = readFileSync(new URL('../src/components/sales/SalesOrderCard.css', import.meta.url), 'utf8');

test('global palette uses quieter production colors without layout changes', () => {
  assert.match(variablesCss, /--bg:\s*#f4f7fb;/);
  assert.match(variablesCss, /--surface2:\s*#eef3f8;/);
  assert.match(variablesCss, /--border:\s*#d8e1ec;/);
  assert.match(variablesCss, /--blue:\s*#2563eb;/);
  assert.match(variablesCss, /--blue-light:\s*#eff6ff;/);
  assert.match(variablesCss, /--blue-dark:\s*#1d4ed8;/);
  assert.match(variablesCss, /--green:\s*#059669;/);
  assert.match(variablesCss, /--red:\s*#dc2626;/);
  assert.match(variablesCss, /--text-dim:\s*#64748b;/);
});

test('sales and worker surfaces consume the refreshed shared palette', () => {
  assert.match(salesPageCss, /\.sales-my-page\s*\{[\s\S]*background:\s*var\(--bg,\s*#f4f7fb\);/);
  assert.match(workerStationCss, /\.station-view\s*\{[\s\S]*background:\s*var\(--bg,\s*#f4f7fb\);/);
  assert.match(salesSummaryCss, /border:\s*1px solid var\(--border,\s*#d8e1ec\);/);
  assert.match(salesOrderCardCss, /border:\s*1px solid var\(--border,\s*#d8e1ec\);/);
  assert.match(salesOrderCardCss, /linear-gradient\(90deg,\s*#2563eb,\s*#60a5fa\)/);
});
