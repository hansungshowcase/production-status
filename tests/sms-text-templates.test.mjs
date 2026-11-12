import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';

const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const SAME = { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' };
const post = (body, headers = SAME) => ({ method: 'POST', body, query: {}, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' }, headers });
const get = () => ({ method: 'GET', query: { resource: 'text_templates' }, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' }, headers: SAME });

function fakeDb() {
  const rows = [];
  let next = 1;
  const log = [];
  return {
    rows, log,
    async execute({ sql, args }) {
      const t = sql.trim();
      log.push(t.split(/\s+/)[0]);
      if (t.startsWith('CREATE TABLE')) return { rows: [] };
      if (t.startsWith('ALTER TABLE')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image')) return { rows: rows.filter(r => r.id === args[0]) };
      if (t.startsWith('SELECT id, name, body')) return { rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)).map(r => ({ ...r, has_image: Boolean(r.image) })) };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: rows.filter(r => r.name === args[0]) };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE id')) return { rows: rows.filter(r => r.id === args[0]) };
      if (t.startsWith('SELECT COUNT')) return { rows: [{ n: rows.length }] };
      if (t.startsWith('INSERT')) { const r = { id: next++, name: args[0], body: args[1], ...(args[2] ? { image: args[2] } : {}) }; rows.push(r); return { rows: [{ id: r.id }] }; }
      if (t.startsWith('UPDATE') && t.includes('image = ?')) { const r = rows.find(x => x.id === args[3]); r.name = args[0]; r.body = args[1]; if (args[2]) r.image = args[2]; else delete r.image; return { rows: [{ id: r.id }] }; }
      if (t.startsWith('UPDATE')) { const r = rows.find(x => x.id === args[2]); r.name = args[0]; r.body = args[1]; return { rows: [{ id: r.id }] }; }
      if (t.startsWith('DELETE')) { const i = rows.findIndex(x => x.id === args[0]); if (i < 0) return { rows: [] }; rows.splice(i, 1); return { rows: [{ id: args[0] }] }; }
      throw new Error(`예상 못 한 SQL ${sql}`);
    },
  };
}
const setup = () => { _resetTextTemplateSchemaForTest(); const db = fakeDb(); return { db, deps: { db, rateLimitCheck: () => true, env: {} } }; };
const call = async (req, deps) => { const res = response(); await handleSmsConsole(req, res, deps); return res; };

test('저장 → 목록 → 수정 → 삭제', async () => {
  const { db, deps } = setup();
  const saved = await call(post({ action: 'text_template_save', name: '안내', body: '안녕하세요' }), deps);
  assert.equal(saved.statusCode, 201);
  const id = saved.body.item.id;
  let list = await call(get(), deps);
  assert.deepEqual(list.body.items, [{ id, name: '안내', body: '안녕하세요' }]);
  const edited = await call(post({ action: 'text_template_save', id, name: '안내', body: '수정한 문구' }), deps);
  assert.equal(edited.statusCode, 200);
  list = await call(get(), deps);
  assert.equal(list.body.items[0].body, '수정한 문구');
  const del = await call(post({ action: 'text_template_delete', id }), deps);
  assert.equal(del.statusCode, 200);
  assert.equal(db.rows.length, 0);
  assert.equal((await call(post({ action: 'text_template_delete', id }), deps)).statusCode, 404);
});

test('같은 이름·길이·개수 상한 거절', async () => {
  const { db, deps } = setup();
  await call(post({ action: 'text_template_save', name: 'A', body: 'x' }), deps);
  const dup = await call(post({ action: 'text_template_save', name: 'A', body: 'y' }), deps);
  assert.equal(dup.statusCode, 409);
  assert.match(dup.body.error.message, /같은 이름의 문구가 있습니다/);
  assert.equal((await call(post({ action: 'text_template_save', name: 'B'.repeat(41), body: 'x' }), deps)).statusCode, 400);
  assert.equal((await call(post({ action: 'text_template_save', name: '', body: 'x' }), deps)).statusCode, 400);
  assert.equal((await call(post({ action: 'text_template_save', name: 'C', body: '' }), deps)).statusCode, 400);
  assert.equal((await call(post({ action: 'text_template_save', name: 'C', body: 'a'.repeat(2001) }), deps)).statusCode, 400);
  assert.equal((await call(post({ action: 'text_template_save', name: 'C', body: '가'.repeat(1001) }), deps)).statusCode, 400);
  assert.equal(db.rows.length, 1);
  for (let i = 0; i < 99; i += 1) db.rows.push({ id: 100 + i, name: `n${i}`, body: 'x' });
  assert.equal(db.rows.length, 100);
  assert.equal((await call(post({ action: 'text_template_save', name: 'over', body: 'x' }), deps)).statusCode, 409);
  assert.equal(db.rows.length, 100);
});

test('쓰기 스위치 꺼짐·다른 출처 → 거절, DB 변화 0', async () => {
  const { db, deps } = setup();
  const seed = await call(post({ action: 'text_template_save', name: 'S', body: 'x' }), deps);
  const id = seed.body.item.id;
  const before = JSON.stringify(db.rows);
  const off = { ...deps, guard: { writeStatus: async () => ({ enabled: false }) } };
  assert.equal((await call(post({ action: 'text_template_save', name: 'T', body: 'x' }), off)).statusCode, 503);
  assert.equal((await call(post({ action: 'text_template_delete', id }), off)).statusCode, 503);
  const other = { origin: 'https://evil.example', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' };
  assert.equal((await call(post({ action: 'text_template_save', name: 'T', body: 'x' }, other), deps)).statusCode, 403);
  assert.equal((await call(post({ action: 'text_template_delete', id }, other), deps)).statusCode, 403);
  assert.equal(JSON.stringify(db.rows), before);
});

// ---- 사진(2026-11-12) ----
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]).toString('base64');
const getOne = id => ({ method: 'GET', query: { resource: 'text_template', id: String(id) }, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' }, headers: SAME });

test('문구+사진 저장 → 목록은 has_image 만 → 단건 조회에 사진', async () => {
  const { deps } = setup();
  const saved = await call(post({ action: 'text_template_save', name: '사진안내', body: '사진 문구', image: { data: JPG } }), deps);
  assert.equal(saved.statusCode, 201);
  assert.equal(saved.body.item.has_image, true);
  assert.equal(saved.body.item.image, undefined);
  const id = saved.body.item.id;
  const list = await call(get(), deps);
  assert.deepEqual(list.body.items, [{ id, name: '사진안내', body: '사진 문구', has_image: true }]);
  assert.ok(!JSON.stringify(list.body).includes(JPG));
  const one = await call(getOne(id), deps);
  assert.equal(one.statusCode, 200);
  assert.equal(one.body.item.image, JPG);
  assert.equal((await call(getOne(999), deps)).statusCode, 404);
  assert.equal((await call(getOne('abc'), deps)).statusCode, 400);
});

test('사진 형식·용량 초과 거절, DB 변화 0', async () => {
  const { db, deps } = setup();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]).toString('base64');
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(201 * 1024, 1)]).toString('base64');
  for (const image of [{ data: png }, { data: big }, { data: '!!!' }]) {
    const out = await call(post({ action: 'text_template_save', name: 'X', body: 'x', image }), deps);
    assert.equal(out.statusCode, 400);
  }
  assert.equal(db.rows.length, 0);
});

test('사진 없는 기존 문구는 그대로, 수정 때 image 를 안 보내면 사진 유지·null 이면 지움', async () => {
  const { db, deps } = setup();
  const plain = await call(post({ action: 'text_template_save', name: '글만', body: '글' }), deps);
  assert.equal(plain.body.item.has_image, undefined);
  assert.equal(db.rows[0].image, undefined);
  const withPhoto = await call(post({ action: 'text_template_save', name: '사진', body: '글', image: JPG }), deps);
  const id = withPhoto.body.item.id;
  await call(post({ action: 'text_template_save', id, name: '사진', body: '글 수정' }), deps);
  assert.equal(db.rows.find(r => r.id === id).image, JPG);
  await call(post({ action: 'text_template_save', id, name: '사진', body: '글 수정', image: null }), deps);
  assert.equal(db.rows.find(r => r.id === id).image, undefined);
});
