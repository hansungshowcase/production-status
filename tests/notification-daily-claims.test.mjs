import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('daily notification claims have a KST date, normalized recipient, milestone primary key', async () => {
  const sql = await readFile(new URL('../migrations/20261022_notification_daily_claims.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS notification_daily_claims/);
  assert.match(sql, /PRIMARY KEY \(kst_date, to_phone, milestone\)/);
  assert.match(sql, /attempt_token TEXT NOT NULL/);
  assert.match(sql, /provider_msgid TEXT/);
});

test('notify schema exposes the same idempotent daily-claim table', async () => {
  const schema = await import(`../api/_lib/notifySchema.js?daily=${Math.random()}`);
  const statements = [];
  await schema.ensureNotificationDailyClaimsSchema({
    async execute({ sql }) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: [] };
    },
  });
  assert.match(statements.join('\n'), /CREATE TABLE IF NOT EXISTS notification_daily_claims/);
});

test('daily claim permits one attempt per KST date and uncertainty remains terminal for that date', async () => {
  const { claimDailyNotification, finishDailyNotification } = await import(`../api/cron/risk-daily.js?claims=${Math.random()}`);
  const rows = new Map();
  const db = {
    async execute({ sql, args }) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO notification_daily_claims')) {
        const [date, phone, milestone, token] = args;
        const key = `${date}:${phone}:${milestone}`;
        if (rows.has(key)) return { rows: [] };
        rows.set(key, { status: 'sending', attempt_token: token });
        return { rows: [{ attempt_token: token }] };
      }
      if (compact.startsWith('UPDATE notification_daily_claims')) {
        const [status, providerMsgId, error, date, phone, milestone, token] = args;
        const key = `${date}:${phone}:${milestone}`;
        const row = rows.get(key);
        if (!row || row.attempt_token !== token) return { rows: [] };
        Object.assign(row, { status, provider_msgid: providerMsgId, error });
        return { rows: [{ attempt_token: token }] };
      }
      throw new Error(`Unexpected SQL: ${compact}`);
    },
  };
  const first = { kstDate: '2026-10-22', toPhone: '010-1234-5678', milestone: 'chonbe_alert', attemptToken: 'attempt-1' };

  assert.equal(await claimDailyNotification(db, first), true);
  assert.equal(await claimDailyNotification(db, { ...first, attemptToken: 'attempt-2' }), false);
  assert.equal(await finishDailyNotification(db, { ...first, toPhone: '01012345678' }, { ok: false, uncertain: true, error: 'timeout' }), true);
  assert.equal(rows.get('2026-10-22:01012345678:chonbe_alert').status, 'uncertain');
  assert.equal(await claimDailyNotification(db, { ...first, kstDate: '2026-10-23', attemptToken: 'attempt-3' }), true);
});
