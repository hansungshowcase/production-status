// 에어테이블 등록 인원 조회(설계 19-1). 환경값이 없으면 닫힌다. 10분 간격 선점, 최대 3쪽, 실패는 조용히(건수만 warn).
import { insertLead } from './smsLeads.js';

const POLL_EVERY_MS = 10 * 60000;
const LOOKBACK_MS = 2 * 24 * 3600000;
const MAX_PAGES = 3;
const flags = new Map();
export function _resetAirtablePollForTest() { flags.clear(); }

const iso = ms => new Date(ms).toISOString();

export function airtableEnv(env = process.env) {
  const token = String(env.AIRTABLE_TOKEN || '').trim(); const baseId = String(env.AIRTABLE_BASE_ID || '').trim();
  const table = String(env.AIRTABLE_TABLE || '').trim(); const phoneField = String(env.AIRTABLE_PHONE_FIELD || '').trim();
  const nameField = String(env.AIRTABLE_NAME_FIELD || '').trim();
  return token && baseId && table && phoneField ? { token, baseId, table, phoneField, nameField } : null;
}

// 숫자만 남기고 82 로 시작하면 0 으로 바꾼다(+82 10-1234-5678 → 01012345678)
export function normalizeAirtablePhone(value) {
  const number = String(value ?? '').replace(/\D/g, '');
  return number.startsWith('82') ? `0${number.slice(2)}` : number;
}

async function ensurePollSchema(db) {
  if (flags.get('poll')) return;
  await db.execute({ sql: 'CREATE TABLE IF NOT EXISTS sms_lead_poll (source TEXT PRIMARY KEY, last_poll_at TIMESTAMPTZ)', args: [] });
  flags.set('poll', true);
}

const text = value => (Array.isArray(value) ? value.join(' ') : String(value ?? ''));

export async function pollAirtableLeads(db, { env = process.env, fetchImpl = fetch, nowMs = Date.now(), warn = console.warn } = {}) {
  const config = airtableEnv(env);
  if (!config) return 0;
  try {
    await ensurePollSchema(db);
    const claimed = await db.execute({
      sql: `INSERT INTO sms_lead_poll (source, last_poll_at) VALUES ('airtable', ?)
        ON CONFLICT (source) DO UPDATE SET last_poll_at = EXCLUDED.last_poll_at WHERE sms_lead_poll.last_poll_at IS NULL OR sms_lead_poll.last_poll_at < ? RETURNING source`,
      args: [iso(nowMs), iso(nowMs - POLL_EVERY_MS)],
    });
    if (!claimed.rows?.[0]) return 0;
    const formula = `IS_AFTER(CREATED_TIME(), '${iso(nowMs - LOOKBACK_MS)}')`;
    const base = `https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.table)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
    let offset = ''; let added = 0; let skipped = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await fetchImpl(offset ? `${base}&offset=${encodeURIComponent(offset)}` : base, { headers: { Authorization: `Bearer ${config.token}` } });
      if (!response.ok) throw new Error('airtable http');
      const data = await response.json();
      for (const record of Array.isArray(data?.records) ? data.records : []) {
        try {
          const joinedAtMs = Date.parse(record?.createdTime);
          const fields = record?.fields || {};
          if (await insertLead(db, { source: 'airtable', key: record?.id, phone: normalizeAirtablePhone(text(fields[config.phoneField])), name: config.nameField ? text(fields[config.nameField]) : '', joinedAtMs })) added += 1;
        } catch { skipped += 1; }
      }
      offset = data?.offset ? String(data.offset) : '';
      if (!offset) break;
    }
    if (skipped) warn('[airtable] 저장하지 못한 건수', skipped);
    return added;
  } catch {
    warn('[airtable] 조회 실패');
    return 0;
  }
}
