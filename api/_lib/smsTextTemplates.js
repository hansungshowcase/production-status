// 내 문자 문구 저장소(보내기 화면에서 불러 쓰는 문구). 번호·이름은 다루지 않는다.
import { byteLength } from './sendProvider.js';
import { parseSendExtras } from './smsManualSend.js';

export const TEXT_TEMPLATE_LIMITS = Object.freeze({ name: 40, bodyBytes: 2000, count: 100, images: 3, autoDaysMax: 365 });
export const AUTO_KIND = 'ship_plus_days';
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
  for (const column of ['images TEXT', 'auto_kind TEXT', 'auto_days INT', 'auto_enabled BOOLEAN NOT NULL DEFAULT false', 'auto_start_date TEXT']) {
    await db.execute({ sql: `ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS ${column}`, args: [] });
  }
  flags.set('sms.textTemplates', true);
}

const ok = (body, status = 200) => ({ status, body });
const bad = (message, status = 400) => ({ status, body: { error: { message, status } } });
const imageCountOf = row => Math.max(0, Number(row.image_count) || 0);
const toItem = row => ({
  id: Number(row.id), name: row.name, body: row.body, ...(row.has_image ? { has_image: true } : {}),
  ...(imageCountOf(row) > 0 ? { image_count: imageCountOf(row) } : {}),
  ...(row.auto_kind ? { auto_kind: String(row.auto_kind), auto_days: Number(row.auto_days) || 0, auto_enabled: row.auto_enabled === true } : {}),
});

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

// 입력 auto → { skip } | { kind:'', days:null } | { kind, days } | { error }
function readAuto(input) {
  if (input?.auto === undefined) return { skip: true };
  if (input.auto === null || !input.auto?.kind) return { kind: '', days: null };
  if (input.auto.kind !== AUTO_KIND) return { error: '자동 발송 종류가 올바르지 않습니다.' };
  const days = Number(input.auto.days);
  if (!(Number.isInteger(days) && days >= 1 && days <= TEXT_TEMPLATE_LIMITS.autoDaysMax)) return { error: `출고 후 일수는 1~${TEXT_TEMPLATE_LIMITS.autoDaysMax}일로 입력해 주세요.` };
  return { kind: AUTO_KIND, days };
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

export async function listTextTemplates(db) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({
    sql: `SELECT id, name, body,
      ((image IS NOT NULL AND image <> '') OR COALESCE(images, '') NOT IN ('', '[]')) AS has_image,
      CASE WHEN COALESCE(images, '') NOT IN ('', '[]') THEN jsonb_array_length(images::jsonb) WHEN image IS NOT NULL AND image <> '' THEN 1 ELSE 0 END AS image_count,
      auto_kind, auto_days, auto_enabled
      FROM sms_text_templates ORDER BY name ASC`,
    args: [],
  });
  return ok({ items: (out.rows || []).map(toItem) });
}

export async function getTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled FROM sms_text_templates WHERE id = ?', args: [id] });
  const row = out.rows?.[0];
  if (!row) return bad('문구를 찾을 수 없습니다.', 404);
  const images = storedImages(row);
  const item = { id: Number(row.id), name: row.name, body: row.body, ...(images.length ? { has_image: true, image: images[0] } : {}) };
  if (images.length) { item.images = images; item.image_count = images.length; }
  if (row.auto_kind) { item.auto_kind = String(row.auto_kind); item.auto_days = Number(row.auto_days) || 0; item.auto_enabled = row.auto_enabled === true; }
  return ok({ item });
}

export async function saveTextTemplate(db, input) {
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
  const auto = readAuto(input);
  if (auto.error) return bad(auto.error);
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
        if (!auto.skip) { cols.push('auto_kind', 'auto_days'); args.push(auto.kind, auto.days); }
        out = await db.execute({ sql: `INSERT INTO sms_text_templates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`, args });
      } else {
        out = photo.base64
          ? await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body, image) VALUES (?, ?, ?) RETURNING id', args: [name, body.trim(), photo.base64] })
          : await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body) VALUES (?, ?) RETURNING id', args: [name, body.trim()] });
      }
      const item = { id: Number(out.rows?.[0]?.id), ...itemBase };
      if (auto.kind) { item.auto_kind = auto.kind; item.auto_days = auto.days; item.auto_enabled = false; }
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
    if (!auto.skip) { changed.push('auto_kind IS DISTINCT FROM ?', 'auto_days IS DISTINCT FROM ?'); guardArgs.push(auto.kind, auto.days); }
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
      if (!auto.skip) { sets.push('auto_kind = ?', 'auto_days = ?'); args.push(auto.kind, auto.days); if (!auto.kind) sets.push('auto_enabled = false'); }
      args.push(id);
      const out = await db.execute({ sql: `UPDATE sms_text_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? RETURNING id, auto_kind, auto_days, auto_enabled`, args });
      returned = out.rows?.[0] || null;
    } else if (photo.skip) await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), id] });
    else await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, image = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), photo.base64 || null, id] });
  } catch (error) {
    if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
    throw error;
  }
  const item = { id, ...itemBase };
  if (returned?.auto_kind) { item.auto_kind = String(returned.auto_kind); item.auto_days = Number(returned.auto_days) || 0; item.auto_enabled = returned.auto_enabled === true; }
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
