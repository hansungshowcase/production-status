// 내 문자 문구 저장소(보내기 화면에서 불러 쓰는 문구). 번호·이름은 다루지 않는다.
import { byteLength } from './sendProvider.js';
import { parseSendExtras, staffDirectory } from './smsManualSend.js';
import { STEPS } from './steps.js';

export const TEXT_TEMPLATE_LIMITS = Object.freeze({ name: 40, bodyBytes: 2000, count: 100, images: 3, autoDaysMax: 365 });
export const AUTO_KIND = 'ship_plus_days';
// 기준 사건: 출고 완료 후 / 주문 등록 후(2026-11-13 더함)
export const AUTO_KINDS = Object.freeze(['ship_plus_days', 'order_plus_days']);
export const isAutoKind = kind => AUTO_KINDS.includes(kind);
// 2단계-가(2026-11-13): 기준일형(납기일·출고예정일 기준) — 항상 안내(info) 문구
// 3단계-가(설계 17절): 'ship_or_due' = 출고예정일(없으면 납기일) 기준
export const EVENT_KINDS = Object.freeze(['due_date', 'ship_scheduled', 'ship_or_due']);
export const isEventKind = kind => EVENT_KINDS.includes(kind);
// 2단계-나(2026-11-13, 설계 15절): 즉시형(주문 등록 시·공정 시작 시·공정 완료 시) — 항상 안내(info) 문구
export const INSTANT_KINDS = Object.freeze(['order_created', 'process_started', 'process_completed']);
export const isInstantKind = kind => INSTANT_KINDS.includes(kind);
export const isInfoKind = kind => isEventKind(kind) || isInstantKind(kind);
export const isAnyAutoKind = kind => isAutoKind(kind) || isInfoKind(kind);
export const OFFSET_MAX = 365;
const STAFF_CAP = 30;
// 고객 대상 안내 문구 검사: 주문 변수가 하나 이상 있어야 하고 광고 낱말이 없어야 한다. '' 이면 통과.
const ORDER_VAR_RE = /#\{(주문번호|규격|수량|예상출고일|조회링크)\}/;
const AD_WORD_RE = /할인|이벤트|혜택|쿠폰|특가|소개|세일|무료|증정|사은품|\(광고\)/;
// 쓸 수 있는 변수(고객 / 직원). 이 밖의 #{…} 는 치환되지 않고 글자 그대로 나가므로 저장·켜기·실행에서 막는다.
const INFO_VARS = Object.freeze({ customer: ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크'], staff: ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크', '제품'] });
const hasUnknownVar = (text, audience) => [...text.matchAll(/#\{([^}]*)\}/g)].some(match => !INFO_VARS[audience].includes(match[1]));
export function infoCheck(body, audience = 'customer') {
  const text = String(body ?? '');
  const staffLike = audience === 'staff' || audience === 'sales'; // 영업담당 수신은 직원과 같은 검사
  if (hasUnknownVar(text, staffLike ? 'staff' : 'customer')) return 'info_unknown_var';
  if (staffLike) return '';
  if (AD_WORD_RE.test(text)) return 'info_has_ad_words';
  if (!ORDER_VAR_RE.test(text)) return 'info_needs_order_var';
  return '';
}
export const INFO_CHECK_MESSAGE = Object.freeze({
  info_has_ad_words: '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다.',
  info_needs_order_var: '안내 문구에는 주문 변수가 하나 이상 있어야 합니다.',
  info_unknown_var: '이 문구에서 쓸 수 없는 변수가 들어 있습니다.',
});
export const parseStaffIds = value => {
  try { const list = JSON.parse(String(value || '')); return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item) : []; } catch { return []; }
};
export const AUTO_LIMITS = Object.freeze({ repeatMax: 10, intervalMax: 365, defaultRepeat: 1, defaultInterval: 30 });
const flags = new Map();
export function _resetTextTemplateSchemaForTest() { flags.clear(); }

// 표 만들기: sms_manual_sends 와 같은 방식(요청 때 CREATE TABLE IF NOT EXISTS, 인스턴스당 1회)
export async function ensureTextTemplateSchema(db) {
  if (flags.get('sms.textTemplates')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_text_templates (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  // 사진 1장(base64 JPG). 목록 응답에는 싣지 않고 단건 조회에서만 준다.
  await db.execute({ sql: 'ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS image TEXT', args: [] });
  // 출고 후 자동 발송(2026-11-13): 사진 최대 3장(JSON 배열)과 자동 발송 조건·켜짐 상태. 기존 image 칸은 그대로 둔다.
  for (const column of ['images TEXT', 'auto_kind TEXT', 'auto_days INT', 'auto_enabled BOOLEAN NOT NULL DEFAULT false', 'auto_start_date TEXT', 'auto_send_from TEXT', 'auto_repeat INT NOT NULL DEFAULT 1', 'auto_interval INT NOT NULL DEFAULT 30',
    'auto_offset INT NOT NULL DEFAULT 0', 'auto_unless_step TEXT', "auto_audience TEXT NOT NULL DEFAULT 'customer'", 'auto_staff TEXT', "auto_msg_type TEXT NOT NULL DEFAULT 'ad'", 'auto_step TEXT', 'auto_enabled_at TIMESTAMPTZ',
    "auto_daily TEXT NOT NULL DEFAULT ''", 'auto_weekdays BOOLEAN NOT NULL DEFAULT false', "auto_unless_mode TEXT NOT NULL DEFAULT 'completed'"]) {
    await db.execute({ sql: `ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS ${column}`, args: [] });
  }
  flags.set('sms.textTemplates', true);
}

const ok = (body, status = 200) => ({ status, body });
const bad = (message, status = 400, extra = {}) => ({ status, body: { error: { message, status }, ...extra } });
const imageCountOf = row => Math.max(0, Number(row.image_count) || 0);
const toItem = row => ({
  id: Number(row.id), name: row.name, body: row.body, ...(row.has_image ? { has_image: true } : {}),
  ...(imageCountOf(row) > 0 ? { image_count: imageCountOf(row) } : {}),
  ...(row.auto_kind ? autoFields(row) : {}),
});
// 자동 발송 칸(응답용). send_from 은 있을 때만, repeat·interval 은 기본값으로 채운다.
function autoFields(row) {
  return {
    auto_kind: String(row.auto_kind), auto_days: Number(row.auto_days) || 0, auto_enabled: row.auto_enabled === true,
    ...(row.auto_send_from ? { auto_send_from: String(row.auto_send_from) } : {}),
    auto_repeat: Number(row.auto_repeat) || AUTO_LIMITS.defaultRepeat, auto_interval: Number(row.auto_interval) || AUTO_LIMITS.defaultInterval,
    auto_offset: Number(row.auto_offset) || 0, auto_unless_step: row.auto_unless_step ? String(row.auto_unless_step) : '',
    auto_audience: ['staff', 'sales'].includes(row.auto_audience) ? row.auto_audience : 'customer', auto_staff: parseStaffIds(row.auto_staff), auto_msg_type: row.auto_msg_type === 'info' ? 'info' : 'ad',
    ...(isEventKind(row.auto_kind) ? { auto_daily: String(row.auto_daily || ''), auto_weekdays: row.auto_weekdays === true, auto_unless_mode: row.auto_unless_mode === 'started' ? 'started' : 'completed' } : {}),
    ...(row.auto_step ? { auto_step: String(row.auto_step) } : {}),
  };
}

// 저장된 사진 목록(base64 배열). images 칸이 비어 있으면 예전 image 1장을 쓴다.
export function storedImages(row) {
  try {
    const list = JSON.parse(String(row?.images || ''));
    if (Array.isArray(list) && list.length) return list.filter(item => typeof item === 'string' && item);
  } catch { /* 칸이 비었거나 깨졌으면 예전 image 로 본다 */ }
  return typeof row?.image === 'string' && row.image ? [row.image] : [];
}

// 입력 images → { skip } | { list:[base64…] } | { error }. 장당 형식·용량 검사는 보내기와 같은 함수.
function readImages(input) {
  if (input?.images === undefined) return { skip: true };
  if (input.images === null) return { list: [] };
  if (!Array.isArray(input.images)) return { error: '사진 목록이 올바르지 않습니다.' };
  if (input.images.length > TEXT_TEMPLATE_LIMITS.images) return { error: `사진은 최대 ${TEXT_TEMPLATE_LIMITS.images}장까지 넣을 수 있습니다.` };
  const list = [];
  for (const item of input.images) {
    const data = typeof item === 'string' ? { data: item } : item;
    const parsed = parseSendExtras({ image: data });
    if (parsed.error) return { error: parsed.error };
    list.push(parsed.image.base64);
  }
  return { list };
}

// 입력 auto → { skip } | { kind:'', days:null, … 기본값 } | { kind, days, send_from, repeat, interval } | { error }
const AD_EXTRA = Object.freeze({ offset: 0, unless_step: null, audience: 'customer', staff: null, msg_type: 'ad', step: null, daily: '', weekdays: false, unless_mode: 'completed' });
function readAuto(input, staff = staffDirectory()) {
  if (input?.auto === undefined) return { skip: true };
  if (input.auto === null || !input.auto?.kind) return { kind: '', days: null, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, ...AD_EXTRA };
  if (isEventKind(input.auto.kind)) return readEventAuto(input.auto, staff, typeof input.body === 'string' ? input.body : '');
  if (isInstantKind(input.auto.kind)) return readInstantAuto(input.auto, staff, typeof input.body === 'string' ? input.body : '');
  if (!isAutoKind(input.auto.kind)) return { error: '자동 발송 종류가 올바르지 않습니다.' };
  const days = Number(input.auto.days);
  const when = input.auto.kind === AUTO_KIND ? '출고' : '주문';
  if (!(Number.isInteger(days) && days >= 1 && days <= TEXT_TEMPLATE_LIMITS.autoDaysMax)) return { error: `${when} 후 일수는 1~${TEXT_TEMPLATE_LIMITS.autoDaysMax}일로 입력해 주세요.` };
  const rawFrom = input.auto.send_from;
  let sendFrom = null;
  if (rawFrom !== undefined && rawFrom !== null && rawFrom !== '') {
    const text = typeof rawFrom === 'string' ? rawFrom : '';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (!valid) return { error: '시작일은 YYYY-MM-DD 형식으로 입력해 주세요.' };
    sendFrom = text;
  }
  const repeat = input.auto.repeat === undefined || input.auto.repeat === null || input.auto.repeat === '' ? AUTO_LIMITS.defaultRepeat : Number(input.auto.repeat);
  if (!(Number.isInteger(repeat) && repeat >= 1 && repeat <= AUTO_LIMITS.repeatMax)) return { error: `반복 횟수는 1~${AUTO_LIMITS.repeatMax}번으로 입력해 주세요.` };
  const interval = input.auto.interval === undefined || input.auto.interval === null || input.auto.interval === '' ? AUTO_LIMITS.defaultInterval : Number(input.auto.interval);
  if (!(Number.isInteger(interval) && interval >= 1 && interval <= AUTO_LIMITS.intervalMax)) return { error: `반복 간격은 1~${AUTO_LIMITS.intervalMax}일로 입력해 주세요.` };
  return { kind: input.auto.kind, days, send_from: sendFrom, repeat, interval, ...AD_EXTRA };
}

// 기준일형(납기일·출고예정일 기준): 항상 안내 문구. 일수·시작일·반복은 쓰지 않는다(days 0, repeat 1 고정).
function readEventAuto(auto, staff, body) {
  const offset = auto.offset === undefined || auto.offset === null || auto.offset === '' ? 0 : Number(auto.offset);
  if (!(Number.isInteger(offset) && offset >= -OFFSET_MAX && offset <= OFFSET_MAX)) return { error: `기준일 대비 일수는 -${OFFSET_MAX}~${OFFSET_MAX}일로 입력해 주세요.` };
  const unless = typeof auto.unless_step === 'string' ? auto.unless_step.trim() : '';
  if (unless && !STEPS.includes(unless)) return { error: '미완료 조건의 공정 이름이 올바르지 않습니다.' };
  const audience = auto.audience === undefined || auto.audience === null || auto.audience === '' ? 'customer' : auto.audience;
  if (audience !== 'customer' && audience !== 'staff' && audience !== 'sales') return { error: '받는 사람은 고객·직원·영업담당 중 하나여야 합니다.' };
  const daily = auto.daily === undefined || auto.daily === null ? '' : auto.daily;
  if (daily !== '' && daily !== 'until' && daily !== 'ongoing') return { error: '매일 반복 방식이 올바르지 않습니다.' };
  if (daily === 'until' && offset >= 0) return { error: '일 전부터 당일까지 매일은 기준일 이전(일 전)일 때만 고를 수 있습니다.', reason: 'offset' };
  const unlessMode = auto.unless_mode === undefined || auto.unless_mode === null || auto.unless_mode === '' ? 'completed' : auto.unless_mode;
  if (unlessMode !== 'completed' && unlessMode !== 'started') return { error: '미완료·미착수 조건이 올바르지 않습니다.' };
  let ids = null;
  if (audience === 'staff') {
    const list = Array.isArray(auto.staff) ? [...new Set(auto.staff.filter(item => typeof item === 'string' && item))] : [];
    if (!list.length) return { error: '받는 직원을 1명 이상 골라 주세요.' };
    if (list.length > STAFF_CAP || list.some(item => !staff.some(person => person.id === item))) return { error: '받는 직원이 올바르지 않습니다.' };
    ids = list.sort();
  }
  const blocked = infoCheck(body, audience);
  if (blocked) return { error: INFO_CHECK_MESSAGE[blocked], reason: blocked };
  return { kind: auto.kind, days: 0, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, offset, unless_step: unless || null, audience, staff: ids ? JSON.stringify(ids) : null, msg_type: 'info', step: null, daily, weekdays: auto.weekdays === true, unless_mode: unless ? unlessMode : 'completed' };
}

// 즉시형(주문 등록 시·공정 시작/완료 시): 항상 안내 문구. process_* 는 공정 필수. 일수·오프셋·미완료 조건·시작일·반복은 쓰지 않는다. 받는 사람·본문 검사는 기준일형과 같다.
function readInstantAuto(auto, staff, body) {
  const step = auto.kind === 'order_created' ? null : (typeof auto.step === 'string' ? auto.step.trim() : '');
  if (auto.kind !== 'order_created' && !STEPS.includes(step)) return { error: '공정을 골라 주세요.' };
  if (auto.audience === 'sales') return { error: '영업담당 수신은 날짜 기준 안내에서만 쓸 수 있습니다.' };
  const base = readEventAuto({ ...auto, offset: 0, unless_step: '', daily: '', weekdays: false, unless_mode: 'completed' }, staff, body);
  if (base.error) return base;
  return { ...base, kind: auto.kind, step };
}

// 입력 image → { skip } 건드리지 않음 | { clear } 지움 | { base64 } 저장 | { error }. 형식·용량 검사는 보내기와 같은 함수.
function readImage(input) {
  if (input?.image === undefined) return { skip: true };
  if (input.image === null || input.image === '') return { clear: true };
  const data = typeof input.image === 'string' ? { data: input.image } : input.image;
  const parsed = parseSendExtras({ image: data });
  if (parsed.error) return { error: parsed.error };
  return { base64: parsed.image.base64 };
}

// 저장한 새 칸 값 → 응답(auto_*) / DB 행 모양. 저장 직후 응답은 방금 검증한 값을 그대로 쓴다.
const newAutoColumns = auto => ({ auto_offset: auto.offset, auto_unless_step: auto.unless_step, auto_audience: auto.audience, auto_staff: auto.staff, auto_msg_type: auto.msg_type, auto_step: auto.step, auto_daily: auto.daily, auto_weekdays: auto.weekdays, auto_unless_mode: auto.unless_mode });
const newAutoFields = auto => ({ auto_offset: auto.offset, auto_unless_step: auto.unless_step || '', auto_audience: auto.audience, auto_staff: parseStaffIds(auto.staff), auto_msg_type: auto.msg_type, ...(auto.step ? { auto_step: auto.step } : {}), ...(isEventKind(auto.kind) ? { auto_daily: auto.daily, auto_weekdays: auto.weekdays, auto_unless_mode: auto.unless_mode } : {}) });

export async function listTextTemplates(db) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({
    sql: `SELECT id, name, body,
      ((image IS NOT NULL AND image <> '') OR COALESCE(images, '') NOT IN ('', '[]')) AS has_image,
      CASE WHEN COALESCE(images, '') NOT IN ('', '[]') THEN jsonb_array_length(images::jsonb) WHEN image IS NOT NULL AND image <> '' THEN 1 ELSE 0 END AS image_count,
      auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode
      FROM sms_text_templates ORDER BY name ASC`,
    args: [],
  });
  return ok({ items: (out.rows || []).map(toItem) });
}

export async function getTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode FROM sms_text_templates WHERE id = ?', args: [id] });
  const row = out.rows?.[0];
  if (!row) return bad('문구를 찾을 수 없습니다.', 404);
  const images = storedImages(row);
  const item = { id: Number(row.id), name: row.name, body: row.body, ...(images.length ? { has_image: true, image: images[0] } : {}) };
  if (images.length) { item.images = images; item.image_count = images.length; }
  if (row.auto_kind) Object.assign(item, autoFields(row));
  return ok({ item });
}

export async function saveTextTemplate(db, input, { staff } = {}) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const body = typeof input?.body === 'string' ? input.body : '';
  if (!name || [...name].length > TEXT_TEMPLATE_LIMITS.name) return bad(`문구 이름은 1~${TEXT_TEMPLATE_LIMITS.name}자로 입력해 주세요.`);
  const bytes = byteLength(body.trim());
  if (bytes < 1 || bytes > TEXT_TEMPLATE_LIMITS.bodyBytes) return bad(`문구는 1~${TEXT_TEMPLATE_LIMITS.bodyBytes}바이트로 입력해 주세요.`);
  const hasId = input?.id !== undefined && input?.id !== null && input?.id !== '';
  const id = hasId ? Number(input.id) : null;
  if (hasId && !(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  const photo = readImage(input);
  if (photo.error) return bad(photo.error);
  const photos = readImages(input);
  if (photos.error) return bad(photos.error);
  const auto = readAuto(input, staff || staffDirectory());
  if (auto.error) return bad(auto.error, 400, auto.reason ? { reason: auto.reason } : {});
  const hasNew = !photos.skip || !auto.skip;
  const imagesJson = photos.list?.length ? JSON.stringify(photos.list) : null;
  const photoCount = photos.skip ? (photo.base64 ? 1 : 0) : photos.list.length;
  await ensureTextTemplateSchema(db);
  const same = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE name = ?', args: [name] });
  const sameId = same.rows?.[0] ? Number(same.rows[0].id) : null;
  if (sameId !== null && sameId !== id) return bad('같은 이름의 문구가 있습니다.', 409);
  const itemBase = { name, body: body.trim(), ...(photoCount ? { has_image: true } : {}), ...(photos.skip ? {} : { image_count: photos.list.length }) };
  if (id === null) {
    const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_text_templates', args: [] });
    if (Number(count.rows?.[0]?.n || 0) >= TEXT_TEMPLATE_LIMITS.count) return bad(`문구는 최대 ${TEXT_TEMPLATE_LIMITS.count}개까지 저장할 수 있습니다.`, 409);
    try {
      let out;
      if (hasNew) {
        // 사진 여러 장·자동 발송 칸이 있는 요청. 켜짐은 저장으로 켜지 않는다(기본 false, 켜기는 auto_toggle).
        const cols = ['name', 'body']; const args = [name, body.trim()];
        if (photo.base64 && photos.skip) { cols.push('image'); args.push(photo.base64); }
        if (imagesJson) { cols.push('images'); args.push(imagesJson); }
        if (!auto.skip) { cols.push('auto_kind', 'auto_days', 'auto_send_from', 'auto_repeat', 'auto_interval', 'auto_offset', 'auto_unless_step', 'auto_audience', 'auto_staff', 'auto_msg_type', 'auto_step', 'auto_daily', 'auto_weekdays', 'auto_unless_mode'); args.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval, auto.offset, auto.unless_step, auto.audience, auto.staff, auto.msg_type, auto.step, auto.daily, auto.weekdays, auto.unless_mode); }
        out = await db.execute({ sql: `INSERT INTO sms_text_templates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`, args });
      } else {
        out = photo.base64
          ? await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body, image) VALUES (?, ?, ?) RETURNING id', args: [name, body.trim(), photo.base64] })
          : await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body) VALUES (?, ?) RETURNING id', args: [name, body.trim()] });
      }
      const item = { id: Number(out.rows?.[0]?.id), ...itemBase };
      if (auto.kind) { item.auto_kind = auto.kind; item.auto_days = auto.days; item.auto_enabled = false; if (auto.send_from) item.auto_send_from = auto.send_from; item.auto_repeat = auto.repeat; item.auto_interval = auto.interval; Object.assign(item, newAutoFields(auto)); }
      return ok({ item }, 201);
    } catch (error) {
      if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
      throw error;
    }
  }
  const found = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE id = ?', args: [id] });
  if (!found.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  let disabled = false;
  let returned = null;
  try {
    // 켜진 자동 발송 문구의 본문·일수·사진이 바뀌면 끈다(다시 켤 때 확인을 다시 거치게). 바뀐 게 없으면 아무 행도 안 건드린다.
    const changed = ['body IS DISTINCT FROM ?']; const guardArgs = [name, body.trim(), id, body.trim()];
    if (!auto.skip) {
      changed.push('auto_kind IS DISTINCT FROM ?', 'auto_days IS DISTINCT FROM ?', 'auto_send_from IS DISTINCT FROM ?', 'auto_repeat IS DISTINCT FROM ?', 'auto_interval IS DISTINCT FROM ?');
      guardArgs.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval);
      changed.push('auto_offset IS DISTINCT FROM ?', 'auto_unless_step IS DISTINCT FROM ?', 'auto_audience IS DISTINCT FROM ?', 'auto_staff IS DISTINCT FROM ?');
      guardArgs.push(auto.offset, auto.unless_step, auto.audience, auto.staff);
      changed.push('auto_step IS DISTINCT FROM ?'); guardArgs.push(auto.step);
      changed.push('auto_daily IS DISTINCT FROM ?', 'auto_weekdays IS DISTINCT FROM ?', 'auto_unless_mode IS DISTINCT FROM ?'); guardArgs.push(auto.daily, auto.weekdays, auto.unless_mode);
    }
    if (!photos.skip) { changed.push("COALESCE(images, '') IS DISTINCT FROM ?"); guardArgs.push(imagesJson || ''); }
    else if (!photo.skip) { changed.push("COALESCE(image, '') IS DISTINCT FROM ?"); guardArgs.push(photo.base64 || ''); }
    const guard = await db.execute({
      sql: `UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false WHERE id = ? AND auto_enabled = true AND (${changed.join(' OR ')}) RETURNING id, auto_kind`,
      args: guardArgs,
    });
    disabled = Boolean(guard.rows?.[0]?.auto_kind);
    if (hasNew) {
      const sets = ['name = ?', 'body = ?']; const args = [name, body.trim()];
      if (!photos.skip) { sets.push('images = ?', 'image = NULL'); args.push(imagesJson); }
      else if (!photo.skip) { sets.push('image = ?'); args.push(photo.base64 || null); }
      if (!auto.skip) { sets.push('auto_kind = ?', 'auto_days = ?', 'auto_send_from = ?', 'auto_repeat = ?', 'auto_interval = ?', 'auto_offset = ?', 'auto_unless_step = ?', 'auto_audience = ?', 'auto_staff = ?', 'auto_msg_type = ?', 'auto_step = ?', 'auto_daily = ?', 'auto_weekdays = ?', 'auto_unless_mode = ?'); args.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval, auto.offset, auto.unless_step, auto.audience, auto.staff, auto.msg_type, auto.step, auto.daily, auto.weekdays, auto.unless_mode); if (!auto.kind) sets.push('auto_enabled = false'); }
      args.push(id);
      const out = await db.execute({ sql: `UPDATE sms_text_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? RETURNING id, auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode`, args });
      returned = out.rows?.[0] || null;
    } else if (photo.skip) await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), id] });
    else await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, image = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), photo.base64 || null, id] });
  } catch (error) {
    if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
    throw error;
  }
  const item = { id, ...itemBase };
  if (returned?.auto_kind) Object.assign(item, autoFields(auto.skip ? returned : { ...returned, ...newAutoColumns(auto) }));
  if (disabled) { item.auto_enabled = false; item.auto_disabled = true; }
  return ok({ item });
}

export async function deleteTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'DELETE FROM sms_text_templates WHERE id = ? RETURNING id', args: [id] });
  if (!out.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  return ok({ deleted: true, id });
}
