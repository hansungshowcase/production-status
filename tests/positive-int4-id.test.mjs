import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePositiveInt4Id } from '../api/_lib/positiveInt4Id.js';

test('parsePositiveInt4Id accepts only scalar PostgreSQL int4 positive IDs', () => {
  for (const [input, expected] of [
    [1, 1],
    [2147483647, 2147483647],
    ['1', 1],
    [' 001 ', 1],
    ['2147483647', 2147483647],
  ]) {
    assert.equal(parsePositiveInt4Id(input), expected);
  }

  for (const input of [
    undefined,
    null,
    true,
    false,
    '',
    '   ',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '2147483648',
    ['1'],
    ['1', '2'],
    { value: '1' },
  ]) {
    assert.equal(parsePositiveInt4Id(input), null, `expected ${String(input)} to be rejected`);
  }
});
