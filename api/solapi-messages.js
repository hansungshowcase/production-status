import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { validKstDate } from './_lib/customerNotificationHistory.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import {
  PAGE_SIZES, buildGroups, buildItems, countItems, countSenders, countTypes, fetchSolapiDay, hasSolapiCredentials, paginate,
  typeMatches,
} from './_lib/solapiMessageLog.js';
import { buildGroupRows, fetchSolapiGroupsDay, groupSource } from './_lib/solapiGroupLog.js';

const AUDIENCES = new Set(['all', 'customer', 'staff', 'other']);
const STATUSES = new Set(['all', 'success', 'pending', 'failed']);
const VIEWS = new Set(['messages', 'groups']);
const GROUP_STATUSES = new Set(['all', 'COMPLETE', 'SENDING', 'PENDING', 'SCHEDULED', 'FAILED']);

const queryValue = value => (Array.isArray(value) ? value[0] : value);
const emptyCounts = () => ({ total: 0, success: 0, pending: 0, failed: 0 });
const bad = (res, error) => res.status(400).json({ error });

function kstToday(nowMs) {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
}

// 빈 값은 "필터 없음", 있으면 정규식 검사. 틀리면 null(=400).
function optional(q, name, pattern) {
  const value = String(queryValue(q[name]) ?? '').trim();
  if (!value) return { value: '' };
  return pattern.test(value) ? { value } : null;
}
function optionalCount(q, name) {
  const raw = String(queryValue(q[name]) ?? '').trim();
  if (!raw) return { value: 0 };
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 100000 ? { value: n } : null;
}

const groupMatchesAudience = (group, audience) => audience === 'all' || group.audience === audience
  || (group.audience === 'mixed' && (audience === 'customer' || audience === 'staff'));

export async function handleSolapiMessages(req, res, { db, fetchImpl, rateLimitCheck: limiter, nowMs } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // 칩·탭·쪽 이동마다 1요청. 쏠라피 호출은 날짜별 60초 캐시라 40회여도 외부 호출은 늘지 않는다
  if (!(limiter || rateLimitCheck)(req, res, { windowMs: 60000, max: 40 })) return;

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const q = req.query || {};
  const date = String(queryValue(q.date) || kstToday(now)).trim();
  const audience = String(queryValue(q.audience) || 'all');
  const status = String(queryValue(q.status) || 'all');
  const type = String(queryValue(q.type) || 'all');
  const view = String(queryValue(q.view) || 'groups');
  const groupStatus = String(queryValue(q.group_status) || 'all');
  if (!validKstDate(date)) return bad(res, '올바른 조회 날짜가 아닙니다.');
  if (!AUDIENCES.has(audience)) return bad(res, '올바른 구분이 아닙니다.');
  if (!STATUSES.has(status)) return bad(res, '올바른 상태가 아닙니다.');
  if (!VIEWS.has(view)) return bad(res, '올바른 보기가 아닙니다.');
  if (!GROUP_STATUSES.has(groupStatus)) return bad(res, '올바른 그룹 상태가 아닙니다.');
  // BMS_CAROUSEL_FEED 같은 긴 쏠라피 타입명도 받는다(화면 '메시지종류' 칩이 원래 이름을 보냄)
  if (type !== 'all' && !/^[A-Za-z_]{2,30}$/.test(type)) return bad(res, '올바른 타입이 아닙니다.');
  const pageSizeRaw = String(queryValue(q.page_size) ?? '').trim();
  const pageSize = pageSizeRaw ? Number(pageSizeRaw) : 50;
  if (!PAGE_SIZES.includes(pageSize)) return bad(res, '올바른 쪽 크기가 아닙니다.');
  const to4 = optional(q, 'to4', /^\d{4}$/);
  const from = optional(q, 'from', /^[0-9*-]{4,20}$/);
  const messageId = optional(q, 'message_id', /^[\w-]{1,64}$/);
  const groupId = optional(q, 'group_id', /^[A-Za-z0-9]{10,40}$/);
  const templateId = optional(q, 'template_id', /^[\w-]{1,64}$/);
  const minTotal = optionalCount(q, 'min_total');
  const minSent = optionalCount(q, 'min_sent');
  if (!to4 || !from || !messageId || !groupId || !templateId || !minTotal || !minSent) return bad(res, '올바른 검색 조건이 아닙니다.');
  const requestedPage = Number.parseInt(queryValue(q.page), 10);
  const page = Number.isFinite(requestedPage) ? requestedPage : 1;

  const base = { date, configured: true, partial: false, groups_partial: false, checked_at: new Date(now).toISOString() };
  if (!hasSolapiCredentials()) {
    return res.json({
      ...base, configured: false,
      counts: { all: emptyCounts(), customer: emptyCounts(), staff: emptyCounts(), other: emptyCounts() },
      group_counts: { all: 0, customer: 0, staff: 0, other: 0 },
      types: [], senders: [], pagination: { page: 1, page_size: pageSize, total_items: 0, total_pages: 0 },
      items: [], groups: [], group_map: {},
    });
  }

  const database = db || getDb();
  let solapi;
  let rows;
  let groupResult = null;
  try {
    [solapi, { rows }, groupResult] = await Promise.all([
      fetchSolapiDay(date, { fetchImpl, nowMs: now }).catch(error => { throw Object.assign(new Error('Solapi lookup failed'), { cause: error }); }),
      database.execute({
        sql: `SELECT milestone, recipient_name, order_id, message_subject, provider_msgid, to_phone
                FROM notification_log
               WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = ?::date`,
        args: [date],
      }),
      // 그룹 조회가 실패해도 메시지만으로 계속한다.
      fetchSolapiGroupsDay(date, { fetchImpl, nowMs: now }).catch(() => null),
    ]);
  } catch (error) {
    if (/Solapi/i.test(String(error?.message))) {
      return res.status(502).json({ error: '쏠라피 발송내역을 불러오지 못했습니다' });
    }
    throw error;
  }

  const slimGroups = groupResult?.groups || null;
  const groupSources = new Map((slimGroups || []).filter(g => g.groupId).map(g => [g.groupId, groupSource(g.appId)]));
  const all = buildItems(solapi.messages, rows || [], { nowMs: now, groupSources });
  const counts = countItems(all);
  const byAudience = audience === 'all' ? all : all.filter(item => item.audience === audience);
  const types = countTypes(byAudience);
  const senders = countSenders(byAudience);
  const allGroups = slimGroups ? buildGroupRows(slimGroups, all) : buildGroups(all);
  const group_counts = { all: allGroups.length, customer: 0, staff: 0, other: 0 };
  for (const group of allGroups) {
    if (group.audience === 'customer' || group.audience === 'mixed') group_counts.customer += 1;
    if (group.audience === 'staff' || group.audience === 'mixed') group_counts.staff += 1;
    if (group.audience === 'other') group_counts.other += 1;
  }

  let pageRows;
  let pagination;
  let groupMap = {};
  if (view === 'groups') {
    const filteredGroups = allGroups.filter(group => groupMatchesAudience(group, audience)
      && (groupStatus === 'all' || String(group.status || '').toUpperCase() === groupStatus)
      && (!groupId.value || group.group_id === groupId.value)
      && group.total >= minTotal.value && group.sent_total >= minSent.value);
    ({ rows: pageRows, pagination } = paginate(filteredGroups, page, pageSize));
  } else {
    const filtered = byAudience.filter(item => (status === 'all' || item.status === status) && typeMatches(item, type)
      && (!to4.value || item.to.endsWith(to4.value))
      && (!from.value || item.from === from.value)
      && (!messageId.value || item.message_id === messageId.value)
      && (!groupId.value || item.group_id === groupId.value)
      && (!templateId.value || item.template_id === templateId.value));
    ({ rows: pageRows, pagination } = paginate(filtered, page, pageSize));
    const wanted = new Set(pageRows.map(item => item.group_id).filter(Boolean));
    for (const group of allGroups) if (group.group_id && wanted.has(group.group_id)) groupMap[group.group_id] = group;
  }

  return res.json({
    ...base, partial: solapi.partial, groups_partial: !slimGroups || groupResult.partial === true,
    counts, group_counts, types, senders, pagination,
    items: view === 'groups' ? [] : pageRows,
    groups: view === 'groups' ? pageRows : [],
    group_map: groupMap,
  });
}

export default cors((req, res) => handleSolapiMessages(req, res));
