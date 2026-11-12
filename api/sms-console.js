import { cors } from './_lib/cors.js';
import { enforceSameOriginWrite } from './_lib/accessPolicy.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import { classifyStatus, collapseReplacements, fetchSolapiDay, hasSolapiCredentials } from './_lib/solapiMessageLog.js';
import { matchReviewCampaign } from './_lib/customerReviewCampaigns.js';
import * as defaultGuard from './_lib/smsConsoleGuard.js';
import { TEMPLATE_ID_RE, TEMPLATE_LIMITS, validateTemplateInput } from '../shared/smsConsole.js';
import { classify, normalizeChannel } from '../shared/smsTemplateKinds.js';
import { getDb } from './_lib/db.js';
import { listScheduledSends, runKakaoSend, runSend, runSendCancel, sendOptions } from './_lib/smsManualSend.js';
import { deleteTextTemplate, getTextTemplate, listTextTemplates, saveTextTemplate } from './_lib/smsTextTemplates.js';

const RESOURCES = new Set(['overview', 'templates', 'usage', 'categories', 'scope', 'sent', 'send', 'text_templates', 'text_template']);
const ACTIONS = new Set(['create', 'update', 'rename', 'inspect', 'cancel_inspect', 'delete', 'send', 'text_template_save', 'text_template_delete', 'send_cancel']);
const USAGE_DAYS = 7;
const USAGE_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const STATUS_KEYS = ['APPROVED', 'INSPECTING', 'PENDING', 'REJECTED'];
// 이 프로그램이 고객 알림톡에 쓰는 템플릿 ID 환경값(api/_lib/notify.js TEMPLATE_ENV 와 같아야 함 — 시험이 확인).
// 며칠 안 쓰였어도 지우면 주문 접수·제작 시작·포장·출고·일정 변경 알림이 멈추므로 삭제를 막는다.
export const PROGRAM_TEMPLATE_ENVS = Object.freeze(['SOLAPI_TPL_ORDERED', 'SOLAPI_TPL_STARTED', 'SOLAPI_TPL_PACKED', 'SOLAPI_TPL_SHIPPED', 'SOLAPI_TPL_RESCHEDULED']);
export function programTemplateIds() {
  const ids = new Set(PROGRAM_TEMPLATE_ENVS.map(name => String(process.env[name] || '').trim()).filter(Boolean));
  for (const id of String(process.env.SMS_CONSOLE_PROTECTED_TEMPLATE_IDS || '').split(',')) if (id.trim()) ids.add(id.trim());
  return ids;
}
const markProgramUse = (items, ids) => (items || []).map(item => (ids.has(item?.id) ? { ...item, program_use: true } : item));

let usageCache = null; // { at, value }
export function _resetConsoleCacheForTest() { usageCache = null; }

const queryValue = v => (Array.isArray(v) ? v[0] : v);
const fail = (res, status, message) => res.status(status).json({ error: { message, status } });
const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const isKakaoError = e => Boolean(e) && (e.name === 'SolapiKakaoError' || (typeof e.publicMessage === 'string' && Number.isFinite(e.status)));

function kstDates(nowMs, days) {
  const out = [];
  for (let i = 0; i < days; i += 1) out.push(new Date(nowMs + 9 * 3600000 - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

// 발송 묶음(종류별 보기용): 같은 7일 훑기에서 문구 묶음을 함께 센다. 본문·이름·전화번호는 남기지 않는다.
function addSent(sent, entry, nowMs) {
  const { orig, final } = entry;
  const review = matchReviewCampaign(orig) || matchReviewCampaign(final);
  const text = [orig.text, final.text].filter((t, i, a) => t != null && a.indexOf(t) === i).join('\n');
  const result = classify({
    type: orig.type, templateId: orig.kakaoOptions?.templateId || final.kakaoOptions?.templateId || '',
    subject: orig.subject ?? final.subject, text, reviewId: review?.id, customFields: orig.customFields,
  });
  const group = sent.get(result.key) || { key: result.key, kind: result.kind, sender: result.sender, channels: {}, ad: false, count7: 0, fail7: 0, replaced7: 0, last_ms: 0, audience: result.audience };
  const channel = normalizeChannel(orig.type);
  group.channels[channel] = (group.channels[channel] || 0) + 1;
  if (result.ad) group.ad = true;
  group.count7 += 1;
  if (entry.replaced) group.replaced7 += 1;
  else if (classifyStatus(final, { nowMs }).status === 'failed') group.fail7 += 1;
  const at = Date.parse(orig.dateCreated || '');
  if (Number.isFinite(at) && at > group.last_ms) group.last_ms = at;
  sent.set(result.key, group);
}

function sentGroupList(sent) {
  return [...(sent?.values() || [])].filter(group => !(group.kind === '미분류' && Object.keys(group.channels).some(c => c === 'ATA' || c.startsWith('BMS')))).map(group => {
    const channel = Object.entries(group.channels).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return {
      key: group.key, kind: group.kind, sender: group.sender, channel, ad: group.ad, count7: group.count7,
      fail7: group.fail7, replaced7: group.replaced7, last_sent: group.last_ms ? new Date(group.last_ms).toISOString() : null, audience: group.audience,
    };
  }).sort((a, b) => b.count7 - a.count7 || a.key.localeCompare(b.key));
}

async function computeUsage(fetchDay, nowMs, { fresh = false } = {}) {
  if (!fresh && usageCache && nowMs - usageCache.at >= 0 && nowMs - usageCache.at < USAGE_TTL_MS) return usageCache.value;
  const dates = kstDates(nowMs, USAGE_DAYS);
  const byTemplate = {};
  const sent = new Map();
  let partial = false;
  const lastMs = {};
  const readDay = async date => {
    try {
      const day = await fetchDay(date, { nowMs });
      if (day?.partial) partial = true;
      try { for (const entry of collapseReplacements(day?.messages || [])) addSent(sent, entry, nowMs); } catch { /* 묶음 판정 실패가 7일 사용량 셈을 막지 않게 한다 */ }
      for (const message of day?.messages || []) {
        if (message?.replacement === true) continue;
        const id = message?.kakaoOptions?.templateId;
        if (!id) continue;
        const entry = byTemplate[id] || (byTemplate[id] = { count: 0, last_at: null });
        entry.count += 1;
        const at = Date.parse(message.dateCreated || '');
        if (Number.isFinite(at) && at > (lastMs[id] || 0)) { lastMs[id] = at; entry.last_at = new Date(at).toISOString(); }
      }
    } catch { partial = true; }
  };
  for (let i = 0; i < dates.length; i += 2) await Promise.all(dates.slice(i, i + 2).map(readDay));
  const value = { days: USAGE_DAYS, partial, by_template: byTemplate, checked_at: new Date(nowMs).toISOString() };
  // 'sent' 는 usage 응답 모양을 바꾸지 않도록 열거되지 않는 칸으로만 붙인다(resource=sent 가 같은 훑기 결과를 재사용).
  Object.defineProperty(value, 'sent', { value: sent, enumerable: false });
  if (!fresh) usageCache = { at: nowMs, value };
  return value;
}

function envIds() {
  return String(process.env.SMS_CONSOLE_KAKAO_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

const emptyCounts = () => ({ total: 0, APPROVED: 0, INSPECTING: 0, PENDING: 0, REJECTED: 0 });

async function handleGet(req, res, ctx) {
  const { deps, kakao, guard, nowMs, opts } = ctx;
  const resource = String(queryValue(req.query?.resource) || '');
  if (!RESOURCES.has(resource)) return fail(res, 400, '올바른 조회가 아닙니다.');
  if (resource === 'send') {
    const write = await guard.writeStatus({ db: deps.db, nowMs });
    const options = sendOptions(deps.env || process.env, deps.staff, write.enabled);
    // 아직 안 나간 예약이 있을 때만 'scheduled' 칸을 더한다(없으면 응답은 예전과 같다). 조회 실패는 화면을 막지 않는다.
    try {
      const scheduled = await listScheduledSends(deps.db || getDb(), nowMs);
      if (scheduled.length) options.scheduled = scheduled;
    } catch { /* 예약 목록은 덤이다 */ }
    return res.status(200).json(options);
  }
  if (resource === 'text_templates') {
    try {
      const out = await listTextTemplates(deps.db || getDb());
      return res.status(out.status).json(out.body);
    } catch { return fail(res, 500, '문구를 불러오지 못했습니다.'); }
  }
  if (resource === 'text_template') {
    try {
      const out = await getTextTemplate(deps.db || getDb(), { id: queryValue(req.query?.id) });
      return res.status(out.status).json(out.body);
    } catch { return fail(res, 500, '문구를 불러오지 못했습니다.'); }
  }
  const configured = (deps.hasCredentials || hasSolapiCredentials)();
  const checked_at = new Date(nowMs).toISOString();
  try {
    if (resource === 'usage') {
      if (!configured) return res.status(200).json({ configured: false, days: USAGE_DAYS, partial: false, by_template: {}, checked_at });
      return res.status(200).json({ configured: true, ...(await computeUsage(ctx.fetchDay, nowMs)) });
    }
    if (resource === 'sent') {
      if (!configured) return res.status(200).json({ configured: false, days: USAGE_DAYS, partial: false, groups: [], checked_at });
      const usage = await computeUsage(ctx.fetchDay, nowMs);
      return res.status(200).json({ configured: true, days: USAGE_DAYS, partial: usage.partial, groups: sentGroupList(usage.sent), checked_at: usage.checked_at });
    }
    if (resource === 'categories') {
      if (!configured) return res.status(200).json({ configured: false, items: [] });
      return res.status(200).json({ configured: true, items: await kakao.listCategories(opts) });
    }
    const write = await guard.writeStatus({ db: deps.db, nowMs });
    if (resource === 'overview') {
      if (!configured) return res.status(200).json({ configured: false, balance: null, template_counts: null, write, checked_at });
      const [balance, listed] = await Promise.all([kakao.getBalance(opts), kakao.listTemplates(opts)]);
      return res.status(200).json({ configured: true, balance: Number.isFinite(balance) ? balance : null,
        template_counts: listed.counts || emptyCounts(), write, checked_at });
    }
    if (resource === 'templates') {
      if (!configured) return res.status(200).json({ configured: false, write, targets: [], items: [], counts: emptyCounts(), unresolved_groups: 0, checked_at });
      const listed = await kakao.listTemplates({ ...opts, fresh: String(queryValue(req.query?.fresh) || '') === '1' });
      return res.status(200).json({ configured: true, write, targets: listed.targets || [], items: markProgramUse(listed.items, programTemplateIds()),
        counts: listed.counts || emptyCounts(), unresolved_groups: listed.unresolved_groups || 0, checked_at });
    }
    // scope: 진단용(이름·내용 없음)
    if (!configured) return res.status(200).json({ configured: false, channels: [], groups: [], pattern: '^한성', env_ids: envIds().length });
    const ids = envIds();
    const [directory, listed] = await Promise.all([kakao.listDirectory(opts), kakao.listTemplates(opts)]);
    const counts = {};
    for (const item of listed.items || []) if (item?.target?.kind === 'group') counts[item.target.id] = (counts[item.target.id] || 0) + 1;
    return res.status(200).json({
      configured: true,
      channels: (directory.channels || []).map(c => ({ id: c.id, allowed: Boolean(kakao.scopeOf({ channelId: c.id }, directory, ids)?.allowed) })),
      groups: (directory.groups || []).map(g => ({ id: g.id, allowed: Boolean(kakao.scopeOf({ channelGroupId: g.id }, directory, ids)?.allowed), template_count: counts[g.id] || 0 })),
      pattern: '^한성', env_ids: ids.length,
    });
  } catch (error) {
    if (isKakaoError(error) && (error.status === 401 || error.status === 403)) {
      return fail(res, 502, '쏠라피에서 불러오지 못했습니다 — 쏠라피 API 키의 카카오 템플릿 권한·허용 IP 를 확인하세요');
    }
    return fail(res, 502, '쏠라피에서 불러오지 못했습니다');
  }
}

function parseBody(body) {
  let value = body;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function handlePost(req, res, ctx) {
  const { deps, kakao, guard, nowMs, opts } = ctx;
  if (!enforceSameOriginWrite(req, res)) return;
  const body = parseBody(req.body);
  // 보내기는 템플릿 작업과 요청 수 제한 통을 나눈다.
  const isSend = body?.action === 'send' || body?.action === 'send_cancel';
  if (!(deps.rateLimitCheck || rateLimitCheck)(req, res, { windowMs: 60000, max: isSend ? 10 : 5, keySuffix: isSend ? 'SEND' : 'POST' })) return;
  if (!body || !ACTIONS.has(body.action)) return fail(res, 400, '올바른 요청이 아닙니다.');
  const action = body.action;
  if (action === 'send_cancel') return doSendCancel(body, res, ctx);
  if (isSend) return doSend(body, res, ctx);

  const write = await guard.writeStatus({ db: deps.db, nowMs });
  // 관리자 비밀번호 잠금은 두지 않는다(2026-11-11 사장님 "비밀번호 필요없으니까 빼버려 내가 관리하는데").
  // 실수 방지(같은 출처·분당 5회·한성 채널만·사용 중/프로그램 템플릿 삭제 막음·삭제 때 이름 입력)는 그대로.
  if (!write.enabled) return fail(res, 503, '등록·삭제가 꺼져 있습니다.');
  if (action === 'text_template_save' || action === 'text_template_delete') {
    try {
      const db = deps.db || getDb();
      const out = action === 'text_template_save' ? await saveTextTemplate(db, body) : await deleteTextTemplate(db, body);
      return res.status(out.status).json(out.body);
    } catch { return fail(res, 500, '문구를 저장하지 못했습니다.'); }
  }
  if (!(deps.hasCredentials || hasSolapiCredentials)()) return fail(res, 503, '쏠라피 연결이 설정되지 않았습니다.');

  try {
    if (action === 'create') return await doCreate(body, res, ctx);
    const id = String(body.id || '');
    if (!TEMPLATE_ID_RE.test(id)) return fail(res, 400, '올바른 템플릿이 아닙니다.');
    const found = await kakao.getTemplateFresh(id, opts);
    if (!found) return fail(res, 404, '템플릿을 찾을 수 없습니다.');
    if (!found.scope?.allowed) return fail(res, 403, '이 템플릿은 관리할 수 없는 채널의 템플릿입니다.');
    const template = found.template || {};
    const status = template.status;

    if (action === 'delete') {
      if (typeof body.confirmName !== 'string' || body.confirmName !== template.name) return fail(res, 400, '템플릿 이름을 정확히 입력해 주세요.');
      if (programTemplateIds().has(id)) return fail(res, 409, '이 프로그램의 고객 알림(주문 접수·제작 시작·포장·출고·일정 변경)에 쓰는 템플릿이라 지울 수 없습니다.');
      const usage = await computeUsage(ctx.fetchDay, nowMs, { fresh: true });
      const count = usage.by_template[id]?.count || 0;
      if (count > 0) return fail(res, 409, `최근 7일 동안 ${count}건 발송된 템플릿입니다. 이 템플릿을 쓰는 자동 발송(쏠라피 자동화·프로그램 알림)을 먼저 끄세요.`);
      if (usage.partial) return fail(res, 409, '발송 사용 여부를 확인하지 못해 삭제할 수 없습니다. 잠시 후 다시 시도하세요.');
      await kakao.deleteTemplate(id, opts);
      kakao.clearTemplateCache();
      console.info('[sms-console]', action, id);
      return res.status(200).json({ deleted: true, id });
    }
    if (action === 'rename') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > TEMPLATE_LIMITS.name) return fail(res, 400, `템플릿 이름은 1~${TEMPLATE_LIMITS.name}자로 입력해 주세요.`);
      await kakao.renameTemplate(id, name, opts);
    } else if (action === 'inspect' || action === 'update') {
      if (status !== 'PENDING' && status !== 'REJECTED') return fail(res, 409, '검수 전 또는 반려된 템플릿만 가능합니다.');
      if (action === 'inspect') {
        const comment = body.comment == null ? '' : body.comment;
        if (typeof comment !== 'string' || comment.length > TEMPLATE_LIMITS.comment) return fail(res, 400, `검수 의견은 ${TEMPLATE_LIMITS.comment}자 이하로 입력해 주세요.`);
        await kakao.requestInspection(id, comment, opts);
      } else {
        if (template.supported === false) return fail(res, 409, '이 유형의 템플릿은 쏠라피에서 수정해 주세요.');
        const checked = validateTemplateInput(body.template, { requireTarget: false });
        if (!checked.ok) return res.status(400).json({ error: { message: '입력값을 확인해 주세요.', status: 400, fields: checked.errors } });
        await kakao.updateTemplate(id, checked.value, opts);
      }
    } else if (action === 'cancel_inspect') {
      if (status !== 'INSPECTING') return fail(res, 409, '검수 중인 템플릿만 취소할 수 있습니다.');
      await kakao.cancelInspection(id, opts);
    }
    kakao.clearTemplateCache();
    console.info('[sms-console]', action, id);
    const fresh = await kakao.getTemplateFresh(id, opts).catch(() => null);
    return res.status(200).json({ item: fresh?.template || { id } });
  } catch (error) {
    return writeError(res, error);
  }
}

// 문자 직접 보내기: 등록·삭제 스위치(SMS_CONSOLE_WRITE)와 별개로 SMS_SEND 스위치·발송 비밀번호로 막는다.
async function doSend(body, res, ctx) {
  const { deps, opts, guard } = ctx;
  try {
    const write = await guard.writeStatus({ db: deps.db, nowMs: ctx.nowMs });
    if (body.kakao !== undefined) {
      // 승인된 알림톡 템플릿으로 보내기(문자 발송 경로와 별도 함수)
      const kakaoOut = await runKakaoSend(body, { writeEnabled: write.enabled, env: deps.env || process.env, db: deps.db || getDb(), provider: deps.sendProvider, fetchImpl: opts.fetchImpl, nowMs: ctx.nowMs, staff: deps.staff, kakao: ctx.kakao, kakaoOpts: opts });
      return res.status(kakaoOut.status).json(kakaoOut.body);
    }
    const out = await runSend(body, { writeEnabled: write.enabled, env: deps.env || process.env, db: deps.db || getDb(), provider: deps.sendProvider, fetchImpl: opts.fetchImpl, nowMs: ctx.nowMs, staff: deps.staff });
    return res.status(out.status).json(out.body);
  } catch {
    return fail(res, 500, '문자를 보내지 못했습니다.');
  }
}

// 아직 안 나간 예약 취소(문자 보내기 화면의 예약 목록)
async function doSendCancel(body, res, ctx) {
  const { deps, opts, guard } = ctx;
  try {
    const write = await guard.writeStatus({ db: deps.db, nowMs: ctx.nowMs });
    const out = await runSendCancel(body, { writeEnabled: write.enabled, env: deps.env || process.env, db: deps.db || getDb(), provider: deps.sendProvider, fetchImpl: opts.fetchImpl, nowMs: ctx.nowMs });
    return res.status(out.status).json(out.body);
  } catch {
    return fail(res, 500, '예약을 취소하지 못했습니다.');
  }
}

function writeError(res, error) {
  if (isKakaoError(error)) {
    if (error.status >= 400 && error.status < 500) return fail(res, 409, oneLine(error.publicMessage) || '쏠라피에서 거절했습니다.');
  }
  return fail(res, 502, '쏠라피에서 처리하지 못했습니다');
}

async function doCreate(body, res, ctx) {
  const { kakao, opts } = ctx;
  const checked = validateTemplateInput(body.template);
  if (!checked.ok) return res.status(400).json({ error: { message: '입력값을 확인해 주세요.', status: 400, fields: checked.errors } });
  const wantInspection = body.requestInspection === true;
  const comment = body.comment == null ? '' : body.comment;
  if (typeof comment !== 'string' || comment.length > TEMPLATE_LIMITS.comment) return fail(res, 400, `검수 의견은 ${TEMPLATE_LIMITS.comment}자 이하로 입력해 주세요.`);
  try {
    const listed = await kakao.listTemplates(opts);
    const target = checked.value.target;
    const allowed = (listed.targets || []).some(t => t.kind === target.kind && t.id === target.id);
    if (!allowed) return fail(res, 403, '이 채널에는 템플릿을 등록할 수 없습니다.');
    const raw = await kakao.createTemplate(checked.value, opts);
    const id = raw?.templateId || raw?.id || null;
    let inspected = false;
    let warning;
    if (wantInspection && id) {
      try { await kakao.requestInspection(id, comment, opts); inspected = true; } catch (error) {
        warning = `템플릿은 등록됐지만 검수 요청은 실패했습니다. ${isKakaoError(error) ? oneLine(error.publicMessage) : ''}`.trim();
      }
    } else if (wantInspection) {
      warning = '템플릿은 등록됐지만 검수 요청은 하지 못했습니다.';
    }
    kakao.clearTemplateCache();
    console.info('[sms-console]', 'create', id);
    const fresh = id ? await kakao.getTemplateFresh(id, opts).catch(() => null) : null;
    const payload = { item: fresh?.template || { id, name: checked.value.name }, inspected };
    if (warning) payload.warning = warning;
    return res.status(201).json(payload);
  } catch (error) {
    kakao.clearTemplateCache();
    return writeError(res, error);
  }
}

export async function handleSmsConsole(req, res, deps = {}) {
  for (const h of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(h, 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const guard = deps.guard || defaultGuard;
  let kakao = deps.kakao;
  if (req.method === 'GET') {
    if (!(deps.rateLimitCheck || rateLimitCheck)(req, res, { windowMs: 60000, max: 30, keySuffix: 'GET' })) return;
  }
  if (!kakao) kakao = await import('./_lib/kakaoTemplates.js');
  const ctx = { deps, kakao, guard, nowMs, opts: { fetchImpl: deps.fetchImpl, nowMs },
    fetchDay: deps.fetchSolapiDay || ((date, o) => fetchSolapiDay(date, { fetchImpl: deps.fetchImpl, ...o })) };
  return req.method === 'GET' ? handleGet(req, res, ctx) : handlePost(req, res, ctx);
}

export default cors((req, res) => handleSmsConsole(req, res));
