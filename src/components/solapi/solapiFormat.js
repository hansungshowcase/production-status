// 쏠라피 발송내역 화면 공용 표시 함수 (한국시간 기준). 표·상세 창·껍데기가 함께 쓴다.
const KST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  const map = {};
  for (const part of KST_PARTS.formatToParts(new Date(ms))) map[part.type] = part.value;
  return map;
}

// '11/11 15:15:13' (표 생성일 칸)
export function fmtShort(iso) {
  const p = parts(iso);
  return p ? `${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}` : '-';
}

// '2026.11.11 15:15:13' (상세 창)
export function fmtFull(iso) {
  const p = parts(iso);
  return p ? `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}:${p.second}` : '-';
}

// '방금' · '5분 전' · '3시간 전' · '2일 전' (요청별 내역 최근 업데이트 앞 괄호)
export function fmtRelative(iso, nowIso) {
  const at = Date.parse(iso || '');
  const now = Date.parse(nowIso || '') || Date.now();
  if (!Number.isFinite(at)) return '';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

// BMS_FREE → BMS, RCS_LMS → RCS (배지·점 색 묶음)
export function typeKey(type) {
  const raw = String(type || '').toUpperCase();
  if (raw.startsWith('BMS')) return 'BMS';
  if (raw.startsWith('RCS')) return 'RCS';
  return raw;
}

// 건별 내역 타입 앞 색 점
export const TYPE_DOT = {
  SMS: '#94a3b8', LMS: '#4f8ef7', MMS: '#2563eb', ATA: '#f5c518', CTA: '#f59e0b', CTI: '#f59e0b',
  BMS: '#10a37f', RCS: '#7c3aed', NSA: '#03c75a', VOICE: '#6b7280', FAX: '#6b7280',
};

// 요청별 내역 타입 칸: 발송 출처 배지(API·COMM·AUTO) + 메시지 타입 배지
export const SOURCE_BADGE = {
  API: { bg: '#8c8c8c', fg: '#ffffff', title: '직접 API 호출(우리 프로그램 등)' },
  COMM: { bg: '#111111', fg: '#3ddc84', title: '스마트스토어 연동' },
  AUTO: { bg: '#ff5a1f', fg: '#ffffff', title: '쏠라피 자동화' },
  APP: { bg: '#6b7280', fg: '#ffffff', title: '쏠라피 앱' },
};
export const TYPE_BADGE = {
  SMS: { bg: '#94a3b8', fg: '#ffffff' }, LMS: { bg: '#6aaef0', fg: '#ffffff' }, MMS: { bg: '#2f6fe4', fg: '#ffffff' },
  ATA: { bg: '#ffe14d', fg: '#3a3000' }, CTA: { bg: '#ffb020', fg: '#3a2500' }, CTI: { bg: '#ffb020', fg: '#3a2500' },
  BMS: { bg: '#0f9f7a', fg: '#ffffff' }, RCS: { bg: '#7c3aed', fg: '#ffffff' }, NSA: { bg: '#03c75a', fg: '#ffffff' },
};

export const AUDIENCE_LABEL = { customer: '고객', staff: '직원', other: '기타', mixed: '혼합' };

// 상태코드 글자 색: 성공 파랑, 대기·발송중 회색, 실패 빨강
export const STATUS_COLOR = { success: '#4541ff', pending: '#8a8f98', failed: '#e5484d' };

// 현황 막대 색
export const BAR_COLOR = { failed: '#f25c5c', success: '#5b8def', pending: '#c7ccd6' };
