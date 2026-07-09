// 납기 리스크 판정 — 현장 공정 규칙 기반 (2026-07-08 대표 확인)
// 핵심 규칙:
//   ① 출고 5일 전에는 '분체작업'까지 완료되어 있어야 한다.
//   ② '조립작업'이 끝나면 보통 2~3일 내(설비→출고) 마무리된다.
// → 위 규칙으로 "지금 진도로 볼 때 출고까지 며칠 남았나(estRemain)"를 추정하고,
//   유효 납기(조정예정일 우선)와 비교해 신호등을 판정한다.
// 이 모듈은 순수 로직 (DB/네트워크 접근 없음).
import { STEPS } from './steps.js';

// 각 공정이 '완료'된 시점 기준, 출고까지 남는 예상 달력일 (현장 규칙 반영)
export const REMAIN_AFTER = {
  '도면설계': 16,
  '레이저작업': 14,
  'V-커팅작업': 12,
  '절곡작업': 10,
  '용접작업': 8,
  '분체작업': 5,   // 규칙①: 분체 완료 = 출고 5일 전
  '조립작업': 3,   // 규칙②: 조립 완료 후 2~3일 내 출고
  '설비작업': 2,
  '포장': 1,
  '출고': 0,
};
// 아무 공정도 완료 안 됨(접수/도면 착수 전)
const REMAIN_NONE = 18;

// KST 오늘 'YYYY-MM-DD'
export function kstToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toUtcMidnight(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// to - from (달력일). 파싱 불가 시 null.
export function daysBetween(from, to) {
  const a = toUtcMidnight(from);
  const b = toUtcMidnight(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

// today 로부터 addDays 뒤 날짜 'YYYY-MM-DD'
function addDaysStr(today, addDays) {
  const base = toUtcMidnight(today);
  if (base === null) return null;
  return new Date(base + addDays * 86400000).toISOString().slice(0, 10);
}

function isDone(status) {
  return status === 'completed' || status === 'done';
}

// assessOrder(order, processes, today)
//   → { level, daysLeft, estRemain, currentStep, slack, predictedShip, checkpointBreached }
//   level: 'green' | 'amber' | 'red' | 'overdue' | 'unknown'
//   - 유효 납기 = ship_scheduled_date ?? due_date (조정 예정일 우선)
//   - estRemain = REMAIN_AFTER[가장 진척된 완료공정]  (공정 순서는 STEPS 기준)
//   - 여유(slack) = daysLeft − estRemain
//   - 규칙① 체크포인트: 출고 5일 전(daysLeft ≤ 5)인데 분체 미완료 → 지연 확정(red)
export function assessOrder(order, processes = [], today = kstToday()) {
  const doneSet = new Set(processes.filter(p => isDone(p.status)).map(p => p.step_name));
  const inProgress = processes.find(p => p.status === 'in_progress');
  const nextWaiting = processes.find(p => p.status === 'waiting');

  // 가장 진척된 완료공정 = STEPS 순서상 index 최대인 완료 공정
  let furthestDone = null;
  let furthestIdx = -1;
  for (const name of doneSet) {
    const idx = STEPS.indexOf(name);
    if (idx > furthestIdx) { furthestIdx = idx; furthestDone = name; }
  }

  const currentStep = inProgress?.step_name
    || nextWaiting?.step_name
    || furthestDone
    || (STEPS[0] || null);

  const estRemain = furthestDone ? (REMAIN_AFTER[furthestDone] ?? REMAIN_NONE) : REMAIN_NONE;
  const predictedShip = addDaysStr(today, estRemain);

  const effectiveDue = order.ship_scheduled_date || order.due_date || null;
  if (!effectiveDue) {
    return { level: 'unknown', daysLeft: null, estRemain, currentStep, slack: null, predictedShip, checkpointBreached: false };
  }

  const daysLeft = daysBetween(today, effectiveDue);
  if (daysLeft === null) {
    return { level: 'unknown', daysLeft: null, estRemain, currentStep, slack: null, predictedShip, checkpointBreached: false };
  }

  // 규칙① 체크포인트: 출고 5일 전인데 분체 미완료면 확실히 뒤처진 것
  const checkpointBreached = daysLeft <= 5 && !doneSet.has('분체작업');

  if (daysLeft < 0) {
    return { level: 'overdue', daysLeft, estRemain, currentStep, slack: daysLeft - estRemain, predictedShip, checkpointBreached };
  }

  const slack = daysLeft - estRemain;
  let level = slack >= 2 ? 'green' : slack >= 0 ? 'amber' : 'red';
  if (checkpointBreached) level = 'red'; // 체크포인트 위반은 최소 red

  return { level, daysLeft, estRemain, currentStep, slack, predictedShip, checkpointBreached };
}
