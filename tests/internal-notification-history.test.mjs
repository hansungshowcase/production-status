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
