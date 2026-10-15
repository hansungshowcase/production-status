import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const notifySourceUrl = new URL('../api/_lib/notify.js', import.meta.url);
const sweepSourceUrl = new URL('../api/cron/sweep.js', import.meta.url);

function makeUntouchedDb() {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      throw new Error('DB must not be touched for shipped notifications');
    },
  };
}

test('shipped notification skips before schema, order, or network work for every order state', async () => {
  const { maybeNotify } = await import(`../api/_lib/notify.js?shipped=${Math.random()}`);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be touched for shipped notifications');
  };

  try {
    const orders = [
      {},
      { id: null },
      { id: 901, notify_state: { shipped: { status: 'queued' } } },
      { id: 901, notify_state: { shipped: { status: 'failed' } } },
      { id: 901, notify_state: { shipped: { status: 'sending', at: '2020-01-01T00:00:00.000Z' } } },
    ];
    for (const order of orders) {
      const db = makeUntouchedDb();
      const result = await maybeNotify(db, order, 'shipped');
      assert.deepEqual(result, { skipped: true, reason: 'shipped_notification_disabled' });
      assert.equal(db.calls.length, 0);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sweep excludes shipped notify keys while retaining other pending milestones', async () => {
  const source = await readFile(sweepSourceUrl, 'utf8');
  assert.match(source, /WHERE kv\.key <> 'shipped'\s+AND \(/);
  assert.match(source, /if \(key === 'shipped'\) continue;/);
  assert.doesNotMatch(source, /missedShipped/);
  assert.doesNotMatch(source, /sinceDate/);
  assert.doesNotMatch(source, /runNotify\(order, 'shipped'/);
  assert.match(source, /const \{ rows: missedPacked \}/);
});

test('packed notification uses progress lookup wording', async () => {
  const { buildMessage } = await import(`../api/_lib/notify.js?packed=${Math.random()}`);
  const { text } = buildMessage({ id: 901, client_name: '테스트', quantity: 1 }, 'packed', 'https://example.com/track/tok');

  assert.match(text, /진행 현황은 아래 조회 링크에서 확인해 주세요\./);
  assert.doesNotMatch(text, /출고 완료 시 다시 안내드립니다\./);
});
