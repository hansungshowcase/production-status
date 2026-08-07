const SECRET = 'hansung-production-status';
const SPREADSHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const TARGET_SHEET_ID = 0;
const WRITE_WIDTH = 19;
const ID_COLUMN = 20;
const ROW_WIDTH = 20;
const LOCK_TIMEOUT_MS = 5000;
const REQUIRED_HEADERS = ['발주일', '납기일', '담당', '거래처', '전화번호'];
const KEY_COLUMNS = [0, 1, 2, 3, 8, 10, 12, 14, 16, 17, 18];

function jsonOutput(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function normalizeHeader(value) {
  return String(value || '').replace(/\s/g, '');
}

function findHeaderRow(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), WRITE_WIDTH);
  const rowsToCheck = Math.min(Math.max(sheet.getLastRow(), 1), 20);
  const rows = sheet
    .getRange(1, 1, rowsToCheck, Math.min(lastColumn, 30))
    .getDisplayValues();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const headers = rows[rowIndex].map(normalizeHeader);
    if (REQUIRED_HEADERS.every((header) => headers.includes(header))) {
      return rowIndex + 1;
    }
  }

  return null;
}

function sheetHasOrderHeaders(sheet) {
  return findHeaderRow(sheet) !== null;
}

function firstDataRow(sheet) {
  const headerRow = findHeaderRow(sheet);
  return headerRow ? headerRow + 1 : 1;
}

function findTargetSheet(spreadsheet, requestedSheetId) {
  const sheets = spreadsheet.getSheets();
  const requested = sheets.find((item) => item.getSheetId() === requestedSheetId);
  if (requested && sheetHasOrderHeaders(requested)) {
    return requested;
  }

  return sheets.find(sheetHasOrderHeaders) || requested || sheets[0];
}

function nextInputRow(sheet) {
  const startRow = firstDataRow(sheet);
  const lastRow = Math.max(sheet.getLastRow(), startRow);
  const range = sheet.getRange(startRow, 1, lastRow - startRow + 1, ROW_WIDTH);
  const values = range.getDisplayValues();
  const formulas = range.getFormulas();
  let lastOccupiedRow = startRow - 1;
  let blankRunStart = null;
  let blankRunLength = 0;

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const hasValue = values[rowIndex].some((value, columnIndex) => (
      String(value).trim() !== '' || String(formulas[rowIndex][columnIndex] || '').trim() !== ''
    ));
    if (hasValue) {
      lastOccupiedRow = startRow + rowIndex;
      if (blankRunLength >= 3) {
        return blankRunStart;
      }
      blankRunStart = null;
      blankRunLength = 0;
    } else {
      if (blankRunLength === 0) {
        blankRunStart = startRow + rowIndex;
      }
      blankRunLength += 1;
    }
  }

  return lastOccupiedRow + 1;
}

function normalizeDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const match = String(value ?? '').trim().match(/^(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/);
  if (!match) return String(value ?? '').trim();

  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function normalizeCell(value, columnIndex) {
  if (columnIndex === 0 || columnIndex === 1) {
    return normalizeDate(value);
  }
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function isMatchingOrderRow(rowValues, targetValues) {
  return KEY_COLUMNS.every((index) => (
    normalizeCell(rowValues[index], index) === normalizeCell(targetValues[index], index)
  ));
}

function normalizeOrderId(value) {
  const orderId = Number(value);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

function findOrderRowById(sheet, orderId) {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return null;

  const startRow = firstDataRow(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return null;

  const rows = sheet
    .getRange(startRow, ID_COLUMN, lastRow - startRow + 1, 1)
    .getValues();

  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const value = rows[rowIndex][0];
    if (String(value ?? '').trim() !== '' && Number(value) === normalizedOrderId) {
      return startRow + rowIndex;
    }
  }

  return null;
}

// KEY_COLUMNS 가 출고완료(E)·문/디자인·비고를 보지 않으므로 같은 거래처의 같은 날 같은 사양 발주는
// 레거시 행끼리 구별되지 않는다. 후보가 여러 개면 지우지 않고 호출자에게 모호함을 알린다.
function findMatchingLegacyOrderRows(sheet, targetValues) {
  const startRow = firstDataRow(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];

  const rows = sheet
    .getRange(startRow, 1, lastRow - startRow + 1, ROW_WIDTH)
    .getValues();

  const matches = [];
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const hasOrderId = String(rows[rowIndex][ID_COLUMN - 1] ?? '').trim() !== '';
    if (!hasOrderId && isMatchingOrderRow(rows[rowIndex], targetValues)) {
      matches.push(startRow + rowIndex);
    }
  }

  return matches;
}

function deleteMatchingOrder(sheet, orderId, targetValues) {
  const rowById = findOrderRowById(sheet, orderId);
  if (rowById) {
    sheet.deleteRow(rowById);
    return { deletedRow: rowById };
  }

  const legacyMatches = findMatchingLegacyOrderRows(sheet, targetValues);
  if (legacyMatches.length === 0) return { deletedRow: null };
  if (legacyMatches.length > 1) return { error: 'ambiguous legacy match' };

  sheet.deleteRow(legacyMatches[0]);
  return { deletedRow: legacyMatches[0] };
}

function withMutationLock(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error('Unable to acquire script lock');
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

// 이 정렬은 A~T(ROW_WIDTH=20)만 옮긴다. 실제 시트는 AQ(43)열까지 쓰고 있어
// (파트 2,934행 / 자재 발주·입고 2,100행 / AD열 2,548행), 실행하면 왼쪽 주문 정보만
// 자리를 옮기고 오른쪽 자재·파트 정보는 제자리에 남아 3천 행이 통째로 어긋난다.
// 되돌리기가 사실상 불가능해서 비활성화한다. (2026-08-07)
// 정렬이 필요하면 구글시트 화면에서 직접 하거나, 출고용 스크립트의 sortRangeByColumn 을 쓴다.
// 그쪽은 마지막 사용 열까지 포함하고 시작·끝 행을 지정할 수 있다.
function sortOrdersByDate(sheet) {
  throw new Error('sort disabled: 이 정렬은 A~T 20칸만 옮겨 나머지 열이 어긋납니다. 시트에서 직접 정렬하거나 출고용 스크립트의 sortRangeByColumn 을 사용하세요.');
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');
  if (data.secret !== SECRET) {
    return jsonOutput({ ok: false, error: 'unauthorized' });
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const targetSheetId = Number(data.sheetId ?? TARGET_SHEET_ID);

  if (data.action === 'statusAll') {
    const sheets = spreadsheet.getSheets().map((item) => ({
      sheetName: item.getName(),
      sheetId: item.getSheetId(),
      hasOrderHeaders: sheetHasOrderHeaders(item),
      lastRow: item.getLastRow(),
      nextRow: nextInputRow(item),
    }));
    return jsonOutput({ ok: true, spreadsheetId: SPREADSHEET_ID, sheets });
  }

  const sheet = findTargetSheet(spreadsheet, targetSheetId);
  if (!sheet) {
    return jsonOutput({ ok: false, error: 'target sheet not found' });
  }

  if (data.action === 'inspectRows') {
    const rows = (data.rows || [1, 2, 2702, 2703, 3433]).map((row) => ({
      row,
      values: sheet.getRange(Number(row), 1, 1, 30).getDisplayValues()[0],
    }));
    return jsonOutput({ ok: true, sheetName: sheet.getName(), sheetId: sheet.getSheetId(), rows });
  }

  if (data.action === 'status') {
    return jsonOutput({
      ok: true,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: sheet.getName(),
      sheetId: sheet.getSheetId(),
      nextRow: nextInputRow(sheet),
    });
  }

  // 정렬 요청은 락을 잡거나 시트를 건드리기 전에 거절한다.
  if (data.action === 'sort') {
    return jsonOutput({
      ok: false,
      error: 'sort disabled: A~T 20칸만 옮겨 나머지 열이 어긋납니다. 출고용 스크립트의 sortRangeByColumn 을 사용하세요.',
    });
  }

  if (data.action === 'deleteRow') {
    return withMutationLock(() => {
      const row = Number(data.row);
      if (!Number.isInteger(row) || row < firstDataRow(sheet)) {
        return jsonOutput({ ok: false, error: 'invalid row' });
      }
      sheet.deleteRow(row);
      return jsonOutput({ ok: true, deletedRow: row });
    });
  }

  const values = Array.isArray(data.values) ? data.values.slice(0, WRITE_WIDTH) : [];
  while (values.length < WRITE_WIDTH) {
    values.push('');
  }

  if (data.action === 'deleteOrder') {
    return withMutationLock(() => {
      const result = deleteMatchingOrder(sheet, data.orderId, values);
      if (result.error) {
        return jsonOutput({ ok: false, error: result.error });
      }
      return jsonOutput({ ok: true, deletedRow: result.deletedRow });
    });
  }

  const orderId = normalizeOrderId(data.orderId);
  if (!orderId) {
    return jsonOutput({ ok: false, error: 'invalid orderId' });
  }

  return withMutationLock(() => {
    const matchingRow = findOrderRowById(sheet, orderId);
    if (matchingRow) {
      return jsonOutput({
        ok: true,
        row: matchingRow,
        deduplicated: true,
        spreadsheetId: SPREADSHEET_ID,
      });
    }

    const inputRow = nextInputRow(sheet);
    sheet.hideColumns(ID_COLUMN);
    sheet.getRange(inputRow, 1, 1, ROW_WIDTH).setValues([[...values, orderId]]);

    return jsonOutput({
      ok: true,
      row: inputRow,
      deduplicated: false,
      spreadsheetId: SPREADSHEET_ID,
    });
  });
}
