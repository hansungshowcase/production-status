import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleMaterials } from '../api/materials.js';

function createResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('GET만 허용하고 모든 응답에 브라우저 및 CDN no-store를 지정한다', async () => {
  const response = createResponse();

  await handleMaterials({ method: 'POST', query: {} }, response, {
    loadMaterialsData: async () => { throw new Error('호출되면 안 됨'); },
  });

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('allow'), 'GET');
});

test('refresh=1만 모듈 캐시 우회 신호로 전달하고 안전한 조회 결과를 반환한다', async () => {
  const refreshValues = [];
  const response = createResponse();
  const safeResult = {
    fetched_at: '2026-10-01T00:00:00.000Z',
    orders: [{ company: '가업체', source_row: 6 }],
  };

  await handleMaterials({ method: 'GET', query: { refresh: '1' } }, response, {
    loadMaterialsData: async options => {
      refreshValues.push(options.refresh);
      return safeResult;
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, safeResult);
  assert.deepEqual(refreshValues, [true]);
});

test('시트 오류를 빈 200 응답으로 바꾸지 않는다', async () => {
  const response = createResponse();
  const sourceError = Object.assign(new Error('원본 시트 헤더가 예상과 다릅니다.'), {
    status: 502,
    publicMessage: '원본 시트 헤더가 예상과 다릅니다.',
  });

  await handleMaterials({ method: 'GET', query: {} }, response, {
    loadMaterialsData: async () => { throw sourceError; },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.payload, {
    error: { message: '원본 시트 헤더가 예상과 다릅니다.', status: 502 },
  });
});

test('앱 출고 대조 실패의 안전한 503 메시지를 그대로 전파한다', async () => {
  const response = createResponse();
  const databaseError = Object.assign(new Error('database offline'), {
    status: 503,
    publicMessage: '앱 출고 상태를 확인하지 못했습니다. 다시 조회해 주세요.',
  });

  await handleMaterials({ method: 'GET', query: {} }, response, {
    loadMaterialsData: async () => { throw databaseError; },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.payload, {
    error: { message: '앱 출고 상태를 확인하지 못했습니다. 다시 조회해 주세요.', status: 503 },
  });
});
