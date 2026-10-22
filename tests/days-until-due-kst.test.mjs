import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('../api/_lib/daysUntilDue.js', import.meta.url).href;

function evaluateInTimezone(timezone, nowIso, dueDates) {
  const script = `
    import { daysUntilDue } from ${JSON.stringify(moduleUrl)};
    const RealDate = Date;
    const fixedNow = RealDate.parse(${JSON.stringify(nowIso)});
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [fixedNow]));
      }
      static now() { return fixedNow; }
      static parse(value) { return RealDate.parse(value); }
      static UTC(...args) { return RealDate.UTC(...args); }
    };
    const values = ${JSON.stringify(dueDates)}.map((value) => {
      const result = daysUntilDue(value);
      return Number.isNaN(result) ? 'NaN' : result;
    });
    process.stdout.write(JSON.stringify(values));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('납기 일수는 서버 시간대와 KST 시각에 관계없이 같은 KST 달력 날짜를 사용한다', () => {
  // Given: four KST times on one date and servers in two unrelated timezones.
  const cases = [
    ['2026-10-21T15:00:00.000Z', '2026-10-22'], // KST 00:00
    ['2026-10-21T23:30:00.000Z', '2026-10-22'], // KST 08:30
    ['2026-10-22T00:00:00.000Z', '2026-10-22'], // KST 09:00
    ['2026-10-22T14:59:00.000Z', '2026-10-22'], // KST 23:59
  ];

  // When: each instant is evaluated under UTC and America/Los_Angeles server time.
  const results = cases.flatMap(([nowIso, dueDate]) => [
    evaluateInTimezone('UTC', nowIso, [dueDate])[0],
    evaluateInTimezone('America/Los_Angeles', nowIso, [dueDate])[0],
  ]);

  // Then: every comparison reports the KST due date as today.
  assert.deepEqual(results, Array(results.length).fill(0));
});

test('납기 일수는 월말, 연말, 윤년 경계를 KST 달력 일수로 계산한다', () => {
  // Given: KST instants immediately before calendar boundaries.
  const cases = [
    ['2026-10-31T14:59:00.000Z', ['2026-11-01'], [1]],
    ['2026-12-31T14:59:00.000Z', ['2027-01-01'], [1]],
    ['2028-02-28T14:59:00.000Z', ['2028-02-29', '2028-03-01'], [1, 2]],
    ['2028-02-29T14:59:00.000Z', ['2028-03-01'], [1]],
  ];

  // When/Then: the same calendar distances are observed in either server timezone.
  for (const [nowIso, dueDates, expected] of cases) {
    assert.deepEqual(evaluateInTimezone('UTC', nowIso, dueDates), expected);
    assert.deepEqual(evaluateInTimezone('America/Los_Angeles', nowIso, dueDates), expected);
  }
});

test('납기 일수의 null, invalid, 오늘 전후 임계값 동작은 유지된다', () => {
  // Given: a fixed KST date and null, invalid, yesterday, today, and tomorrow inputs.
  const inputs = [null, 'not-a-date', '2026-10-21', '2026-10-22', '2026-10-23'];

  // When: the inputs are evaluated around the unchanged zero-day threshold.
  const results = evaluateInTimezone('UTC', '2026-10-21T23:30:00.000Z', inputs);

  // Then: null and invalid handling plus -1/0/1 thresholds match the previous contract.
  assert.deepEqual(results, [null, 'NaN', -1, 0, 1]);
});

test('order eligibility and stats queries use the same KST calendar as emitted D-day fields', async () => {
  const { handleGet } = await import('../api/orders/index.js');
  const { readFile } = await import('node:fs/promises');
  const basis = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date";
  for (const filter of [{ overdue: 'true' }, { due_soon: 'true' }]) {
    const statements = [];
    await handleGet({ query: filter }, { json: value => value }, { execute: async query => {
      statements.push(query);
      return { rows: statements.length === 1 ? [] : [{ count: 0 }] };
    } });
    for (const query of statements) {
      assert.ok(query.sql.includes(basis));
      assert.ok(!query.sql.includes('CURRENT_DATE'));
    }
    assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
  }
  const stats = await readFile(new URL('../api/stats.js', import.meta.url), 'utf8');
  assert.ok(!stats.includes('CURRENT_DATE'));
  assert.equal(stats.split(basis).length - 1, 7);
});
