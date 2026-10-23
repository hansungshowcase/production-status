import { buildInternalAlertMessage } from './internalProductionAlerts.js';
import { buildMessage } from './notify.js';
import {
  OVERDUE_REMINDER_DEFINITIONS,
  buildOverdueReminderMessage,
} from './overdueReminders.js';
import { buildAdminAlert } from './solapiDeliveryMonitor.js';
import { buildChonbeAlertMessage } from '../cron/risk-daily.js';

const SAMPLE_LABEL = '문자 예시 · 가상 정보';
const PAUSED_LABEL = '중단된 알림의 문구 예시';
const SAMPLE_DATE = '2026-10-30';
const SAMPLE_ORDER = Object.freeze({
  id: 1001,
  client_name: '가상 고객',
  order_date: '2026-10-20',
  due_date: SAMPLE_DATE,
  ship_scheduled_date: SAMPLE_DATE,
  ship_date: SAMPLE_DATE,
  product_type: '가상 쇼케이스',
  door_type: '양문형',
  width: 1200,
  depth: 700,
  height: 1800,
  quantity: 1,
});
const SAMPLE_TRACK_URL = 'https://production-status.vercel.app/track/EXAMPLE-NOT-A-REAL-TOKEN';
const INTERNAL_TYPES = Object.freeze({
  internal_vcut_completed: 'vcut_completed',
  internal_design_due: 'design_due',
  internal_laser_due: 'laser_due',
  internal_welding_due: 'welding_due',
  internal_assembly_due: 'assembly_due',
});

function sample(message, label = SAMPLE_LABEL) {
  return {
    subject: message.subject,
    text: message.text,
    label,
    source: 'sample',
  };
}

function buildCustomerExample(milestone) {
  return buildMessage(SAMPLE_ORDER, milestone, SAMPLE_TRACK_URL, { date: SAMPLE_DATE });
}

function buildInternalExample(type) {
  return buildInternalAlertMessage({
    type,
    recipientName: '가상 담당자',
    items: [{
      type,
      order: SAMPLE_ORDER,
      daysLeft: 3,
      referenceDate: '2026-10-27',
      currentStep: '가상 공정',
      stepStates: {
        'V-커팅작업': '완료',
        '절곡작업': '완료',
        '용접작업': '대기',
        '조립작업': '진행중',
        '설비작업': '대기',
        '포장': '대기',
      },
    }],
  });
}

function buildOverdueExample(kind) {
  const unshipped = kind === OVERDUE_REMINDER_DEFINITIONS.UNSHIPPED.kind;
  const packing = kind === OVERDUE_REMINDER_DEFINITIONS.PACKING.kind;
  return buildOverdueReminderMessage({
    kind,
    recipientName: packing ? '정영호 팀장' : '가상 담당자',
    kstDate: '2026-10-31',
    orders: packing ? [
      { orderId: 1001, clientName: '가상 거래처 A', dueDay: '2026-11-03', daysLeft: 3, overdueDays: -3 },
      { orderId: 1002, clientName: '가상 거래처 B', dueDay: '2026-10-31', daysLeft: 0, overdueDays: 0 },
      { orderId: 1003, clientName: '가상 거래처 C', dueDay: '2026-10-29', daysLeft: -2, overdueDays: 2 },
    ] : [{
      orderId: 1001,
      clientName: '가상 거래처',
      dueDay: unshipped ? '2026-10-20' : SAMPLE_DATE,
      daysLeft: unshipped ? -11 : -1,
      overdueDays: unshipped ? 11 : 1,
    }],
  });
}

export function buildNotificationExample(item, now = new Date()) {
  const milestone = String(item?.milestone || '');
  if (['ordered', 'started', 'packed', 'rescheduled', 'shipped'].includes(milestone)) {
    return sample(
      buildCustomerExample(milestone),
      item?.policy?.status === 'paused' ? PAUSED_LABEL : SAMPLE_LABEL,
    );
  }
  if (INTERNAL_TYPES[milestone]) return sample(buildInternalExample(INTERNAL_TYPES[milestone]));
  if (Object.values(OVERDUE_REMINDER_DEFINITIONS).some(definition => definition.kind === milestone)) {
    return sample(buildOverdueExample(milestone));
  }
  if (milestone === 'chonbe_alert') {
    return sample(buildChonbeAlertMessage({
      today: '2026-10-30',
      persons: '가상 영업담당자',
      items: [{
        order_id: 1001,
        client_name: '가상 거래처',
        due_date: '2026-11-02',
        days_left: 3,
        current_step: '가상 공정',
      }],
    }));
  }
  if (milestone === 'sms_delivery_block_admin_alert') {
    return sample(buildAdminAlert({
      recipient_name: '가상 수신자',
      to_phone: '010****0000',
      milestone: 'internal_design_due',
    }, {
      statusCode: '2061',
      reason: '가상 전달 결과',
    }, new Date(now).getTime(), 'EXAMPLE-NOT-A-REAL-TOKEN'));
  }
  return null;
}
