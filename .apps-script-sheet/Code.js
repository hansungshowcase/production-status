const SECRET = 'hansung-production-status';
const SPREADSHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const TARGET_SHEET_ID = 0;
const WRITE_WIDTH = 19;
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
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const values = sheet.getRange(1, 1, lastRow, WRITE_WIDTH).getDisplayValues();

  for (let rowIndex = values.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const hasValue = values[rowIndex].some((value) => String(value).trim() !== '');
    if (hasValue) {
      return rowIndex + 2;
    }
  }

  return firstDataRow(sheet);
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

function findMatchingOrderRow(sheet, targetValues) {
  const startRow = firstDataRow(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return null;

  const rows = sheet
    .getRange(startRow, 1, lastRow - startRow + 1, WRITE_WIDTH)
    .getValues();

  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    if (isMatchingOrderRow(rows[rowIndex], targetValues)) {
      return startRow + rowIndex;
    }
  }

  return null;
}

function deleteMatchingOrder(sheet, targetValues) {
  const matchingRow = findMatchingOrderRow(sheet, targetValues);
  if (!matchingRow) return null;

  sheet.deleteRow(matchingRow);
  return matchingRow;
}

function sortOrdersByDate(sheet) {
  const startRow = firstDataRow(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return;

  sheet
    .getRange(startRow, 1, lastRow - startRow + 1, WRITE_WIDTH)
    .sort({ column: 1, ascending: true });
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
    return jsonOutput({ ok: true, sheets });
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
      sheetName: sheet.getName(),
      sheetId: sheet.getSheetId(),
      nextRow: nextInputRow(sheet),
    });
  }

  if (data.action === 'sort') {
    sortOrdersByDate(sheet);
    return jsonOutput({ ok: true, sorted: true });
  }

  if (data.action === 'deleteRow') {
    const row = Number(data.row);
    if (!Number.isInteger(row) || row < firstDataRow(sheet)) {
      return jsonOutput({ ok: false, error: 'invalid row' });
    }
    sheet.deleteRow(row);
    return jsonOutput({ ok: true, deletedRow: row });
  }

  const values = Array.isArray(data.values) ? data.values.slice(0, WRITE_WIDTH) : [];
  while (values.length < WRITE_WIDTH) {
    values.push('');
  }

  if (data.action === 'deleteOrder') {
    const deletedRow = deleteMatchingOrder(sheet, values);
    return jsonOutput({ ok: true, deletedRow });
  }

  const matchingRow = findMatchingOrderRow(sheet, values);
  if (matchingRow) {
    return jsonOutput({ ok: true, deduplicated: true, row: matchingRow });
  }

  const inputRow = nextInputRow(sheet);
  sheet.getRange(inputRow, 1, 1, WRITE_WIDTH).setValues([values]);
  sortOrdersByDate(sheet);

  return jsonOutput({ ok: true, row: inputRow });
}
