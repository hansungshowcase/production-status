// 납기 지연 자동 감지 로직 검증 — 현장 규칙 사다리
// 규칙: 출고 5일 전엔 분체작업이 최소 '시작'돼 있어야 함.
//   분체 완료&5일전=정상 / 분체 진행중&5일전=주의 / 분체 미착수&5일전=지연확정
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessOrder, isShipRiskAlert, isKstWeekend, kstDayOfWeek, daysBetween, REMAIN_AFTER } from '../api/_lib/risk.js';
import { STEPS } from '../api/_lib/steps.js';

const TODAY = '2026-07-09';

// statusMap 예: { '분체작업': 'in_progress' } — 나머지 공정은 'waiting'
function procs(statusMap = {}) {
  return STEPS.map((name) => ({ step_name: name, status: statusMap[name] || 'waiting' }));
}
// stepName 까지(포함) 완료 처리 + extra 로 덮어쓰기
function doneUpTo(stepName, extra = {}) {
  const idx = STEPS.indexOf(stepName);
  const map = {};
  STEPS.forEach((n, i) => { if (i <= idx) map[n] = 'completed'; });
  return procs({ ...map, ...extra });
}
const order = (due, over = {}) => ({ due_date: due, status: 'in_production', ...over });

test('날짜 계산 sanity', () => {
  assert.equal(daysBetween('2026-07-09', '2026-07-14'), 5);
  assert.equal(daysBetween('2026-07-09', '2026-07-05'), -4);
});

test('1) 초기 단계·여유 충분 → green', () => {
  const r = assessOrder(order('2026-08-20'), doneUpTo('도면설계'), TODAY);
  assert.equal(r.level, 'green');
});

test('2) 분체 완료 & 출고 5일 전 → green (이상적 궤도)', () => {
  const r = assessOrder(order('2026-07-14'), doneUpTo('분체작업'), TODAY);
  assert.equal(r.daysLeft, 5);
  assert.equal(r.level, 'green');
});

test('3) 분체 진행중 & 출고 5일 전 → amber (최소 기준 충족·빠듯)', () => {
  const r = assessOrder(order('2026-07-14'), doneUpTo('용접작업', { '분체작업': 'in_progress' }), TODAY);
  assert.equal(r.level, 'amber');
  assert.equal(r.checkpointStarted, true);
});

test('4) 분체 미착수 & 출고 5일 전 → red (지연 확정 + 사유 명시)', () => {
  const r = assessOrder(order('2026-07-14'), doneUpTo('용접작업'), TODAY);
  assert.equal(r.level, 'red');
  assert.equal(r.checkpointStarted, false);
  assert.ok(r.reasons.some((x) => x.includes('분체작업 미착수')), `사유: ${r.reasons.join(', ')}`);
});

test('5) 분체 미착수 & 출고 7일 전 → amber (조기 경보)', () => {
  const r = assessOrder(order('2026-07-16'), doneUpTo('용접작업'), TODAY);
  assert.equal(r.daysLeft, 7);
  assert.equal(r.level, 'amber');
});

test('6) 분체 미착수 & 출고 8일 전 → green (아직 이름)', () => {
  const r = assessOrder(order('2026-07-17'), doneUpTo('용접작업'), TODAY);
  assert.equal(r.daysLeft, 8);
  assert.equal(r.level, 'green');
});

test('7) 조립 완료 & 출고 3일 전 → green (조립 후 2~3일 규칙)', () => {
  const r = assessOrder(order('2026-07-12'), doneUpTo('조립작업'), TODAY);
  assert.equal(r.daysLeft, 3);
  assert.equal(r.level, 'green');
});

test('8) 조립 완료 & 출고 2일 전 → amber', () => {
  const r = assessOrder(order('2026-07-11'), doneUpTo('조립작업'), TODAY);
  assert.equal(r.level, 'amber');
});

test('9) 납기 경과 & 미출고 → overdue', () => {
  const r = assessOrder(order('2026-07-05'), doneUpTo('조립작업'), TODAY);
  assert.equal(r.level, 'overdue');
  assert.ok(r.reasons.some((x) => x.includes('경과')));
});

test('10) ship_scheduled_date 가 due_date 보다 우선', () => {
  const r = assessOrder(order('2026-07-10', { ship_scheduled_date: '2026-07-20' }), doneUpTo('용접작업'), TODAY);
  assert.equal(r.daysLeft, 11);
  assert.equal(r.level, 'green');
});

test('11) 납기일 없음 → unknown (오탐 방지)', () => {
  const r = assessOrder({ status: 'in_production' }, doneUpTo('용접작업'), TODAY);
  assert.equal(r.level, 'unknown');
});

test('12) 이미 출고됨 → shipped', () => {
  const r = assessOrder(order('2026-07-14', { status: 'shipped' }), doneUpTo('출고'), TODAY);
  assert.equal(r.level, 'shipped');
});

test('13) 공정 데이터 없음 + 납기 임박 → red (데이터 누락도 지연으로 포착)', () => {
  const r = assessOrder(order('2026-07-13'), [], TODAY);
  assert.equal(r.level, 'red');
  assert.equal(r.checkpointStarted, false);
});

test('14) 공정 미착수 + 여유 충분 → green', () => {
  const r = assessOrder(order('2026-08-01'), [], TODAY);
  assert.equal(r.level, 'green');
});

test('15) predictedShip = 오늘 + estRemain (분체 완료 → +5일)', () => {
  const r = assessOrder(order('2026-07-14'), doneUpTo('분체작업'), TODAY);
  assert.equal(r.estRemain, REMAIN_AFTER['분체작업']);
  assert.equal(r.predictedShip, '2026-07-14');
});

// ── 관리자 문자 발송 조건: "출고 5일 이내 + 분체 미착수" 만 true ──
const alert = (due, procsArg) => isShipRiskAlert(assessOrder(order(due), procsArg, TODAY));

test('문자대상 O — 분체 미착수 & D-5', () => {
  assert.equal(alert('2026-07-14', doneUpTo('용접작업')), true);
});
test('문자대상 O — 분체 미착수 & D-3', () => {
  assert.equal(alert('2026-07-12', doneUpTo('용접작업')), true);
});
test('문자대상 O — 분체 미착수 & D-0(당일)', () => {
  assert.equal(alert('2026-07-09', doneUpTo('용접작업')), true);
});
test('문자대상 X — 분체 미착수지만 D-6(아직 이름)', () => {
  assert.equal(alert('2026-07-15', doneUpTo('용접작업')), false);
});
test('문자대상 X — 분체 진행중(착수함) & D-5', () => {
  assert.equal(alert('2026-07-14', doneUpTo('용접작업', { '분체작업': 'in_progress' })), false);
});
test('문자대상 X — 분체 완료 & D-5', () => {
  assert.equal(alert('2026-07-14', doneUpTo('분체작업')), false);
});
test('문자대상 X — 이미 납기 경과(분체 미착수라도)', () => {
  assert.equal(alert('2026-07-05', doneUpTo('용접작업')), false);
});
test('문자대상 X — 납기일 없음', () => {
  assert.equal(isShipRiskAlert(assessOrder({ status: 'in_production' }, doneUpTo('용접작업'), TODAY)), false);
});

// ── 평일에만 발송 (주말 제외) ──
// 크론은 23:40 UTC 에 발화 → KST 로는 '다음날 08:40'. 요일 환산 실수를 잡는다.
const fireAt = (utcIso) => Date.parse(utcIso);

test('KST 요일 환산: 23:40 UTC → 다음날 KST 요일', () => {
  assert.equal(kstDayOfWeek(fireAt('2026-07-09T23:40:00Z')), 5); // KST 7/10 금
  assert.equal(kstDayOfWeek(fireAt('2026-07-10T23:40:00Z')), 6); // KST 7/11 토
  assert.equal(kstDayOfWeek(fireAt('2026-07-11T23:40:00Z')), 0); // KST 7/12 일
  assert.equal(kstDayOfWeek(fireAt('2026-07-12T23:40:00Z')), 1); // KST 7/13 월
});

test('금요일 아침(KST) → 발송', () => assert.equal(isKstWeekend(fireAt('2026-07-09T23:40:00Z')), false));
test('토요일 아침(KST) → 미발송', () => assert.equal(isKstWeekend(fireAt('2026-07-10T23:40:00Z')), true));
test('일요일 아침(KST) → 미발송', () => assert.equal(isKstWeekend(fireAt('2026-07-11T23:40:00Z')), true));
test('월요일 아침(KST) → 발송', () => assert.equal(isKstWeekend(fireAt('2026-07-12T23:40:00Z')), false));

test('크론 스케줄 가드: risk-daily 는 UTC 일~목(0-4) — KST 월~금 08:40', () => {
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const cron = vercel.crons.find((c) => c.path === '/api/cron/risk-daily');
  // ⚠️ '1-5'(UTC 월~금)로 바꾸면 KST 화~토가 되어 토요일에 발송됨 — 반드시 0-4
  assert.equal(cron.schedule, '40 23 * * 0-4');
});
