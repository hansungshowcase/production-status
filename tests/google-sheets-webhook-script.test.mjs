import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = new URL('../.apps-script-sheet/Code.js', import.meta.url);
const spreadsheetId = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';

function makeRange(sheet, row, column, rowCount, columnCount) {
  return {
    getDisplayValues() {
      return Array.from({ length: rowCount }, (_, rowOffset) => (
        Array.from({ length: columnCount }, (_, columnOffset) => {
          const value = sheet.rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? '';
          return String(value);
        })
      ));
    },
    getValues() {
      return Array.from({ length: rowCount }, (_, rowOffset) => (
        Array.from({ length: columnCount }, (_, columnOffset) => (
          sheet.rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''
        ))
      ));
    },
    setValues(values) {
      sheet.setValuesCalls.push({ row, column, rowCount, columnCount, values });
      if (sheet.failNextSetValues) {
        sheet.failNextSetValues = false;
        throw new Error('simulated sheet write failure');
      }
      for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
        while (sheet.rows.length < row + rowOffset) sheet.rows.push([]);
        for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
          sheet.rows[row - 1 + rowOffset][column - 1 + columnOffset] = values[rowOffset][columnOffset];
        }
      }
      return this;
    },
    sort(options) {
      sheet.sortCalls.push({ row, column, rowCount, columnCount, options });
      const sorted = sheet.rows
        .slice(row - 1, row - 1 + rowCount)
        .sort((left, right) => String(left[options.column - 1] ?? '').localeCompare(String(right[options.column - 1] ?? '')));
      sheet.rows.splice(row - 1, rowCount, ...sorted);
      return this;
    },
  };
}

function makeSheet(headers) {
  return {
    rows: [[...headers]],
    setValuesCalls: [],
    sortCalls: [],
    deleteCalls: [],
    hiddenColumns: [],
    failNextSetValues: false,
    getSheetId: () => 0,
    getName: () => 'Orders',
    getLastColumn() {
      return Math.max(0, ...this.rows.map((row) => row.length));
    },
    getLastRow() {
      return this.rows.length;
    },
    getRange(row, column, rowCount, columnCount) {
      return makeRange(this, row, column, rowCount, columnCount);
    },
    deleteRow(row) {
      this.deleteCalls.push(row);
      this.rows.splice(row - 1, 1);
    },
    hideColumns(column) {
      this.hiddenColumns.push(column);
    },
  };
}

async function createAppsScriptHarness() {
  const source = await readFile(sourcePath, 'utf8');
  const lockState = {
    available: true,
    held: false,
    attempts: [],
    releases: 0,
  };
  const context = vm.createContext({
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(content) {
        return {
          content,
          setMimeType() { return this; },
        };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock(timeoutMs) {
            lockState.attempts.push(timeoutMs);
            if (!lockState.available || lockState.held) return false;
            lockState.held = true;
            return true;
          },
          releaseLock() {
            assert.equal(lockState.held, true, 'releaseLock must only release an acquired lock');
            lockState.held = false;
            lockState.releases += 1;
          },
        };
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
    Utilities: { formatDate: (value) => value.toISOString().slice(0, 10) },
  });
  vm.runInContext(source, context, { filename: sourcePath.pathname });
  const headers = vm.runInContext('REQUIRED_HEADERS', context);
  const sheet = makeSheet(headers);
  const spreadsheet = { getSheets: () => [sheet] };
  context.SpreadsheetApp = {
    openById(id) {
      assert.equal(id, spreadsheetId);
      return spreadsheet;
    },
  };

  return {
    context,
    lockState,
    sheet,
    post(payload) {
      const output = context.doPost({ postData: { contents: JSON.stringify({
        secret: 'hansung-production-status',
        ...payload,
      }) } });
      return JSON.parse(output.content);
    },
  };
}

function visibleValues(orderDate) {
  return [
    orderDate, '2026-09-30', 'manager', 'same client',
    '', '', '', '', '010-0000-0000', '', 'door', '',
    100, '*', 200, '*', 300, 1, 'white',
  ];
}

test('append uses the hidden order ID for replay safety and preserves append order', async () => {
  const harness = await createAppsScriptHarness();
  const firstValues = visibleValues('2026-09-02');
  const secondValues = visibleValues('2026-08-01');

  const first = harness.post({ orderId: 101, values: firstValues });
  const second = harness.post({ orderId: 102, values: secondValues });
  const replay = harness.post({ orderId: 101, values: firstValues });

  assert.deepEqual(first, { ok: true, row: 2, deduplicated: false, spreadsheetId });
  assert.deepEqual(second, { ok: true, row: 3, deduplicated: false, spreadsheetId });
  assert.deepEqual(replay, { ok: true, row: 2, deduplicated: true, spreadsheetId });
  assert.equal(harness.sheet.setValuesCalls.length, 2);
  assert.equal(harness.sheet.setValuesCalls[0].columnCount, 20);
  assert.deepEqual(Array.from(harness.sheet.setValuesCalls[0].values[0]), [...firstValues, 101]);
  assert.deepEqual(Array.from(harness.sheet.setValuesCalls[1].values[0]), [...secondValues, 102]);
  assert.equal(typeof harness.sheet.rows[1][19], 'number');
  assert.ok(harness.sheet.hiddenColumns.includes(20));
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => [row[0], row[19]]), [
    ['2026-09-02', 101],
    ['2026-08-01', 102],
  ]);
  assert.equal(harness.sheet.sortCalls.length, 0, 'normal append must not sort');

  assert.equal(harness.post({ action: 'status' }).spreadsheetId, spreadsheetId);
});

test('identical visible values with distinct IDs append as distinct rows', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');

  harness.post({ orderId: 201, values });
  harness.post({ orderId: 202, values });

  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[19]), [201, 202]);
  assert.equal(harness.sheet.setValuesCalls.length, 2);
});

test('all mutating actions use one bounded script lock and contention performs no mutation', async () => {
  const actions = [
    { orderId: 301, values: visibleValues('2026-08-03') },
    { action: 'sort' },
    { action: 'deleteRow', row: 2 },
    { action: 'deleteOrder', orderId: 301, values: visibleValues('2026-08-03') },
  ];

  for (const payload of actions) {
    const harness = await createAppsScriptHarness();
    harness.sheet.rows.push([...visibleValues('2026-08-03'), 301]);
    const before = structuredClone(harness.sheet.rows);
    harness.lockState.available = false;

    assert.throws(() => harness.post(payload), /lock/i);
    assert.deepEqual(harness.sheet.rows, before);
    assert.equal(harness.lockState.attempts.length, 1);
    assert.ok(harness.lockState.attempts[0] > 0 && harness.lockState.attempts[0] <= 10_000);
    assert.equal(harness.lockState.releases, 0);
  }
});

test('the script lock is released when a sheet mutation throws', async () => {
  const harness = await createAppsScriptHarness();
  harness.sheet.failNextSetValues = true;

  assert.throws(
    () => harness.post({ orderId: 401, values: visibleValues('2026-08-03') }),
    /simulated sheet write failure/,
  );
  assert.equal(harness.lockState.held, false);
  assert.equal(harness.lockState.releases, 1);

  const retry = harness.post({ orderId: 401, values: visibleValues('2026-08-03') });
  assert.equal(retry.row, 2);
  assert.equal(harness.lockState.held, false);
  assert.equal(harness.lockState.releases, 2);
});

test('explicit sort covers A:T and keeps each hidden ID aligned with its visible row', async () => {
  const harness = await createAppsScriptHarness();
  harness.post({ orderId: 501, values: visibleValues('2026-09-02') });
  harness.post({ orderId: 502, values: visibleValues('2026-08-01') });

  const result = harness.post({ action: 'sort' });

  assert.deepEqual(result, { ok: true, sorted: true, spreadsheetId });
  assert.equal(harness.sheet.sortCalls.length, 1);
  assert.equal(harness.sheet.sortCalls[0].columnCount, 20);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => [row[0], row[19]]), [
    ['2026-08-01', 502],
    ['2026-09-02', 501],
  ]);
});

test('deleteOrder prefers the hidden ID and only falls back to visible fields for legacy blank-ID rows', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.post({ orderId: 601, values });
  harness.post({ orderId: 602, values });
  harness.sheet.rows.push([...values, '']);

  const byId = harness.post({ action: 'deleteOrder', orderId: 602, values });
  assert.equal(byId.deletedRow, 3);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[19]), [601, '']);

  const legacyFallback = harness.post({ action: 'deleteOrder', orderId: 999, values });
  assert.equal(legacyFallback.deletedRow, 3);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[19]), [601]);

  const noModernFallback = harness.post({ action: 'deleteOrder', orderId: 999, values });
  assert.equal(noModernFallback.deletedRow, null);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[19]), [601]);
});
