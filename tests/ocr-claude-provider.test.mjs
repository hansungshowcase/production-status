import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import handler from '../api/ocr/work-order.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const COMPLETE = {
  client_name: '눙크베이커리',
  order_date: '2026-10-28',
  due_date: '2026-11-17',
  phone: '010-0000-0000',
  delivery_address: '서울',
  sales_person: '이준형',
  product_type: '제과',
  door_type: '뒷문',
  width: 900,
  depth: 650,
  height: 1200,
  quantity: 1,
  color: '화이트',
  notes: '',
};

function buildRequest() {
  const boundary = 'testboundary123';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="w.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_1X1,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = Readable.from([body]);
  req.method = 'POST';
  req.url = '/api/ocr/work-order';
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
    origin: 'https://production-status.vercel.app',
    'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function buildResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function claudeMessage(data) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(data) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function geminiMessage(data) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] };
}

async function run({ env, fetchImpl }) {
  const saved = {
    fetch: globalThis.fetch,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  const calls = [];
  for (const key of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, body: init?.body });
    return fetchImpl(url, init);
  };
  try {
    const res = buildResponse();
    await handler(buildRequest(), res);
    return { res, calls };
  } finally {
    globalThis.fetch = saved.fetch;
    for (const key of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('Claude 키가 있으면 Claude 가 먼저 읽고, 읽은 값을 그대로 돌려준다', async () => {
  const { res, calls } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) return jsonResponse(claudeMessage(COMPLETE));
      throw new Error(`예상하지 못한 호출: ${url}`);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'claude');
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.client_name, '눙크베이커리');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/messages/);
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.equal(sent.messages[0].content[0].source.media_type, 'image/png');
  assert.equal(sent.messages[0].content[1].type, 'text');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.effort, 'low');
});

test('Claude 가 실패하면 OpenAI 를 거치지 않고 Gemini 로 넘어간다', async () => {
  const { res, calls } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test', OPENAI_API_KEY: 'sk-openai-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) {
        return jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      }
      if (url.includes('generativelanguage.googleapis.com')) return jsonResponse(geminiMessage(COMPLETE));
      throw new Error(`예상하지 못한 호출: ${url}`);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'gemini');
  assert.equal(res.body.data.client_name, '눙크베이커리');
  assert.equal(calls.filter((call) => call.url.includes('openai.com')).length, 0);
  assert.equal(calls.filter((call) => call.url.includes('anthropic.com')).length, 1);
});

test('Claude 가 거절하면 Gemini 로 넘어간다', async () => {
  const { res } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) {
        return jsonResponse({ ...claudeMessage({}), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } });
      }
      return jsonResponse(geminiMessage(COMPLETE));
    },
  });
  assert.equal(res.body.provider, 'gemini');
});

test('Claude 키가 없으면 기존 순서(OpenAI → Gemini) 그대로다', async () => {
  const { res, calls } = await run({
    env: { GEMINI_API_KEY: 'g-test', OPENAI_API_KEY: 'sk-openai-test' },
    fetchImpl: (url) => {
      if (url.includes('openai.com')) return jsonResponse({ error: { message: 'quota' } }, 429);
      if (url.includes('generativelanguage.googleapis.com')) return jsonResponse(geminiMessage(COMPLETE));
      throw new Error(`예상하지 못한 호출: ${url}`);
    },
  });
  assert.equal(res.body.provider, 'gemini');
  assert.equal(calls.filter((call) => call.url.includes('anthropic.com')).length, 0);
  assert.equal(calls.filter((call) => call.url.includes('openai.com')).length, 1);
});

const PARTIAL = { ...COMPLETE, due_date: null, quantity: null };
const GEMINI_WRONG_NAME = { ...COMPLETE, client_name: '농크베이커리', due_date: '2026-11-17', quantity: 1 };

test('Claude 가 일부 칸만 못 읽으면 Claude 값은 두고 빈 칸만 Gemini 로 채운다', async () => {
  const { res } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) return jsonResponse(claudeMessage(PARTIAL));
      return jsonResponse(geminiMessage(GEMINI_WRONG_NAME));
    },
  });
  assert.equal(res.body.provider, 'claude+gemini');
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.client_name, '눙크베이커리');
  assert.equal(res.body.data.due_date, '2026-11-17');
  assert.equal(res.body.data.quantity, 1);
});

test('Claude 키만 있고 Gemini 키가 없으면 Claude 가 읽은 칸을 수동 확인으로 넘긴다', async () => {
  const { res, calls } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) return jsonResponse(claudeMessage(PARTIAL));
      throw new Error(`예상하지 못한 호출: ${url}`);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'manual');
  assert.equal(res.body.success, false);
  assert.equal(res.body.data.client_name, '눙크베이커리');
  assert.equal(calls.length, 1);
});

test('Claude 가 일부만 읽고 Gemini 도 실패하면 Claude 가 읽은 칸은 남는다', async () => {
  const { res } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) return jsonResponse(claudeMessage(PARTIAL));
      return jsonResponse({ error: { message: 'unavailable' } }, 503);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'manual');
  assert.equal(res.body.data.client_name, '눙크베이커리');
});

test('Claude 와 Gemini 가 모두 실패하면 빈 값으로 수동 입력에 넘긴다', async () => {
  const { res } = await run({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' },
    fetchImpl: (url) => {
      if (url.includes('anthropic.com')) return jsonResponse({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500);
      return jsonResponse({ error: { message: 'unavailable' } }, 503);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'manual');
  assert.equal(res.body.success, false);
  assert.equal(res.body.data.client_name, '');
});
