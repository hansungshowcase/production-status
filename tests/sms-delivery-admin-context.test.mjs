import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdminAlert } from '../api/_lib/solapiDeliveryMonitor.js';

const source = {
  milestone: 'internal_overdue_equipment',
  recipient_name: '까지',
  to_phone: '010****4537',
  created_at: '2026-10-23T23:40:21.388Z',
};
const nowMs = Date.parse('2026-10-25T15:00:14.000Z');

test('delayed final-failure alert identifies original send and provider result times', () => {
  const message = buildAdminAlert(source, {
    statusCode: '3040',
    reason: '전송시간 초과',
    dateReported: '2026-10-25T14:59:51.000Z',
  }, nowMs, 'existing-token');

  assert.match(message.text, /알림 종류: 납기 지연 설비작업 미완료/);
  assert.doesNotMatch(message.text, /internal_overdue_equipment/);
  assert.match(message.text, /원문 발송 시각: .*2026.*10.*24.*08:40:21/);
  assert.match(message.text, /결과 확정 시각: .*2026.*10.*25.*23:59:51/);
  assert.match(message.text, /확인 시각: .*2026.*10.*26.*00:00:14/);
  assert.match(message.text, /최종 전달 실패: 3040 전송시간 초과/);
  assert.equal(message.tag, 'sms_delivery_final_failure_admin_alert');
  assert.equal(message.customFields.deliveryAlertKey, 'existing-token');
});

test('unknown provider result time is not replaced with the current check time', () => {
  const message = buildAdminAlert(source, {
    statusCode: '3040', reason: '전송시간 초과', dateReported: 'invalid',
  }, nowMs, 'existing-token');

  assert.match(message.text, /원문 발송 시각: .*2026.*10.*24/);
  assert.doesNotMatch(message.text, /결과 확정 시각:|Invalid Date/);
});

test('packing failure context retains existing administrator routing and block policy', () => {
  const message = buildAdminAlert({ ...source, milestone: 'internal_overdue_packing' }, {
    statusCode: '3061', reason: '차단',
  }, nowMs, 'existing-token');

  assert.match(message.text, /알림 종류: 포장 완료 요청/);
  assert.match(message.text, /원문 발송 시각: .*2026.*10.*24/);
  assert.equal(message.tag, 'sms_delivery_block_admin_alert');
  assert.match(message.text, /수신거부 또는 차단 여부를 확인/);
});
