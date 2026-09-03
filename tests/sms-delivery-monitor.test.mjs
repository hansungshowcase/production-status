import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function makeSchemaDb() {
  const statements = [];
  return {
    statements,
    async execute(query) {
      statements.push(compactSql(query?.sql));
      return { rows: [] };
    },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

class MonitorDb {
  constructor(logs = []) {
    this.logs = logs.map((row) => ({ ...row }));
    this.alerts = new Map();
    this.calls = [];
    this.clock = 0;
  }

  async execute(query) {
    const sql = compactSql(query?.sql);
    const args = query?.args || [];
    this.calls.push({ sql, args });

    if (/^(ALTER TABLE|CREATE TABLE)/i.test(sql)) return { rows: [] };

    if (/^SELECT .* FROM notification_log /i.test(sql)) {
      let selected = this.logs;
      if (/LEFT JOIN notification_delivery_alerts/i.test(sql)) {
        selected = selected.filter((row) => {
          if (row.delivery_status_code == null || ['2000', '3000'].includes(row.delivery_status_code)) {
            return true;
          }
          return [...this.alerts.values()].some((alert) => (
            alert.provider_msgid === row.provider_msgid
            && ['queued', 'failed'].includes(alert.status)
          ));
        });
        selected = [...selected].sort((left, right) => {
          const leftAlert = [...this.alerts.values()].find((alert) => (
            alert.provider_msgid === left.provider_msgid
            && ['queued', 'failed'].includes(alert.status)
          ));
          const rightAlert = [...this.alerts.values()].find((alert) => (
            alert.provider_msgid === right.provider_msgid
            && ['queued', 'failed'].includes(alert.status)
          ));
          const leftOrder = leftAlert?.updated_order ?? left.delivery_checked_order ?? left.created_order ?? 0;
          const rightOrder = rightAlert?.updated_order ?? right.delivery_checked_order ?? right.created_order ?? 0;
          return leftOrder - rightOrder || Number(left.id) - Number(right.id);
        });
      }
      const limit = Number(args.at(-1)) || selected.length;
      return {
        rows: selected.slice(0, limit).map((row) => {
          const alert = [...this.alerts.values()].find((item) => (
            item.provider_msgid === row.provider_msgid && item.status !== 'sent'
          ));
          return { ...row, delivery_alert_key: alert?.alert_key || null };
        }),
      };
    }

    if (/^UPDATE notification_log SET delivery_status =/i.test(sql)) {
      const [status, statusCode, reason, reportedAt, receivedAt, id] = args;
      const row = this.logs.find((item) => Number(item.id) === Number(id));
      if (row) {
        Object.assign(row, {
          delivery_status: status,
          delivery_status_code: statusCode,
          delivery_reason: reason,
          delivery_reported_at: reportedAt,
          delivery_received_at: receivedAt,
          delivery_checked_order: ++this.clock,
        });
      }
      return { rows: row ? [{ id: row.id }] : [] };
    }

    if (/^INSERT INTO notification_delivery_alerts/i.test(sql)) {
      const [alertKey, sourceLogId, providerMsgId, recipientName, toPhone, statusCode, reason] = args;
      const existing = this.alerts.get(alertKey);
      if (existing && !['queued', 'failed'].includes(existing.status)) return { rows: [] };
      const claimed = {
        alert_key: alertKey,
        source_log_id: sourceLogId,
        provider_msgid: providerMsgId,
        recipient_name: recipientName,
        to_phone: toPhone,
        status_code: statusCode,
        reason,
        status: 'sending',
        attempts: (existing?.attempts || 0) + 1,
        updated_order: ++this.clock,
      };
      this.alerts.set(alertKey, claimed);
      return { rows: [{ ...claimed }] };
    }

    if (/^UPDATE notification_delivery_alerts SET status = 'sent'/i.test(sql)) {
      const [adminProviderMsgId, alertKey] = args;
      const alert = this.alerts.get(alertKey);
      if (alert) Object.assign(alert, {
        status: 'sent',
        admin_provider_msgid: adminProviderMsgId,
        updated_order: ++this.clock,
      });
      return { rows: alert ? [{ alert_key: alertKey }] : [] };
    }

    if (/^UPDATE notification_delivery_alerts SET status = 'failed'/i.test(sql)) {
      const [error, alertKey] = args;
      const alert = this.alerts.get(alertKey);
      if (alert) Object.assign(alert, { status: 'failed', error, updated_order: ++this.clock });
      return { rows: alert ? [{ alert_key: alertKey }] : [] };
    }

    if (/^UPDATE notification_delivery_alerts SET status = 'queued'/i.test(sql)) {
      const [alertKey] = args;
      const alert = this.alerts.get(alertKey);
      if (alert) Object.assign(alert, { status: 'queued', updated_order: ++this.clock });
      return { rows: alert ? [{ alert_key: alertKey }] : [] };
    }

    return { rows: [] };
  }
}

async function loadMonitor() {
  return import(`../api/_lib/solapiDeliveryMonitor.js?monitor=${Math.random()}`);
}

function logRow(id, overrides = {}) {
  return {
    id,
    milestone: 'internal_assembly_daily',
    recipient_name: '강종효',
    to_phone: '010****0873',
    provider_msgid: `message-${id}`,
    created_at: '2026-09-03T00:00:00.000Z',
    delivery_status_code: null,
    ...overrides,
  };
}

function reportFor(row, statusCode, reason) {
  return {
    messageId: row.provider_msgid,
    status: 'COMPLETE',
    statusCode,
    reason,
    dateReported: '2026-09-03T00:01:00.000Z',
    dateReceived: statusCode === '4000' ? '2026-09-03T00:00:59.000Z' : null,
  };
}

test('delivery monitor schema stores final reports and deduplicated admin alerts', async () => {
  const schema = await import(`../api/_lib/notifySchema.js?deliverySchema=${Math.random()}`);
  assert.equal(typeof schema.ensureSmsDeliveryMonitorSchema, 'function');

  const db = makeSchemaDb();
  await schema.ensureSmsDeliveryMonitorSchema(db);
  const sql = db.statements.join('\n');

  for (const column of [
    'delivery_status',
    'delivery_status_code',
    'delivery_reason',
    'delivery_reported_at',
    'delivery_received_at',
    'delivery_checked_at',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS notification_delivery_alerts\b/);
  assert.match(sql, /alert_key TEXT PRIMARY KEY/);
  assert.match(sql, /admin_provider_msgid TEXT/);
});

test('Solapi final receipt 4000 is stored without notifying the administrator', async () => {
  const monitor = await loadMonitor();
  const row = logRow(1, { milestone: 'internal_design_due', recipient_name: '김보수 팀장' });
  const db = new MonitorDb([row]);
  const sent = [];

  const result = await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T01:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [reportFor(row, '4000', '수신 완료')],
    sendAdmin: async (...args) => {
      sent.push(args);
      return { ok: true, msgId: 'unexpected' };
    },
  });

  assert.equal(db.logs[0].delivery_status_code, '4000');
  assert.equal(db.logs[0].delivery_received_at, '2026-09-03T00:00:59.000Z');
  assert.equal(sent.length, 0);
  const select = db.calls.find((call) => /^SELECT .* FROM notification_log /i.test(call.sql));
  assert.equal(select.args.at(-1), 20);
  assert.deepEqual(result, {
    scanned: 1,
    reported: 1,
    received: 1,
    blocked: 0,
    alerted: 0,
    failed: 0,
  });
});

test('blocking reports notify 010-7731-4237 once per recipient, code, and KST date', async () => {
  const monitor = await loadMonitor();
  assert.deepEqual(
    [...monitor.BLOCK_STATUS_CODES].sort(),
    ['1061', '2061', '3047', '3054', '3055', '3061'],
  );
  const first = logRow(2);
  const second = logRow(3);
  const db = new MonitorDb([first, second]);
  const sent = [];

  const result = await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T01:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [
      reportFor(first, '3061', '사용자에 의해 수신거부됨'),
      reportFor(second, '3061', '사용자에 의해 수신거부됨'),
    ],
    sendAdmin: async (_db, message) => {
      sent.push(message);
      return { ok: true, msgId: 'admin-message-1' };
    },
  });

  assert.equal(result.blocked, 2);
  assert.equal(result.alerted, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '010-7731-4237');
  assert.equal(sent[0].tag, 'sms_delivery_block_admin_alert');
  assert.match(sent[0].customFields.deliveryAlertKey, /^[a-f0-9]{48}$/);
  assert.match(sent[0].text, /강종효/);
  assert.match(sent[0].text, /010\*\*\*\*0873/);
  assert.match(sent[0].text, /3061/);
  assert.equal([...db.alerts.values()][0].status, 'sent');
});

test('a sent block alert is excluded so unresolved messages cannot be starved by the row limit', async () => {
  const monitor = await loadMonitor();
  const blocked = logRow(21, { recipient_name: '백승정', to_phone: '010****4464' });
  const unresolved = logRow(22, { recipient_name: '마카라', to_phone: '010****8947' });
  const db = new MonitorDb([blocked, unresolved]);

  await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T03:30:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [
      reportFor(blocked, '3061', '사용자에 의해 수신거부됨'),
      reportFor(unresolved, '4000', '수신 완료'),
    ],
    sendAdmin: async () => ({ ok: true, msgId: 'admin-message-sent' }),
  });

  unresolved.delivery_status_code = null;
  db.logs.find((row) => row.id === unresolved.id).delivery_status_code = null;
  const queried = [];
  await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T03:35:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async (ids) => {
      queried.push(...ids);
      return [reportFor(unresolved, '4000', '수신 완료')];
    },
    sendAdmin: async () => ({ ok: true, msgId: 'must-not-send' }),
  });

  assert.deepEqual(queried, [unresolved.provider_msgid]);
  const select = db.calls.findLast((call) => /^SELECT .* FROM notification_log /i.test(call.sql));
  assert.match(select.sql, /delivery_status_code IN \('2000', '3000'\)/);
  assert.match(select.sql, /LEFT JOIN notification_delivery_alerts/i);
  assert.match(select.sql, /status IN \('queued', 'failed'\)/);
  assert.doesNotMatch(select.sql, /delivery_status_code IN \('2000', '3000', '1061'/);
  assert.match(
    select.sql,
    /COALESCE\(\s*delivery_alert.updated_at, notification_log.delivery_checked_at, notification_log.created_at\s*\) ASC/,
  );
});

test('a provider-accepted administrator alert is reconciled before retrying after a lost response', async () => {
  const monitor = await loadMonitor();
  const row = logRow(31, { recipient_name: '까우사르', to_phone: '010****2576' });
  const db = new MonitorDb([row]);
  const sent = [];
  const lookupTokens = [];
  const lookupDates = [];
  let lookupResult = null;
  const options = {
    nowMs: Date.parse('2026-09-03T04:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [reportFor(row, '3061', '사용자에 의해 수신거부됨')],
    findAdminAlert: async (token, lookupOptions) => {
      lookupTokens.push(token);
      lookupDates.push(lookupOptions.kstDate);
      return lookupResult;
    },
    sendAdmin: async (_db, message) => {
      sent.push(message);
      return { ok: false, error: 'response lost after provider acceptance' };
    },
  };

  const first = await monitor.runSmsDeliveryMonitor(db, options);
  assert.equal(first.failed, 1);
  assert.equal(sent.length, 1);
  assert.equal(lookupTokens.length, 0);

  lookupResult = { messageId: 'admin-message-recovered' };
  const second = await monitor.runSmsDeliveryMonitor(db, {
    ...options,
    nowMs: Date.parse('2026-09-04T01:00:00.000Z'),
  });
  assert.equal(second.alerted, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(lookupTokens, [sent[0].customFields.deliveryAlertKey]);
  assert.deepEqual(lookupDates, ['2026-09-03']);
  assert.equal([...db.alerts.values()][0].status, 'sent');
  assert.equal([...db.alerts.values()][0].admin_provider_msgid, 'admin-message-recovered');
});

test('two blocked rows with the same daily key do not retry inside the same invocation', async () => {
  const monitor = await loadMonitor();
  const first = logRow(32, { recipient_name: '강종효', to_phone: '010****0873' });
  const second = logRow(33, { recipient_name: '강종효', to_phone: '010****0873' });
  const db = new MonitorDb([first, second]);
  let sends = 0;
  let lookups = 0;

  const result = await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T04:30:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [
      reportFor(first, '3061', '사용자에 의해 수신거부됨'),
      reportFor(second, '3061', '사용자에 의해 수신거부됨'),
    ],
    findAdminAlert: async () => {
      lookups += 1;
      return null;
    },
    sendAdmin: async () => {
      sends += 1;
      return { ok: false, error: 'response lost after provider acceptance' };
    },
  });

  assert.equal(result.blocked, 2);
  assert.equal(result.failed, 1);
  assert.equal(sends, 1);
  assert.equal(lookups, 0);
});

test('a failed administrator alert is retried on the next monitor run', async () => {
  const monitor = await loadMonitor();
  const row = logRow(4, { recipient_name: '백승정', to_phone: '010****4464' });
  const db = new MonitorDb([row]);
  let attempts = 0;
  const options = {
    nowMs: Date.parse('2026-09-03T02:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => [reportFor(row, '3047', '착신거절')],
    findAdminAlert: async () => null,
    sendAdmin: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: 'temporary failure' }
        : { ok: true, msgId: 'admin-message-2' };
    },
  };

  const failed = await monitor.runSmsDeliveryMonitor(db, options);
  const retried = await monitor.runSmsDeliveryMonitor(db, options);

  assert.equal(failed.failed, 1);
  assert.equal(retried.alerted, 1);
  assert.equal(attempts, 2);
  assert.equal([...db.alerts.values()][0].status, 'sent');
  assert.equal([...db.alerts.values()][0].attempts, 2);
});

test('customer and administrator messages are excluded from delivery monitoring', async () => {
  const monitor = await loadMonitor();
  const monitored = logRow(5, { milestone: 'chonbe_alert', recipient_name: '이준형' });
  const admin = logRow(6, { milestone: 'sms_delivery_block_admin_alert', recipient_name: '관리자' });
  const customer = logRow(7, { milestone: 'ordered', recipient_name: '' });
  const db = new MonitorDb([monitored, admin, customer]);
  const queried = [];

  await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T03:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async (ids) => {
      queried.push(...ids);
      return [reportFor(monitored, '4000', '수신 완료')];
    },
    sendAdmin: async () => ({ ok: true, msgId: 'unused' }),
  });

  assert.deepEqual(queried, [monitored.provider_msgid]);
  const select = db.calls.find((call) => /^SELECT .* FROM notification_log /i.test(call.sql));
  assert.match(select.sql, /LEFT\(milestone, 9\) = 'internal_'/);
  assert.doesNotMatch(select.sql, /milestone LIKE 'internal_%'/);
});

test('one monitor invocation dispatches at most two new administrator alerts', async () => {
  const monitor = await loadMonitor();
  const rows = [
    logRow(41, { recipient_name: '강종효', to_phone: '010****0873' }),
    logRow(42, { recipient_name: '까우사르', to_phone: '010****2576' }),
    logRow(43, { recipient_name: '나타왓', to_phone: '010****9396' }),
    logRow(44, { recipient_name: '마카라', to_phone: '010****8947' }),
  ];
  const db = new MonitorDb(rows);
  const sent = [];

  const result = await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T05:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async () => rows.map((row) => reportFor(row, '3061', '사용자에 의해 수신거부됨')),
    findAdminAlert: async () => null,
    sendAdmin: async (_db, message) => {
      sent.push(message);
      return { ok: true, msgId: `admin-message-${sent.length}` };
    },
  });

  assert.equal(result.blocked, 4);
  assert.equal(result.alerted, 2);
  assert.equal(sent.length, 2);
  assert.equal([...db.alerts.values()].filter((alert) => alert.status === 'queued').length, 2);

  const retried = await monitor.runSmsDeliveryMonitor(db, {
    nowMs: Date.parse('2026-09-03T05:05:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async (ids) => rows
      .filter((row) => ids.includes(row.provider_msgid))
      .map((row) => reportFor(row, '3061', '사용자에 의해 수신거부됨')),
    findAdminAlert: async () => null,
    sendAdmin: async (_db, message) => {
      sent.push(message);
      return { ok: true, msgId: `admin-message-${sent.length}` };
    },
  });

  assert.equal(retried.alerted, 2);
  assert.equal(sent.length, 4);
  assert.equal([...db.alerts.values()].filter((alert) => alert.status === 'queued').length, 0);
});

test('repeated failures rotate to the next queued recipient instead of starving it', async () => {
  const monitor = await loadMonitor();
  const rows = [
    logRow(51, { recipient_name: '강종효', to_phone: '010****0873', delivery_status_code: '3061' }),
    logRow(52, { recipient_name: '까우사르', to_phone: '010****2576', delivery_status_code: '3061' }),
    logRow(53, { recipient_name: '나타왓', to_phone: '010****9396', delivery_status_code: '3061' }),
  ];
  const db = new MonitorDb(rows);
  rows.forEach((row, index) => {
    const alertKey = `2026-09-03:${row.recipient_name}:${row.to_phone}:3061`;
    db.alerts.set(alertKey, {
      alert_key: alertKey,
      source_log_id: row.id,
      provider_msgid: row.provider_msgid,
      recipient_name: row.recipient_name,
      to_phone: row.to_phone,
      status_code: '3061',
      reason: '사용자에 의해 수신거부됨',
      status: 'failed',
      attempts: 1,
      updated_order: index + 1,
    });
  });
  db.clock = 3;
  const sent = [];
  const options = {
    nowMs: Date.parse('2026-09-03T06:00:00.000Z'),
    ensureSchema: async () => {},
    fetchReports: async (ids) => rows
      .filter((row) => ids.includes(row.provider_msgid))
      .map((row) => reportFor(row, '3061', '사용자에 의해 수신거부됨')),
    findAdminAlert: async () => null,
    sendAdmin: async (_db, message) => {
      sent.push(message);
      return { ok: false, error: 'Solapi temporarily unavailable' };
    },
  };

  await monitor.runSmsDeliveryMonitor(db, options);
  await monitor.runSmsDeliveryMonitor(db, { ...options, nowMs: Date.parse('2026-09-03T06:05:00.000Z') });

  assert.equal(sent.length, 4);
  assert.match(sent[0].text, /강종효/);
  assert.match(sent[1].text, /까우사르/);
  assert.match(sent[2].text, /나타왓/);
});

test('administrator alert lookup searches only the administrator number and returns sanitized data', async () => {
  const monitor = await loadMonitor();
  const originalKey = process.env.SOLAPI_API_KEY;
  const originalSecret = process.env.SOLAPI_API_SECRET;
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
  let requestedUrl;

  try {
    const match = await monitor.findSolapiAdminAlert('token-123', {
      kstDate: '2026-09-03',
      nowMs: Date.parse('2026-09-05T03:00:00.000Z'),
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return {
          ok: true,
          async json() {
            return {
              messageList: {
                accepted: {
                  messageId: 'admin-message-accepted',
                  status: 'SENDING',
                  statusCode: '2000',
                  customFields: { deliveryAlertKey: 'token-123' },
                  text: 'must not escape the adapter',
                  to: '01077314237',
                },
              },
            };
          },
        };
      },
    });

    assert.equal(requestedUrl.searchParams.get('to'), '01077314237');
    assert.equal(requestedUrl.searchParams.get('limit'), '500');
    assert.equal(requestedUrl.searchParams.get('startDate'), '2026-09-02T15:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('endDate'), '2026-09-05T15:00:00.000Z');
    assert.equal(match.messageId, 'admin-message-accepted');
    assert.equal('text' in match, false);
    assert.equal('to' in match, false);
  } finally {
    if (originalKey === undefined) delete process.env.SOLAPI_API_KEY;
    else process.env.SOLAPI_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.SOLAPI_API_SECRET;
    else process.env.SOLAPI_API_SECRET = originalSecret;
  }
});

test('sendAdminLms forwards the delivery alert token as a Solapi custom field', async () => {
  const originalKey = process.env.SOLAPI_API_KEY;
  const originalSecret = process.env.SOLAPI_API_SECRET;
  const originalSender = process.env.SMS_SENDER;
  const originalFetch = globalThis.fetch;
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
  process.env.SMS_SENDER = '0212345678';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() { return { messageId: 'admin-message-1' }; },
    };
  };

  try {
    const { sendAdminLms } = await import(`../api/_lib/notify.js?customFields=${Math.random()}`);
    const db = new MonitorDb();
    const result = await sendAdminLms(db, {
      to: '010-7731-4237',
      subject: '관리자 알림',
      text: '문자 수신 이상',
      tag: 'sms_delivery_block_admin_alert',
      customFields: { deliveryAlertKey: 'token-123' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(requestBody.message.customFields, { deliveryAlertKey: 'token-123' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SOLAPI_API_KEY;
    else process.env.SOLAPI_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.SOLAPI_API_SECRET;
    else process.env.SOLAPI_API_SECRET = originalSecret;
    if (originalSender === undefined) delete process.env.SMS_SENDER;
    else process.env.SMS_SENDER = originalSender;
  }
});

test('Solapi report lookup batches message IDs and never returns message bodies', async () => {
  const monitor = await loadMonitor();
  const originalKey = process.env.SOLAPI_API_KEY;
  const originalSecret = process.env.SOLAPI_API_SECRET;
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
  const batches = [];

  try {
    const reports = await monitor.fetchSolapiDeliveryReports(['m1', 'm2', 'm3'], {
      batchSize: 2,
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        const ids = [...parsed.searchParams.entries()]
          .filter(([key]) => /^messageIds\[\d+\]$/.test(key))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value);
        assert.equal(parsed.searchParams.get('messageIds'), null);
        batches.push(ids);
        assert.match(options.headers.Authorization, /^HMAC-SHA256 apiKey=test-key,/);
        return {
          ok: true,
          async json() {
            return {
              messageList: Object.fromEntries(ids.map((id) => [id, {
                messageId: id,
                status: 'COMPLETE',
                statusCode: '4000',
                reason: '수신 완료',
                text: 'must not escape the adapter',
                to: '01000000000',
              }])),
            };
          },
        };
      },
    });

    assert.deepEqual(batches, [['m1', 'm2'], ['m3']]);
    assert.equal(reports.length, 3);
    assert.equal('text' in reports[0], false);
    assert.equal('to' in reports[0], false);
  } finally {
    if (originalKey === undefined) delete process.env.SOLAPI_API_KEY;
    else process.env.SOLAPI_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.SOLAPI_API_SECRET;
    else process.env.SOLAPI_API_SECRET = originalSecret;
  }
});

test('delivery monitor cron authenticates requests and skips KST weekends', async () => {
  const cron = await import(`../api/cron/sms-delivery-monitor.js?cron=${Math.random()}`);
  assert.equal(typeof cron.handleSmsDeliveryMonitor, 'function');
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'delivery-monitor-secret';
  const calls = [];
  const monitorLogs = [];

  try {
    const unauthorized = mockResponse();
    await cron.handleSmsDeliveryMonitor(
      { method: 'GET', headers: {} },
      unauthorized,
      { db: {}, monitor: async () => { calls.push('unauthorized'); } },
    );
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(calls, []);

    const authorized = mockResponse();
    const monitorResult = {
      scanned: 2,
      reported: 2,
      received: 2,
      blocked: 0,
      alerted: 0,
      failed: 0,
    };
    await cron.handleSmsDeliveryMonitor(
      { method: 'GET', headers: { authorization: 'Bearer delivery-monitor-secret' } },
      authorized,
      {
        db: {},
        nowMs: Date.parse('2026-09-03T00:00:00.000Z'),
        monitor: async () => {
          calls.push('weekday');
          return monitorResult;
        },
        logger: {
          info(label, payload) { monitorLogs.push({ label, payload }); },
        },
      },
    );
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(authorized.body, { ok: true, ...monitorResult });
    assert.deepEqual(monitorLogs, [{ label: '[sms-delivery-monitor]', payload: monitorResult }]);

    const weekend = mockResponse();
    await cron.handleSmsDeliveryMonitor(
      { method: 'GET', headers: { authorization: 'Bearer delivery-monitor-secret' } },
      weekend,
      {
        db: {},
        nowMs: Date.parse('2026-09-05T00:00:00.000Z'),
        monitor: async () => { calls.push('weekend'); },
      },
    );
    assert.deepEqual(weekend.body, { ok: true, skipped: 'weekend' });
    assert.deepEqual(calls, ['weekday']);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('Vercel schedules the delivery monitor exactly once every five minutes', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const schedules = config.crons.filter((cron) => cron.path === '/api/cron/sms-delivery-monitor');
  assert.deepEqual(schedules, [
    { path: '/api/cron/sms-delivery-monitor', schedule: '*/5 * * * *' },
  ]);
});
