import { authHeader, safeText } from './customerReviewDelivery.js';

const SOLAPI_GROUP_URL = 'https://api.solapi.com/messages/v4/groups';
const DAY_MS = 86400000;
const CACHE_TTL_MS = 60000;
const CACHE_MAX_DATES = 8;
const CACHE = new Map();
const APP_COMM = 'dJLDX22NaHBQ';
const APP_AUTO = 'JfpLPhLYJqGV';
const STATUS_LABELS = {
  COMPLETE: '처리완료', SENDING: '발송요청완료', PENDING: '접수대기', SCHEDULED: '예약대기', FAILED: '실패',
};

export function clearSolapiGroupCache() { CACHE.clear(); }

export function groupSource(appId) {
  if (!appId) return 'API';
  if (appId === APP_COMM) return 'COMM';
  if (appId === APP_AUTO) return 'AUTO';
  return 'APP';
}

export function groupStatusLabel(status) {
  const raw = String(status || '');
  return STATUS_LABELS[raw.toUpperCase()] || raw;
}

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

// 쏠라피 그룹 → 필요한 필드만(계정·잔액·예치금 등은 남기지 않는다)
export function slimGroup(g = {}) {
  const c = g.count || {};
  const logs = Array.isArray(g.log) ? g.log : [];
  const last = logs.length ? logs[logs.length - 1] : null;
  return {
    groupId: g.groupId || null,
    status: g.status || '',
    appId: g.app?.appId || null,
    count: {
      total: num(c.total), registeredFailed: num(c.registeredFailed), sentTotal: num(c.sentTotal),
      sentSuccess: num(c.sentSuccess), sentFailed: num(c.sentFailed), sentPending: num(c.sentPending),
      sentReplacement: num(c.sentReplacement), refund: num(c.refund),
    },
    log: last ? { createAt: last.createAt || null, message: last.message ?? null } : null,
    dateCreated: g.dateCreated || null, dateUpdated: g.dateUpdated || null,
    dateSent: g.dateSent || null, dateCompleted: g.dateCompleted || null,
    isRefunded: g.isRefunded === true,
  };
}

export async function fetchSolapiGroupsDay(date, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hit = CACHE.get(date);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_TTL_MS) return hit.value;
  const start = Date.parse(`${date}T00:00:00+09:00`);
  const groups = [];
  let startKey = null;
  let partial = false;
  for (let page = 0; page < 3; page += 1) {
    const url = new URL(SOLAPI_GROUP_URL);
    url.searchParams.set('startDate', new Date(start).toISOString());
    url.searchParams.set('endDate', new Date(start + DAY_MS).toISOString());
    url.searchParams.set('limit', '500');
    if (startKey) url.searchParams.set('startKey', startKey);
    const response = await fetchImpl(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(8000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.groupList || typeof payload.groupList !== 'object') {
      throw new Error(`Solapi group lookup failed: HTTP ${response.status}`);
    }
    for (const group of Object.values(payload.groupList)) {
      const at = Date.parse(group.dateCreated || '');
      if (at >= start && at < start + DAY_MS) groups.push(slimGroup(group));
    }
    startKey = payload.nextKey || null;
    if (!startKey) break;
    if (page === 2) partial = true;
  }
  const value = { groups, partial };
  CACHE.set(date, { at: nowMs, value });
  while (CACHE.size > CACHE_MAX_DATES) CACHE.delete(CACHE.keys().next().value);
  return value;
}

const typeKey = type => {
  const name = String(type || '').toUpperCase().replace(/_/g, ' ');
  return name.startsWith('BMS') ? 'BMS' : name;
};

export function buildGroupRows(slimGroups = [], items = []) {
  const byGroup = new Map();
  for (const item of items) {
    if (!item.group_id) continue;
    if (!byGroup.has(item.group_id)) byGroup.set(item.group_id, []);
    byGroup.get(item.group_id).push(item);
  }
  const rows = slimGroups.map(g => {
    const list = byGroup.get(g.groupId) || [];
    const types = [];
    const audiences = new Set();
    const categories = new Map();
    const preview = [];
    for (const item of list) {
      for (const raw of [item.replaced_from, item.type]) {
        const key = typeKey(raw);
        if (key && !types.includes(key)) types.push(key);
      }
      if (item.audience) audiences.add(item.audience);
      if (item.category) categories.set(item.category, (categories.get(item.category) || 0) + 1);
      const label = item.recipient_name || item.to;
      if (label && preview.length < 3 && !preview.includes(label)) preview.push(label);
    }
    const audience = audiences.size === 0 ? null : audiences.size === 1 ? [...audiences][0] : 'mixed';
    const category = categories.size
      ? [...categories.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    const c = g.count || {};
    return {
      group_id: g.groupId, created_at: g.dateCreated, updated_at: g.dateUpdated, sent_at: g.dateSent,
      completed_at: g.dateCompleted, status: g.status, status_label: groupStatusLabel(g.status),
      source: groupSource(g.appId), types, total: c.total || 0, registered_failed: c.registeredFailed || 0,
      sent_total: c.sentTotal || 0, success: c.sentSuccess || 0,
      failed: (c.sentFailed || 0) + (c.registeredFailed || 0), pending: c.sentPending || 0,
      replacement: c.sentReplacement || 0, refund: c.refund || 0, is_refunded: g.isRefunded === true,
      last_log: g.log ? { at: g.log.createAt, message: safeText(g.log.message) } : null,
      audience, category, recipients_preview: preview,
    };
  });
  return rows.sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
}
