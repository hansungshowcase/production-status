import test from 'node:test';
import assert from 'node:assert/strict';
import { getSearchResultNavigation } from '../src/components/worker/searchResultNavigation.js';

test('worker search results navigate to the current station and focus the order', () => {
  const result = getSearchResultNavigation({
    id: 42,
    currentStepName: 'assembly',
    currentStep: 3,
  });

  assert.deepEqual(result, {
    path: '/worker/station/assembly',
    state: { focusOrderId: 42 },
  });
});

test('worker search results fall back to legacy update page when no current station is known', () => {
  const result = getSearchResultNavigation({
    id: 77,
    currentStepName: '-',
    currentStep: null,
  });

  assert.deepEqual(result, {
    path: '/worker/update/77',
  });
});
