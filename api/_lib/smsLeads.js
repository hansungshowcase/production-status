// 가입·문의 접수 표(설계 19-1): 카페24 회원가입 + 에어테이블 등록을 한 표에 모은다.
// 번호·이름은 암호화해 두고 45일 뒤 지운다. 해시는 cafe24_signups 와 같은 식이다. 응답·로그에 이름·번호를 남기지 않는다.
import crypto from 'node:crypto';
import { cafe24Connected, digits, MOBILE_RE, openValue, PHONE_KEY, phoneHash, sealValue } from './cafe24.js';
import { airtableEnv } from './airtableLeads.js';

const NAME_KEY = 'lead.name';
const KEEP_MS = 45 * 24 * 3600000;
const NAME_MAX = 60;
const flags = new Map();
export function _resetLeadSchemaForTest() { flags.clear(); }

const iso = ms => new Date(ms).toISOString();
const keyHash = (source, key) => crypto.createHash('sha256').update(`sms-lead-v1:${source}:${String(key).trim()}`).digest('hex');

export async function ensureLeadSchema(db) {
  if (flags.get('lead')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_leads (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL,
      phone_hash TEXT NOT NULL,
      phone_last4 TEXT,
      phone_enc TEXT,
      name_enc TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source, key_hash)
    )`,
    args: [],
  });
  flags.set('lead', true);
}

// 접수 1건 저장. 반환: true=새 행, false=이미 있음·휴대폰 형식 아님·암호화 실패
export async function insertLead(db, { source, key, phone, name, joinedAtMs }) {
  const number = digits(phone);
  const id = String(key ?? '').trim();
  if (!id || !source || !MOBILE_RE.test(number) || !Number.isFinite(joinedAtMs)) return false;
  await ensureLeadSchema(db);
  let phoneEnc; let nameEnc = null;
  try { phoneEnc = sealValue(PHONE_KEY, number); } catch { return false; }
  const text = String(name ?? '').trim().slice(0, NAME_MAX);
  if (text) { try { nameEnc = sealValue(NAME_KEY, text); } catch { nameEnc = null; } }
  const out = await db.execute({
    sql: 'INSERT INTO sms_leads (source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, key_hash) DO NOTHING RETURNING id',
    args: [source, keyHash(source, id), iso(joinedAtMs), phoneHash(number), number.slice(-4), phoneEnc, nameEnc],
  });
  return Boolean(out.rows?.[0]);
}

// 발송 후보: 창 안의 접수 중 번호가 남아 있는 것(읽기만). 번호를 못 푸는 행은 건너뛰고, 이름을 못 풀면 빈 값.
export async function leadCandidates(db, { fromIso, toIso }) {
  await ensureLeadSchema(db);
  const rows = (await db.execute({
    sql: 'SELECT id, phone_hash, phone_last4, phone_enc, name_enc, joined_at FROM sms_leads WHERE joined_at >= ? AND joined_at <= ? AND phone_enc IS NOT NULL ORDER BY id ASC LIMIT 2000',
    args: [fromIso, toIso],
  })).rows || [];
  const list = [];
  for (const row of rows) {
    let phone;
    try { phone = digits(openValue(PHONE_KEY, row.phone_enc)); } catch { continue; }
    if (!MOBILE_RE.test(phone)) continue;
    let name = '';
    if (row.name_enc) { try { name = String(openValue(NAME_KEY, row.name_enc)); } catch { name = ''; } }
    list.push({ id: Number(row.id), phone, name, hash: row.phone_hash, last4: row.phone_last4 || '', joinedAtMs: new Date(row.joined_at).getTime() });
  }
  return list;
}

// 45일 지난 행의 번호·이름 지우기(해시·끝 4자리만 남김)
export async function purgeOldLeads(db, nowMs = Date.now()) {
  await ensureLeadSchema(db);
  await db.execute({ sql: 'UPDATE sms_leads SET phone_enc = NULL, name_enc = NULL WHERE (phone_enc IS NOT NULL OR name_enc IS NOT NULL) AND joined_at < ?', args: [iso(nowMs - KEEP_MS)] });
}

// 가입·문의 정보가 들어올 길이 하나라도 열려 있는지(켜기 차단 판정용)
export async function leadSourcesConnected(db, env = process.env) {
  if (airtableEnv(env)) return true;
  return cafe24Connected(db, env);
}
