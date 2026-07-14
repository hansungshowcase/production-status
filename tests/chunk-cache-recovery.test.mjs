import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const boundarySource = readFileSync(
  new URL('../src/components/common/ChunkErrorBoundary.jsx', import.meta.url),
  'utf8',
);
const serviceWorkerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const clearCachePageUrl = new URL('../public/clear-cache.html', import.meta.url);

test('chunk load recovery clears service workers and browser caches before reload', () => {
  assert.match(boundarySource, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(boundarySource, /\.unregister\(\)/);
  assert.match(boundarySource, /caches\.keys\(\)/);
  assert.match(boundarySource, /caches\.delete\(/);
  assert.match(boundarySource, /clearCachesAndReload\(\)/);
});

test('manual cache clear page unregisters stale app caches and returns to the app', () => {
  assert.equal(existsSync(clearCachePageUrl), true);

  const clearCachePage = readFileSync(clearCachePageUrl, 'utf8');
  assert.match(clearCachePage, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(clearCachePage, /\.unregister\(\)/);
  assert.match(clearCachePage, /caches\.keys\(\)/);
  assert.match(clearCachePage, /caches\.delete\(/);
  assert.match(clearCachePage, /location\.replace\('\/\?cache-cleared='/);
});

test('cache recovery assets are forced fresh after deploy', () => {
  assert.match(serviceWorkerSource, /const CACHE_VERSION = 53;/);

  const rootHeader = vercelConfig.headers.find((header) => header.source === '/');
  assert.ok(rootHeader);
  assert.ok(
    rootHeader.headers.some(
      (header) =>
        header.key === 'Clear-Site-Data' &&
        header.value === '"cache"',
    ),
  );

  const clearCacheHeader = vercelConfig.headers.find((header) => header.source === '/clear-cache.html');
  assert.ok(clearCacheHeader);
  assert.ok(
    clearCacheHeader.headers.some(
      (header) =>
        header.key === 'Cache-Control' &&
        header.value === 'no-cache, no-store, must-revalidate',
    ),
  );
});
