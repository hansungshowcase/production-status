const SECRET = 'hansung-production-status';
const SPREADSHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const TARGET_SHEET_ID = 0;

function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');

  if (data.secret !== SECRET) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const targetSheetId = Number(data.sheetId ?? TARGET_SHEET_ID);
  const sheet = spreadsheet.getSheets().find((item) => item.getSheetId() === targetSheetId);

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'target sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  sheet.appendRow(data.values);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
