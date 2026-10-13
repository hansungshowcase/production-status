export const PROCESS_UNDO_MANAGER = '김보수 팀장';

export function isProcessUndoManager(value) {
  return typeof value === 'string'
    && value.replace(/\s+/g, '') === PROCESS_UNDO_MANAGER.replace(/\s+/g, '');
}
