// 자사몰(카페24) 회원가입 연결(2026-11-13 설계 18절). 환경 변수가 없으면 모든 함수가 무동작이다.
// 번호는 가입 문자를 보내기 전까지만 암호화해 두고(선점 직후·24시간 뒤 지움), 해시·끝 4자리만 남긴다. 토큰·번호·본문은 로그에 남기지 않는다.
import crypto from 'node:crypto';
import { decryptPrivateConfigRow, encryptPrivateConfigValue } from './privateConfig.js';
import { insertLead } from './smsLeads.js';

const HASH_SALT = 'hansung-sms-event-v1'; // smsEventSend.js 의 번호 해시와 같은 식(같은 번호 = 같은 해시)
export const MOBILE_RE = /^01[016789]\d{7,8}$/;
export const PHONE_KEY = 'cafe24.phone';
const ACCESS_KEY = 'cafe24.access';
const REFRESH_KEY = 'cafe24.refresh';
const PHONE_KEEP_MS = 24 * 3600000;
const POLL_EVERY_MS = 60 * 60000;
const REFRESH_LEAD_MS = 5 * 24 * 3600000; // 리프레시 토큰 만료 5일 전부터 갱신
const ACCESS_TTL_MS = 110 * 60000; // 문서상 2시간 — 여유를 두고 110분으로 본다(응답의 만료 시각 표기는 시간대가 불분명해 쓰지 않는다)
const REFRESH_TTL_MS = 13 * 24 * 3600000; // 문서상 14일 — 13일로 본다
const STATE_TTL_MS = 10 * 60000;
export const WEBHOOK_EVENT_JOIN = 90032;

const flags = new Map();
export function _resetCafe24SchemaForTest() { flags.clear(); }

export const digits = value => String(value ?? '').replace(/\D/g, '');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
export const phoneHash = phone => sha(`${HASH_SALT}:${digits(phone)}`);
const memberHash = memberId => sha(`cafe24-member-v1:${String(memberId).trim()}`);
const iso = ms => new Date(ms).toISOString();
export const timingSafeMatch = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// 환경 변수 읽기: 카페24 연결(콜백·토큰)에 필요한 3개가 모두 있어야 값, 없으면 null
export function cafe24Env(env = process.env) {
  const clientId = String(env.CAFE24_CLIENT_ID || '').trim(); const clientSecret = String(env.CAFE24_CLIENT_SECRET || '').trim(); const mallId = String(env.CAFE24_MALL_ID || '').trim();
  return clientId && clientSecret && mallId ? { clientId, clientSecret, mallId, webhookKey: String(env.CAFE24_WEBHOOK_KEY || '').trim() } : null;
}
export const baseUrl = (env = process.env) => String(env.BASE_URL || 'https://production-status.vercel.app').replace(/\/+$/, '');

export async function ensureCafe24Schema(db) {
  if (flags.get('cafe24')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS cafe24_signups (
      id BIGSERIAL PRIMARY KEY,
      member_hash TEXT NOT NULL UNIQUE,
      joined_at TIMESTAMPTZ NOT NULL,
      phone_hash TEXT NOT NULL,
      phone_last4 TEXT,
      phone_enc TEXT,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS cafe24_tokens (
      id INT PRIMARY KEY,
      access_enc TEXT,
      refresh_enc TEXT,
      access_expires_at TIMESTAMPTZ,
      refresh_expires_at TIMESTAMPTZ,
      refreshing_until TIMESTAMPTZ,
      last_poll_at TIMESTAMPTZ
    )`,
    args: [],
  });
  flags.set('cafe24', true);
}

// ---- 암호화(privateConfig.js 의 AES-256-GCM 도우미를 그대로 쓴다. 키는 DB 비밀번호에서 파생 — 새 환경 변수 없음) ----
export function sealValue(key, value) {
  const sealed = encryptPrivateConfigValue(key, String(value));
  return JSON.stringify({ c: sealed.ciphertext, i: sealed.iv, t: sealed.authTag, v: sealed.keyVersion });
}
export function openValue(key, text) {
  const parsed = JSON.parse(String(text));
  return decryptPrivateConfigRow({ key, key_version: parsed.v, iv: parsed.i, auth_tag: parsed.t, ciphertext: parsed.c });
}

// ---- 토큰 ----
export async function cafe24Connected(db, env = process.env) {
  if (!cafe24Env(env)) return false;
  try {
    await ensureCafe24Schema(db);
    return Boolean((await db.execute({ sql: 'SELECT id FROM cafe24_tokens WHERE id = 1 AND refresh_expires_at IS NOT NULL', args: [] })).rows?.[0]);
  } catch { return false; }
}

async function saveTokens(db, data, nowMs) {
  const access = String(data?.access_token || ''); const refresh = String(data?.refresh_token || '');
  if (!access || !refresh) throw new Error('cafe24 token 응답 형식');
  await db.execute({
    sql: `INSERT INTO cafe24_tokens (id, access_enc, refresh_enc, access_expires_at, refresh_expires_at, refreshing_until) VALUES (1, ?, ?, ?, ?, NULL)
      ON CONFLICT (id) DO UPDATE SET access_enc = EXCLUDED.access_enc, refresh_enc = EXCLUDED.refresh_enc, access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, refreshing_until = NULL`,
    args: [sealValue(ACCESS_KEY, access), sealValue(REFRESH_KEY, refresh), iso(nowMs + ACCESS_TTL_MS), iso(nowMs + REFRESH_TTL_MS)],
  });
}

async function tokenRequest(config, fetchImpl, params) {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetchImpl(`https://${config.mallId}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw Object.assign(new Error(`cafe24 token http ${response.status}`), { status: response.status });
  return response.json();
}

// 콜백: code → 토큰 교환 → 암호화 저장
export async function exchangeCode(db, { env = process.env, code, fetchImpl = fetch, nowMs = Date.now() }) {
  const config = cafe24Env(env);
  if (!config) throw new Error('cafe24 env');
  await ensureCafe24Schema(db);
  const data = await tokenRequest(config, fetchImpl, { grant_type: 'authorization_code', code, redirect_uri: `${baseUrl(env)}/api/cafe24/callback` });
  if (data?.mall_id && String(data.mall_id) !== config.mallId) throw new Error('cafe24 mall');
  await saveTokens(db, data, nowMs);
}

// 토큰을 못 쓰게 됐을 때(리프레시 400·401, 복호화 실패) 만료 일자를 지워 "이미 연결됨" 판정이 거짓이 되게 한다(콜백으로 재연결)
const invalidateLink = db => db.execute({ sql: 'UPDATE cafe24_tokens SET refresh_expires_at = NULL, refreshing_until = NULL WHERE id = 1', args: [] });
async function openOrInvalidate(db, key, text) {
  try { return openValue(key, text); } catch (error) { await invalidateLink(db); throw error; }
}
async function refreshNow(db, config, fetchImpl, nowMs, row) {
  const refreshToken = await openOrInvalidate(db, REFRESH_KEY, row.refresh_enc);
  let data;
  try { data = await tokenRequest(config, fetchImpl, { grant_type: 'refresh_token', refresh_token: refreshToken }); } catch (error) {
    if (error?.status === 400 || error?.status === 401) await invalidateLink(db);
    throw error;
  }
  await saveTokens(db, data, nowMs);
  return String(data.access_token);
}
// 선점 UPDATE 로 동시 갱신을 막는다(못 잡으면 null — 다음 실행에서 다시)
async function claimRefresh(db, nowMs) {
  const out = await db.execute({
    sql: 'UPDATE cafe24_tokens SET refreshing_until = ? WHERE id = 1 AND (refreshing_until IS NULL OR refreshing_until < ?) RETURNING id',
    args: [iso(nowMs + 30000), iso(nowMs)],
  });
  return Boolean(out.rows?.[0]);
}
// 선점 성공 뒤 행을 다시 읽는다(선점 전에 읽은 행은 그 사이 다른 실행이 갱신해 옛 리프레시 토큰일 수 있다)
const readTokenRow = async db => (await db.execute({ sql: 'SELECT access_enc, refresh_enc, access_expires_at, refresh_expires_at FROM cafe24_tokens WHERE id = 1', args: [] })).rows?.[0];
const releaseClaim = db => db.execute({ sql: 'UPDATE cafe24_tokens SET refreshing_until = NULL WHERE id = 1', args: [] });
// 연결돼 있고 리프레시 토큰 만료가 5일보다 많이 남았는지(콜백이 반복 요청을 막는 데 쓴다)
export async function cafe24LinkFresh(db, nowMs = Date.now()) {
  try {
    await ensureCafe24Schema(db);
    const row = await readTokenRow(db);
    return Boolean(row && row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() > nowMs + REFRESH_LEAD_MS);
  } catch { return false; }
}
// 호출 직전 액세스 토큰(만료일 때만 갱신). 없거나 못 얻으면 null.
export async function getAccessToken(db, { env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const config = cafe24Env(env);
  if (!config) return null;
  await ensureCafe24Schema(db);
  const row = (await db.execute({ sql: 'SELECT access_enc, refresh_enc, access_expires_at FROM cafe24_tokens WHERE id = 1', args: [] })).rows?.[0];
  if (!row) return null;
  if (row.access_expires_at && new Date(row.access_expires_at).getTime() > nowMs + 60000) return openOrInvalidate(db, ACCESS_KEY, row.access_enc);
  if (!(await claimRefresh(db, nowMs))) return null;
  const fresh = await readTokenRow(db);
  if (!fresh) return null;
  if (fresh.access_expires_at && new Date(fresh.access_expires_at).getTime() > nowMs + 60000) { await releaseClaim(db); return openOrInvalidate(db, ACCESS_KEY, fresh.access_enc); }
  return refreshNow(db, config, fetchImpl, nowMs, fresh);
}
// 매일 크론: 리프레시 토큰 만료 5일 이내면 갱신 1번
export async function refreshIfNearExpiry(db, { env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const config = cafe24Env(env);
  if (!config) return false;
  await ensureCafe24Schema(db);
  const row = (await db.execute({ sql: 'SELECT access_enc, refresh_enc, refresh_expires_at FROM cafe24_tokens WHERE id = 1', args: [] })).rows?.[0];
  if (!row || !row.refresh_expires_at || new Date(row.refresh_expires_at).getTime() > nowMs + REFRESH_LEAD_MS) return false;
  if (!(await claimRefresh(db, nowMs))) return false;
  const fresh = await readTokenRow(db);
  if (!fresh || !fresh.refresh_expires_at || new Date(fresh.refresh_expires_at).getTime() > nowMs + REFRESH_LEAD_MS) { await releaseClaim(db); return false; }
  await refreshNow(db, config, fetchImpl, nowMs, fresh);
  return true;
}

// ---- 콜백 state(서명된 짧은 수명) ----
const stateSignature = (config, payload) => crypto.createHmac('sha256', config.clientSecret).update(payload).digest('hex');
export function makeState(config, nowMs = Date.now()) {
  const payload = `${nowMs}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${stateSignature(config, payload)}`;
}
export const stateNonce = state => String(state || '').split('.')[1] || '';
export function checkState(config, state, nowMs = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`; const age = nowMs - Number(parts[0]);
  return timingSafeMatch(parts[2], stateSignature(config, payload)) && Number.isFinite(age) && age >= 0 && age <= STATE_TTL_MS;
}

// ---- 가입 기록 ----
// 시각: 가입 시각 칸을 읽되, 해석이 안 되거나 최근 48시간 밖이면 받은 시각을 쓴다(시간대 표기 불확실 대비). 시간대가 없는 문자열은 KST 로 본다.
export function readJoinedAt(raw, nowMs) {
  const text = String(raw || '').trim();
  if (text) {
    const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(' ', 'T')}+09:00`);
    if (Number.isFinite(ms) && ms >= nowMs - 48 * 3600000 && ms <= nowMs + 5 * 60000) return Math.min(ms, nowMs);
  }
  return nowMs;
}

// 켜진 가입 문구가 있는지(번호를 저장할지 정한다). 표·칸이 아직 없으면 없는 것으로 본다.
export async function hasEnabledJoinTemplate(db) {
  try {
    return Boolean((await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind = 'member_joined' LIMIT 1", args: [] })).rows?.[0]);
  } catch { return false; }
}

// 가입 1건 저장(같은 회원 아이디는 1행). 번호는 keepPhone 이고 암호화가 될 때만 저장한다. 반환: true=새 행
export async function insertSignup(db, { memberId, phone, name, joinedAtMs, source, keepPhone }) {
  const id = String(memberId || '').trim(); const number = digits(phone);
  if (!id || !MOBILE_RE.test(number)) return false;
  let enc = null;
  if (keepPhone) { try { enc = sealValue(PHONE_KEY, number); } catch { enc = null; } }
  const out = await db.execute({
    sql: 'INSERT INTO cafe24_signups (member_hash, joined_at, phone_hash, phone_last4, phone_enc, source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (member_hash) DO NOTHING RETURNING id',
    args: [memberHash(id), iso(joinedAtMs), phoneHash(number), number.slice(-4), enc, source],
  });
  const added = Boolean(out.rows?.[0]);
  if (added) { try { await insertLead(db, { source: 'cafe24', key: id, phone: number, name, joinedAtMs }); } catch { /* 접수 표 저장 실패는 조용히 */ } }
  return added;
}

// 발송 후보: 창 안의 가입 중 번호가 남아 있는 것(읽기만). 복호화 못 하는 행은 건너뛴다.
export async function signupCandidates(db, fromIso, toIso) {
  await ensureCafe24Schema(db);
  const rows = (await db.execute({
    sql: 'SELECT id, phone_hash, phone_last4, phone_enc FROM cafe24_signups WHERE joined_at >= ? AND joined_at <= ? AND phone_enc IS NOT NULL ORDER BY id ASC LIMIT 1000',
    args: [fromIso, toIso],
  })).rows || [];
  const list = [];
  for (const row of rows) {
    try { list.push({ id: Number(row.id), phone: digits(openValue(PHONE_KEY, row.phone_enc)), hash: row.phone_hash, last4: row.phone_last4 || '' }); } catch { /* 건너뜀 */ }
  }
  return list.filter(item => MOBILE_RE.test(item.phone));
}
// 선점 직후: 번호 지우기
export async function clearPhones(db, ids) {
  if (!ids.length) return;
  await db.execute({ sql: `UPDATE cafe24_signups SET phone_enc = NULL WHERE id IN (${ids.map(() => '?').join(', ')})`, args: ids });
}
// 24시간 지난 행의 번호 지우기
export async function purgeStalePhones(db, nowMs = Date.now()) {
  await ensureCafe24Schema(db);
  await db.execute({ sql: 'UPDATE cafe24_signups SET phone_enc = NULL WHERE phone_enc IS NOT NULL AND joined_at < ?', args: [iso(nowMs - PHONE_KEEP_MS)] });
}

// ---- 보충 조회(켜진 가입 문구가 있고 마지막 조회가 60분 넘었을 때만. 실패는 조용히) ----
const kstDay = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export async function pollSignups(db, { env = process.env, fetchImpl = fetch, nowMs = Date.now(), warn = console.warn } = {}) {
  const config = cafe24Env(env);
  if (!config) return 0;
  try {
    await ensureCafe24Schema(db);
    const claimed = await db.execute({ sql: 'UPDATE cafe24_tokens SET last_poll_at = ? WHERE id = 1 AND (last_poll_at IS NULL OR last_poll_at < ?) RETURNING id', args: [iso(nowMs), iso(nowMs - POLL_EVERY_MS)] });
    if (!claimed.rows?.[0]) return 0;
    const token = await getAccessToken(db, { env, fetchImpl, nowMs });
    if (!token) return 0;
    const url = `https://${config.mallId}.cafe24api.com/api/v2/admin/customersprivacy?date_type=join&start_date=${kstDay(nowMs - 86400000)}&end_date=${kstDay(nowMs)}&limit=100`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('cafe24 poll http');
    const list = (await response.json())?.customersprivacy;
    let added = 0; let skipped = 0;
    for (const item of Array.isArray(list) ? list : []) {
      try {
        if (await insertSignup(db, { memberId: item?.member_id, phone: item?.cellphone, name: item?.name, joinedAtMs: readJoinedAt(item?.created_date, nowMs), source: 'poll', keepPhone: true })) added += 1;
      } catch { skipped += 1; }
    }
    if (skipped) warn('[cafe24] 보충 조회에서 저장하지 못한 건수', skipped);
    return added;
  } catch {
    warn('[cafe24] 보충 조회 실패');
    return 0;
  }
}

// 매일 크론(10시)에서 한 번: 연결돼 있을 때만 번호 정리 + 리프레시 토큰 갱신. 실패는 조용히.
export async function maintainCafe24(db, { env = process.env, fetchImpl = fetch, nowMs = Date.now(), warn = console.warn } = {}) {
  if (!cafe24Env(env)) return;
  try { await purgeStalePhones(db, nowMs); } catch { warn('[cafe24] 번호 정리 실패'); }
  try { await refreshIfNearExpiry(db, { env, fetchImpl, nowMs }); } catch { warn('[cafe24] 토큰 갱신 실패'); }
}
