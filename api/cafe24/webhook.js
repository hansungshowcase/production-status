// 카페24 웹훅 받는 주소(설계 18절). 환경 변수가 없으면 503(닫힘). 가입만 기록하고 여기서는 발송하지 않는다. 본문·번호는 로그에 남기지 않는다.
// 로그인 정책(cors 래퍼)을 거치지 않는다 — 카페24 서버가 부르는 주소이고 X-API-Key 로 직접 확인한다.
import { getDb } from '../_lib/db.js';
import { cafe24Env, ensureCafe24Schema, hasEnabledJoinTemplate, insertSignup, readJoinedAt, timingSafeMatch, WEBHOOK_EVENT_JOIN } from '../_lib/cafe24.js';
import { ensureTextTemplateSchema } from '../_lib/smsTextTemplates.js';

const pick = (source, names) => {
  for (const name of names) if (source && typeof source === 'object' && source[name] !== undefined && source[name] !== null && source[name] !== '') return source[name];
  return undefined;
};

export async function handleCafe24Webhook(req, res, dependencies = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  const env = dependencies.env || process.env;
  const config = cafe24Env(env);
  if (!config || !config.webhookKey) return res.status(503).json({ error: { message: '연결되지 않았습니다.', status: 503 } });
  if (!timingSafeMatch(req.headers?.['x-api-key'] || '', config.webhookKey)) return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });

  const warn = dependencies.warn || console.warn;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const resource = body.resource && typeof body.resource === 'object' ? body.resource : body;
    const mall = pick(resource, ['mall_id']) ?? pick(body, ['mall_id']);
    const event = pick(body, ['event_no']);
    if ((mall !== undefined && String(mall) !== config.mallId) || (event !== undefined && Number(event) !== WEBHOOK_EVENT_JOIN)) return res.status(200).json({ ok: true });
    const memberId = pick(resource, ['member_id']);
    const phone = pick(resource, ['cellphone']);
    if (memberId === undefined || phone === undefined) { warn('[cafe24-webhook] 가입 칸을 찾지 못한 건수', 1); return res.status(200).json({ ok: true }); }
    const db = dependencies.db || getDb();
    const nowMs = dependencies.nowMs ?? Date.now();
    await ensureCafe24Schema(db);
    await ensureTextTemplateSchema(db);
    const keepPhone = await hasEnabledJoinTemplate(db); // 켜진 가입 문구가 없으면 번호를 저장하지 않는다
    await insertSignup(db, { memberId, phone, joinedAtMs: readJoinedAt(pick(resource, ['created_date']), nowMs), source: 'webhook', keepPhone });
    return res.status(200).json({ ok: true });
  } catch {
    warn('[cafe24-webhook] 처리 실패');
    return res.status(500).json({ error: { message: '처리하지 못했습니다.', status: 500 } });
  }
}

export default handleCafe24Webhook;
