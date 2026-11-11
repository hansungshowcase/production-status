import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { validKstDate } from './_lib/customerNotificationHistory.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import {
  buildGroups, buildItems, countItems, countTypes, fetchSolapiDay, hasSolapiCredentials, paginate, typeMatches,
} from './_lib/solapiMessageLog.js';

const AUDIENCES = new Set(['all', 'customer', 'staff', 'other']);
const STATUSES = new Set(['all', 'success', 'pending', 'failed']);
const VIEWS = new Set(['messages', 'groups']);

const queryValue = value => (Array.isArray(value) ? value[0] : value);
const emptyCounts = () => ({ total: 0, success: 0, pending: 0, failed: 0 });

function kstToday(nowMs) {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
}

export async function handleSolapiMessages(req, res, { db, fetchImpl, rateLimitCheck: limiter, nowMs } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(limiter || rateLimitCheck)(req, res, { windowMs: 60000, max: 20 })) return;

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const q = req.query || {};
  const date = String(queryValue(q.date) || kstToday(now)).trim();
  const audience = String(queryValue(q.audience) || 'all');
  const status = String(queryValue(q.status) || 'all');
  const type = String(queryValue(q.type) || 'all');
  const view = String(queryValue(q.view) || 'messages');
  if (!validKstDate(date)) return res.status(400).json({ error: '올바른 조회 날짜가 아닙니다.' });
  if (!AUDIENCES.has(audience)) return res.status(400).json({ error: '올바른 구분이 아닙니다.' });
  if (!STATUSES.has(status)) return res.status(400).json({ error: '올바른 상태가 아닙니다.' });
  if (!VIEWS.has(view)) return res.status(400).json({ error: '올바른 보기가 아닙니다.' });
  if (type !== 'all' && !/^[A-Za-z_]{2,12}$/.test(type)) return res.status(400).json({ error: '올바른 타입이 아닙니다.' });
  const requestedPage = Number.parseInt(queryValue(q.page), 10);
  const page = Number.isFinite(requestedPage) ? requestedPage : 1;

  const base = { date, configured: true, partial: false, checked_at: new Date(now).toISOString() };
  if (!hasSolapiCredentials()) {
    return res.json({
      ...base, configured: false,
      counts: { all: emptyCounts(), customer: emptyCounts(), staff: emptyCounts(), other: emptyCounts() },
      types: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 }, items: [], groups: [],
    });
  }

  const database = db || getDb();
  let solapi;
  let rows;
  try {
    [solapi, { rows }] = await Promise.all([
      fetchSolapiDay(date, { fetchImpl, nowMs: now }).catch(error => { throw Object.assign(new Error('Solapi lookup failed'), { cause: error }); }),
      database.execute({
        sql: `SELECT milestone, recipient_name, order_id, message_subject, provider_msgid, to_phone
                FROM notification_log
               WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = ?::date`,
        args: [date],
      }),
    ]);
  } catch (error) {
    if (/Solapi/i.test(String(error?.message))) {
      return res.status(502).json({ error: '쏠라피 발송내역을 불러오지 못했습니다' });
    }
    throw error;
  }

  const all = buildItems(solapi.messages, rows || [], { nowMs: now });
  const counts = countItems(all);
  const byAudience = audience === 'all' ? all : all.filter(item => item.audience === audience);
  const types = countTypes(byAudience);
  const filtered = byAudience.filter(item => (status === 'all' || item.status === status) && typeMatches(item, type));
  const { rows: pageRows, pagination } = paginate(view === 'groups' ? buildGroups(filtered) : filtered, page);

  return res.json({
    ...base, partial: solapi.partial, counts, types, pagination,
    items: view === 'groups' ? [] : pageRows,
    groups: view === 'groups' ? pageRows : [],
  });
}

export default cors((req, res) => handleSolapiMessages(req, res));
