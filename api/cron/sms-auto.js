import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { AUTO_TIME_BUDGET_MS, runAutoSendAll } from '../_lib/smsAutoSend.js';
import { maintainCafe24 } from '../_lib/cafe24.js';
import { purgeOldLeads } from '../_lib/smsLeads.js';
import { runEventSendAll } from '../_lib/smsEventSend.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// 매일 KST 10:00 에 켜진 자동 문구를 보낸다. 응답·로그에는 건수만 남긴다(이름·번호 없음).
export async function handleSmsAuto(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const nowMs = dependencies.nowMs ?? Date.now();
  const db = dependencies.db || getDb();
  const run = dependencies.run || runAutoSendAll;
  const runEvent = dependencies.runEvent || runEventSendAll;
  const logger = dependencies.logger || console;
  try {
    const deps = { db, nowMs, env: dependencies.env || process.env, provider: dependencies.provider, fetchImpl: dependencies.fetchImpl, tick: dependencies.tick, deadline: (dependencies.tick || Date.now)() + AUTO_TIME_BUDGET_MS };
    const result = await run(deps);
    const info = await runEvent(deps); // 광고 실행 뒤 안내 실행(같은 전체 마감 시각)
    try { await (dependencies.maintainCafe24 || maintainCafe24)(db, { env: deps.env, fetchImpl: deps.fetchImpl, nowMs }); } catch { /* 카페24 정리·토큰 갱신 실패는 조용히 */ }
    try { await (dependencies.purgeOldLeads || purgeOldLeads)(db, nowMs); } catch { /* 접수 정리 실패는 조용히 */ }
    logger.info?.('[sms-auto]', result, info);
    return res.json({ ok: true, ...result, info });
  } catch {
    logger.error?.('[sms-auto] 실행 실패');
    return res.status(500).json({ error: { message: '자동 발송을 실행하지 못했습니다.', status: 500 } });
  }
}

export default cors(handleSmsAuto);
