import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ALERT_ROUTES, canonicalAlertRecipientName, routeAlerts } from '../api/_lib/alertRoutes.js';
import {
  isPublicNotificationRow,
  recipientFilterForName,
  serializeInternalNotification,
} from '../api/_lib/internalNotificationHistory.js';
import { resolveInquiryRoute } from '../src/pages/inquiryRouting.js';
import { NOTIFICATION_RECIPIENT_FILTERS } from '../src/pages/smsHistoryFilters.js';

test('황보민수 지연경보는 승인된 연락처로 라우팅하고 이름을 보존한다', () => {
  assert.equal(ALERT_ROUTES['황보민수'], '010-2915-0220');
  assert.equal(canonicalAlertRecipientName(' 황보민수 '), '황보민수');
  const { byPhone, unrouted } = routeAlerts([{ sales_person: ' 황보민수 ', client_name: '검증' }], ALERT_ROUTES, '');
  assert.equal(unrouted.length, 0);
  assert.equal(byPhone.size, 1);
  assert.deepEqual([...byPhone.get('01029150220').persons], ['황보민수']);
});

test('황보민수 고객 문의는 기존 SMS 버튼으로 연결한다', () => {
  assert.deepEqual(resolveInquiryRoute(' 황보민수 '), {
    kind: 'sms',
    manager: '황보민수',
    href: 'sms:01029150220',
    phone: '010-2915-0220',
  });
});

test('황보민수 공개 발송내역은 연락처를 마스킹하고 수신자를 식별한다', () => {
  const row = { id: 1, milestone: 'chonbe_alert', to_phone: '010-2915-0220', status: 'dry_run' };
  assert.equal(isPublicNotificationRow(row), true);
  const item = serializeInternalNotification(row);
  assert.equal(item.recipient_name, '황보민수');
  assert.equal(item.phone, '010****0220');
  assert.doesNotMatch(JSON.stringify(item), /010-?2915-?0220/);
});

test('황보민수 수신자 필터는 화면과 API에서 같은 마스킹 번호를 사용한다', () => {
  assert.ok(NOTIFICATION_RECIPIENT_FILTERS.includes('황보민수'));
  assert.deepEqual(recipientFilterForName('황보민수'), { milestone: 'chonbe_alert', maskedPhone: '010****0220' });
});

test('황보민수 공정 연락처와 고객 문의 안내는 실제 담당자를 표시한다', () => {
  const workerSource = readFileSync(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
  const trackSource = readFileSync(new URL('../src/pages/TrackPage.jsx', import.meta.url), 'utf8');
  assert.match(workerSource, /\{ name: '황보민수', role: '영업', phone: '010-2915-0220' \}/);
  assert.match(trackSource, /출고 관련 문의는 \$\{inquiryRoute\.manager\} 담당자에게/);
  assert.doesNotMatch(trackSource, /출고 관련 문의는 신은철 담당자에게/);
});
