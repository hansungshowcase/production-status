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
    getFormulas() {
      return Array.from({ length: rowCount }, (_, rowOffset) => (
        Array.from({ length: columnCount }, (_, columnOffset) => (
          sheet.formulaRows?.[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''
        ))
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
    formulaRows: [],
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

function blankRow() {
  return Array(20).fill('');
}

function occupiedRow(orderId) {
  return [...visibleValues('2026-08-01'), orderId];
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

test('append chooses the earliest interior run of three blank rows before later history', async () => {
  const harness = await createAppsScriptHarness();
  harness.sheet.rows.push(...Array.from({ length: 3422 }, (_, index) => (
    index + 2 <= 2952 ? occupiedRow(index + 2) : blankRow()
  )));
  harness.sheet.rows[1620] = blankRow();
  harness.sheet.rows[2952] = blankRow();
  harness.sheet.rows[2953] = blankRow();
  harness.sheet.rows[2954] = blankRow();
  harness.sheet.rows[3422] = occupiedRow(3423);

  const first = harness.post({ orderId: 3430, values: visibleValues('2026-08-03') });
  const second = harness.post({ orderId: 3431, values: visibleValues('2026-08-04') });

  assert.equal(first.row, 2953);
  assert.equal(second.row, 2954);
  assert.equal(harness.sheet.rows[2952][19], 3430);
  assert.equal(harness.sheet.rows[2953][19], 3431);
  assert.equal(harness.sheet.rows[1620][19], '');
});

test('occupancy trims whitespace and counts 0, false, and hidden T-only IDs', async () => {
  const harness = await createAppsScriptHarness();
  const whitespace = blankRow();
  whitespace[0] = '   ';
  const zero = blankRow();
  zero[0] = 0;
  const falseValue = blankRow();
  falseValue[0] = false;
  const hiddenId = blankRow();
  hiddenId[19] = 3440;
  harness.sheet.rows.push(
    whitespace,
    blankRow(),
    blankRow(),
    zero,
    falseValue,
    blankRow(),
    blankRow(),
    blankRow(),
    hiddenId,
  );

  const first = harness.post({ orderId: 3441, values: visibleValues('2026-08-03') });
  const second = harness.post({ orderId: 3442, values: visibleValues('2026-08-04') });

  assert.equal(first.row, 2);
  assert.equal(second.row, 7);
  assert.equal(harness.sheet.rows[4][0], 0);
  assert.equal(harness.sheet.rows[5][0], false);
  assert.equal(harness.sheet.rows[9][19], 3440);
});

test('formula returning an empty display value still makes the row occupied', async () => {
  const harness = await createAppsScriptHarness();
  harness.sheet.rows.push(blankRow(), occupiedRow(3450));
  harness.sheet.formulaRows[1] = blankRow();
  harness.sheet.formulaRows[1][0] = '=IF(TRUE,"","")';

  const result = harness.post({ orderId: 3451, values: visibleValues('2026-08-03') });

  assert.equal(result.row, 4);
  assert.equal(harness.sheet.rows[1][0], '');
  assert.equal(harness.sheet.rows[2][19], 3450);
});

test('without a qualifying interior run, append follows the last occupied row', async () => {
  const harness = await createAppsScriptHarness();
  harness.sheet.rows.push(
    occupiedRow(3460),
    blankRow(),
    occupiedRow(3461),
    blankRow(),
    blankRow(),
    occupiedRow(3462),
    blankRow(),
    blankRow(),
  );

  const result = harness.post({ orderId: 3463, values: visibleValues('2026-08-03') });

  assert.equal(result.row, 8);
  assert.equal(harness.sheet.rows[7][19], 3463);
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

test('a single unambiguous legacy candidate is still deleted', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.sheet.rows.push([...values, '']);

  const result = harness.post({ action: 'deleteOrder', orderId: 701, values });

  assert.deepEqual(result, { ok: true, deletedRow: 2 });
  assert.deepEqual(harness.sheet.deleteCalls, [2]);
  assert.equal(harness.sheet.rows.length, 1);
});

// KEY_COLUMNS 는 출고완료(E)·문/디자인·비고를 보지 않는다. 같은 거래처가 같은 날 같은 사양으로 2건
// 발주하면 레거시 행을 구분할 수 없어, 예전에는 조용히 맨 아래(출고완료가 기록된) 행을 지웠다.
test('deleteOrder deletes nothing when several legacy rows match the same visible values', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.sheet.rows.push([...values, ''], [...values, '']);
  const before = structuredClone(harness.sheet.rows);

  const result = harness.post({ action: 'deleteOrder', orderId: 702, values });

  assert.deepEqual(result, { ok: false, error: 'ambiguous legacy match' });
  assert.deepEqual(harness.sheet.deleteCalls, [], 'ambiguous match must not delete any row');
  assert.deepEqual(harness.sheet.rows, before);
  assert.equal(harness.lockState.held, false);
  assert.equal(harness.lockState.releases, 1);
});

test('a hidden order ID still wins even when the legacy candidates are ambiguous', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.sheet.rows.push([...values, ''], [...values, 703], [...values, '']);

  const result = harness.post({ action: 'deleteOrder', orderId: 703, values });

  assert.deepEqual(result, { ok: true, deletedRow: 3 });
  assert.deepEqual(harness.sheet.deleteCalls, [3]);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[19]), ['', '']);
});

test('deleteOrder reports no deletion when no row matches at all', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.sheet.rows.push([...visibleValues('2026-01-01'), '']);

  const result = harness.post({ action: 'deleteOrder', orderId: 704, values });

  assert.deepEqual(result, { ok: true, deletedRow: null });
  assert.deepEqual(harness.sheet.deleteCalls, []);
  assert.equal(harness.sheet.rows.length, 2);
});
