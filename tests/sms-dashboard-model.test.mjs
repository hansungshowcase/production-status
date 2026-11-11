import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeToday, matrixCells, hourlyBars, recentGroups, balanceState, templateCountsView, kstTime,
} from '../src/components/smsconsole/dashboardModel.js';

test('summarizeToday: 빈 값·null 은 0, 실패 경계', () => {
  assert.deepEqual(summarizeToday(null), { total: 0, success: 0, pending: 0, failed: 0, hasFailed: false });
  assert.equal(summarizeToday({ all: { total: 5, success: 5, pending: 0, failed: 0 } }).hasFailed, false);
  const s = summarizeToday({ all: { total: 5, success: 3, pending: 1, failed: 1 } });
  assert.equal(s.hasFailed, true);
  assert.equal(s.total, 5);
  assert.equal(summarizeToday({ all: { total: 'x', failed: -2 } }).failed, 0);
});

test('matrixCells: matrix 없음이면 0, 칸 순서 고정', () => {
  const m = matrixCells(undefined);
  assert.equal(m.rows.length, 2);
  assert.deepEqual(m.rows.map(r => r.aud), ['customer', 'staff']);
  assert.deepEqual(m.rows[0].cells.map(c => c.ch), ['sms', 'kakao']);
  assert.equal(m.rows[0].cells[0].total, 0);
  assert.equal(m.otherTotal, 0);
});

test('matrixCells: 값과 기타 합계', () => {
  const m = matrixCells({
    customer: { sms: { total: 4, failed: 1 }, kakao: { total: 2 }, other: { total: 1 } },
    staff: { sms: { total: 0 }, kakao: { total: 7, failed: 0 }, other: { total: 0 } },
    other: { sms: { total: 2 }, kakao: { total: 1 }, other: { total: 3 } },
  });
  assert.equal(m.rows[0].cells[0].total, 4);
  assert.equal(m.rows[0].cells[0].failed, 1);
  assert.equal(m.rows[1].cells[1].total, 7);
  assert.equal(m.otherTotal, 1 + 2 + 1 + 3);
});

test('hourlyBars: 24개, 비율, 실패 경계', () => {
  const empty = hourlyBars(null);
  assert.equal(empty.length, 24);
  assert.ok(empty.every(b => b.heightPct === 0));
  const bars = hourlyBars([{ hour: 14, total: 6, failed: 0 }, { hour: 9, total: 3, failed: 2 }, { hour: 30, total: 99 }]);
  assert.equal(bars[14].heightPct, 100);
  assert.equal(bars[14].label, '14시 6건');
  assert.equal(bars[14].failPct, 0);
  assert.equal(bars[9].heightPct, 50);
  assert.equal(bars[9].failPct, 67);
  assert.match(bars[9].label, /^9시 3건/);
  assert.equal(hourlyBars([{ hour: 1, total: 1000 }, { hour: 2, total: 1 }])[2].heightPct, 4);
  assert.equal(hourlyBars([{ hour: 1, total: 2, failed: 9 }])[1].failed, 2);
});

test('recentGroups: 앞 5개, 시각·그룹ID 끝 8자리', () => {
  assert.deepEqual(recentGroups(null), []);
  const groups = Array.from({ length: 7 }, (_, i) => ({
    group_id: `G4V0123456789ABC${i}`, created_at: '2026-11-11T05:07:00.000Z', type_label: '알림톡', total: i + 1, success: i + 1, pending: 0, failed: 0,
  }));
  const r = recentGroups(groups);
  assert.equal(r.length, 5);
  assert.equal(r[0].time, '14:07');
  assert.equal(r[0].idTail, '6789ABC0');
  assert.equal(r[0].tone, 'ok');
  const f = recentGroups([{ group_id: 'abc', total: 2, failed: 1 }])[0];
  assert.equal(f.tone, 'danger');
  assert.equal(f.time, '');
  assert.equal(recentGroups([{ total: 1, pending: 1 }])[0].stateLabel, '발송중');
  assert.equal(kstTime('bad'), '');
});

test('balanceState: 5000 경계·null', () => {
  assert.equal(balanceState(null).known, false);
  assert.equal(balanceState(4999).low, true);
  assert.equal(balanceState(5000).low, false);
  assert.equal(balanceState(9679).text, '₩9,679');
  assert.match(balanceState(0).warning, /잔액이 적습니다/);
  assert.equal(balanceState(undefined).text, '확인 못 함');
});

test('templateCountsView: null·반려 강조', () => {
  assert.equal(templateCountsView(null).known, false);
  const v = templateCountsView({ total: 6, APPROVED: 3, INSPECTING: 1, PENDING: 1, REJECTED: 1 });
  assert.deepEqual(v.items.map(i => i.count), [3, 1, 1, 1]);
  assert.equal(v.rejected, 1);
  assert.equal(templateCountsView({}).rejected, 0);
});
