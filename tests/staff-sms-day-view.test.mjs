import assert from 'node:assert/strict';
import test from 'node:test';

// 2026-11-11 사장님 "이름누르면 그날 발송된 문자를 볼 수 있도록 … 전체보기를 누르면 발송 순서대로"
// GET /api/internal-notifications?view=day&date= : 그날 기록 전체(먼저 보낸 것부터) + 등록 직원 이름·끝 4자리

function row(id, minute, extra = {}) {
  return {
    id, milestone: 'internal_overdue_equipment', to_phone: '010****4237', status: 'success',
    recipient_name: '이시아 부장', message_subject: `제목 ${id}`, message_text: '본문',
    created_at: `2026-11-11T0${minute}:00:00Z`, delivery_status_code: '4000',
    ...extra,
  };
}

function makeDb(rows) {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push({ sql: String(query?.sql || '').replace(/\s+/g, ' ').trim(), args: query?.args || [] });
      return { rows };
    },
  };
}

function mockResponse() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(query, rows = []) {
  const { handleInternalNotifications } = await import(`../api/internal-notifications.js?day=${Math.random()}`);
  const db = makeDb(rows);
  const res = mockResponse();
  await handleInternalNotifications({ method: 'GET', headers: {}, query }, res, { db, rateLimitCheck: () => true });
  return { res, db };
}

test('하루 보기는 날짜가 없으면 거절한다', async () => {
  const { res, db } = await call({ view: 'day' });
  assert.equal(res.statusCode, 400);
  assert.equal(db.calls.length, 0);
});

test('하루 보기는 건수 집계 없이 그날 기록을 먼저 보낸 순서로 한 번에 준다', async () => {
  const { res, db } = await call({ view: 'day', date: '2026-11-11' }, [row(1, 1), row(2, 2, { recipient_name: '신은철', milestone: 'chonbe_alert', to_phone: '010****7407' })]);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.length, 1);
  assert.doesNotMatch(db.calls[0].sql, /COUNT\(\*\)/);
  assert.match(db.calls[0].sql, /ORDER BY created_at ASC, id ASC LIMIT \?$/);
  assert.equal(db.calls[0].args.at(-1), 301);
  assert.match(db.calls[0].sql, /\(created_at AT TIME ZONE 'Asia\/Seoul'\)::date = \?::date/);
  assert.deepEqual(res.body.items.map(item => item.id), [1, 2]);
  assert.equal(res.body.truncated, false);
  assert.equal('pagination' in res.body, false);
});

test('하루 보기는 300건을 넘으면 300건만 주고 넘었다고 알린다', async () => {
  const rows = Array.from({ length: 301 }, (_, index) => row(index + 1, 1));
  const { res } = await call({ view: 'day', date: '2026-11-11' }, rows);
  assert.equal(res.body.items.length, 300);
  assert.equal(res.body.truncated, true);
});

test('등록 직원 15명은 이름과 번호 끝 4자리만 내보낸다', async () => {
  const { res } = await call({ view: 'day', date: '2026-11-11' });
  const recipients = res.body.recipients;
  assert.equal(recipients.length, 15);
  assert.deepEqual(recipients.slice(0, 3), [
    { name: '이시아 부장', phone_tail: '4237' },
    { name: '최우석 이사', phone_tail: '5110' },
    { name: '이정섭 부장', phone_tail: '5938' },
  ]);
  for (const person of recipients) {
    assert.deepEqual(Object.keys(person).sort(), ['name', 'phone_tail']);
    assert.match(person.phone_tail, /^\d{4}$/, person.name);
  }
  // 전체 번호(5자리 이상 숫자)나 가린 번호(*)가 섞이지 않는다
  assert.doesNotMatch(JSON.stringify(recipients), /\d{5,}|\*/);
});

test('하루 보기가 아니면 지금처럼 최신순 10건 쪽 넘김이다', async () => {
  const { res, db } = await call({ date: '2026-11-11' }, [row(1, 1)]);
  assert.match(db.calls.at(-1).sql, /ORDER BY created_at DESC, id DESC LIMIT \? OFFSET \?$/);
  assert.ok(res.body.pagination);
  assert.equal('recipients' in res.body, false);
});
