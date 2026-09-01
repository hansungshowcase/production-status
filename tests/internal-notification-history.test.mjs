import assert from 'node:assert/strict';
import test from 'node:test';

function makeNotificationDb() {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push({
        sql: String(query?.sql || '').replace(/\s+/g, ' ').trim(),
        args: query?.args || [],
      });
      return { rows: [] };
    },
  };
}

async function withoutSolapi(fn) {
  const savedKey = process.env.SOLAPI_API_KEY;
  const savedSecret = process.env.SOLAPI_API_SECRET;
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
  try {
    return await fn();
  } finally {
    if (savedKey === undefined) delete process.env.SOLAPI_API_KEY;
    else process.env.SOLAPI_API_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.SOLAPI_API_SECRET;
    else process.env.SOLAPI_API_SECRET = savedSecret;
  }
}

test('내부 LMS 로그에 수신자명·제목·발송 본문을 스냅숏으로 저장한다', async () => {
  await withoutSolapi(async () => {
    const { sendAdminLms } = await import(`../api/_lib/notify.js?history=${Math.random()}`);
    const db = makeNotificationDb();
    const result = await sendAdminLms(db, {
      to: '010-9606-0873',
      recipientName: '강종효',
      subject: '[한성엘시디에스 포장 완료 자가 점검]',
      text: '강종효님, 포장 완료까지 확인해 주세요.',
      tag: 'internal_assembly_daily',
    });

    assert.equal(result.dryRun, true);
    const insert = db.calls.find(call => call.sql.startsWith('INSERT INTO notification_log'));
    assert.ok(insert);
    assert.match(insert.sql, /recipient_name, message_subject, message_text/);
    assert.deepEqual(insert.args.slice(-3), [
      '강종효',
      '[한성엘시디에스 포장 완료 자가 점검]',
      '강종효님, 포장 완료까지 확인해 주세요.',
    ]);
  });
});

test('기존 영업 관리자 문자는 내부 발송내역 스냅숏에 내용을 저장하지 않는다', async () => {
  await withoutSolapi(async () => {
    const { sendAdminLms } = await import(`../api/_lib/notify.js?history=${Math.random()}`);
    const db = makeNotificationDb();
    await sendAdminLms(db, {
      to: '010-0000-0000',
      recipientName: '영업 담당자',
      subject: '납기 위험 알림',
      text: '기존 영업 알림 본문',
      tag: 'admin_risk_daily',
    });

    const insert = db.calls.find(call => call.sql.startsWith('INSERT INTO notification_log'));
    assert.ok(insert);
    assert.deepEqual(insert.args.slice(-3), [null, null, null]);
  });
});

const historyRows = [
  {
    id: 3,
    milestone: 'internal_assembly_daily',
    to_phone: '010****0873',
    status: 'success',
    recipient_name: '강종효',
    message_subject: '포장 완료 자가 점검',
    message_text: '강종효님, 포장 완료까지 확인해 주세요.',
    created_at: '2026-09-01T00:40:00.000Z',
    provider_msgid: 'never-expose-this',
    error: 'never-expose-this',
  },
  {
    id: 2,
    milestone: 'admin_risk_daily',
    to_phone: '010****9999',
    status: 'success',
    recipient_name: '영업 담당자',
    message_subject: '영업 위험 알림',
    message_text: '공개하면 안 되는 영업 알림',
    created_at: '2026-09-01T00:30:00.000Z',
  },
  {
    id: 1,
    milestone: 'internal_design_due',
    to_phone: '010****4034',
    status: 'dry_run',
    recipient_name: null,
    message_subject: null,
    message_text: null,
    created_at: '2026-09-01T00:20:00.000Z',
  },
];

function makeHistoryDb(rows = historyRows) {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push({
        sql: String(query?.sql || '').replace(/\s+/g, ' ').trim(),
        args: query?.args || [],
      });
      return { rows };
    },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function callHistoryApi(query = {}, options = {}) {
  const { handleInternalNotifications } = await import(`../api/internal-notifications.js?api=${Math.random()}`);
  const db = options.db || makeHistoryDb();
  const res = mockResponse();
  await handleInternalNotifications(
    { method: options.method || 'GET', headers: {}, query },
    res,
    {
      db,
      rateLimitCheck: options.rateLimitCheck || (() => true),
      ensureSchema: async () => {},
    },
  );
  return { res, db };
}

test('공개 발송내역 API는 인증 없이 내부 문자만 마스킹해 반환한다', async () => {
  const { res, db } = await callHistoryApi({ audience: 'all', limit: '50' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body.items.map(item => item.milestone), [
    'internal_assembly_daily',
    'internal_design_due',
  ]);
  assert.equal(res.body.items[0].phone, '010****0873');
  assert.equal(res.body.items[1].recipient_name, '김보수 팀장');
  assert.equal(res.body.items[1].text, null);
  assert.deepEqual(res.body.counts, { total: 2, success: 1, failed: 0, dry_run: 1 });
  assert.equal('error' in res.body.items[0], false);
  assert.equal('provider_msgid' in res.body.items[0], false);
  assert.match(db.calls.at(-1).sql, /LEFT\(milestone, 9\) = 'internal_'/);
});

test('공개 발송내역 API는 간부와 팀원을 구분해 조회한다', async () => {
  const member = await callHistoryApi({ audience: 'member' });
  const executive = await callHistoryApi({ audience: 'executive' });

  assert.deepEqual(member.res.body.items.map(item => item.audience), ['member']);
  assert.deepEqual(executive.res.body.items.map(item => item.audience), ['executive']);
  assert.match(member.db.calls.at(-1).sql, /milestone = 'internal_assembly_daily'/);
  assert.match(executive.db.calls.at(-1).sql, /milestone <> 'internal_assembly_daily'/);
});

test('공개 발송내역 API는 잘못된 요청을 거절하고 조회 개수를 100건으로 제한한다', async () => {
  const invalid = await callHistoryApi({ audience: 'sales' });
  const method = await callHistoryApi({}, { method: 'POST' });
  const limited = await callHistoryApi({ limit: '9999' });

  assert.equal(invalid.res.statusCode, 400);
  assert.equal(method.res.statusCode, 405);
  assert.deepEqual(limited.db.calls.at(-1).args, [100]);
});

test('공개 발송내역 API는 전체 전화번호와 인증 의존성을 소스에 포함하지 않는다', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../api/internal-notifications.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /requireAuth|from ['"]\.\/_lib\/auth\.js['"]/);
  assert.doesNotMatch(source, /provider_msgid/);
});

test('저장값이 잘못 들어와도 전체 전화번호는 공개 응답에서 다시 마스킹한다', async () => {
  const { serializeInternalNotification } = await import('../api/_lib/internalNotificationHistory.js');
  const item = serializeInternalNotification({
    id: 9,
    milestone: 'internal_assembly_daily',
    to_phone: '010-9606-0873',
    status: 'success',
    created_at: '2026-09-01T01:00:00.000Z',
  });

  assert.equal(item.phone, '010****0873');
  assert.equal(item.recipient_name, '강종효');
  assert.doesNotMatch(JSON.stringify(item), /010-?9606-?0873/);
});

test('내부 문자 이력 열 보정은 일반 주문 알림 스키마 경로와 분리한다', async () => {
  const schema = await import(`../api/_lib/notifySchema.js?scope=${Math.random()}`);
  const db = makeNotificationDb();

  await schema.ensureNotifySchema(db);
  assert.equal(
    db.calls.some(call => /recipient_name|message_subject|message_text/.test(call.sql)),
    false,
  );

  await schema.ensureInternalNotificationHistorySchema(db);
  assert.equal(
    db.calls.filter(call => /^ALTER TABLE notification_log ADD COLUMN/.test(call.sql)).length,
    3,
  );
});
