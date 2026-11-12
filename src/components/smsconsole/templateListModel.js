// 알림톡 템플릿 목록 화면 계산(순수 함수). 화면(KakaoTemplateManager)과 시험이 같이 쓴다.
import { TEMPLATE_STATUS } from '../../../shared/smsConsole.js';

export const STATUS_ORDER = ['APPROVED', 'INSPECTING', 'PENDING', 'REJECTED'];

export function statusInfo(status) {
  return TEMPLATE_STATUS[status] || { label: '알 수 없음', tone: 'muted' };
}

// 이름·템플릿 ID 포함 검색(대소문자 무시) + 상태 거르기. 서버 호출 없음.
// status 'in_use' = 발송 중(최근 7일 사용 1건 이상, usage 필요)
export function filterTemplates(items, { query = '', status = 'all', usage = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  return list.filter((item) => {
    if (status === 'in_use') {
      if (!(usageCount(usage, item.id) > 0)) return false;
    } else if (status && status !== 'all' && item.status !== status) return false;
    if (!q) return true;
    return String(item.name || '').toLowerCase().includes(q) || String(item.id || '').toLowerCase().includes(q);
  });
}

export function statusCounts(items) {
  const counts = { all: 0, APPROVED: 0, INSPECTING: 0, PENDING: 0, REJECTED: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    counts.all += 1;
    if (item && counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return counts;
}

// 상태 알약 목록: [{id,label,count}]
// usage 를 알면 맨 앞에 '발송 중' 알약을 더한다.
export function statusPills(items, usage = null) {
  const counts = statusCounts(items);
  const inUse = usageKnown(usage)
    ? [{ id: 'in_use', label: '발송 중', count: (Array.isArray(items) ? items : []).filter((item) => usageCount(usage, item?.id) > 0).length }]
    : [];
  return [...inUse, { id: 'all', label: '전체', count: counts.all },
    ...STATUS_ORDER.map((id) => ({ id, label: TEMPLATE_STATUS[id].label, count: counts[id] }))];
}

// 처음 선택할 알약: 발송 중이 1개 이상이면 발송 중, 아니면 전체
// 주소에 tpl 로 특정 템플릿이 들어와 있고 그것이 발송 중이 아니면 전체로 시작한다(그 템플릿이 보이게).
export function defaultStatusFilter(pills, selectedId = '', usage = null) {
  const inUse = (Array.isArray(pills) ? pills : []).find((pill) => pill.id === 'in_use');
  if (!(inUse && inUse.count > 0)) return 'all';
  if (selectedId && !(usageCount(usage, selectedId) > 0)) return 'all';
  return 'in_use';
}

// usage = { by_template, partial } 또는 null(조회 실패·아직 없음)
export function usageKnown(usage) {
  return Boolean(usage && typeof usage === 'object' && usage.by_template && typeof usage.by_template === 'object');
}

// 최근 7일 발송 건수. 모르면 null. 일부만 조회됐고(partial) 0건이면 모르는 것으로 본다.
export function usageCount(usage, id) {
  if (!usageKnown(usage)) return null;
  const row = usage.by_template[id];
  const count = Number(row?.count) || 0;
  if (count === 0 && usage.partial) return null;
  return count;
}

// 사용 배지: { tone, text } 또는 null(쓰이지 않음 → 배지 없음)
export function usageBadge(usage, id) {
  const count = usageCount(usage, id);
  if (count === null) return { tone: 'muted', text: '사용 여부 확인 못 함' };
  if (count > 0) return { tone: 'warn', text: `최근 7일 ${count}건` };
  return null;
}

// ⋮ 메뉴에 보일 동작 id 목록(설계 2-3 순서)
export function availableActions(template) {
  if (!template) return [];
  const actions = [];
  const open = template.status === 'PENDING' || template.status === 'REJECTED';
  if (open) actions.push('inspect');
  if (template.status === 'INSPECTING') actions.push('cancel_inspect');
  if (open && template.supported !== false && template.editable !== false) actions.push('edit');
  actions.push('rename', 'today_log', 'delete');
  return actions;
}

export const ACTION_LABELS = {
  inspect: '검수 요청',
  cancel_inspect: '검수 요청 취소',
  edit: '내용 수정',
  rename: '이름 변경',
  today_log: '오늘 발송 보기',
  delete: '삭제',
};

// 삭제 가능 판정: 최근 7일 1건 이상이거나 사용량을 모르면 불가(서버와 같은 안전 쪽 규칙)
// 이 프로그램의 고객 알림에 쓰는 템플릿(서버가 program_use 로 표시)은 사용량과 관계없이 불가
export function deleteDecision(template, usage) {
  const count = usageCount(usage, template?.id);
  if (template?.program_use === true) return { allowed: false, reason: 'program', count };
  if (count === null) return { allowed: false, reason: 'unknown', count: null };
  if (count > 0) return { allowed: false, reason: 'in_use', count };
  return { allowed: true, reason: '', count: 0 };
}

export function deleteConfirmed(template, typed) {
  return Boolean(template) && String(typed ?? '') === String(template.name ?? '') && String(template.name ?? '') !== '';
}

// 한국 시간 기준 YYYY.MM.DD (ISO 문자열·숫자 시각). 못 읽으면 ''
export function formatDate(value) {
  if (value === undefined || value === null || value === '') return '';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

export function isValidRename(name) {
  const text = String(name ?? '').trim();
  return text.length >= 1 && text.length <= 100;
}

// 본문을 '#{변수}' 기준으로 [{text, variable}] 조각으로 나눈다(미리보기에서 요소로 그림)
export function splitVariables(content) {
  const text = String(content ?? '');
  const parts = [];
  const re = /#\{[^{}\n]{1,40}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), variable: false });
    parts.push({ text: m[0], variable: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), variable: false });
  return parts;
}
