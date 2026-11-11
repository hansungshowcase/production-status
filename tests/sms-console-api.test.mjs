import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { handleSmsConsole, _resetConsoleCacheForTest, PROGRAM_TEMPLATE_ENVS, programTemplateIds } from '../api/sms-console.js';
import { _resetGuardForTest, isLocked, noteFailure } from '../api/_lib/smsConsoleGuard.js';
import * as realGuard from '../api/_lib/smsConsoleGuard.js';

class SolapiKakaoError extends Error {
  constructor(status, publicMessage) { super(publicMessage); this.name = 'SolapiKakaoError'; this.status = status; this.publicMessage = publicMessage; }
}
const NOW = Date.parse('2026-11-11T03:00:00Z');
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const request = (method, { body, query = {}, origin = 'https://production-status.vercel.app', ip = '9.9.9.9' } = {}) => ({
  method, body, query, url: '/api/sms-console', socket: { remoteAddress: ip },
  headers: { origin, host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' },
});
const allow = () => true;
const tpl = (over = {}) => ({ id: 'KA01', name: '배송 안내', status: 'PENDING', supported: true, editable: true, target: { kind: 'group', id: 'G1', name: '한성' }, content: '본문', ...over });

function fakeKakao(over = {}) {
  const calls = [];
  const rec = name => async (...args) => { calls.push([name, ...args.slice(0, -1)]); return {}; };
  const kakao = {
    calls, cleared: 0,
    SolapiKakaoError,
    clearTemplateCache() { this.cleared += 1; },
    async listDirectory() { return { channels: [{ id: 'C1', name: 'a' }], groups: [{ id: 'G1', name: '한성' }], groupsResolved: true }; },
    scopeOf(raw) { const id = raw.channelId || raw.channelGroupId; return { allowed: id === 'G1', id }; },
    async listTemplates() { return { items: [tpl()], targets: [{ kind: 'group', id: 'G1', name: '한성' }], counts: { total: 1, APPROVED: 0, INSPECTING: 0, PENDING: 1, REJECTED: 0 }, unresolved_groups: 0 }; },
    async getTemplateFresh(id) { return id === 'NONE' ? null : { raw: {}, template: tpl({ id }), scope: { allowed: id !== 'OUT' } }; },
    createTemplate: async (v) => { calls.push(['create', v]); return { templateId: 'NEW1' }; },
    updateTemplate: rec('update'), renameTemplate: rec('rename'), requestInspection: rec('inspect'),
    cancelInspection: rec('cancel'), deleteTemplate: rec('delete'),
    async listCategories() { return [{ code: '999999', name: '기타' }]; },
    async getBalance() { return 9679; },
    ...over,
  };
  return kakao;
}
const guard = (over = {}) => ({
  writeStatus: async () => ({ enabled: true, reason: null }),
  verifyAdminPassword: async p => p === 'good',
  noteFailure: realGuard.noteFailure, isLocked: realGuard.isLocked, ...over,
});
const emptyDay = async () => ({ messages: [], partial: false });
function deps(over = {}) {
  return { kakao: fakeKakao(), guard: guard(), fetchSolapiDay: emptyDay, nowMs: NOW, rateLimitCheck: allow, hasCredentials: () => true, ...over };
}
const run = async (req, d) => { const res = response(); await handleSmsConsole(req, res, d); return res; };
const post = (body, o) => request('POST', { body, ...o });
const validTemplate = () => ({ target: { kind: 'group', id: 'G1' }, name: '시험', content: '#{이름}님 시험입니다', categoryCode: '999999', messageType: 'BA', emphasizeType: 'NONE', securityFlag: false, buttons: [] });
const reset = () => { _resetGuardForTest(); _resetConsoleCacheForTest(); };

function noForbiddenKeys(value) {
  const bad = ['to', 'text', 'password'];
  const walk = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!bad.includes(k), `금지 키 ${k}`); walk(x); } };
  walk(value);
}

test('GET: 틀린 resource 400, no-store 헤더', async () => {
  reset();
  const res = await run(request('GET', { query: { resource: 'nope' } }), deps());
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.message, '올바른 조회가 아닙니다.');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal((await run(request('PUT'), deps())).statusCode, 405);
});

test('GET: 쏠라피 키 없음 configured:false 빈 값 200', async () => {
  reset();
  for (const resource of ['overview', 'templates', 'usage', 'categories', 'scope']) {
    const res = await run(request('GET', { query: { resource } }), deps({ hasCredentials: () => false }));
    assert.equal(res.statusCode, 200, resource);
    assert.equal(res.body.configured, false);
  }
});

test('GET: overview·templates·categories·scope 정상, 실패는 502', async () => {
  reset();
  const o = await run(request('GET', { query: { resource: 'overview' } }), deps());
  assert.equal(o.body.balance, 9679); assert.equal(o.body.template_counts.PENDING, 1); assert.equal(o.body.write.enabled, true);
  const t = await run(request('GET', { query: { resource: 'templates' } }), deps());
  assert.equal(t.body.items.length, 1); assert.equal(t.body.targets[0].id, 'G1');
  const c = await run(request('GET', { query: { resource: 'categories' } }), deps());
  assert.equal(c.body.items[0].code, '999999');
  const s = await run(request('GET', { query: { resource: 'scope' } }), deps());
  assert.deepEqual(s.body.channels, [{ id: 'C1', allowed: false }]);
  assert.deepEqual(s.body.groups, [{ id: 'G1', allowed: true, template_count: 1 }]);
  const bad = await run(request('GET', { query: { resource: 'templates' } }), deps({ kakao: fakeKakao({ listTemplates: async () => { throw new SolapiKakaoError(500, 'x'); } }) }));
  assert.equal(bad.statusCode, 502);
  assert.deepEqual(bad.body, { error: { message: '쏠라피에서 불러오지 못했습니다', status: 502 } });
});

test('GET usage: 7일 셈, 대체발송 제외, 2개씩, 실패는 partial, 10분 캐시, 수신번호·본문 없음', async () => {
  reset();
  const seen = []; let inflight = 0, maxInflight = 0;
  const fetchSolapiDay = async date => {
    seen.push(date); inflight += 1; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 2)); inflight -= 1;
    if (date === '2026-11-08') throw new Error('boom');
    return { partial: false, messages: [
      { to: '01011112222', text: '비밀', dateCreated: `${date}T01:00:00Z`, kakaoOptions: { templateId: 'KA01' } },
      { to: '01011112222', text: '대체', replacement: true, dateCreated: `${date}T02:00:00Z`, kakaoOptions: { templateId: 'KA01' } },
      { to: '0', dateCreated: `${date}T00:00:00Z`, kakaoOptions: { templateId: null } },
    ] };
  };
  const d = deps({ fetchSolapiDay });
  const res = await run(request('GET', { query: { resource: 'usage' } }), d);
  assert.deepEqual(seen.slice().sort(), ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
  assert.ok(maxInflight <= 2);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.by_template.KA01.count, 6);
  assert.equal(res.body.by_template.KA01.last_at, '2026-11-11T01:00:00.000Z');
  noForbiddenKeys(res.body);
  const n = seen.length;
  await run(request('GET', { query: { resource: 'usage' } }), d);
  assert.equal(seen.length, n, '캐시');
});

test('POST: 다른 출처 차단', async () => {
  reset();
  let called = 0;
  const d = deps({ guard: guard({ writeStatus: async () => { called += 1; return { enabled: true }; } }) });
  const res = await run(post({ action: 'unlock', password: 'good' }, { origin: 'https://untrusted.example' }), d);
  assert.equal(res.statusCode, 403);
  assert.equal(called, 0);
});

test('POST: 본문 모양 400, 쓰기 꺼짐 503, 틀린 비밀번호 401, unlock 200', async () => {
  reset();
  assert.equal((await run(post({ action: 'zzz' }), deps())).statusCode, 400);
  assert.equal((await run(post('not json'), deps())).statusCode, 400);
  const off = await run(post({ action: 'unlock', password: 'good' }), deps({ guard: guard({ writeStatus: async () => ({ enabled: false, reason: 'disabled' }) }) }));
  assert.equal(off.statusCode, 503);
  assert.equal((await run(post({ action: 'unlock', password: 'bad' }), deps())).statusCode, 401);
  const ok = await run(post({ action: 'unlock', password: 'good' }), deps());
  assert.equal(ok.statusCode, 200); assert.deepEqual(ok.body, { ok: true });
});

test('POST: 10회 틀리면 11번째는 429(맞는 비밀번호도 잠김)', async () => {
  reset();
  const d = deps();
  for (let i = 0; i < 10; i += 1) assert.equal((await run(post({ action: 'unlock', password: 'bad' }), d)).statusCode, 401);
  assert.equal((await run(post({ action: 'unlock', password: 'good' }), d)).statusCode, 429);
  assert.equal((await run(post({ action: 'unlock', password: 'good' }, { ip: '8.8.8.8' }), d)).statusCode, 200);
});

test('POST: 범위 밖 403, 없는 템플릿 404, 잘못된 ID 400', async () => {
  reset();
  assert.equal((await run(post({ action: 'rename', password: 'good', id: 'OUT', name: 'x' }), deps())).statusCode, 403);
  assert.equal((await run(post({ action: 'rename', password: 'good', id: 'NONE', name: 'x' }), deps())).statusCode, 404);
  assert.equal((await run(post({ action: 'rename', password: 'good', id: '../x', name: 'x' }), deps())).statusCode, 400);
  const d = deps();
  const c = await run(post({ action: 'create', password: 'good', template: { ...validTemplate(), target: { kind: 'channel', id: 'C1' } } }), d);
  assert.equal(c.statusCode, 403);
  assert.equal(d.kakao.calls.length, 0);
});

test('POST delete: 사용 중 409, 사용량 실패 409, confirmName 불일치 400, 성공', async () => {
  reset();
  const used = async date => ({ partial: false, messages: date === '2026-11-11' ? [{ kakaoOptions: { templateId: 'KA01' }, dateCreated: `${date}T01:00:00Z` }, { kakaoOptions: { templateId: 'KA01' }, dateCreated: `${date}T02:00:00Z` }] : [] });
  let d = deps({ fetchSolapiDay: used });
  let res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '배송 안내' }), d);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, '최근 7일 동안 2건 발송된 템플릿입니다. 이 템플릿을 쓰는 자동 발송(쏠라피 자동화·프로그램 알림)을 먼저 끄세요.');
  assert.ok(!d.kakao.calls.some(c => c[0] === 'delete'));

  reset();
  d = deps({ fetchSolapiDay: async () => { throw new Error('down'); } });
  res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '배송 안내' }), d);
  assert.equal(res.statusCode, 409);
  assert.ok(!d.kakao.calls.some(c => c[0] === 'delete'));

  reset();
  d = deps();
  res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '다른 이름' }), d);
  assert.equal(res.statusCode, 400);
  assert.ok(!d.kakao.calls.some(c => c[0] === 'delete'));

  reset();
  d = deps();
  res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '배송 안내' }), d);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { deleted: true, id: 'KA01' });
  assert.ok(d.kakao.calls.some(c => c[0] === 'delete' && c[1] === 'KA01'));
  assert.equal(d.kakao.cleared, 1);
});

test('POST create: 201 과 캐시 비움, 입력 검증 400', async () => {
  reset();
  const d = deps();
  const res = await run(post({ action: 'create', password: 'good', template: validTemplate() }), d);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.inspected, false);
  assert.equal(res.body.item.id, 'NEW1');
  assert.equal(d.kakao.cleared, 1);
  assert.equal(d.kakao.calls.filter(c => c[0] === 'inspect').length, 0);
  const bad = await run(post({ action: 'create', password: 'good', template: { ...validTemplate(), name: '' } }), deps());
  assert.equal(bad.statusCode, 400);
});

test('POST create: 검수 요청 성공/실패(등록은 유지)', async () => {
  reset();
  let d = deps();
  let res = await run(post({ action: 'create', password: 'good', template: validTemplate(), requestInspection: true, comment: '참고' }), d);
  assert.equal(res.statusCode, 201); assert.equal(res.body.inspected, true);
  assert.deepEqual(d.kakao.calls.find(c => c[0] === 'inspect'), ['inspect', 'NEW1', '참고']);

  reset();
  d = deps({ kakao: fakeKakao({ requestInspection: async () => { throw new SolapiKakaoError(400, '검수 불가') ; } }) });
  res = await run(post({ action: 'create', password: 'good', template: validTemplate(), requestInspection: true }), d);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.inspected, false);
  assert.match(res.body.warning, /검수 요청은 실패/);
  assert.equal(d.kakao.cleared, 1);
});

test('POST update·inspect·cancel 상태 조건, 쏠라피 4xx 는 409', async () => {
  reset();
  const approved = fakeKakao({ getTemplateFresh: async id => ({ raw: {}, template: tpl({ id, status: 'APPROVED' }), scope: { allowed: true } }) });
  assert.equal((await run(post({ action: 'inspect', password: 'good', id: 'KA01' }), deps({ kakao: approved }))).statusCode, 409);
  assert.equal((await run(post({ action: 'cancel_inspect', password: 'good', id: 'KA01' }), deps())).statusCode, 409);
  let d = deps();
  let res = await run(post({ action: 'update', password: 'good', id: 'KA01', template: { ...validTemplate(), target: undefined } }), d);
  assert.equal(res.statusCode, 200);
  assert.ok(d.kakao.calls.some(c => c[0] === 'update'));
  res = await run(post({ action: 'update', password: 'good', id: 'KA01', template: { name: '' } }), deps());
  assert.equal(res.statusCode, 400);
  d = deps({ kakao: fakeKakao({ renameTemplate: async () => { throw new SolapiKakaoError(400, '이름이 중복입니다') ; } }) });
  res = await run(post({ action: 'rename', password: 'good', id: 'KA01', name: '새 이름' }), d);
  assert.equal(res.statusCode, 409); assert.equal(res.body.error.message, '이름이 중복입니다');
  d = deps({ kakao: fakeKakao({ renameTemplate: async () => { throw new SolapiKakaoError(500, '서버') ; } }) });
  assert.equal((await run(post({ action: 'rename', password: 'good', id: 'KA01', name: '새 이름' }), d)).statusCode, 502);
});

test('응답 JSON 에 to/text/password 키가 없고 비밀번호 값도 로그·응답에 없음', async () => {
  reset();
  const logs = [];
  const orig = console.info; console.info = (...a) => logs.push(a.join(' '));
  try {
    const d = deps();
    const responses = [
      await run(request('GET', { query: { resource: 'templates' } }), d),
      await run(request('GET', { query: { resource: 'overview' } }), d),
      await run(post({ action: 'create', password: 'good', template: validTemplate() }), d),
      await run(post({ action: 'unlock', password: 'bad' }), d),
    ];
    for (const r of responses) { noForbiddenKeys(r.body); assert.ok(!JSON.stringify(r.body).includes('good')); }
    assert.ok(logs.length >= 1 && logs.every(l => l.startsWith('[sms-console]') && !l.includes('good')));
  } finally { console.info = orig; }
});

// ── Fable 점검(11/11) 뒤 추가: 프로그램 알림 템플릿 보호·POST 요청 수 제한·권한 오류 문구·전체 잠금 ──
const withEnv = async (name, value, fn) => {
  const before = process.env[name];
  process.env[name] = value;
  try { return await fn(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
};

test('프로그램 알림 템플릿 목록이 notify.js 의 TEMPLATE_ENV 와 같다', () => {
  const src = readFileSync(new URL('../api/_lib/notify.js', import.meta.url), 'utf8');
  const block = src.match(/const TEMPLATE_ENV = \{([\s\S]*?)\};/);
  assert.ok(block, 'notify.js 에 TEMPLATE_ENV 가 있어야 한다');
  const names = [...block[1].matchAll(/'(SOLAPI_TPL_[A-Z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...PROGRAM_TEMPLATE_ENVS].sort(), names);
});

test('POST delete: 프로그램 고객 알림에 쓰는 템플릿은 사용량 0이어도 409, 삭제 호출 없음', async () => {
  reset();
  await withEnv('SOLAPI_TPL_SHIPPED', 'KA01', async () => {
    assert.ok(programTemplateIds().has('KA01'));
    const d = deps();
    const res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '배송 안내' }), d);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error.message, /프로그램의 고객 알림/);
    assert.ok(!d.kakao.calls.some(c => c[0] === 'delete'));
  });
  await withEnv('SMS_CONSOLE_PROTECTED_TEMPLATE_IDS', 'X1, KA01 ,', async () => {
    const d = deps();
    const res = await run(post({ action: 'delete', password: 'good', id: 'KA01', confirmName: '배송 안내' }), d);
    assert.equal(res.statusCode, 409);
    assert.ok(!d.kakao.calls.some(c => c[0] === 'delete'));
  });
});

test('GET templates: 프로그램 알림 템플릿에 program_use 표시', async () => {
  reset();
  await withEnv('SOLAPI_TPL_ORDERED', 'KA01', async () => {
    const res = await run(request('GET', { query: { resource: 'templates' } }), deps());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items[0].program_use, true);
  });
  reset();
  const plain = await run(request('GET', { query: { resource: 'templates' } }), deps());
  assert.equal(plain.body.items[0].program_use, undefined);
});

test('POST 는 분당 5회 제한으로 요청 수 검사를 부른다', async () => {
  reset();
  const seen = [];
  const spy = (req, res, opts) => { seen.push(opts); return true; };
  await run(post({ action: 'unlock', password: 'good' }), deps({ rateLimitCheck: spy }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].max, 5);
  assert.equal(seen[0].keySuffix, 'POST');
  const blocked = await run(post({ action: 'unlock', password: 'good' }), deps({ rateLimitCheck: (req, res) => { res.status(429).json({ error: { message: 'x' } }); return false; } }));
  assert.equal(blocked.statusCode, 429);
});

test('GET: 쏠라피 카카오 권한 오류(403)는 권한·허용 IP 안내와 함께 502', async () => {
  reset();
  const kakao = fakeKakao({ async listTemplates() { throw new SolapiKakaoError(403, '권한 없음'); } });
  const res = await run(request('GET', { query: { resource: 'templates' } }), deps({ kakao }));
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error.message, /권한·허용 IP/);
});
