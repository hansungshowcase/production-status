import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROCESS_UNDO_MANAGER,
  isProcessUndoManager,
} from '../shared/processUndoPermission.js';

test('process undo accepts only the canonical manager name with whitespace differences', () => {
  assert.equal(PROCESS_UNDO_MANAGER, '김보수 팀장');
  for (const value of ['김보수 팀장', '김보수팀장', '  김보수  팀장  ', '\t김보수 팀장\n']) {
    assert.equal(isProcessUndoManager(value), true, value);
  }
});

test('process undo rejects partial, decorated, missing, and non-string worker identities', () => {
  for (const value of [
    '김보수',
    '김보수 팀장 대행',
    '부김보수 팀장',
    '김보수 팀장2',
    '',
    null,
    undefined,
    42,
    { name: '김보수 팀장' },
  ]) {
    assert.equal(isProcessUndoManager(value), false, String(value));
  }
});
