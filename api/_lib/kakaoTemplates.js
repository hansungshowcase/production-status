// 쏠라피 알림톡 템플릿 서버 lib (문자 관리 콘솔). 수신번호·본문 발송 내역은 다루지 않는다.
import { authHeader } from './customerReviewDelivery.js';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import {
  SUPPORTED_EMPHASIZE, SUPPORTED_MESSAGE, extractVariables, toSolapiTemplateBody,
} from '../../shared/smsConsole.js';

const BASE = 'https://api.solapi.com/';
const DIR_TTL = 10 * 60 * 1000;
const TEMPLATE_TTL = 60 * 1000;
const CATEGORY_TTL = 24 * 60 * 60 * 1000;
const BALANCE_TTL = 5 * 60 * 1000;
const MAX_PAGES = 5;
const NAME_RULE = /^한성/;
const GENERIC_ERROR = '쏠라피에서 불러오지 못했습니다';

const CACHE = new Map();
export function _resetKakaoCachesForTest() { CACHE.clear(); }
export function clearTemplateCache() { CACHE.delete('templates'); }

export class SolapiKakaoError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = 'SolapiKakaoError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function cleanMessage(value) {
  const text = String(value ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\S{25,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return text || '쏠라피에서 요청을 받아들이지 않았습니다';
}

async function call(path, { method = 'GET', body, query } = {}, { fetchImpl = fetch } = {}) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  let response;
  try {
    const headers = { Authorization: authHeader() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    response = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new SolapiKakaoError(502, GENERIC_ERROR);
  }
  const payload = await response.json().catch(() => null);
  if (response.ok) return payload;
  if (response.status >= 400 && response.status < 500) {
    throw new SolapiKakaoError(response.status, cleanMessage(payload?.errorMessage));
  }
  throw new SolapiKakaoError(502, GENERIC_ERROR);
}

function cached(key, ttl, nowMs) {
  const hit = CACHE.get(key);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < ttl) return hit;
  return null;
}

async function pagedList(path, listKey, opts) {
  const items = [];
  let startKey = null;
  let partial = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await call(path, { query: { limit: 100, startKey } }, opts);
    const list = payload?.[listKey];
    if (Array.isArray(list)) items.push(...list);
    else if (list && typeof list === 'object') items.push(...Object.values(list));
    startKey = payload?.nextKey || null;
    if (!startKey) break;
    if (page === MAX_PAGES - 1) partial = true;
  }
  return { items, partial };
}

export async function listDirectory({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hit = cached('directory', DIR_TTL, nowMs);
  if (hit) return hit.value;
  const opts = { fetchImpl };
  const channelResult = await pagedList('kakao/v2/channels', 'channelList', opts);
  const channels = channelResult.items
    .filter(item => item?.channelId)
    .map(item => ({ id: String(item.channelId), name: String(item.searchId || item.name || '').replace(/^@/, '') }));
  let groups = [];
  let groupsResolved = false;
  try {
    const groupResult = await pagedList('kakao/v2/channel-groups', 'channelGroupList', opts);
    groups = groupResult.items
      .filter(item => item?.channelGroupId || item?.groupId)
      .map(item => ({ id: String(item.channelGroupId || item.groupId), name: String(item.name || '') }));
    groupsResolved = true;
  } catch {
    groups = [];
  }
  const value = { channels, groups, groupsResolved };
  CACHE.set('directory', { at: nowMs, value });
  return value;
}

export function scopeOf(raw, directory, envIds) {
  const groupId = raw?.channelGroupId ? String(raw.channelGroupId) : '';
  const channelId = raw?.channelId ? String(raw.channelId) : '';
  const kind = groupId ? 'group' : 'channel';
  const id = groupId || channelId;
  const list = (kind === 'group' ? directory?.groups : directory?.channels) || [];
  const found = list.find(item => item.id === id);
  const name = found?.name || '';
  const ids = Array.isArray(envIds) ? envIds.filter(Boolean) : [];
  let allowed;
  if (!id) allowed = false;
  else if (ids.length) allowed = ids.includes(id);
  else allowed = Boolean(found && NAME_RULE.test(name));
  return { allowed, kind, id, name };
}

function envIdList() {
  return String(process.env.SMS_CONSOLE_KAKAO_IDS || '').split(',').map(item => item.trim()).filter(Boolean);
}

function toTemplate(raw, scope) {
  const buttons = Array.isArray(raw.buttons) ? raw.buttons.map(button => ({
    type: button.buttonType || '',
    name: button.buttonName || '',
    linkMo: button.linkMo || '',
    linkPc: button.linkPc || '',
    linkAnd: button.linkAnd || '',
    linkIos: button.linkIos || '',
  })) : [];
  const rawVars = Array.isArray(raw.variables)
    ? raw.variables.map(item => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
    : [];
  const variables = rawVars.length ? rawVars : extractVariables(raw.content || '');
  const comments = (Array.isArray(raw.comments) ? raw.comments : []).slice(-3).map(item => ({
    content: item.content || '',
    date: item.dateCreated || '',
    isAdmin: item.isAdmin === true,
  }));
  const messageType = raw.messageType || 'BA';
  const emphasizeType = raw.emphasizeType || 'NONE';
  const supported = SUPPORTED_EMPHASIZE.includes(emphasizeType) && SUPPORTED_MESSAGE.includes(messageType);
  const status = raw.status || '';
  return {
    id: String(raw.templateId || ''),
    name: raw.name || '',
    status,
    target: { kind: scope.kind, id: scope.id, name: scope.name },
    content: raw.content || '',
    messageType,
    emphasizeType,
    emphasizeTitle: raw.emphasizeTitle || '',
    emphasizeSubtitle: raw.emphasizeSubtitle || raw.emphasizeSubTitle || '',
    extra: raw.extra || '',
    securityFlag: raw.securityFlag === true,
    categoryCode: raw.categoryCode || '',
    buttons,
    variables,
    comments,
    dateCreated: raw.dateCreated || '',
    dateUpdated: raw.dateUpdated || '',
    editable: (status === 'PENDING' || status === 'REJECTED') && supported,
    supported,
  };
}

export async function listTemplates({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hit = cached('templates', TEMPLATE_TTL, nowMs);
  if (hit) return hit.value;
  const directory = await listDirectory({ fetchImpl, nowMs });
  const { items: rawList, partial } = await pagedList('kakao/v2/templates', 'templateList', { fetchImpl });
  const envIds = envIdList();
  const items = [];
  const counts = { total: 0, APPROVED: 0, INSPECTING: 0, PENDING: 0, REJECTED: 0 };
  let unresolvedGroups = 0;
  for (const raw of rawList) {
    if (!raw || raw.isHidden === true) continue;
    const scope = scopeOf(raw, directory, envIds);
    if (!scope.allowed) {
      if (scope.kind === 'group' && !scope.name && !envIds.length) unresolvedGroups += 1;
      continue;
    }
    const template = toTemplate(raw, scope);
    items.push(template);
    counts.total += 1;
    if (template.status in counts) counts[template.status] += 1;
  }
  const targets = [
    ...directory.channels.map(item => ({ kind: 'channel', ...item })),
    ...directory.groups.map(item => ({ kind: 'group', ...item })),
  ].filter(item => scopeOf(item.kind === 'group' ? { channelGroupId: item.id } : { channelId: item.id }, directory, envIds).allowed);
  const value = { items, targets, counts, unresolved_groups: unresolvedGroups };
  if (partial) value.partial = true;
  CACHE.set('templates', { at: nowMs, value });
  return value;
}

export async function getTemplateFresh(id, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let raw;
  try {
    raw = await call(`kakao/v2/templates/${encodeURIComponent(id)}`, {}, { fetchImpl });
  } catch (error) {
    if (error instanceof SolapiKakaoError && error.status === 404) return null;
    throw error;
  }
  if (!raw || typeof raw !== 'object') return null;
  const directory = await listDirectory({ fetchImpl, nowMs });
  const scope = scopeOf(raw, directory, envIdList());
  return { raw, template: toTemplate(raw, scope), scope };
}

export async function createTemplate(value, { fetchImpl = fetch } = {}) {
  return call('kakao/v2/templates', { method: 'POST', body: toSolapiTemplateBody(value) }, { fetchImpl });
}

export async function updateTemplate(id, value, { fetchImpl = fetch } = {}) {
  return call(`kakao/v2/templates/${encodeURIComponent(id)}`, {
    method: 'PUT', body: toSolapiTemplateBody(value, { forUpdate: true }),
  }, { fetchImpl });
}

export async function renameTemplate(id, name, { fetchImpl = fetch } = {}) {
  return call(`kakao/v2/templates/${encodeURIComponent(id)}/name`, { method: 'PUT', body: { name } }, { fetchImpl });
}

export async function requestInspection(id, comment, { fetchImpl = fetch } = {}) {
  const body = comment ? { comment: String(comment) } : {};
  return call(`kakao/v2/templates/${encodeURIComponent(id)}/inspection`, { method: 'PUT', body }, { fetchImpl });
}

export async function cancelInspection(id, { fetchImpl = fetch } = {}) {
  return call(`kakao/v2/templates/${encodeURIComponent(id)}/inspection/cancel`, { method: 'PUT' }, { fetchImpl });
}

export async function deleteTemplate(id, { fetchImpl = fetch } = {}) {
  return call(`kakao/v2/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }, { fetchImpl });
}

function flattenCategories(list, out = []) {
  for (const item of Array.isArray(list) ? list : []) {
    if (item?.code != null && item?.name != null) out.push({ code: String(item.code), name: String(item.name) });
    for (const key of ['categories', 'children', 'subCategories']) {
      if (Array.isArray(item?.[key])) flattenCategories(item[key], out);
    }
  }
  return out;
}

export async function listCategories({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hit = cached('categories', CATEGORY_TTL, nowMs);
  if (hit) return hit.value;
  const payload = await call('kakao/v2/templates/categories', {}, { fetchImpl });
  const value = flattenCategories(payload);
  CACHE.set('categories', { at: nowMs, value });
  return value;
}

export async function getBalance({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!hasSolapiCredentials()) return null;
  const hit = cached('balance', BALANCE_TTL, nowMs);
  if (hit) return hit.value;
  const payload = await call('cash/v1/balance', {}, { fetchImpl });
  const number = Number(payload?.balance);
  const value = Number.isFinite(number) ? number : null;
  CACHE.set('balance', { at: nowMs, value });
  return value;
}
