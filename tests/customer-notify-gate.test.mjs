import test from 'node:test';
import assert from 'node:assert/strict';

// 2026-07-09 dca9af0 이 sendCustomerMessage 에 authEnabled() 게이트를 넣어
// SALES_PASSWORD/ADMIN_PASSWORD 를 쓰지 않는 이 배포에서 고객 알림이 한 달간 전량 차단됐다.
// (notification_log 에 '인증 비활성 — 고객 실발송 차단' 506건)
// 이 파일은 그 결합이 되돌아오지 않도록 고정한다.

const SOLAPI_URL = 'https://api.solapi.com/messages/v4/send';

function makeDb() {
  const calls = [];
  return {
    calls,
    async execute(query) {
      const sql = String(query?.sql || '').replace(/\s+/g, ' ').trim();
      calls.push({ sql, args: query?.args || [] });

      // 멱등 선점 UPDATE — 선점 성공을 흉내낸다.
      if (/^UPDATE orders SET notify_state/i.test(sql)) {
        return { rows: [{ id: 901 }] };
      }
      // track_token 조회/발급
      if (/track_token/i.test(sql)) {
        return { rows: [{ id: 901, track_token: 'tok-901' }] };
      }
      return { rows: [] };
    },
  };
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runNotify({ authOff = true } = {}) {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      async json() { return { messageId: 'MSG-TEST-1' }; },
    };
  };

  try {
    return await withEnv({
      SOLAPI_API_KEY: 'test-key',
      SOLAPI_API_SECRET: 'test-secret',
      SMS_SENDER: '025550000',
      KAKAO_PF_ID: undefined,
      // 인증 opt-in 을 끈 상태 = 현재 프로덕션과 동일
      ...(authOff ? { SALES_PASSWORD: undefined, ADMIN_PASSWORD: undefined, AUTH_DISABLED: undefined } : {}),
    }, async () => {
      const { maybeNotify } = await import(`../api/_lib/notify.js?gate=${Math.random()}`);
      const db = makeDb();
      const result = await maybeNotify(db, {
        id: 901,
        client_name: '테스트거래처',
        phone: '010-1234-5678',
        status: 'in_production',
        due_date: '2026-08-20',
        product_type: '제과',
      }, 'ordered');
      return { result, sent, db };
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('인증 비밀번호가 없어도 고객 알림은 실제로 발송된다', async () => {
  const { result, sent } = await runNotify({ authOff: true });

  const solapiCalls = sent.filter((s) => s.url === SOLAPI_URL);
  assert.equal(solapiCalls.length, 1, '솔라피로 실제 발송 요청이 나가야 한다');
  assert.equal(result.skipped, undefined, '차단되어 skip 되면 안 된다');
  assert.notEqual(result.ok, false, '인증 비활성을 이유로 실패로 떨어지면 안 된다');
});

test('발송 실패 사유에 인증 관련 문구가 다시 등장하지 않는다', async () => {
  const { result } = await runNotify({ authOff: true });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /인증 비활성/);
  assert.doesNotMatch(text, /SALES_PASSWORD/);
  assert.doesNotMatch(text, /ADMIN_PASSWORD/);
});

test('notify 모듈은 인증 모듈에 의존하지 않는다', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../api/_lib/notify.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '\.\/auth\.js'/, '고객 발송과 인증 설정은 별개 관심사다');
  assert.doesNotMatch(source, /authEnabled\s*\(/);
});

test('솔라피 미설정이면 실발송 없이 dry-run 으로 남는다', async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(String(url));
    return { ok: true, status: 200, async json() { return {}; } };
  };
  try {
    await withEnv({
      SOLAPI_API_KEY: undefined,
      SOLAPI_API_SECRET: undefined,
      SMS_SENDER: '025550000',
    }, async () => {
      const { maybeNotify } = await import(`../api/_lib/notify.js?dry=${Math.random()}`);
      const db = makeDb();
      await maybeNotify(db, {
        id: 902,
        client_name: '테스트거래처2',
        phone: '010-1234-5678',
        status: 'in_production',
      }, 'ordered');
    });
    assert.equal(sent.filter((u) => u === SOLAPI_URL).length, 0, '솔라피 미설정이면 발송 요청이 없어야 한다');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
