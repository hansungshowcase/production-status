import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

test('installed app checks for the latest service worker immediately and on resume', () => {
  assert.match(indexSource, /navigator\.serviceWorker\.addEventListener\('controllerchange'/);
  assert.match(indexSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(indexSource, /reg\.update\(\)/);
  assert.match(serviceWorkerSource, /const CACHE_VERSION = 53;/);
  assert.match(serviceWorkerSource, /self\.skipWaiting\(\)/);
  assert.match(serviceWorkerSource, /self\.clients\.claim\(\)/);
  assert.match(serviceWorkerSource, /refreshOpenClients/);
  assert.match(serviceWorkerSource, /client\.navigate\(url\.href\)/);
  assert.match(serviceWorkerSource, /app_update/);
});
