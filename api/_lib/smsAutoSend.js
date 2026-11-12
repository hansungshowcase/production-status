// 출고 완료 후 N일 뒤 자동 문자(2026-11-13 설계). 문자 관리 쪽 새 표(sms_auto_sends·sms_optouts)만 쓴다.
// orders 는 SELECT 만 한다(orders·processes·notification_log 에 쓰지 않는다). 번호 전체·이름은 DB·응답·로그에 남기지 않는다(끝 4자리와 해시만).
// 자동 재시도는 없다: 불확실하거나 일부만 실패하면 'uncertain' 으로 두고 다시 보내지 않는다.
import crypto from 'node:crypto';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import { classifyText, getSendProvider } from './sendProvider.js';
import { ensureManualSendSchema, sendSettings } from './smsManualSend.js';
import { AUTO_KIND, ensureTextTemplateSchema, storedImages } from './smsTextTemplates.js';

const DAY_MS = 86400000;
const HASH_SALT = 'hansung-sms-auto-v1';
const TARGET_RE = /^010\d{7,8}$/;
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const OPTOUT_LINE_RE = /무료\s*수신\s*거부[^\n]*080[-\d]{7,}/;
const KEY_RE = /^[\w-]{8,80}$/;
const CATCH_UP_DAYS = 3;
const DEFAULT_MAX_PER_DAY = 30;
const SEND_WINDOW = { from: 8, to: 21 }; // KST 08시 이상 21시 미만
const TIME_BUDGET_MS = 20000;
const TARGET_LIMIT = 1000;

const flags = new Map();
export function _resetAutoSchemaForTest() { flags.clear(); }

export async function ensureAutoSchema(db) {
  if (flags.get('sms.auto')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_auto_sends (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT NOT NULL,
      phone_hash TEXT NOT NULL,
      phone_last4 TEXT,
      order_id BIGINT,
      ship_date TEXT,
      kst_date TEXT NOT NULL,
      status TEXT NOT NULL,
      part_status TEXT,
      reason TEXT,
      group_ids TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (template_id, phone_hash),
      UNIQUE (template_id, order_id)
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_optouts (
      id BIGSERIAL PRIMARY KEY,
      phone_hash TEXT NOT NULL UNIQUE,
      phone_last4 TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  flags.set('sms.auto', true);
}

const reply = (status, body) => ({ status, body });
const errorReply = (status, message, extra = {}) => reply(status, { error: { message, status }, ...extra });
const digits = value => String(value ?? '').replace(/\D/g, '');
const intEnv = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };

export const phoneHash = phone => crypto.createHash('sha256').update(`${HASH_SALT}:${digits(phone)}`).digest('hex');
export const kstDate = nowMs => new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
export const kstHour = nowMs => new Date(nowMs + 9 * 3600000).getUTCHours();
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const inSendWindow = nowMs => { const h = kstHour(nowMs); return h >= SEND_WINDOW.from && h < SEND_WINDOW.to; };

export function autoSettings(env = process.env) {
  return { on: env.SMS_AUTO !== 'off', maxPerDay: intEnv(env.SMS_AUTO_MAX_PER_DAY, DEFAULT_MAX_PER_DAY) };
}

// 광고 형식: '' | 'no_ad_prefix' | 'no_optout_080'
export function adCheck(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text.startsWith('(광고)')) return 'no_ad_prefix';
  if (!OPTOUT_LINE_RE.test(text)) return 'no_optout_080';
  return '';
}
const optoutLineOf = body => String(body ?? '').split('\n').map(line => line.trim()).find(line => OPTOUT_LINE_RE.test(line)) || '';

const cleanName = value => {
  const name = String(value ?? '').replace(/#\{|\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || '고객';
};
const fillName = (body, name) => String(body).replace(/#\{고객명\}/g, cleanName(name));

// 통 구성: 사진 N장이면 N통(MMS 1통에 사진 1장). 1통째 = 본문 + 사진1, 2통째부터 = 사진 + 짧은 글. 사진이 없으면 본문만 1통.
export function buildParts(template, imageCount) {
  const n = Math.max(1, imageCount);
  const parts = [{ index: 0, image: imageCount > 0 ? 0 : -1, short: false }];
  for (let i = 1; i < n; i += 1) parts.push({ index: i, image: i, short: true });
  const total = parts.length;
  const tail = optoutLineOf(template.body);
  const shortText = i => `(광고) 한성쇼케이스 ${template.name} ${i + 1}/${total}${tail ? `\n${tail}` : ''}`;
  return parts.map(part => ({ ...part, text: part.short ? shortText(part.index) : null }));
}
const partText = (part, template, name) => (part.short ? part.text : fillName(String(template.body).trim(), name));

async function loadTemplate(db, id) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({
    sql: 'SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date FROM sms_text_templates WHERE id = ?',
    args: [id],
  });
  const row = out.rows?.[0];
  if (!row) return null;
  return { id: Number(row.id), name: row.name, body: row.body, images: storedImages(row), auto_kind: row.auto_kind || '', auto_days: Number(row.auto_days) || 0, auto_enabled: row.auto_enabled === true, auto_start_date: row.auto_start_date || '' };
}

// 대상 조회: orders 읽기 전용 SELECT 1개. 출고(status shipped)한 지 days 일이 된 날부터 3일 전 출고분까지, 시작일 이후 출고분만.
export async function findTargets(db, { nowMs, days, startDate }) {
  const today = kstDate(nowMs);
  const upper = addDays(today, -days);
  let lower = addDays(upper, -CATCH_UP_DAYS);
  if (startDate && startDate > lower) lower = startDate;
  if (lower > upper) return [];
  const out = await db.execute({
    sql: `SELECT id, phone, client_name, LEFT(ship_date, 10) AS ship_day FROM orders
          WHERE status = 'shipped' AND ship_date IS NOT NULL AND LEFT(ship_date, 10) >= ? AND LEFT(ship_date, 10) <= ?
          ORDER BY ship_date ASC, id ASC LIMIT ${TARGET_LIMIT}`,
    args: [lower, upper],
  });
  const seen = new Set();
  const targets = [];
  for (const row of out.rows || []) {
    const phone = digits(row.phone);
    if (!TARGET_RE.test(phone) || seen.has(phone)) continue;
    seen.add(phone);
    targets.push({ orderId: Number(row.id), phone, name: row.client_name, shipDate: row.ship_day });
  }
  return targets;
}

// 수신거부·이미 보낸(선점한) 번호·주문을 뺀 오늘 대상
async function eligibleTargets(db, template, { nowMs, startDate }) {
  const raw = await findTargets(db, { nowMs, days: template.auto_days, startDate });
  if (!raw.length) return [];
  const optouts = new Set(((await db.execute({ sql: 'SELECT phone_hash FROM sms_optouts', args: [] })).rows || []).map(row => row.phone_hash));
  const claimed = (await db.execute({ sql: 'SELECT phone_hash, order_id FROM sms_auto_sends WHERE template_id = ?', args: [template.id] })).rows || [];
  const claimedHash = new Set(claimed.map(row => row.phone_hash));
  const claimedOrder = new Set(claimed.map(row => Number(row.order_id)));
  return raw.filter(t => {
    const hash = phoneHash(t.phone);
    t.hash = hash;
    return !optouts.has(hash) && !claimedHash.has(hash) && !claimedOrder.has(t.orderId);
  });
}

const placeholders = list => list.map(() => '?').join(', ');

// ---- 자동 발송 1개 문구 실행(설계 3절 ①~⑧ 순서 그대로) ----
export async function runAutoSend(template, { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, tick = Date.now } = {}) {
  const startedAt = tick();
  const out = { template_id: template.id, ran: false, reason: '', targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0 };
  const settings = autoSettings(env);
  if (!template.auto_enabled || !settings.on) return { ...out, reason: 'off' }; // ①
  if (!inSendWindow(nowMs)) return { ...out, reason: 'night' }; // ② 선점도 하지 않는다
  const blocked = adCheck(template.body); // ③
  if (blocked) return { ...out, reason: blocked };
  if (template.auto_kind !== AUTO_KIND || !(template.auto_days >= 1)) return { ...out, reason: 'no_auto' };

  const vendor = provider || getSendProvider();
  const from = digits(env.SMS_SENDER);
  if (!vendor || typeof vendor.sendEach !== 'function' || !from) return { ...out, reason: 'no_provider' };
  if (!provider && !hasSolapiCredentials()) return { ...out, reason: 'no_provider' };

  await ensureAutoSchema(db);
  const today = kstDate(nowMs);
  const eligible = await eligibleTargets(db, template, { nowMs, startDate: template.auto_start_date }); // ④
  out.targets = eligible.length;
  if (!eligible.length) return { ...out, ran: true };

  const usedToday = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ?', args: [today] })).rows?.[0]?.n) || 0; // ⑤
  const room = Math.max(0, settings.maxPerDay - usedToday);
  const picked = eligible.slice(0, room);
  if (!picked.length) return { ...out, ran: true, reason: 'cap' };

  const parts = buildParts(template, template.images.length);
  const fileIds = []; // ⑥ 사진 올리기: 장당 1번(받는 사람 수와 무관), 하나라도 실패하면 선점 없이 끝
  for (const base64 of template.images) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) return { ...out, ran: true, reason: 'upload_failed' };
    fileIds.push(fileId);
  }

  // ⑦ 선점: 여러 행 INSERT 1번. 돌아온 행만 보낸다.
  const values = picked.map(() => "(?, ?, ?, ?, ?, ?, 'claimed')").join(', ');
  const claimArgs = picked.flatMap(t => [template.id, t.hash, t.phone.slice(-4), t.orderId, t.shipDate, today]);
  const claimedRows = (await db.execute({
    sql: `INSERT INTO sms_auto_sends (template_id, phone_hash, phone_last4, order_id, ship_date, kst_date, status) VALUES ${values} ON CONFLICT DO NOTHING RETURNING id, phone_hash`,
    args: claimArgs,
  })).rows || [];
  const byHash = new Map(picked.map(t => [t.hash, t]));
  let active = claimedRows.map(row => ({ id: Number(row.id), target: byHash.get(row.phone_hash) })).filter(item => item.target);
  // 크론이 겹쳐 돌았을 때: 선점 뒤 오늘 합계가 상한을 넘으면 넘은 행은 지우고 보내지 않는다.
  const after = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ?', args: [today] })).rows?.[0]?.n) || 0;
  if (after > settings.maxPerDay) {
    const over = Math.min(active.length, after - settings.maxPerDay);
    const drop = active.slice(active.length - over);
    if (drop.length) {
      await db.execute({ sql: `DELETE FROM sms_auto_sends WHERE status = 'claimed' AND id IN (${placeholders(drop)})`, args: drop.map(item => item.id) });
      active = active.slice(0, active.length - over);
    }
  }
  out.claimed = active.length;
  out.ran = true;
  if (!active.length) return out;

  // ⑧ 통별 발송. 어느 통이든 깨끗한 성공이 아니면 그 뒤 통은 보내지 않는다(모두 같은 결과를 갖는다).
  const partStatus = [];
  const groupIds = [];
  let reason = '';
  let stop = false;
  for (const part of parts) {
    if (stop) { partStatus.push('skipped'); continue; }
    if (tick() - startedAt >= TIME_BUDGET_MS) { partStatus.push('skipped'); stop = true; reason = '시간 초과'; continue; }
    const messages = active.map(item => {
      const message = { to: item.target.phone, text: partText(part, template, item.target.name) };
      if (part.image >= 0) message.fileId = fileIds[part.image];
      return message;
    });
    let result;
    try { result = await vendor.sendEach({ from, messages }, { fetchImpl }); } catch { result = { accepted: 0, failed: 0, uncertain: true, error: '보냈는지 확인하지 못했습니다.' }; }
    if (result.groupId) groupIds.push(result.groupId);
    if (result.uncertain) { partStatus.push('uncertain'); stop = true; reason = String(result.error || '불확실').slice(0, 200); }
    else if (result.failed === 0) partStatus.push('sent');
    else if (result.accepted === 0) { partStatus.push('failed'); stop = true; reason = String(result.error || '거절').slice(0, 200); }
    else { partStatus.push('uncertain'); stop = true; reason = '일부만 실패'; }
  }
  const status = partStatus.every(s => s === 'sent') ? 'sent' : partStatus[0] === 'failed' ? 'failed' : 'uncertain';
  try {
    await db.execute({
      sql: `UPDATE sms_auto_sends SET status = ?, part_status = ?, reason = ?, group_ids = ? WHERE id IN (${placeholders(active)})`,
      args: [status, JSON.stringify(partStatus), reason || null, JSON.stringify(groupIds), ...active.map(item => item.id)],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과를 막지 않는다. 행은 claimed 로 남아 다음 실행이 uncertain 으로 바꾼다. */ }
  out[status] = active.length;
  return out;
}

// 하루 지난 claimed(실행이 끊긴 것)는 uncertain 으로 바꾼다. 다시 보내지 않는다.
export async function sweepStaleClaims(db, nowMs) {
  await ensureAutoSchema(db);
  await db.execute({ sql: "UPDATE sms_auto_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
}

// 크론: 켜진 자동 문구를 모두 실행. 결과는 건수만.
export async function runAutoSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  await ensureTextTemplateSchema(db);
  await sweepStaleClaims(db, nowMs);
  const list = await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind = 'ship_plus_days' ORDER BY id ASC", args: [] });
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  for (const row of list.rows || []) {
    const template = await loadTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runAutoSend(template, deps);
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// ---- 화면 자료 ----
export async function autoStatus(db, { id, nowMs = Date.now(), env = process.env } = {}) {
  const templateId = Number(id);
  if (!(Number.isInteger(templateId) && templateId > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  await ensureAutoSchema(db);
  const template = await loadTemplate(db, templateId);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  const today = kstDate(nowMs);
  const sums = (await db.execute({ sql: 'SELECT status, COUNT(*) AS n, MAX(kst_date) AS last FROM sms_auto_sends WHERE template_id = ? GROUP BY status', args: [templateId] })).rows || [];
  const count = status => Number(sums.find(row => row.status === status)?.n) || 0;
  const sent7 = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE template_id = ? AND status = 'sent' AND kst_date >= ?", args: [templateId, addDays(today, -6)] })).rows?.[0]?.n) || 0;
  let todayTargets = 0;
  if (template.auto_kind === AUTO_KIND && template.auto_days >= 1) {
    const startDate = template.auto_start_date || addDays(today, -template.auto_days);
    todayTargets = (await eligibleTargets(db, template, { nowMs, startDate })).length;
  }
  const reason = template.auto_kind !== AUTO_KIND ? 'no_auto' : adCheck(template.body);
  return reply(200, {
    enabled: template.auto_enabled && autoSettings(env).on, days: template.auto_days, start_date: template.auto_start_date || '',
    today_targets: todayTargets, sent_7d: sent7, sent_total: count('sent'), failed_total: count('failed'), uncertain_total: count('uncertain') + count('claimed'),
    last_sent_date: sums.find(row => row.status === 'sent')?.last || '', enable_blocked_reason: reason,
  });
}

function costOf(vendor, parts, people, env) {
  let total = 0;
  for (const part of parts) {
    const type = part.image >= 0 ? 'MMS' : 'LMS';
    total += Number(vendor.estimate({ type, count: people }, env)?.total) || 0;
  }
  return total;
}

// action auto_toggle { id, enabled, dry_run }
export async function autoToggle(body, { db, provider, env = process.env, nowMs = Date.now() } = {}) {
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  if (typeof body.enabled !== 'boolean') return errorReply(400, '올바른 요청이 아닙니다.');
  await ensureAutoSchema(db);
  const template = await loadTemplate(db, id);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  if (!body.enabled) {
    if (body.dry_run === true) return reply(200, { ok: true, enabled: false });
    await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = false WHERE id = ? RETURNING id', args: [id] });
    return reply(200, { ok: true, enabled: false, start_date: template.auto_start_date || '' });
  }
  if (template.auto_kind !== AUTO_KIND || !(template.auto_days >= 1)) return errorReply(400, '자동 발송이 설정된 문구가 아닙니다.', { reason: 'no_auto' });
  const blocked = adCheck(template.body);
  if (blocked) return errorReply(400, blocked === 'no_ad_prefix' ? '본문이 (광고) 로 시작해야 켤 수 있습니다.' : '본문에 080 무료수신거부 번호가 있어야 켤 수 있습니다.', { reason: blocked });
  if (!autoSettings(env).on) return errorReply(503, '자동 발송이 꺼져 있습니다.');
  const startDate = addDays(kstDate(nowMs), -template.auto_days);
  if (body.dry_run === true) {
    const vendor = provider || getSendProvider();
    const parts = buildParts(template, template.images.length);
    const targets = (await eligibleTargets(db, template, { nowMs, startDate })).length;
    const people = Math.min(targets, autoSettings(env).maxPerDay);
    return reply(200, { ok: true, targets, parts: parts.length, cost: vendor ? costOf(vendor, parts, people, env) : null, daily_max: autoSettings(env).maxPerDay });
  }
  await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ? WHERE id = ? RETURNING id', args: [startDate, id] });
  return reply(200, { ok: true, enabled: true, start_date: startDate });
}

// action auto_test { id, to, dry_run, idempotencyKey }: 번호 1개 전용. 자동 발송과 같은 통 구성, #{고객명} 은 '고객'.
// sms_auto_sends 에는 적지 않고 sms_manual_sends 에 건수를 남긴다(그 표의 하루 상한에 잡힌다).
export async function autoTest(body, { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, writeEnabled = true } = {}) {
  const settings = sendSettings(env, writeEnabled);
  if (!settings.enabled) return errorReply(403, '발송이 꺼져 있습니다.');
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  const to = digits(body?.to);
  if (typeof body?.to !== 'string' || !MOBILE_RE.test(to)) return errorReply(400, '받는 번호가 휴대폰 번호 형식이 아닙니다.');
  const dryRun = body.dry_run === true;
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!dryRun && !KEY_RE.test(key)) return errorReply(400, '올바른 요청이 아닙니다.');
  // 시험 발송은 사장님이 직접 넣은 번호 1개로만 가므로 시간 제한을 두지 않는다(고객 자동 발송의 야간 금지는 runAutoSend 에 그대로).
  const template = await loadTemplate(db, id);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  const vendor = provider || getSendProvider();
  if (!vendor || typeof vendor.sendEach !== 'function') return errorReply(503, '발송 업체가 설정되지 않았습니다.');
  const parts = buildParts(template, template.images.length);
  const cost = costOf(vendor, parts, 1, env);
  if (dryRun) return reply(200, { ok: true, dry_run: true, parts: parts.length, cost });
  const from = digits(env.SMS_SENDER);
  if (!from) return errorReply(503, '발신번호가 설정되지 않았습니다.');
  if (!provider && !hasSolapiCredentials()) return errorReply(503, '쏠라피 연결이 설정되지 않았습니다.');

  await ensureManualSendSchema(db);
  const dayStart = new Date(Date.parse(`${kstDate(nowMs)}T00:00:00Z`) - 9 * 3600000).toISOString();
  const used = Number((await db.execute({ sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?', args: [dayStart] })).rows?.[0]?.n) || 0;
  if (used + parts.length > settings.daily) return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${used}건 보냈습니다.`);
  const msgType = template.images.length ? 'MMS' : classifyText(template.body).type || 'LMS';
  const hash = crypto.createHmac('sha256', String(env.SOLAPI_API_SECRET || 'sms-manual-send')).update(to).digest('hex');
  const inserted = await db.execute({
    sql: `INSERT INTO sms_manual_sends (idem_key, msg_type, recipient_count, text_length, tails, recipients_hash, status)
          VALUES (?, ?, ?, ?, ?, ?, 'sending') ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    args: [key, msgType, parts.length, [...String(template.body)].length, to.slice(-4), hash],
  });
  if (!inserted.rows?.length) {
    const row = (await db.execute({ sql: 'SELECT status, recipient_count FROM sms_manual_sends WHERE idem_key = ?', args: [key] })).rows?.[0] || {};
    return reply(200, { ok: true, duplicate: true, status: row.status || 'sending', parts: Number(row.recipient_count) || parts.length });
  }
  const fileIds = [];
  for (const base64 of template.images) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) {
      try { await db.execute({ sql: 'DELETE FROM sms_manual_sends WHERE idem_key = ?', args: [key] }); } catch { /* 정리 실패는 무시 */ }
      return errorReply(502, '사진을 올리지 못했습니다. 다시 시도해 주세요.');
    }
    fileIds.push(fileId);
  }
  const results = [];
  let stop = false;
  let groupId = null;
  let message = '';
  for (const part of parts) {
    if (stop) { results.push('skipped'); continue; }
    const item = { to, text: partText(part, template, '고객') };
    if (part.image >= 0) item.fileId = fileIds[part.image];
    let result;
    try { result = await vendor.sendEach({ from, messages: [item] }, { fetchImpl }); } catch { result = { accepted: 0, failed: 0, uncertain: true, error: '보냈는지 확인하지 못했습니다.' }; }
    if (result.groupId) groupId = result.groupId;
    if (result.uncertain) { results.push('uncertain'); stop = true; message = String(result.error || '').slice(0, 200); }
    else if (result.failed === 0) results.push('sent');
    else { results.push('failed'); stop = true; message = String(result.error || '').slice(0, 200); }
  }
  const okCount = results.filter(r => r === 'sent').length;
  const status = results.every(r => r === 'sent') ? 'sent' : results.includes('uncertain') ? 'uncertain' : okCount ? 'partial' : 'failed';
  try {
    await db.execute({
      sql: 'UPDATE sms_manual_sends SET status = ?, success_count = ?, fail_count = ?, group_id = ?, error = ? WHERE idem_key = ?',
      args: [status, okCount, results.filter(r => r === 'failed').length, groupId, message || null, key],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과 응답을 막지 않게 한다 */ }
  const out = { ok: true, sent: okCount > 0, status, parts: parts.length, part_status: results, cost };
  if (message) out.message = message;
  return reply(200, out);
}

// ---- 수신거부 번호 ----
export async function optoutAdd(body, { db } = {}) {
  const phone = digits(body?.phone);
  if (typeof body?.phone !== 'string' || !MOBILE_RE.test(phone)) return errorReply(400, '휴대폰 번호 형식이 아닙니다.');
  await ensureAutoSchema(db);
  const hash = phoneHash(phone);
  const inserted = await db.execute({ sql: 'INSERT INTO sms_optouts (phone_hash, phone_last4) VALUES (?, ?) ON CONFLICT (phone_hash) DO NOTHING RETURNING id', args: [hash, phone.slice(-4)] });
  const row = inserted.rows?.[0] || (await db.execute({ sql: 'SELECT id FROM sms_optouts WHERE phone_hash = ?', args: [hash] })).rows?.[0];
  return reply(inserted.rows?.length ? 201 : 200, { ok: true, item: { id: Number(row?.id), last4: phone.slice(-4) }, duplicate: !inserted.rows?.length });
}

export async function optoutDelete(body, { db } = {}) {
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 번호가 아닙니다.');
  await ensureAutoSchema(db);
  const out = await db.execute({ sql: 'DELETE FROM sms_optouts WHERE id = ? RETURNING id', args: [id] });
  if (!out.rows?.[0]) return errorReply(404, '번호를 찾을 수 없습니다.');
  return reply(200, { ok: true, deleted: true, id });
}

export async function optoutList(db) {
  await ensureAutoSchema(db);
  const out = await db.execute({ sql: 'SELECT id, phone_last4, created_at FROM sms_optouts ORDER BY id DESC LIMIT 500', args: [] });
  const items = (out.rows || []).map(row => ({ id: Number(row.id), last4: String(row.phone_last4 || ''), created_at: row.created_at ? new Date(row.created_at).toISOString() : null }));
  return reply(200, { items, count: items.length });
}
