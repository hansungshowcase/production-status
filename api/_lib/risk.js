// 납기 지연 자동 감지 — 현장 공정 규칙 기반 (2026-07-09 대표 확인)
// 핵심 규칙:
//   ① [하드 체크포인트] 출고 5일 전에는 '분체작업'이 최소한 '시작'되어 있어야 한다.
//      - 출고 5일 전(daysLeft ≤ 5)인데 분체 미착수 → 지연 확정(red)
//      - 출고 7일 전(daysLeft ≤ 7)인데 분체 미착수 → 주의(amber)  (조기 경보)
//   ② '조립작업' 완료 후에는 보통 2~3일 내(설비→출고) 마무리된다.
//   ③ 각 공정의 진척도로 "지금 진도면 출고까지 며칠 남았나(estRemain)"를 추정한다.
// → estRemain 과 유효 납기를 비교한 여유(slack) + 체크포인트를 함께 보고 신호등을 판정.
// 순수 로직 (DB/네트워크 접근 없음).
import { STEPS } from './steps.js';

// 각 공정이 '완료'된 시점 기준, 출고까지 남는 예상 달력일 (현장 규칙 반영)
export const REMAIN_AFTER = {
  '도면설계': 16,
  '레이저작업': 14,
  'V-커팅작업': 12,
  '절곡작업': 10,
  '용접작업': 8,
  '분체작업': 5,   // 분체 완료 ≈ 출고 5일 전
  '조립작업': 3,   // 조립 완료 후 2~3일 내 출고
  '설비작업': 2,
  '포장': 1,
  '출고': 0,
};
const REMAIN_NONE = 18; // 아무 공정도 시작 안 됨(접수/도면 착수 전)

// ── 하드 체크포인트: 출고 N일 전까지 분체작업이 최소 '시작'돼 있어야 함 ──
export const CHECKPOINT_STEP = '분체작업';
export const CHECKPOINT_DAYS_RED = 5;   // 5일 전 미착수 → 지연 확정
export const CHECKPOINT_DAYS_AMBER = 7; // 7일 전 미착수 → 주의(조기 경보)

export function kstToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// KST 기준 요일 (0=일 … 6=토). UTC+9 로 옮긴 뒤 UTC 요일을 읽으면 KST 벽시계 요일이 된다.
export function kstDayOfWeek(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 60 * 60 * 1000).getUTCDay();
}

// 주말(토·일) 여부 — 담당자 경보는 평일에만 발송
export function isKstWeekend(nowMs = Date.now()) {
  const d = kstDayOfWeek(nowMs);
  return d === 0 || d === 6;
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

function addDaysStr(today, addDays) {
  const base = toUtcMidnight(today);
  if (base === null) return null;
  return new Date(base + addDays * 86400000).toISOString().slice(0, 10);
}

function isDone(status) {
  return status === 'completed' || status === 'done';
}
function isStarted(status) {
  return status === 'in_progress' || isDone(status);
}

// assessOrder(order, processes, today)
//   → { level, daysLeft, estRemain, predictedShip, currentStep, slack, checkpointStarted, reasons }
//   level: 'green' | 'amber' | 'red' | 'overdue' | 'shipped' | 'unknown'
//   - 유효 납기 = ship_scheduled_date ?? due_date (조정 예정일 우선)
//   - estRemain = 진척 프론티어(완료/진행중 공정 중 가장 앞선 것) 기준 출고까지 예상일
//   - slack = daysLeft − estRemain
//   - 체크포인트: 출고 5일 전 분체 미착수 → red / 7일 전 미착수 → amber
export function assessOrder(order, processes = [], today = kstToday()) {
  if (order && order.status === 'shipped') {
    return { level: 'shipped', daysLeft: null, estRemain: 0, predictedShip: null, currentStep: '출고', slack: null, checkpointStarted: true, reasons: [] };
  }

  const byName = {};
  for (const p of (processes || [])) byName[p.step_name] = p.status;

  // 진척 프론티어: STEPS 순서상 '완료 또는 진행중'인 공정 중 가장 앞선 것
  let frontierIdx = -1;
  let frontierName = null;
  let frontierStatus = null;
  STEPS.forEach((name, i) => {
    const st = byName[name];
    if (st && (isDone(st) || st === 'in_progress') && i > frontierIdx) {
      frontierIdx = i; frontierName = name; frontierStatus = st;
    }
  });

  // 표시용 현재 단계
  const inProgress = (processes || []).find(p => p.status === 'in_progress');
  const nextWaiting = STEPS.find(n => byName[n] === 'waiting');
  const currentStep = inProgress?.step_name || nextWaiting || frontierName || STEPS[0] || null;

  // 예상 잔여일 (프론티어 기준). 진행중이면 아직 완료 전이므로 +1일 보정.
  let estRemain;
  if (frontierName) {
    estRemain = REMAIN_AFTER[frontierName] ?? REMAIN_NONE;
    if (frontierStatus === 'in_progress') estRemain += 1;
  } else {
    estRemain = REMAIN_NONE;
  }

  const predictedShip = addDaysStr(today, estRemain);

  const effectiveDue = order?.ship_scheduled_date || order?.due_date || null;
  if (!effectiveDue) {
    return { level: 'unknown', daysLeft: null, estRemain, predictedShip, currentStep, slack: null, checkpointStarted: isStarted(byName[CHECKPOINT_STEP]), reasons: ['납기일 미입력'] };
  }

  const daysLeft = daysBetween(today, effectiveDue);
  if (daysLeft === null) {
    return { level: 'unknown', daysLeft: null, estRemain, predictedShip, currentStep, slack: null, checkpointStarted: isStarted(byName[CHECKPOINT_STEP]), reasons: ['납기일 형식 오류'] };
  }

  const checkpointStarted = isStarted(byName[CHECKPOINT_STEP]);
  const reasons = [];

  // 이미 납기 경과 + 미출고
  if (daysLeft < 0) {
    reasons.push(`납기 ${Math.abs(daysLeft)}일 경과`);
    return { level: 'overdue', daysLeft, estRemain, predictedShip, currentStep, slack: daysLeft - estRemain, checkpointStarted, reasons };
  }

  // slack = 유효납기 − 예상소요일. 현장은 마일스톤을 '딱 맞춰' 돌아가므로
  // 마일스톤에 맞으면(slack≥0) 정상, 1일 뒤처지면 주의, 2일 이상 뒤처지면 지연확정.
  const slack = daysLeft - estRemain;

  // 기본 신호등 (진척 기반)
  let level = slack >= 0 ? 'green' : slack === -1 ? 'amber' : 'red';
  if (slack <= -2) reasons.push(`진척 지연 (예상 출고 ${predictedShip}, 납기 ${Math.abs(slack)}일 초과)`);
  else if (slack === -1) reasons.push(`납기 빠듯 (예상 출고 ${predictedShip})`);

  // ① 하드 체크포인트: 분체 착수 여부
  if (!checkpointStarted && daysLeft <= CHECKPOINT_DAYS_RED) {
    level = 'red';
    reasons.unshift(`출고 ${CHECKPOINT_DAYS_RED}일 전인데 ${CHECKPOINT_STEP} 미착수`);
  } else if (!checkpointStarted && daysLeft <= CHECKPOINT_DAYS_AMBER) {
    if (level === 'green') level = 'amber';
    reasons.push(`${CHECKPOINT_STEP} 착수 지연 (출고 ${daysLeft}일 전)`);
  }

  if (reasons.length === 0) reasons.push('정상 진행');
  return { level, daysLeft, estRemain, predictedShip, currentStep, slack, checkpointStarted, reasons };
}

// 관리자 문자 발송 대상 판정 (대표 지정 조건):
//   "출고가 5일 이내로 남았는데 분체작업이 아직 시작조차 안 된 건"만 알린다.
//   - 이미 납기 경과(daysLeft<0)/납기미입력(null)/분체 착수·완료 건은 제외.
export function isShipRiskAlert(assessment) {
  return !!assessment
    && assessment.checkpointStarted === false
    && assessment.daysLeft != null
    && assessment.daysLeft >= 0
    && assessment.daysLeft <= CHECKPOINT_DAYS_RED;
}
