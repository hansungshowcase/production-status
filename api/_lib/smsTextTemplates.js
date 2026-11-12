// 내 문자 문구 저장소(보내기 화면에서 불러 쓰는 문구). 번호·이름은 다루지 않는다.
import { byteLength } from './sendProvider.js';

export const TEXT_TEMPLATE_LIMITS = Object.freeze({ name: 40, bodyBytes: 2000, count: 100 });
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
  flags.set('sms.textTemplates', true);
}

const ok = (body, status = 200) => ({ status, body });
const bad = (message, status = 400) => ({ status, body: { error: { message, status } } });
const toItem = row => ({ id: Number(row.id), name: row.name, body: row.body });

export async function listTextTemplates(db) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'SELECT id, name, body FROM sms_text_templates ORDER BY name ASC', args: [] });
  return ok({ items: (out.rows || []).map(toItem) });
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
  await ensureTextTemplateSchema(db);
  const same = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE name = ?', args: [name] });
  const sameId = same.rows?.[0] ? Number(same.rows[0].id) : null;
  if (sameId !== null && sameId !== id) return bad('같은 이름의 문구가 있습니다.', 409);
  if (id === null) {
    const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_text_templates', args: [] });
    if (Number(count.rows?.[0]?.n || 0) >= TEXT_TEMPLATE_LIMITS.count) return bad(`문구는 최대 ${TEXT_TEMPLATE_LIMITS.count}개까지 저장할 수 있습니다.`, 409);
    try {
      const out = await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body) VALUES (?, ?) RETURNING id', args: [name, body.trim()] });
      return ok({ item: { id: Number(out.rows?.[0]?.id), name, body: body.trim() } }, 201);
    } catch (error) {
      if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
      throw error;
    }
  }
  const found = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE id = ?', args: [id] });
  if (!found.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  try {
    await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), id] });
  } catch (error) {
    if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
    throw error;
  }
  return ok({ item: { id, name, body: body.trim() } });
}

export async function deleteTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'DELETE FROM sms_text_templates WHERE id = ? RETURNING id', args: [id] });
  if (!out.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  return ok({ deleted: true, id });
}
