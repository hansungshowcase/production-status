import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = new URL('../.apps-script-sheet/Code.js', import.meta.url);
const spreadsheetId = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const idColumnIndex = 43;

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
      if (sheet.failNextSetValues || sheet.failSetValuesAt === sheet.setValuesCalls.length) {
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
    failSetValuesAt: null,
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
  const properties = new Map([
    ['PRODUCTION_STATUS_WEBHOOK_SECRET', 'hansung-production-status'],
  ]);
  const propertyWrites = [];
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
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return properties.get(key) ?? null; },
          setProperties(values) {
            propertyWrites.push({ ...values });
            Object.entries(values).forEach(([key, value]) => properties.set(key, value));
          },
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest(_algorithm, value) {
        return Array.from(createHash('sha256').update(String(value)).digest());
      },
      formatDate: (value) => value.toISOString().slice(0, 10),
    },
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
    properties,
    propertyWrites,
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
  return Array(44).fill('');
}

function occupiedRow(orderId) {
  return rowWithId(visibleValues('2026-08-01'), orderId);
}

function rowWithId(values, orderId) {
  const row = blankRow();
  values.forEach((value, index) => { row[index] = value; });
  row[idColumnIndex] = orderId;
  return row;
}

test('append reserves AR before A:S and preserves replay-safe append order', async () => {
  const harness = await createAppsScriptHarness();
  const firstValues = visibleValues('2026-09-02');
  const secondValues = visibleValues('2026-08-01');

  const first = harness.post({ orderId: 101, values: firstValues });
  const second = harness.post({ orderId: 102, values: secondValues });
  const replay = harness.post({ orderId: 101, values: firstValues });

  assert.deepEqual(first, { ok: true, row: 2, deduplicated: false, spreadsheetId });
  assert.deepEqual(second, { ok: true, row: 3, deduplicated: false, spreadsheetId });
  assert.deepEqual(replay, { ok: true, row: 2, deduplicated: true, spreadsheetId });
  assert.equal(harness.sheet.setValuesCalls.length, 6);
  assert.equal(harness.sheet.setValuesCalls[0].column, 44);
  assert.match(harness.sheet.setValuesCalls[0].values[0][0], /^pending:101:/);
  assert.equal(harness.sheet.setValuesCalls[1].columnCount, 19);
  assert.deepEqual(Array.from(harness.sheet.setValuesCalls[1].values[0]), firstValues);
  assert.deepEqual(Array.from(harness.sheet.setValuesCalls[4].values[0]), secondValues);
  assert.equal(typeof harness.sheet.rows[1][idColumnIndex], 'number');
  assert.deepEqual(harness.sheet.hiddenColumns, []);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => [row[0], row[idColumnIndex]]), [
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

  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[idColumnIndex]), [201, 202]);
  assert.equal(harness.sheet.setValuesCalls.length, 6);
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
  assert.equal(harness.sheet.rows[2952][idColumnIndex], 3430);
  assert.equal(harness.sheet.rows[2953][idColumnIndex], 3431);
  assert.equal(harness.sheet.rows[1620][idColumnIndex], '');
});

test('occupancy trims whitespace and counts 0, false, and AR-only IDs', async () => {
  const harness = await createAppsScriptHarness();
  const whitespace = blankRow();
  whitespace[0] = '   ';
  const zero = blankRow();
  zero[0] = 0;
  const falseValue = blankRow();
  falseValue[0] = false;
  const hiddenId = blankRow();
  hiddenId[idColumnIndex] = 3440;
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
  assert.equal(harness.sheet.rows[9][idColumnIndex], 3440);
});

test('formula returning an empty display value still makes the row occupied', async () => {
  const harness = await createAppsScriptHarness();
  harness.sheet.rows.push(blankRow(), occupiedRow(3450));
  harness.sheet.formulaRows[1] = blankRow();
  harness.sheet.formulaRows[1][0] = '=IF(TRUE,"","")';

  const result = harness.post({ orderId: 3451, values: visibleValues('2026-08-03') });

  assert.equal(result.row, 4);
  assert.equal(harness.sheet.rows[1][0], '');
  assert.equal(harness.sheet.rows[2][idColumnIndex], 3450);
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
  assert.equal(harness.sheet.rows[7][idColumnIndex], 3463);
});

test('all mutating actions use one bounded script lock and contention performs no mutation', async () => {
  // sort 는 비활성화되어 락을 잡기 전에 거절되므로 이 목록에서 뺀다(아래 별도 테스트로 검증).
  const actions = [
    { orderId: 301, values: visibleValues('2026-08-03') },
    { action: 'deleteRow', row: 2 },
    { action: 'deleteOrder', orderId: 301, values: visibleValues('2026-08-03') },
  ];

  for (const payload of actions) {
    const harness = await createAppsScriptHarness();
    harness.sheet.rows.push(rowWithId(visibleValues('2026-08-03'), 301));
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

// 이 정렬은 A~T 20칸만 옮긴다. 실제 시트는 AQ(43)열까지 쓰고 있어(파트·자재 발주/입고 등
// 2,000~2,900행) 실행하면 오른쪽 열이 제자리에 남아 3천 행이 통째로 어긋난다.
// 되돌리기가 사실상 불가능해 비활성화했다. 정렬은 출고용 스크립트의 sortRangeByColumn 을 쓴다.
test('sort 요청은 시트를 건드리지 않고 거절된다', async () => {
  const harness = await createAppsScriptHarness();
  harness.post({ orderId: 501, values: visibleValues('2026-09-02') });
  harness.post({ orderId: 502, values: visibleValues('2026-08-01') });
  const before = structuredClone(harness.sheet.rows);

  const result = harness.post({ action: 'sort' });

  assert.equal(result.ok, false);
  assert.match(result.error, /sort disabled/);
  assert.equal(harness.sheet.sortCalls.length, 0, '정렬을 실제로 실행하면 안 된다');
  assert.deepEqual(harness.sheet.rows, before, '행 순서가 그대로여야 한다');
  // 락조차 잡지 않고 거절해야 다른 요청을 막지 않는다.
  assert.equal(harness.lockState.releases, 2, '앞선 append 2건 외에는 락을 쓰지 않는다');
});

test('deleteOrder prefers the hidden ID and only falls back to visible fields for legacy blank-ID rows', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-08-03');
  harness.post({ orderId: 601, values });
  harness.post({ orderId: 602, values });
  harness.sheet.rows.push([...values, '']);

  const byId = harness.post({ action: 'deleteOrder', orderId: 602, values });
  assert.equal(byId.deletedRow, 3);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[idColumnIndex] ?? ''), [601, '']);

  const legacyFallback = harness.post({ action: 'deleteOrder', orderId: 999, values });
  assert.equal(legacyFallback.deletedRow, 3);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[idColumnIndex] ?? ''), [601]);

  const noModernFallback = harness.post({ action: 'deleteOrder', orderId: 999, values });
  assert.equal(noModernFallback.deletedRow, null);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[idColumnIndex] ?? ''), [601]);
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
  harness.sheet.rows.push([...values, ''], rowWithId(values, 703), [...values, '']);

  const result = harness.post({ action: 'deleteOrder', orderId: 703, values });

  assert.deepEqual(result, { ok: true, deletedRow: 3 });
  assert.deepEqual(harness.sheet.deleteCalls, [3]);
  assert.deepEqual(harness.sheet.rows.slice(1).map((row) => row[idColumnIndex] ?? ''), ['', '']);
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

test('AR reservation recovers each append crash boundary without touching T:AQ', async () => {
  for (const failSetValuesAt of [2, 3]) {
    const harness = await createAppsScriptHarness();
    const protectedRow = blankRow();
    protectedRow[19] = '제조상태';
    protectedRow[20] = '=T2';
    protectedRow[42] = '자재';
    harness.sheet.rows.push(protectedRow);
    const beforeProtected = harness.sheet.rows[1].slice(19, 43);
    harness.sheet.failSetValuesAt = failSetValuesAt;

    assert.throws(
      () => harness.post({ orderId: 801, values: visibleValues('2026-10-22') }),
      /simulated sheet write failure/,
    );
    harness.sheet.failSetValuesAt = null;
    const result = harness.post({ orderId: 801, values: visibleValues('2026-10-22') });

    assert.equal(result.ok, true);
    assert.equal(harness.sheet.rows.filter((row) => row[idColumnIndex] === 801).length, 1);
    assert.deepEqual(harness.sheet.rows[1].slice(19, 43), beforeProtected);
    assert.deepEqual(harness.sheet.hiddenColumns, []);
  }
});

test('numeric T collision and mismatched pending payload are held without writes', async () => {
  const harness = await createAppsScriptHarness();
  const numericT = blankRow();
  numericT[19] = 802;
  harness.sheet.rows.push(numericT);
  const before = structuredClone(harness.sheet.rows);

  assert.deepEqual(
    harness.post({ orderId: 802, values: visibleValues('2026-10-22') }),
    { ok: false, error: 'unresolved legacy order id' },
  );
  assert.deepEqual(
    harness.post({ action: 'deleteOrder', orderId: 802, strictOrderId: true, values: visibleValues('2026-10-22') }),
    { ok: false, error: 'unresolved legacy order id' },
  );
  assert.deepEqual(harness.sheet.rows, before);

  harness.sheet.failSetValuesAt = 2;
  assert.throws(() => harness.post({ orderId: 803, values: visibleValues('2026-10-22') }));
  harness.sheet.failSetValuesAt = null;
  assert.deepEqual(
    harness.post({ orderId: 803, values: visibleValues('2026-10-23') }),
    { ok: false, error: 'conflicting pending order' },
  );
});

test('auth probe reports the strict AR identity capability without sheet access', async () => {
  const harness = await createAppsScriptHarness();
  const result = harness.post({ action: 'authProbe' });
  assert.deepEqual(result, {
    ok: true,
    version: '24-transition',
    strictOrderId: true,
    idColumn: 44,
    idSchema: 'ar-v1',
  });
  assert.equal(harness.lockState.attempts.length, 0);
});

test('duplicate numeric AR identities block append and strict delete without mutation', async () => {
  const harness = await createAppsScriptHarness();
  const values = visibleValues('2026-10-22');
  harness.sheet.rows.push(rowWithId(values, 901), rowWithId(values, 901));

  const append = harness.post({ action: 'append', orderId: 901, values });
  const remove = harness.post({ action: 'deleteOrder', orderId: 901, values, strictOrderId: true });

  assert.deepEqual(append, { ok: false, error: 'duplicate order id' });
  assert.deepEqual(remove, { ok: false, error: 'duplicate order id' });
  assert.equal(harness.sheet.deleteCalls.length, 0);
  assert.equal(harness.sheet.setValuesCalls.length, 0);
});

test('final source removes rotation and rejects the legacy secret without sheet mutation', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /ROTATION_|rotateWebhookSecret|LEGACY_SECRET_PROPERTY|legacySecret/);

  const harness = await createAppsScriptHarness();
  harness.properties.set('PRODUCTION_STATUS_WEBHOOK_LEGACY_SECRET', 'retired-legacy-secret');
  harness.properties.delete('PRODUCTION_STATUS_WEBHOOK_SECRET');
  const legacy = harness.post({ action: 'authProbe', secret: 'retired-legacy-secret' });

  assert.deepEqual(legacy, { ok: false, error: 'unauthorized' });
  assert.equal(harness.sheet.setValuesCalls.length, 0);
  assert.equal(harness.sheet.deleteCalls.length, 0);
  assert.equal(harness.propertyWrites.length, 0);
});
