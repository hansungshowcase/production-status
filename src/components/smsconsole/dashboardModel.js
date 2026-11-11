// 현황판 계산(순수 함수). React·fetch 없음.
export const LOW_BALANCE = 5000;

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const cell = (c) => ({ total: num(c?.total), success: num(c?.success), pending: num(c?.pending), failed: num(c?.failed) });

export function summarizeToday(counts) {
  const all = cell(counts?.all);
  return { ...all, hasFailed: all.failed > 0 };
}

const AUD_ROWS = [['customer', '고객'], ['staff', '직원']];
const CH_COLS = [['sms', '문자'], ['kakao', '알림톡']];

export function matrixCells(matrix) {
  const m = matrix && typeof matrix === 'object' ? matrix : {};
  const rows = AUD_ROWS.map(([aud, label]) => ({
    aud,
    label,
    cells: CH_COLS.map(([ch, chLabel]) => ({ aud, ch, label: chLabel, ...cell(m[aud]?.[ch]) })),
  }));
  let other = 0;
  for (const aud of ['customer', 'staff', 'other']) {
    const line = m[aud] || {};
    if (aud === 'other') other += num(line.sms?.total) + num(line.kakao?.total);
    other += num(line.other?.total);
  }
  return { rows, otherTotal: other };
}

export function hourlyBars(hourly) {
  const source = Array.isArray(hourly) ? hourly : [];
  const byHour = new Array(24).fill(null);
  for (const slot of source) {
    const h = Number(slot?.hour);
    if (Number.isInteger(h) && h >= 0 && h < 24) byHour[h] = slot;
  }
  const slots = byHour.map((slot, hour) => {
    const total = num(slot?.total);
    return { hour, total, failed: Math.min(num(slot?.failed), total) };
  });
  const max = slots.reduce((a, s) => Math.max(a, s.total), 0);
  return slots.map((s) => ({
    ...s,
    heightPct: max > 0 && s.total > 0 ? Math.max(4, Math.round((s.total / max) * 100)) : 0,
    failPct: s.total > 0 ? Math.round((s.failed / s.total) * 100) : 0,
    label: `${s.hour}시 ${s.total}건${s.failed > 0 ? ` (실패 ${s.failed})` : ''}`,
  }));
}

export function kstTime(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function groupState(g) {
  const failed = num(g.failed);
  const pending = num(g.pending);
  const tone = failed > 0 ? 'danger' : pending > 0 ? 'info' : 'ok';
  if (typeof g.status_label === 'string' && g.status_label.trim()) return { label: g.status_label.trim(), tone };
  if (failed > 0) return { label: `실패 ${failed}`, tone };
  if (pending > 0) return { label: '발송중', tone };
  return { label: '완료', tone };
}

export function recentGroups(groups, limit = 5) {
  const list = Array.isArray(groups) ? groups : [];
  return list.slice(0, limit).map((g, i) => {
    const id = String(g?.group_id || '');
    const types = Array.isArray(g?.types) ? g.types.filter(Boolean) : [];
    const state = groupState(g || {});
    return {
      key: id || `idx-${i}`,
      time: kstTime(g?.created_at),
      kind: String(g?.type_label || types.join('·') || '-'),
      total: num(g?.total),
      stateLabel: state.label,
      tone: state.tone,
      idTail: id ? id.slice(-8) : '',
    };
  });
}

export function formatWon(value) {
  return `₩${num(value).toLocaleString('ko-KR')}`;
}

export function balanceState(balance) {
  if (balance === null || balance === undefined || balance === '' || !Number.isFinite(Number(balance))) {
    return { known: false, text: '확인 못 함', low: false, warning: '' };
  }
  const n = Number(balance);
  const low = n < LOW_BALANCE;
  return { known: true, text: formatWon(n), low, warning: low ? '잔액이 적습니다 — 충전은 쏠라피에서' : '' };
}

export function templateCountsView(counts) {
  if (!counts || typeof counts !== 'object') return { known: false, items: [], rejected: 0 };
  const items = [
    ['APPROVED', '승인', 'ok'], ['INSPECTING', '검수 중', 'info'], ['PENDING', '검수 전', 'muted'], ['REJECTED', '반려', 'danger'],
  ].map(([key, label, tone]) => ({ key, label, tone, count: num(counts[key]) }));
  return { known: true, items, rejected: items[3].count };
}
