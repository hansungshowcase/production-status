import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { runInstantSendAll } from '../_lib/smsEventSend.js';

export const INSTANT_TIME_BUDGET_MS = 20000;

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// 5분마다 켜진 즉시형 안내 문구(주문 등록 시·공정 시작/완료 시)를 보낸다. 응답·로그에는 건수만 남긴다(이름·번호 없음).
export async function handleSmsAutoEvent(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const nowMs = dependencies.nowMs ?? Date.now();
  const db = dependencies.db || getDb();
  const run = dependencies.run || runInstantSendAll;
  const logger = dependencies.logger || console;
  try {
    const deps = { db, nowMs, env: dependencies.env || process.env, provider: dependencies.provider, fetchImpl: dependencies.fetchImpl, tick: dependencies.tick, deadline: (dependencies.tick || Date.now)() + INSTANT_TIME_BUDGET_MS };
    const result = await run(deps);
    logger.info?.('[sms-auto-event]', result);
    return res.json({ ok: true, ...result });
  } catch {
    logger.error?.('[sms-auto-event] 실행 실패');
    return res.status(500).json({ error: { message: '자동 발송을 실행하지 못했습니다.', status: 500 } });
  }
}

export default cors(handleSmsAutoEvent);
