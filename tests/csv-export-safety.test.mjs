import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeCSV } from '../api/export/csv.js';

function parseSingleCsvCell(csvCell) {
  if (!csvCell.startsWith('"')) return csvCell;
  assert.equal(csvCell.endsWith('"'), true);
  return csvCell.slice(1, -1).replaceAll('""', '"');
}

test('CSV string cells cannot start a spreadsheet formula after leading whitespace', () => {
  // Given: string cells covering every spreadsheet formula prefix and leading whitespace class.
  const values = [
    '=1+1',
    '+SUM(A1:A2)',
    '-10+20',
    '@SUM(A1:A2)',
    ' =1+1',
    '\t+1+1',
    '\r-1+1',
    '\n@SUM(A1:A2)',
    'ordinary text',
  ];

  // When: each value passes through the production CSV cell encoder and a CSV round trip.
  const roundTripped = values.map((value) => parseSingleCsvCell(escapeCSV(value)));

  // Then: formula-shaped strings are prefixed before their original bytes, while ordinary text is unchanged.
  assert.deepEqual(roundTripped, [
    "'=1+1",
    "'+SUM(A1:A2)",
    "'-10+20",
    "'@SUM(A1:A2)",
    "' =1+1",
    "'\t+1+1",
    "'\r-1+1",
    "'\n@SUM(A1:A2)",
    'ordinary text',
  ]);
});

test('CSV numeric cells retain their numeric representation', () => {
  // Given: numeric values that would look formula-like if they were strings.
  const values = [-120, 0, 12.5];

  // When: the values pass through the production CSV cell encoder.
  const encoded = values.map(escapeCSV);

  // Then: no text-neutralization prefix changes their numeric meaning.
  assert.deepEqual(encoded, ['-120', '0', '12.5']);
});

test('CSV quoting still round-trips commas, quotes, carriage returns, and line feeds', () => {
  // Given: one non-formula string containing every CSV structural character.
  const value = 'memo,"quoted"\r\nsecond line';

  // When: it passes through the production CSV cell encoder and a CSV round trip.
  const roundTripped = parseSingleCsvCell(escapeCSV(value));

  // Then: the original cell bytes are preserved.
  assert.equal(roundTripped, value);
});
