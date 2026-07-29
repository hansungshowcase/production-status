import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../.apps-script-sheet/Code.js', import.meta.url);

test('Google Sheets webhook deduplicates then sorts by order date after append', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /function findHeaderRow\(sheet\)/);
  assert.match(source, /function findMatchingOrderRow\(sheet, targetValues\)/);
  assert.match(source, /function sortOrdersByDate\(sheet\)/);
  assert.match(source, /const matchingRow = findMatchingOrderRow\(sheet, values\)/);
  assert.match(source, /sortOrdersByDate\(sheet\);/);
});
