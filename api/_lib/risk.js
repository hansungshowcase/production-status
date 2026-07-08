// 납기 리스크 판정 — 05_납기리스크_알림_설계.md 3장 알고리즘
// 기준선: 2026-07-08 실측 (주문일→해당 공정 완료까지 달력일 P50/P80)
// 공정 순서는 제품마다 유동적이므로 "완료 공정 P50 의 최댓값"을 현재 진도로 삼는다.
// 이 모듈은 의존성 없는 순수 로직 (DB/네트워크 접근 없음).

export const BASELINE = {
  '도면설계': { p50: 3.4, p80: 7.7 },
  '레이저작업': { p50: 5.6, p80: 9.6 },
  'V-커팅작업': { p50: 9.6, p80: 15.5 },
  '절곡작업': { p50: 10.6, p80: 17.6 },
  '용접작업': { p50: 12.5, p80: 18.6 },
  '분체작업': { p50: 13.7, p80: 20.5 },
  '조립작업': { p50: 15.5, p80: 21.7 },
  '설비작업': { p50: 19.6, p80: 26.1 },
  '포장': { p50: 21.4, p80: 29.1 },
  '출고': { p50: 21.6, p80: 27.2 },
};

// 출고(전체 리드타임) P50 — 예상잔여일 = max(SHIP_P50 − 완료공정 P50 최댓값, 1)
export const SHIP_P50 = 21.6;

// KST 오늘 날짜 'YYYY-MM-DD'
export function kstToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toUtcMidnight(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// from → to 달력일 차이 (to - from). 파싱 불가 시 null.
export function daysBetween(from, to) {
  const a = toUtcMidnight(from);
  const b = toUtcMidnight(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// assessOrder(order, processes, today) → { level, daysLeft, estRemain, currentStep, slack }
// level: 'green' | 'amber' | 'red' | 'overdue' | 'unknown'
// - 유효 납기 = ship_scheduled_date ?? due_date (조정된 예정일 우선)
// - 여유(slack) = (납기 − 오늘) − 예상잔여. 여유≥2 green / 0~2 amber / <0 red / 납기경과+미출고 overdue
export function assessOrder(order, processes = [], today = kstToday()) {
  const done = processes.filter(p => p.status === 'completed');
  const inProgress = processes.find(p => p.status === 'in_progress');
  const currentStep = inProgress?.step_name
    || processes.find(p => p.status === 'waiting')?.step_name
    || (done.length ? done[done.length - 1].step_name : null);

  const progressP50 = done.reduce((mx, p) => {
    const b = BASELINE[p.step_name];
    return b && b.p50 > mx ? b.p50 : mx;
  }, 0);
  const estRemain = round1(Math.max(SHIP_P50 - progressP50, 1));

  const effectiveDue = order.ship_scheduled_date || order.due_date || null;
  if (!effectiveDue) {
    return { level: 'unknown', daysLeft: null, estRemain, currentStep, slack: null };
  }

  const daysLeft = daysBetween(today, effectiveDue);
  if (daysLeft === null) {
    return { level: 'unknown', daysLeft: null, estRemain, currentStep, slack: null };
  }
  if (daysLeft < 0) {
    // 납기 경과 + 미출고 (판정 대상은 in_production 만이므로 미출고 전제)
    return { level: 'overdue', daysLeft, estRemain, currentStep, slack: round1(daysLeft - estRemain) };
  }

  const slack = daysLeft - estRemain;
  const level = slack >= 2 ? 'green' : slack >= 0 ? 'amber' : 'red';
  return { level, daysLeft, estRemain, currentStep, slack: round1(slack) };
}
