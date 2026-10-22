import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const installPromptSource = readFileSync(
  new URL('../src/components/common/InstallPrompt.jsx', import.meta.url),
  'utf8',
);
const serviceWorkerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('install prompt is shown on every browser session until the app is running standalone', () => {
  assert.doesNotMatch(installPromptSource, /pwa_install_dismissed/);
  assert.doesNotMatch(installPromptSource, /pwa_installed/);
  assert.doesNotMatch(installPromptSource, /localStorage\.getItem/);
  assert.doesNotMatch(installPromptSource, /localStorage\.setItem/);
  assert.match(installPromptSource, /setShow\(true\)/);
  assert.match(installPromptSource, /beforeinstallprompt/);
  assert.match(installPromptSource, /appinstalled/);
});

test('installed app checks for a waiting service worker without forcing a page reload', () => {
  assert.match(indexSource, /navigator\.serviceWorker\.register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/);
  assert.match(indexSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(indexSource, /reg\.update\(\)/);
  assert.match(indexSource, /setInterval\(requestUpdate, 2 \* 60 \* 1000\)/);
  assert.doesNotMatch(indexSource, /controllerchange/);
  assert.doesNotMatch(indexSource, /location\.reload\(/);
  assert.doesNotMatch(indexSource, /newSW\.state === 'activated'/);
});

test('waiting service worker caches its shell separately and activates without forcing open tabs', async () => {
  const listeners = new Map();
  const lifecycleCalls = [];
  const cachedShells = new Map([
    ['hansung-showcase-v53', new Map([['/index.html', 'old-v53-shell']])],
  ]);
  const deletedCaches = [];
  const currentCache = 'hansung-showcase-v54';
  const runtimeCache = 'hansung-runtime-v54';
  const oldCache = 'hansung-showcase-v53';
  const context = {
    URL,
    console,
    caches: {
      async open(name) {
        if (!cachedShells.has(name)) cachedShells.set(name, new Map());
        const cache = cachedShells.get(name);
        return {
          async addAll(paths) {
            for (const path of paths) cache.set(path, `shell-from-${name}`);
          },
        };
      },
      async keys() {
        return [currentCache, runtimeCache, oldCache];
      },
      async delete(name) {
        deletedCaches.push(name);
        cachedShells.delete(name);
        return true;
      },
    },
    self: {
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
      skipWaiting() {
        lifecycleCalls.push('skipWaiting');
      },
      clients: {
        async claim() {
          lifecycleCalls.push('claim');
        },
        async matchAll() {
          lifecycleCalls.push('matchAll');
          return [{
            url: 'https://production-status.vercel.app/orders/new',
            async navigate() {
              lifecycleCalls.push('navigate');
            },
          }];
        },
      },
      location: { origin: 'https://production-status.vercel.app' },
      registration: { showNotification() {} },
    },
  };

  vm.runInNewContext(serviceWorkerSource, context);

  let installPromise;
  listeners.get('install')({
    waitUntil(promise) {
      installPromise = promise;
    },
  });
  await installPromise;

  assert.match(serviceWorkerSource, /const CACHE_VERSION = 54;/);
  assert.equal(cachedShells.get(oldCache).get('/index.html'), 'old-v53-shell');
  assert.equal(cachedShells.get(currentCache).get('/index.html'), `shell-from-${currentCache}`);
  assert.deepEqual(deletedCaches, []);
  assert.deepEqual(lifecycleCalls, []);

  let activatePromise;
  listeners.get('activate')({
    waitUntil(promise) {
      activatePromise = promise;
    },
  });
  await activatePromise;

  assert.deepEqual(deletedCaches, [oldCache]);
  assert.equal(cachedShells.has(oldCache), false);
  assert.deepEqual(lifecycleCalls, []);
});
