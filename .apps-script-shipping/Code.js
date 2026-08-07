const SECRET = 'hansung-production-status';
const SPREADSHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const TARGET_SHEET_ID = 0;
const SHIPPING_COLUMN = 5;
const ID_COLUMN = 20;
const WRITE_WIDTH = 19;
// 여러 직원이 동시에 출고를 눌러도 락을 기다렸다 처리한다.
// 백엔드 SHIPPING_WEBHOOK_TIMEOUT_MS(30초)보다 반드시 짧아야 한다.
const LOCK_TIMEOUT_MS = 25000;
const VALUE_SEPARATOR = ' · ';
const REQUIRED_HEADERS = ['발주일', '납기일', '담당', '거래처', '전화번호'];
// 레거시 행 대조 키. 품목(K, index 10)은 제외한다 — 시트에서는 담당자가
// '꽃' 대신 '하치형 꽃', '제과' 대신 '제과 제판' 처럼 상세하게 고쳐 적기 때문에
// DB 값과 상시 어긋난다. 실측(미출고 154건 대조) 결과 품목을 빼면 매칭 성공이
// 86건 -> 127건으로 늘고 모호 매칭은 0건 그대로였다.
const KEY_COLUMNS = [0, 1, 2, 3, 8, 12, 14, 16, 17, 18];

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

function firstDataRow(sheet) {
  const headerRow = findHeaderRow(sheet);
  return headerRow ? headerRow + 1 : null;
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

function hasLegacyMatchableValues(targetValues) {
  return KEY_COLUMNS.some((index) => normalizeCell(targetValues[index], index) !== '');
}

function normalizeOrderId(value) {
  const orderId = Number(value);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

function normalizeSheetId(value) {
  const sheetId = Number(value);
  return Number.isInteger(sheetId) && sheetId >= 0 ? sheetId : null;
}

function normalizeShippingValue(value) {
  if (value == null) return null;
  const shippingValue = String(value);
  return shippingValue.trim() ? shippingValue : null;
}

function normalizeRequestValues(value) {
  const values = Array.isArray(value) ? value.slice(0, WRITE_WIDTH) : [];
  while (values.length < WRITE_WIDTH) {
    values.push('');
  }
  return values;
}

function parseRequest(event) {
  try {
    const contents = event && event.postData && event.postData.contents;
    const data = JSON.parse(contents || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (error) {
    return null;
  }
}

// T열에 박힌 orderId가 최우선. 없을 때만 T열에 유효 orderId가 없는 레거시 행을 보이는 값으로 대조한다.
// 스크립트 락이 요청을 직렬화하므로, T열 매칭이 되는 흔한 경우에는 넓은 읽기를 아예 하지 않는다.
function locateOrderRow(idColumnValues, startRow, orderId, targetValues, readVisibleRows) {
  const idMatches = [];
  const legacyOffsets = [];

  for (let rowIndex = 0; rowIndex < idColumnValues.length; rowIndex += 1) {
    const rowOrderId = normalizeOrderId(idColumnValues[rowIndex][0]);
    if (rowOrderId === null) {
      legacyOffsets.push(rowIndex);
    } else if (rowOrderId === orderId) {
      idMatches.push(startRow + rowIndex);
    }
  }

  if (idMatches.length > 1) {
    return { error: 'duplicate orderId' };
  }
  if (idMatches.length === 1) {
    return { row: idMatches[0] };
  }
  if (!hasLegacyMatchableValues(targetValues) || legacyOffsets.length === 0) {
    return { error: 'orderId not found' };
  }

  const visibleRows = readVisibleRows();
  const legacyMatches = [];
  for (let index = 0; index < legacyOffsets.length; index += 1) {
    const rowIndex = legacyOffsets[index];
    if (isMatchingOrderRow(visibleRows[rowIndex], targetValues)) {
      legacyMatches.push(startRow + rowIndex);
    }
  }

  if (legacyMatches.length === 0) {
    return { error: 'orderId not found' };
  }
  if (legacyMatches.length > 1) {
    return { error: 'ambiguous legacy match' };
  }
  return { row: legacyMatches[0] };
}

// E열은 사람이 적은 배차 메모와 공용이라 덮어쓰지 않고 이어붙인다. 이미 같은 값이 있으면 쓰지 않는다(멱등).
function mergeShippingValue(existingValue, shippingValue) {
  const existing = String(existingValue ?? '').trim();
  if (existing === '') return shippingValue;
  if (existing.indexOf(shippingValue) !== -1) return null;
  return `${existing}${VALUE_SEPARATOR}${shippingValue}`;
}

// 되돌리기(clearShipped): 출고완료 값 1개와 그에 붙은 구분자만 걷어내고 사람이 적은 메모는 남긴다.
// 값이 없으면 null 을 돌려 아무것도 쓰지 않는다(멱등).
function removeShippingValue(existingValue, shippingValue) {
  const existing = String(existingValue ?? '').trim();
  if (existing === '') return null;

  const index = existing.indexOf(shippingValue);
  if (index === -1) return null;

  let start = index;
  let end = index + shippingValue.length;
  if (
    start >= VALUE_SEPARATOR.length
    && existing.slice(start - VALUE_SEPARATOR.length, start) === VALUE_SEPARATOR
  ) {
    start -= VALUE_SEPARATOR.length;
  } else if (existing.slice(end, end + VALUE_SEPARATOR.length) === VALUE_SEPARATOR) {
    end += VALUE_SEPARATOR.length;
  }

  return `${existing.slice(0, start)}${existing.slice(end)}`.trim();
}

function resolveSheetForMaintenance(data) {
  const requestedSheetId = normalizeSheetId(data.sheetId == null ? TARGET_SHEET_ID : data.sheetId);
  if (requestedSheetId === null) return null;
  return SpreadsheetApp.openById(SPREADSHEET_ID)
    .getSheets()
    .find(function (item) { return Number(item.getSheetId()) === requestedSheetId; }) || null;
}

// startRow 이상만 정렬한다. 폭은 sheet.getLastColumn() 전체를 쓴다 — 일부만 옮기면 나머지가 어긋난다.
// dryRun 이면 아무것도 바꾸지 않고 대상 규모만 돌려준다.
function handleSortRangeByColumn(data) {
  const sheet = resolveSheetForMaintenance(data);
  if (!sheet) return jsonOutput({ ok: false, error: 'target sheet not found' });

  const startRow = Number(data.startRow);
  const sortColumn = Number(data.sortColumn);
  if (!Number.isInteger(startRow) || startRow < 2) {
    return jsonOutput({ ok: false, error: 'invalid startRow' });
  }
  if (!Number.isInteger(sortColumn) || sortColumn < 1) {
    return jsonOutput({ ok: false, error: 'invalid sortColumn' });
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const rowCount = lastRow - startRow + 1;
  if (rowCount <= 1) {
    return jsonOutput({ ok: true, sorted: 0, startRow: startRow, lastRow: lastRow, lastColumn: lastColumn });
  }
  if (sortColumn > lastColumn) {
    return jsonOutput({ ok: false, error: 'sortColumn beyond last column' });
  }

  if (data.dryRun === true) {
    return jsonOutput({ ok: true, dryRun: true, wouldSort: rowCount, startRow: startRow, lastRow: lastRow, lastColumn: lastColumn });
  }

  return withMaintenanceLock(function () {
    sheet
      .getRange(startRow, 1, rowCount, lastColumn)
      .sort({ column: sortColumn, ascending: data.ascending === false ? false : true });
    return jsonOutput({ ok: true, sorted: rowCount, startRow: startRow, lastRow: lastRow, lastColumn: lastColumn });
  });
}

// 구분선 행 삽입. 지정 행 위에 한 줄 넣고 배경색과 안내 문구를 넣는다.
function handleInsertMarkerRow(data) {
  const sheet = resolveSheetForMaintenance(data);
  if (!sheet) return jsonOutput({ ok: false, error: 'target sheet not found' });

  const atRow = Number(data.atRow);
  if (!Number.isInteger(atRow) || atRow < 2) {
    return jsonOutput({ ok: false, error: 'invalid atRow' });
  }
  const text = String(data.text == null ? '' : data.text);
  if (!text.trim()) return jsonOutput({ ok: false, error: 'invalid text' });

  const background = String(data.background || '#ffe680');
  const lastColumn = Math.max(sheet.getLastColumn(), 1);

  return withMaintenanceLock(function () {
    sheet.insertRowBefore(atRow);
    const range = sheet.getRange(atRow, 1, 1, lastColumn);
    range.setBackground(background);
    sheet.getRange(atRow, 1).setValue(text);
    return jsonOutput({ ok: true, insertedRow: atRow, width: lastColumn });
  });
}

function withMaintenanceLock(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return jsonOutput({ ok: false, error: 'lock unavailable' });
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function doPost(event) {
  const data = parseRequest(event);
  if (!data) {
    return jsonOutput({ ok: false, error: 'invalid JSON' });
  }

  if (data.secret !== SECRET) {
    return jsonOutput({ ok: false, error: 'unauthorized' });
  }

  // 운영자 수동 정비용(백엔드는 호출하지 않는다).
  // 기존 등록 스크립트의 sort 는 A~T 20칸만 옮겨, 그 오른쪽(파트·자재 발주/입고 등)
  // 데이터가 제자리에 남아 전 행이 어긋난다. 여기서는 반드시 마지막 사용 열까지 포함해
  // 시트 기본 정렬(서식까지 함께 이동)을 쓴다. 시작 행을 지정해 완료 구간은 건드리지 않는다.
  if (data.action === 'sortRangeByColumn') {
    return handleSortRangeByColumn(data);
  }
  if (data.action === 'insertMarkerRow') {
    return handleInsertMarkerRow(data);
  }

  // clearShipped 는 되돌리기 전용. 행 탐색 규칙은 markShipped 와 완전히 동일하고 E열 계산만 다르다.
  const isClear = data.action === 'clearShipped';
  if (!isClear && data.action !== 'markShipped') {
    return jsonOutput({ ok: false, error: 'unsupported action' });
  }

  const orderId = normalizeOrderId(data.orderId);
  if (!orderId) {
    return jsonOutput({ ok: false, error: 'invalid orderId' });
  }

  const shippingValue = normalizeShippingValue(data.shippingValue);
  if (!shippingValue) {
    return jsonOutput({ ok: false, error: 'invalid shippingValue' });
  }

  const requestedSheetId = normalizeSheetId(
    data.sheetId == null ? TARGET_SHEET_ID : data.sheetId,
  );
  if (requestedSheetId === null) {
    return jsonOutput({ ok: false, error: 'invalid sheetId' });
  }

  const targetValues = normalizeRequestValues(
    isClear && data.matchValues != null ? data.matchValues : data.values,
  );

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet
    .getSheets()
    .find((item) => Number(item.getSheetId()) === requestedSheetId);
  if (!sheet) {
    return jsonOutput({ ok: false, error: 'target sheet not found' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return jsonOutput({ ok: false, error: 'lock unavailable' });
  }

  try {
    const startRow = firstDataRow(sheet);
    if (!startRow) {
      return jsonOutput({ ok: false, error: 'header row not found' });
    }

    const lastRow = sheet.getLastRow();
    const rowCount = lastRow - startRow + 1;
    if (rowCount <= 0) {
      return jsonOutput({ ok: false, error: 'orderId not found' });
    }

    const idColumnValues = sheet.getRange(startRow, ID_COLUMN, rowCount, 1).getValues();
    const located = locateOrderRow(
      idColumnValues,
      startRow,
      orderId,
      targetValues,
      () => sheet.getRange(startRow, 1, rowCount, WRITE_WIDTH).getValues(),
    );
    if (located.error) {
      return jsonOutput({ ok: false, error: located.error });
    }

    const updatedRow = located.row;
    const existingValue = sheet
      .getRange(updatedRow, SHIPPING_COLUMN, 1, 1)
      .getDisplayValues()[0][0];
    const nextValue = isClear
      ? removeShippingValue(existingValue, shippingValue)
      : mergeShippingValue(existingValue, shippingValue);
    if (nextValue === null) {
      return jsonOutput(isClear ? { ok: true, updatedRow, unchanged: true } : { ok: true, updatedRow });
    }

    sheet.getRange(updatedRow, SHIPPING_COLUMN, 1, 1).setValues([[nextValue]]);
    return jsonOutput({ ok: true, updatedRow });
  } finally {
    lock.releaseLock();
  }
}
