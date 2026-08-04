import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = new URL('../.apps-script-shipping/Code.js', import.meta.url);
const manifestPath = new URL('../.apps-script-shipping/appsscript.json', import.meta.url);
const spreadsheetId = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const secret = 'hansung-production-status';

const ROW_WIDTH = 20;
const SHIPPING_VALUE = '출고완료 · 2026-08-04';

// 백엔드 orderValues(order)가 보내는 A~S 19칸과 동일한 모양.
const ORDER_VALUES = [
  '2026-08-03', '2026-08-10', '김담당', '한성거래처', '', '', '', '',
  '010-1234-5678', '', '쇼케이스', '', 900, '*', 600, '*', 1800, 2, '무광블랙',
];

const OTHER_ORDER_VALUES = [
  '2026-08-03', '2026-08-11', '박담당', '다른거래처', '', '', '', '',
  '010-9999-0000', '', '냉장쇼케이스', '', 1200, '*', 700, '*', 1900, 1, '화이트',
];

// 실제 시트: 1~4행 안내/잡동사니, 5행 헤더, 6행부터 데이터.
const NOTICE_ROWS = [
  ['한성쇼케이스 발주 현황'],
  ['※ 발주일 기준으로 정렬됩니다'],
  [],
  ['담당자 연락처: 내선 101'],
];

const HEADER_ROW = [
  '발주일', '납기일', '담당', '거래처', '출고', '입금', '잔금', '비고',
  '전화번호', '주소', '품명', '규격', '가로', '', '세로', '', '높이', '수량', '색상', '파트',
];

function padRow(values) {
  const row = Array(ROW_WIDTH).fill('');
  for (let index = 0; index < values.length && index < ROW_WIDTH; index += 1) {
    row[index] = values[index];
  }
  return row;
}

function dataRow({ orderId = '', shipping = '', values = ORDER_VALUES } = {}) {
  const row = padRow(values);
  row[4] = shipping;
  row[ROW_WIDTH - 1] = orderId;
  return row;
}

function displayValue(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}. ${month}. ${day}`;
  }
  return value == null ? '' : String(value);
}

function makeRange(sheet, row, column, rowCount, columnCount) {
  function read() {
    return Array.from({ length: rowCount }, (_, rowOffset) => (
      Array.from({ length: columnCount }, (_, columnOffset) => (
        sheet.rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''
      ))
    ));
  }

  return {
    getValues() {
      sheet.readCalls.push({ row, column, rowCount, columnCount, kind: 'values' });
      return read();
    },
    getDisplayValues() {
      sheet.readCalls.push({ row, column, rowCount, columnCount, kind: 'display' });
      return read().map((values) => values.map(displayValue));
    },
    setValues(values) {
      sheet.setValuesCalls.push({ row, column, rowCount, columnCount, values });
      if (sheet.failNextSetValues) {
        sheet.failNextSetValues = false;
        throw new Error('simulated sheet write failure');
      }

      for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
        while (sheet.rows.length < row + rowOffset) sheet.rows.push(padRow([]));
        for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
          sheet.rows[row - 1 + rowOffset][column - 1 + columnOffset] = values[rowOffset][columnOffset];
        }
      }
      return this;
    },
  };
}

function makeSheet({
  sheetId = 0,
  dataRows = [],
  noticeRows = NOTICE_ROWS,
  header = HEADER_ROW,
} = {}) {
  const rows = [
    ...noticeRows.map(padRow),
    ...(header ? [padRow(header)] : []),
    ...dataRows.map((row) => [...row]),
  ];

  return {
    rows,
    readCalls: [],
    setValuesCalls: [],
    appendCalls: 0,
    deleteCalls: 0,
    hideCalls: 0,
    sortCalls: 0,
    failNextSetValues: false,
    getSheetId: () => sheetId,
    getName: () => `Orders-${sheetId}`,
    getLastRow() {
      return this.rows.length;
    },
    getLastColumn() {
      return ROW_WIDTH;
    },
    getRange(row, column, rowCount, columnCount) {
      return makeRange(this, row, column, rowCount, columnCount);
    },
    shippingCell(row) {
      return this.rows[row - 1][4];
    },
    appendRow() {
      this.appendCalls += 1;
      throw new Error('appendRow must not be called');
    },
    deleteRow() {
      this.deleteCalls += 1;
      throw new Error('deleteRow must not be called');
    },
    hideColumns() {
      this.hideCalls += 1;
      throw new Error('hideColumns must not be called');
    },
    sort() {
      this.sortCalls += 1;
      throw new Error('sort must not be called');
    },
  };
}

async function createAppsScriptHarness({ sheets = [makeSheet()] } = {}) {
  const source = await readFile(sourcePath, 'utf8');
  const lockState = {
    available: true,
    held: false,
    attempts: [],
    releases: 0,
  };
  const spreadsheetAccess = [];
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
    Session: {
      getScriptTimeZone: () => 'Asia/Seoul',
    },
    Utilities: {
      formatDate(date, timeZone, format) {
        assert.equal(timeZone, 'Asia/Seoul');
        assert.equal(format, 'yyyy-MM-dd');
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
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
  });
  vm.runInContext(source, context, { filename: sourcePath.pathname });

  const spreadsheet = { getSheets: () => sheets };
  context.SpreadsheetApp = {
    openById(id) {
      spreadsheetAccess.push(id);
      assert.equal(id, spreadsheetId);
      return spreadsheet;
    },
  };

  function post(payload = {}, requestSecret = secret) {
    const output = context.doPost({
      postData: {
        contents: JSON.stringify({
          secret: requestSecret,
          action: 'markShipped',
          sheetId: 0,
          orderId: 101,
          shippingValue: SHIPPING_VALUE,
          values: ORDER_VALUES,
          ...payload,
        }),
      },
    });
    return JSON.parse(output.content);
  }

  return {
    context,
    sheets,
    sheet: sheets[0],
    lockState,
    spreadsheetAccess,
    post,
    postWithSecret(requestSecret, payload = {}) {
      return post(payload, requestSecret);
    },
  };
}

test('shipping Apps Script manifest uses the required web-app runtime settings', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Seoul');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
});

// ── 수정 ①: 헤더 5행 / 데이터 6행부터 ──

test('a header on row 5 makes row 6 the first scanned data row', async () => {
  const sheet = makeSheet({
    dataRows: [
      dataRow({ orderId: 101 }),
      dataRow({ orderId: 102, values: OTHER_ORDER_VALUES }),
    ],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 102, values: OTHER_ORDER_VALUES });

  assert.deepEqual(result, { ok: true, updatedRow: 7 });
  const scan = sheet.readCalls.find((call) => call.kind === 'values' && call.column === ROW_WIDTH);
  assert.equal(scan.row, 6, 'the row scan must begin one row below the row-5 header');
  assert.equal(scan.rowCount, 2, 'only the two data rows may be scanned');
  assert.equal(sheet.shippingCell(7), SHIPPING_VALUE);
  assert.equal(sheet.shippingCell(6), '');
  // 안내행(1~4)과 헤더행(5)은 절대 건드리지 않는다.
  assert.ok(sheet.setValuesCalls.every((call) => call.row >= 6));
});

test('the legacy visible-value scan also starts at row 6', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 'ㅇ', values: OTHER_ORDER_VALUES }), dataRow({ orderId: 'ㅇ' })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  assert.deepEqual(harness.post({ orderId: 101 }), { ok: true, updatedRow: 7 });
  const wideScan = sheet.readCalls.find((call) => call.kind === 'values' && call.columnCount > 1);
  assert.equal(wideScan.row, 6);
  assert.equal(wideScan.column, 1);
  assert.equal(wideScan.rowCount, 2);
});

test('a T column hit never triggers the wide legacy read that the script lock serializes on', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 'ㅇ' }), dataRow({ orderId: 101 })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  assert.deepEqual(harness.post({ orderId: 101 }), { ok: true, updatedRow: 7 });

  const wideReads = sheet.readCalls.filter((call) => (
    call.kind === 'values' && call.columnCount > 1
  ));
  assert.deepEqual(wideReads, [], 'matching by T ID must read one column, not the whole table');
});

test('the header row itself is never treated as data even when it carries a stale T value', async () => {
  const headerWithJunkId = [...HEADER_ROW];
  headerWithJunkId[ROW_WIDTH - 1] = 101;
  const sheet = makeSheet({
    header: headerWithJunkId,
    dataRows: [dataRow({ orderId: 101 })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.rows[4][4], '출고', 'the header row must stay untouched');
});

test('a sheet without the required headers is rejected instead of guessing a data row', async () => {
  const sheet = makeSheet({ header: null, dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: false, error: 'header row not found' });
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.equal(harness.lockState.releases, 1);
});

// ── 수정 ②: T열 폴백 ──

test('a unique T column order ID wins over any visible-value candidate', async () => {
  const sheet = makeSheet({
    dataRows: [
      dataRow({ orderId: 'ㅇ' }),
      dataRow({ orderId: 101 }),
    ],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 7 });
  assert.equal(sheet.shippingCell(7), SHIPPING_VALUE);
  assert.equal(sheet.shippingCell(6), '', 'the legacy row must not be touched when a T ID matched');
});

test('a legacy row whose T column holds ㅇ is found by its visible A~S values', async () => {
  const sheet = makeSheet({
    dataRows: [
      dataRow({ orderId: 'ㅇ', values: OTHER_ORDER_VALUES }),
      dataRow({ orderId: 'ㅇ' }),
      dataRow({ orderId: 777, values: OTHER_ORDER_VALUES }),
    ],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101, values: ORDER_VALUES });

  assert.deepEqual(result, { ok: true, updatedRow: 7 });
  assert.equal(sheet.shippingCell(7), SHIPPING_VALUE);
  assert.equal(sheet.shippingCell(6), '');
  assert.equal(sheet.shippingCell(8), '');
});

test('legacy matching ignores date formatting, real Date cells, and stray whitespace', async () => {
  const legacyValues = [...ORDER_VALUES];
  legacyValues[0] = new Date(2026, 7, 3);
  legacyValues[1] = '2026. 8. 10';
  legacyValues[3] = '  한성거래처  ';
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 'ㅇ', values: legacyValues })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101, values: ORDER_VALUES });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), SHIPPING_VALUE);
});

test('a legacy row whose 품목 was rewritten by hand still matches', async () => {
  // 실제 시트에서 담당자가 품목을 '꽃' -> '하치형 꽃', '제과' -> '제과 제판' 처럼
  // 상세하게 고쳐 적는다. 미출고 154건 실측에서 이 불일치가 매칭 실패의 최대 원인(41건)이었다.
  const legacyValues = [...ORDER_VALUES];
  legacyValues[10] = '하치형 쇼케이스 앞문';
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 'ㅇ', values: legacyValues })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101, values: ORDER_VALUES });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), SHIPPING_VALUE);
  assert.equal(sheet.rows[5][10], '하치형 쇼케이스 앞문', '품목 셀은 건드리지 않는다');
});

test('품목만 같고 나머지가 다른 행에는 쓰지 않는다', async () => {
  const decoyValues = [...OTHER_ORDER_VALUES];
  decoyValues[10] = ORDER_VALUES[10];
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 'ㅇ', values: decoyValues })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  const before = structuredClone(sheet.rows);

  const result = harness.post({ orderId: 101, values: ORDER_VALUES });

  assert.deepEqual(result, { ok: false, error: 'orderId not found' });
  assert.deepEqual(sheet.rows, before);
  assert.equal(sheet.setValuesCalls.length, 0);
});

test('two legacy candidates write nothing at all', async () => {
  const sheet = makeSheet({
    dataRows: [
      dataRow({ orderId: 'ㅇ' }),
      dataRow({ orderId: '' }),
    ],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  const before = structuredClone(sheet.rows);

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: false, error: 'ambiguous legacy match' });
  assert.deepEqual(sheet.rows, before);
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.equal(harness.lockState.releases, 1);
});

test('no T ID and no matching visible values reports orderId not found without writing', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 'ㅇ', values: OTHER_ORDER_VALUES })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101, values: ORDER_VALUES });

  assert.deepEqual(result, { ok: false, error: 'orderId not found' });
  assert.equal(sheet.setValuesCalls.length, 0);
});

test('an omitted values payload never falls back onto a blank legacy row', async () => {
  const sheet = makeSheet({
    dataRows: [
      dataRow({ orderId: 'ㅇ', values: [] }),
      dataRow({ orderId: 'ㅇ', values: OTHER_ORDER_VALUES }),
    ],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const blankValues = Array(19).fill('');
  for (const values of [undefined, [], blankValues]) {
    const result = harness.post({ orderId: 101, values });
    assert.deepEqual(result, { ok: false, error: 'orderId not found' });
  }
  assert.equal(sheet.setValuesCalls.length, 0);
});

test('duplicate T column order IDs write nothing at all', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 101 }), dataRow({ orderId: 101 })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  const before = structuredClone(sheet.rows);

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: false, error: 'duplicate orderId' });
  assert.deepEqual(sheet.rows, before);
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.equal(harness.lockState.releases, 1);
});

// ── 수정 ③: E열 값 형식과 기존 메모 보존 ──

test('an empty E cell receives the shipping value verbatim', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101, shipping: '   ' })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), '출고완료 · 2026-08-04');
});

test('a handwritten dispatch memo is preserved and the shipping value is appended', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101, shipping: '8월4일 하나화물' })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), '8월4일 하나화물 · 출고완료 · 2026-08-04');
});

test('an E cell that already equals the shipping value is left untouched', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101, shipping: SHIPPING_VALUE })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.setValuesCalls.length, 0, 'an identical value must not be rewritten');
  assert.equal(sheet.shippingCell(6), SHIPPING_VALUE);
});

test('an E cell that already contains the shipping value is left untouched', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 101, shipping: `8월4일 하나화물 · ${SHIPPING_VALUE}` })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.equal(sheet.shippingCell(6), `8월4일 하나화물 · ${SHIPPING_VALUE}`);
});

test('an older shipping date is kept and the new one is appended, not overwritten', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 101, shipping: '출고완료 · 2026-07-27' })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), '출고완료 · 2026-07-27 · 출고완료 · 2026-08-04');
});

// ── 멱등성(동시 사용 / 아웃박스 재시도) ──

test('three consecutive identical requests leave the E cell unchanged after the first', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const results = [harness.post(), harness.post(), harness.post()];

  assert.deepEqual(results, [
    { ok: true, updatedRow: 6 },
    { ok: true, updatedRow: 6 },
    { ok: true, updatedRow: 6 },
  ]);
  assert.equal(sheet.shippingCell(6), SHIPPING_VALUE);
  assert.equal(sheet.setValuesCalls.length, 1, 'only the first request may write');
});

test('five overlapping requests on an empty E cell match the single-request result exactly', async () => {
  const once = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const onceHarness = await createAppsScriptHarness({ sheets: [once] });
  onceHarness.post();

  const many = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const manyHarness = await createAppsScriptHarness({ sheets: [many] });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(manyHarness.post(), { ok: true, updatedRow: 6 });
  }

  assert.equal(many.shippingCell(6), once.shippingCell(6));
  assert.deepEqual(many.rows, once.rows);
  assert.equal(many.setValuesCalls.length, 1);
});

test('five overlapping requests on a memo row append the shipping value exactly once', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101, shipping: '8월4일 하나화물' })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(harness.post(), { ok: true, updatedRow: 6 });
  }

  const finalValue = sheet.shippingCell(6);
  assert.equal(finalValue, '8월4일 하나화물 · 출고완료 · 2026-08-04');
  assert.equal(finalValue.split(SHIPPING_VALUE).length - 1, 1, 'the shipping value must appear once');
  assert.equal(finalValue.split('출고완료').length - 1, 1);
  assert.equal(sheet.setValuesCalls.length, 1);
});

test('five overlapping requests reached through the legacy fallback stay idempotent', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 'ㅇ', shipping: '8월3일 안' })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(harness.post({ orderId: 101 }), { ok: true, updatedRow: 6 });
  }

  assert.equal(sheet.shippingCell(6), '8월3일 안 · 출고완료 · 2026-08-04');
  assert.equal(sheet.setValuesCalls.length, 1);
});

// ── 동시 접속 / 락 ──

test('the script lock waits long enough for concurrent shipments but stays under the backend timeout', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const lockTimeoutMs = Number(/const LOCK_TIMEOUT_MS = ([\d_]+);/.exec(source)[1].replace(/_/g, ''));

  assert.equal(lockTimeoutMs, 25_000);

  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  harness.post();

  assert.deepEqual(harness.lockState.attempts, [25_000]);
});

test('losing the lock leaves the sheet completely untouched', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  harness.lockState.available = false;
  const before = structuredClone(sheet.rows);

  const result = harness.post({ orderId: 101 });

  assert.deepEqual(result, { ok: false, error: 'lock unavailable' });
  assert.equal(sheet.readCalls.length, 0);
  assert.equal(sheet.setValuesCalls.length, 0);
  assert.deepEqual(sheet.rows, before);
  assert.equal(harness.lockState.releases, 0);
});

test('a request that lost the lock still succeeds once the lock frees up', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101, shipping: '8월4일 하나화물' })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  harness.lockState.available = false;
  assert.deepEqual(harness.post({ orderId: 101 }), { ok: false, error: 'lock unavailable' });

  harness.lockState.available = true;
  assert.deepEqual(harness.post({ orderId: 101 }), { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), '8월4일 하나화물 · 출고완료 · 2026-08-04');
});

test('setValues failure releases the script lock and leaves the row unchanged', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });
  sheet.failNextSetValues = true;
  const before = structuredClone(sheet.rows);

  assert.throws(() => harness.post({ orderId: 101 }), /simulated sheet write failure/);
  assert.deepEqual(sheet.rows, before);
  assert.equal(harness.lockState.held, false);
  assert.equal(harness.lockState.releases, 1);

  const retry = harness.post({ orderId: 101 });
  assert.deepEqual(retry, { ok: true, updatedRow: 6 });
  assert.equal(sheet.shippingCell(6), SHIPPING_VALUE);
  assert.equal(harness.lockState.releases, 2);
});

// ── 입력 검증 ──

test('invalid order IDs and blank shipping values return structured failure without a sheet write', async () => {
  for (const orderId of [0, -1, 1.5, 'not-a-number', 'ㅇ', null, undefined]) {
    const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
    const harness = await createAppsScriptHarness({ sheets: [sheet] });
    const result = harness.post({ orderId });

    assert.deepEqual(result, { ok: false, error: 'invalid orderId' });
    assert.equal(harness.spreadsheetAccess.length, 0);
    assert.equal(sheet.setValuesCalls.length, 0);
  }

  for (const shippingValue of ['', '   ', null, undefined]) {
    const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
    const harness = await createAppsScriptHarness({ sheets: [sheet] });
    const result = harness.post({ shippingValue });

    assert.deepEqual(result, { ok: false, error: 'invalid shippingValue' });
    assert.equal(harness.spreadsheetAccess.length, 0);
    assert.equal(sheet.setValuesCalls.length, 0);
  }
});

test('unsupported actions and malformed JSON are rejected before any sheet access', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  assert.deepEqual(harness.post({ action: 'deleteOrder' }), { ok: false, error: 'unsupported action' });
  const malformed = JSON.parse(harness.context.doPost({ postData: { contents: '{oops' } }).content);
  assert.deepEqual(malformed, { ok: false, error: 'invalid JSON' });
  assert.equal(harness.spreadsheetAccess.length, 0);
  assert.equal(sheet.setValuesCalls.length, 0);
});

test('requested sheet ID must exist and must not fall back to another sheet', async () => {
  const requestedSheet = makeSheet({ sheetId: 7, dataRows: [dataRow({ orderId: 101 })] });
  const otherSheet = makeSheet({ sheetId: 0, dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [otherSheet, requestedSheet] });

  const result = harness.post({ sheetId: 7 });

  assert.deepEqual(result, { ok: true, updatedRow: 6 });
  assert.equal(otherSheet.setValuesCalls.length, 0);
  assert.equal(requestedSheet.setValuesCalls.length, 1);

  const missing = harness.post({ sheetId: 999 });
  assert.deepEqual(missing, { ok: false, error: 'target sheet not found' });
  assert.equal(otherSheet.setValuesCalls.length, 0);
  assert.equal(requestedSheet.setValuesCalls.length, 1);
});

test('invalid secret is rejected before any SpreadsheetApp access or sheet write', async () => {
  const sheet = makeSheet({ dataRows: [dataRow({ orderId: 101 })] });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  const result = harness.postWithSecret('wrong-secret', { orderId: 101 });

  assert.deepEqual(result, { ok: false, error: 'unauthorized' });
  assert.equal(harness.spreadsheetAccess.length, 0);
  assert.equal(sheet.readCalls.length, 0);
  assert.equal(sheet.setValuesCalls.length, 0);
});

test('the shipping script never appends, deletes, hides, or sorts rows', async () => {
  const sheet = makeSheet({
    dataRows: [dataRow({ orderId: 101 }), dataRow({ orderId: 102, values: OTHER_ORDER_VALUES })],
  });
  const harness = await createAppsScriptHarness({ sheets: [sheet] });

  harness.post({ orderId: 101 });
  harness.post({ orderId: 102, values: OTHER_ORDER_VALUES });
  harness.post({ orderId: 999, values: OTHER_ORDER_VALUES });

  assert.equal(sheet.rows.length, 7);
  assert.equal(sheet.appendCalls, 0);
  assert.equal(sheet.deleteCalls, 0);
  assert.equal(sheet.hideCalls, 0);
  assert.equal(sheet.sortCalls, 0);
});
