import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionAlertMessage } from '../api/_lib/productionAlertMessage.js';
import { buildOverdueReminderMessage, OVERDUE_REMINDER_KINDS as KINDS } from '../api/_lib/overdueReminders.js';

const action = '실제 출고 여부를 확인하시고, 출고된 주문은 출고완료 처리해 주시기 바랍니다.';
const countText = (text, value) => text.split(value).length - 1;

test('employee order lists identify clients and put a shared request only once after the whole list', () => {
  const message = buildProductionAlertMessage({
    subject: '[출고 확인]', recipientName: '영업담당자', date: '2026-10-26',
    items: [
      { orderId: 429, clientName: '본가대성집1층', dueDay: '2026-08-28', action },
      { orderId: 544, clientName: '우담정육점', dueDay: '2026-10-05', action },
    ],
    footerLines: [action], url: 'https://production-status.vercel.app',
  });
  assert.doesNotMatch(message.text, /주문\s*#?\d+/);
  assert.match(message.text, /- 본가대성집1층 \| 납기 2026-08-28/);
  assert.match(message.text, /- 우담정육점 \| 납기 2026-10-05/);
  assert.equal(countText(message.text, action), 1);
  assert.ok(message.text.indexOf(action) > message.text.indexOf('- 우담정육점'));
  assert.ok(message.text.indexOf(action) < message.text.indexOf('https://'));
});

test('same-client orders stay separate while missing client names never fall back to internal IDs', () => {
  const message = buildOverdueReminderMessage({
    kind: KINDS.UNSHIPPED, recipientName: '영업담당자', kstDate: '2026-10-26',
    orders: [
      { orderId: 429, clientName: '같은 거래처', dueDay: '2026-08-28', overdueDays: 59 },
      { orderId: 544, clientName: '같은 거래처', dueDay: '2026-10-05', overdueDays: 21 },
      { orderId: 600, clientName: '', dueDay: '2026-10-01', overdueDays: 25 },
    ],
  });
  assert.equal(message.totalCount, 3);
  assert.equal(countText(message.text, '- 같은 거래처'), 2);
  assert.match(message.text, /거래처명 확인 필요/);
  assert.doesNotMatch(message.text, /주문\s*#?\d+/);
  assert.equal(countText(message.text, action), 1);
});

test('mixed packing dates keep their own timing and share one final packing request', () => {
  const message = buildOverdueReminderMessage({
    kind: KINDS.PACKING, recipientName: '정영호 팀장', kstDate: '2026-10-26',
    orders: [
      { orderId: 1, clientName: '납기 전 거래처', dueDay: '2026-10-29', daysLeft: 3 },
      { orderId: 2, clientName: '오늘 거래처', dueDay: '2026-10-26', daysLeft: 0 },
      { orderId: 3, clientName: '납기 경과 거래처', dueDay: '2026-10-24', daysLeft: -2 },
    ],
  });
  assert.match(message.text, /납기까지 3일 남았습니다/);
  assert.match(message.text, /오늘이 납기일입니다/);
  assert.match(message.text, /납기가 2일 지났습니다/);
  assert.equal(countText(message.text, '포장을 서둘러'), 1);
  assert.ok(message.text.indexOf('포장을 서둘러') > message.text.indexOf('- 납기 경과 거래처'));
});
