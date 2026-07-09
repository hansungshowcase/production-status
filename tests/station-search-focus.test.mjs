import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFocusCompletionFromSearchClick } from '../src/pages/stationSearchFocus.js';

test('search result card clicks should focus completion controls when a search is active', () => {
  assert.equal(shouldFocusCompletionFromSearchClick('abc'), true);
  assert.equal(shouldFocusCompletionFromSearchClick('  abc  '), true);
});

test('normal card clicks keep the regular expand/collapse behavior', () => {
  assert.equal(shouldFocusCompletionFromSearchClick(''), false);
  assert.equal(shouldFocusCompletionFromSearchClick('   '), false);
  assert.equal(shouldFocusCompletionFromSearchClick(null), false);
});
