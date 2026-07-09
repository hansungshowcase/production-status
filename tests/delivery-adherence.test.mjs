import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { calculateDeliveryAdherence } from '../api/_lib/deliveryAdherence.js';

test('calculates delivery adherence by production quantity using equipment completion as completion', () => {
  const rows = [
    { quantity: 2, due_date: '2026-07-01', status: 'in_production', equipment_completed_at: '2026-07-01' },
    { quantity: 3, due_date: '2026-07-01', status: 'in_production', equipment_completed_at: null, later_step_started_at: '2026-07-01' },
    { quantity: 4, due_date: '2026-07-01', status: 'in_production', equipment_completed: 0, later_step_started: 0 },
    { quantity: 1, due_date: '2026-07-04', status: 'in_production', equipment_completed: 0, later_step_started: 0 },
  ];

  const result = calculateDeliveryAdherence(rows, '2026-07-03');

  assert.equal(result.total_production_units, 10);
  assert.equal(result.measurable_units, 10);
  assert.equal(result.on_time_units, 6);
  assert.equal(result.missed_units, 4);
  assert.equal(result.adherence_rate, 60);
});

test('home delivery adherence card does not show zeroes before valid data loads', async () => {
  const cardSource = await readFile(new URL('../src/components/home/DeliveryAdherenceCard.jsx', import.meta.url), 'utf8');

  assert.match(cardSource, /useState\(null\)/);
  assert.match(cardSource, /isValidDeliveryAdherence/);
  assert.match(cardSource, /loading \|\| !hasStats \? '-' :/);
  assert.doesNotMatch(cardSource, /const \[stats, setStats\] = useState\(EMPTY_STATS\)/);
});

test('counts equipment work completed after the due date as missed', () => {
  const rows = [
    { quantity: 2, due_date: '2026-07-01', equipment_completed_at: '2026-07-02' },
    { quantity: 3, due_date: '2026-07-01', equipment_completed_at: '2026-07-01' },
  ];

  const result = calculateDeliveryAdherence(rows, '2026-07-03');

  assert.equal(result.total_production_units, 5);
  assert.equal(result.on_time_units, 3);
  assert.equal(result.missed_units, 2);
  assert.equal(result.adherence_rate, 60);
});

test('does not mark future due orders as missed before the due date passes', () => {
  const rows = [
    { quantity: 2, due_date: '2026-07-05', equipment_completed_at: '2026-07-06' },
    { quantity: 3, due_date: '2026-07-05', equipment_completed_at: null },
  ];

  const result = calculateDeliveryAdherence(rows, '2026-07-03');

  assert.equal(result.total_production_units, 5);
  assert.equal(result.on_time_units, 5);
  assert.equal(result.missed_units, 0);
  assert.equal(result.adherence_rate, 100);
});

test('keeps orders without due dates out of the adherence denominator but reports them', () => {
  const rows = [
    { quantity: null, due_date: '2026-07-03', status: 'shipped', equipment_completed: 0 },
    { quantity: 5, due_date: null, status: 'in_production', ship_date: null },
  ];

  const result = calculateDeliveryAdherence(rows, '2026-07-03');

  assert.equal(result.total_production_units, 6);
  assert.equal(result.measurable_units, 1);
  assert.equal(result.on_time_units, 1);
  assert.equal(result.missed_units, 0);
  assert.equal(result.missing_due_date_units, 5);
  assert.equal(result.adherence_rate, 100);
});

test('home delivery adherence API is cached for about half a day to protect database quota', async () => {
  const apiSource = await readFile(new URL('../api/delivery-adherence.js', import.meta.url), 'utf8');
  const corsSource = await readFile(new URL('../api/_lib/cors.js', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../src/api/deliveryAdherence.js', import.meta.url), 'utf8');

  assert.match(apiSource, /calculateDeliveryAdherence/);
  assert.match(apiSource, /equipment_completed_at/);
  assert.match(apiSource, /later_step_started_at/);
  assert.match(apiSource, /res\.setHeader\('ETag', `delivery-adherence-\$\{today\}-\$\{Date\.now\(\)\}`\)/);
  assert.match(corsSource, /'\/api\/delivery-adherence': 'public, s-maxage=43200, stale-while-revalidate=3600'/);
  assert.match(corsSource, /path === '\/api\/delivery-adherence'/);
  assert.match(corsSource, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(corsSource, /res\.setHeader\('Clear-Site-Data', '"cache"'\)/);
  assert.match(clientSource, /delivery_adherence_slot/);
  assert.match(clientSource, /cache:\s*'no-store'/);
  assert.doesNotMatch(clientSource, /cache:\s*'force-cache'/);
});

test('home page shows the four easy delivery adherence numbers before entry actions', async () => {
  const homeSource = await readFile(new URL('../src/pages/HomePage.jsx', import.meta.url), 'utf8');
  const cardSource = await readFile(new URL('../src/components/home/DeliveryAdherenceCard.jsx', import.meta.url), 'utf8');

  assert.match(homeSource, /<DeliveryAdherenceCard \/>/);
  assert.match(cardSource, /총 생산대수/);
  assert.match(cardSource, /납기준수/);
  assert.match(cardSource, /미준수/);
  assert.match(cardSource, /준수율/);
});
