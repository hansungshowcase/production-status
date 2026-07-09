const SECRET = 'hansung-production-status';
const SPREADSHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const TARGET_SHEET_ID = 0;
const WRITE_WIDTH = 19;
const REQUIRED_HEADERS = ['발주일', '납기일', '담당', '거래처', '전화번호'];

function normalizeHeader(value) {
  return String(value || '').replace(/\s/g, '');
}

function sheetHasOrderHeaders(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), WRITE_WIDTH);
  const headers = sheet.getRange(1, 1, 1, Math.min(lastColumn, 30))
    .getDisplayValues()[0]
    .map(normalizeHeader);

  return REQUIRED_HEADERS.every((header) => headers.includes(header));
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

  return 1;
}

function normalizeCell(value) {
  return String(value ?? '').trim();
}

function isMatchingOrderRow(rowValues, targetValues) {
  const keyColumns = [0, 1, 2, 3, 8, 10, 12, 14, 16, 17, 18];
  return keyColumns.every((index) => normalizeCell(rowValues[index]) === normalizeCell(targetValues[index]));
}

function deleteMatchingOrder(sheet, targetValues) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const rows = sheet.getRange(1, 1, lastRow, WRITE_WIDTH).getDisplayValues();

  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    if (isMatchingOrderRow(rows[rowIndex], targetValues)) {
      const deletedRow = rowIndex + 1;
      sheet.deleteRow(deletedRow);
      return deletedRow;
    }
  }

  return null;
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');

  if (data.secret !== SECRET) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
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

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, sheets }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const sheet = findTargetSheet(spreadsheet, targetSheetId);

  if (data.action === 'inspectRows') {
    const rows = (data.rows || [1, 2, 2702, 2703, 3433]).map((row) => ({
      row,
      values: sheet.getRange(Number(row), 1, 1, 30).getDisplayValues()[0],
    }));

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, sheetName: sheet.getName(), sheetId: sheet.getSheetId(), rows }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'target sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (data.action === 'status') {
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        sheetName: sheet.getName(),
        sheetId: sheet.getSheetId(),
        nextRow: nextInputRow(sheet),
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (data.action === 'deleteRow') {
    const row = Number(data.row);
    if (!Number.isInteger(row) || row < 2) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'invalid row' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    sheet.deleteRow(row);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, deletedRow: row }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const values = Array.isArray(data.values) ? data.values.slice(0, WRITE_WIDTH) : [];
  while (values.length < WRITE_WIDTH) {
    values.push('');
  }

  if (data.action === 'deleteOrder') {
    const deletedRow = deleteMatchingOrder(sheet, values);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, deletedRow }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  sheet.getRange(nextInputRow(sheet), 1, 1, WRITE_WIDTH).setValues([values]);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
