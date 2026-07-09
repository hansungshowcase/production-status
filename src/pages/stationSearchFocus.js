export function shouldFocusCompletionFromSearchClick(searchQuery) {
  return Boolean(String(searchQuery || '').trim());
}
