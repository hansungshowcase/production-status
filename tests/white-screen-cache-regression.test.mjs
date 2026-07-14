import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const vercelConfig = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
);
const serviceWorkerSource = readFileSync(
  new URL('../public/sw.js', import.meta.url),
  'utf8',
);

function createServiceWorkerContext(contentTypes) {
  const cachedUrls = [];
  const pendingContentTypes = [...contentTypes];
  const context = {
    URL,
    caches: {
      match: async () => undefined,
      open: async () => ({
        addAll: async () => undefined,
        match: async () => undefined,
        put: async (request) => cachedUrls.push(request.url),
      }),
    },
    fetch: async () => new Response('response', {
      status: 200,
      headers: { 'content-type': pendingContentTypes.shift() },
    }),
    Promise,
    Response,
    self: {
      addEventListener: () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () => [],
        openWindow: async () => undefined,
      },
      location: { origin: 'https://production-status.vercel.app' },
      registration: { showNotification: async () => undefined },
      skipWaiting: () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${serviceWorkerSource}\n;globalThis.__networkFirst = networkFirst;globalThis.__staleWhileRevalidate = staleWhileRevalidate;`,
    context,
  );
  return { cachedUrls, context };
}

function createFallbackContext({ cachedResponse, networkResponse, networkError = false }) {
  const matchCached = async () => cachedResponse?.clone();
  const context = {
    URL,
    caches: {
      match: matchCached,
      open: async () => ({
        addAll: async () => undefined,
        match: matchCached,
        put: async () => undefined,
      }),
    },
    fetch: async () => {
      if (networkError) throw new Error('offline');
      return networkResponse.clone();
    },
    Promise,
    Response,
    self: {
      addEventListener: () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () => [],
        openWindow: async () => undefined,
      },
      location: { origin: 'https://production-status.vercel.app' },
      registration: { showNotification: async () => undefined },
      skipWaiting: () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${serviceWorkerSource}\n;globalThis.__networkFirst = networkFirst;globalThis.__staleWhileRevalidate = staleWhileRevalidate;`,
    context,
  );
  return context;
}

test('white-screen cache fix uses the release service worker cache version', () => {
  assert.match(serviceWorkerSource, /const CACHE_VERSION = 53;/);
});

test('SPA fallback does not rewrite missing Vite assets to index.html', () => {
  const spaFallback = vercelConfig.rewrites.find(
    (rewrite) => rewrite.destination === '/index.html',
  );
  assert.ok(spaFallback, 'SPA fallback rewrite must remain configured');

  const matcher = new RegExp(`^${spaFallback.source}$`);
  assert.equal(matcher.test('/sales/my'), true);
  assert.equal(matcher.test('/assets/missing-build.js'), false);
  assert.equal(matcher.test('/assets/missing-build.css'), false);
});

test('network-first does not cache HTML or prefix-spoofed JS/CSS media types', async () => {
  const { cachedUrls, context } = createServiceWorkerContext([
    'text/html; charset=utf-8',
    'text/html; charset=utf-8',
    'application/javascript-malicious',
    'text/css-evil',
  ]);

  for (const pathname of [
    '/assets/index-stale123.js',
    '/assets/index-stale123.css',
    '/assets/index-malicious1.js',
    '/assets/index-malicious1.css',
  ]) {
    await context.__networkFirst({
      url: `https://production-status.vercel.app${pathname}`,
    });
  }

  assert.deepEqual(cachedUrls, []);
});

test('stale strategy does not cache HTML returned for non-hashed JS or CSS', async () => {
  const { cachedUrls, context } = createServiceWorkerContext([
    'text/html; charset=utf-8',
    'text/html; charset=utf-8',
  ]);

  for (const pathname of ['/legacy.js', '/styles.css']) {
    await context.__staleWhileRevalidate({
      url: `https://production-status.vercel.app${pathname}`,
    });
  }

  assert.deepEqual(cachedUrls, []);
});

test('network-first falls back to valid cached JS or CSS on invalid network responses', async () => {
  const cases = [
    {
      pathname: '/assets/index-stale123.js',
      cachedResponse: new Response('cached-js', {
        headers: { 'content-type': 'application/javascript' },
      }),
      networkResponse: new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      expectedBody: 'cached-js',
    },
    {
      pathname: '/assets/index-stale123.css',
      cachedResponse: new Response('cached-css', {
        headers: { 'content-type': 'text/css' },
      }),
      networkResponse: new Response('not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
      expectedBody: 'cached-css',
    },
  ];

  for (const testCase of cases) {
    const context = createFallbackContext(testCase);
    const response = await context.__networkFirst({
      url: `https://production-status.vercel.app${testCase.pathname}`,
    });
    assert.equal(await response.text(), testCase.expectedBody);
  }
});

test('JS or CSS strategies never return a preexisting HTML cache entry', async () => {
  for (const pathname of ['/assets/index-stale123.js', '/styles.css']) {
    for (const strategy of ['__networkFirst', '__staleWhileRevalidate']) {
      const context = createFallbackContext({
        cachedResponse: new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
        networkError: true,
      });
      const response = await context[strategy]({
        url: `https://production-status.vercel.app${pathname}`,
      });
      assert.equal(response, undefined);
    }
  }
});
