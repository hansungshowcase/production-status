import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('database compute quota errors are exposed as a clear temporary outage', async () => {
  const { normalizeDatabaseError } = await import('../api/_lib/db.js');
  const err = new Error('Server error (HTTP status 402): {"message":"Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits."}');

  const normalized = normalizeDatabaseError(err);

  assert.equal(normalized, err);
  assert.equal(err.status, 503);
  assert.match(err.publicMessage, /데이터베이스 사용 한도/);
  assert.doesNotMatch(err.publicMessage, /서버 내부 오류/);
});

test('automatic refresh intervals are long enough to protect the database quota', async () => {
  const files = [
    { path: '../src/hooks/useWebSocket.js', pattern: /setInterval\(poll,\s*300000\)/ },
    { path: '../src/pages/SalesMyPage.jsx', pattern: /const REFRESH_INTERVAL = 300000/ },
    { path: '../src/pages/WorkerStationViewPage.jsx', pattern: /const REFRESH_INTERVAL = 180000/ },
    { path: '../src/pages/TabletWorkerPage.jsx', pattern: /const REFRESH_INTERVAL = 180000/ },
  ];

  for (const file of files) {
    const source = await readFile(new URL(file.path, import.meta.url), 'utf8');
    assert.match(source, file.pattern, `${file.path} should use the quota-safe refresh interval`);
  }
});
