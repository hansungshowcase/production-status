import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import {
  INTERNAL_ALERT_CONTACTS,
  assemblyWorkerPhone,
} from './internalProductionAlerts.js';
import { INTERNAL_MEMBER_NAMES } from './internalNotificationHistory.js';
import { buildNotificationExample } from './notificationExamples.js';
import { OVERDUE_REMINDER_DEFINITIONS } from './overdueReminders.js';
import { DELIVERY_ALERT_ADMIN_PHONE } from './solapiDeliveryMonitor.js';

export const NOTIFICATION_OVERVIEW_DAYS = 7;
const PUBLIC_INTERNAL_HISTORY_START_MS = Date.parse('2026-09-01T00:00:00+09:00');
const UNKNOWN_HISTORY_TEXT = '발송 기록만으로 확인할 수 없음';

const STATUS_LABELS = Object.freeze({
  ready: '발송 가능 설정',
  test: '테스트 모드',
  incomplete: '설정 미완료',
  conditional: '조건부 활성',
  unknown: '확인 불가',
});

const POLICY_LABELS = Object.freeze({
  active: '정책 사용',
  paused: '정책 중단',
  unknown: '확인 불가',
});

const RECENT_STATUS_LABELS = Object.freeze({
  received: '수신 확인',
  processing: '전달 처리 중',
  accepted: '제공사 접수 성공',
  failed: '발송·전달 실패',
  dry_run: '테스트 기록',
  other: '기타 처리',
});

function configured(value) {
  return Boolean(String(value || '').trim());
}
function phoneConfigured(value) {
  return Boolean(String(value || '').replace(/\D/g, ''));
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 8) return `${digits.slice(0, 2)}****`;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function configuration(status, reason, channel) {
  return {
    status,
    label: STATUS_LABELS[status],
    reason,
    channel,
  };
}

function customerConfiguration(env, milestone) {
  if (!configured(env.POSTGRES_URL)) {
    return configuration('incomplete', '기록 DB 설정이 없어 발송 진입점을 실행할 수 없습니다.', '확인 불가');
  }
  if (milestone === 'started' && env.NOTIFY_STARTED !== '1') {
    return configuration('incomplete', '제작 시작 알림 사용 설정이 꺼져 있습니다.', '확인 불가');
  }

  const hasSolapi = configured(env.SOLAPI_API_KEY) && configured(env.SOLAPI_API_SECRET);
  const hasTemplate = configured(env[`SOLAPI_TPL_${milestone.toUpperCase()}`]);
  const hasProfile = configured(env.KAKAO_PF_ID);
  const hasSender = phoneConfigured(env.SMS_SENDER);
  const channel = hasTemplate && hasProfile ? '알림톡 우선 · 문자 대체' : 'LMS';

  if (!hasSolapi) {
    return configuration('test', '메시지 제공사 설정이 없어 실제 전송 없이 테스트 기록만 남습니다.', channel);
  }
  if (!(hasTemplate && hasProfile) && !hasSender) {
    return configuration('incomplete', '알림톡 조합 또는 LMS 발신번호 설정이 필요합니다.', channel);
  }
  if (!configured(env.CRON_SECRET)) {
    return configuration('conditional', '이벤트 발송은 가능하지만 08:30 대기·재시도 실행 설정이 없습니다.', channel);
  }
  return configuration('ready', '이벤트 발송과 08:30 대기·재시도 실행 조건이 충족되었습니다.', channel);
}

function internalConfiguration(env, { scheduled = false, mixed = false, daily = false } = {}) {
  if (!configured(env.POSTGRES_URL)) {
    return configuration('incomplete', '기록 DB 설정이 없어 발송 진입점을 실행할 수 없습니다.', 'LMS');
  }
  if (scheduled && !mixed && !configured(env.CRON_SECRET)) {
    return configuration('incomplete', '주기 실행 인증 설정이 없어 예약 알림을 실행할 수 없습니다.', 'LMS');
  }
  const hasSolapi = configured(env.SOLAPI_API_KEY) && configured(env.SOLAPI_API_SECRET);
  if (!hasSolapi) {
    return configuration('test', '메시지 제공사 설정이 없어 실제 전송 없이 테스트 기록만 남습니다.', 'LMS');
  }
  if (!phoneConfigured(env.SMS_SENDER)) {
    return configuration('incomplete', 'LMS 발신번호 설정이 필요합니다.', 'LMS');
  }
  if (scheduled && mixed && !configured(env.CRON_SECRET)) {
    return configuration('conditional', '이벤트 발송은 가능하지만 평일 08:40 일일 실행 설정이 없습니다.', 'LMS');
  }
  return configuration('ready', scheduled
    ? `${daily ? '매일' : '평일'} 예약 실행과 LMS 발송 조건이 충족되었습니다.`
    : '이벤트 발생 시 LMS 발송 조건이 충족되었습니다.', 'LMS');
}

function monitorConfiguration(env) {
  if (!configured(env.POSTGRES_URL)) {
    return configuration('incomplete', '기록 DB 설정이 없어 감시 대상을 조회할 수 없습니다.', 'LMS');
  }
  if (!(configured(env.SOLAPI_API_KEY) && configured(env.SOLAPI_API_SECRET))) {
    return configuration('incomplete', '제공사 전달 결과를 조회할 설정이 필요합니다.', 'LMS');
  }
  if (!phoneConfigured(env.SMS_SENDER)) {
    return configuration('incomplete', '차단 감지 후 관리자 LMS를 보낼 발신번호 설정이 필요합니다.', 'LMS');
  }
  if (!configured(env.CRON_SECRET)) {
    return configuration('incomplete', '5분 주기 실행 인증 설정이 없습니다.', 'LMS');
  }
  return configuration('ready', '평일 5분 주기 감시와 관리자 LMS 발송 조건이 충족되었습니다.', 'LMS');
}

function policy(status) {
  return { status, label: POLICY_LABELS[status] };
}

function customerRule({ id, name, trigger, timing, milestone }, env) {
  return {
    id,
    name,
    milestone,
    trigger,
    target: '주문에 등록된 고객 연락처',
    timing,
    policy: policy('active'),
    configuration: customerConfiguration(env, milestone),
  };
}

function contactTarget(contact) {
  return `${contact.name} (${maskPhone(contact.phone)})`;
}

function internalRule({ id, name, milestone, trigger, target, timing, scheduled = false, mixed = false, daily = false }, env) {
  return {
    id,
    name,
    milestone,
    trigger,
    target,
    timing,
    policy: policy('active'),
    configuration: internalConfiguration(env, { scheduled, mixed, daily }),
  };
}

function activeAssemblyWorkers() {
  return [...INTERNAL_MEMBER_NAMES]
    .map(name => ({ name, phone: assemblyWorkerPhone(name) }))
    .filter(({ phone }) => phone)
    .map(({ name, phone }) => `${name} (${maskPhone(phone)})`);
}

function salesTargets(env) {
  const names = [...new Set(Object.keys(ALERT_ROUTES).map(canonicalAlertRecipientName).filter(Boolean))];
  const mapped = names.map((name) => {
    const sourceName = Object.keys(ALERT_ROUTES).find(key => canonicalAlertRecipientName(key) === name);
    return `${name} (${maskPhone(ALERT_ROUTES[sourceName])})`;
  });
  const fallbackPhone = String(env.ALERT_FALLBACK || '').replace(/\D/g, '');
  return {
    label: mapped.join(', '),
    fallbackConfigured: fallbackPhone.length > 0,
    fallbackMaskedPhone: maskPhone(fallbackPhone),
  };
}

function withCheckedAt(item, checkedAt) {
  return { ...item, checked_at: checkedAt };
}

function withExample(item, now) {
  try {
    return { ...item, example_message: buildNotificationExample(item, now) };
  } catch {
    return { ...item, example_message: null };
  }
}

export function buildNotificationCatalog(env = process.env, now = new Date()) {
  const checkedAt = new Date(now).toISOString();
  const sales = salesTargets(env);
  const chonbeConfiguration = internalConfiguration(env, { scheduled: true });
  if (chonbeConfiguration.status === 'ready' && !sales.fallbackConfigured) {
    Object.assign(chonbeConfiguration, configuration(
      'conditional',
      '등록된 영업담당자에게만 발송하며, 미매핑 담당자는 대체 수신번호가 없어 제외됩니다.',
      'LMS',
    ));
  }

  const customer = [
    customerRule({
      id: 'customer_ordered', name: '주문 접수 안내', milestone: 'ordered',
      trigger: '주문 생성 또는 작업지시서 등록 시 멱등 발송',
      timing: 'KST 08:00~21:00 즉시 · 외 시간 대기 · 매일 08:30 대기/재시도',
    }, env),
    customerRule({
      id: 'customer_started', name: '제작 시작 안내', milestone: 'started',
      trigger: '주문의 첫 공정인 도면설계가 실제 시작될 때',
      timing: 'KST 08:00~21:00 즉시 · 외 시간 대기 · 매일 08:30 대기/재시도',
    }, env),
    customerRule({
      id: 'customer_packed', name: '포장 완료 안내', milestone: 'packed',
      trigger: '포장 공정 완료 시',
      timing: 'KST 08:00~21:00 즉시 · 외 시간 대기 · 매일 08:30 대기/재시도',
    }, env),
    customerRule({
      id: 'customer_rescheduled', name: '출고 예정일 변경 안내', milestone: 'rescheduled',
      trigger: '미출고 주문의 출고 예정일이 변경될 때',
      timing: 'KST 08:00~21:00 즉시 · 외 시간 대기 · 매일 08:30 대기/재시도',
    }, env),
    {
      id: 'customer_shipped',
      name: '출고 완료 안내',
      milestone: 'shipped',
      trigger: '출고 완료 처리 시 진입하지만 발송 전에 중단',
      target: '주문에 등록된 고객 연락처',
      timing: '신규·재시도·누락 복구 모두 제외',
      policy: policy('paused'),
      configuration: configuration('unknown', '출고 완료 고객 알림은 정책으로 중단되어 실행 설정을 사용하지 않습니다.', '발송 안 함'),
    },
  ].map(item => withExample(withCheckedAt(item, checkedAt), now));

  const internal = [
    internalRule({
      id: 'internal_vcut_completed', name: 'V-커팅 완료 자재 입고 요청', milestone: 'internal_vcut_completed',
      trigger: 'V-커팅 공정 완료 시', target: contactTarget(INTERNAL_ALERT_CONTACTS.material),
      timing: '완료 이벤트 발생 시 · 요일 제한 없음',
    }, env),
    internalRule({
      id: 'internal_design_due', name: '도면 작업 납기 알림', milestone: 'internal_design_due',
      trigger: '생산중 · 납기 0~9일 · 도면설계 미완료', target: contactTarget(INTERNAL_ALERT_CONTACTS.design),
      timing: '월~금 08:40 KST', scheduled: true,
    }, env),
    internalRule({
      id: 'internal_laser_due', name: '레이저 작업 납기 알림', milestone: 'internal_laser_due',
      trigger: '생산중 · 납기 0~8일 · 레이저작업 미완료', target: contactTarget(INTERNAL_ALERT_CONTACTS.laser),
      timing: '월~금 08:40 KST', scheduled: true,
    }, env),
    internalRule({
      id: 'internal_welding_due', name: '용접 착수 납기 알림', milestone: 'internal_welding_due',
      trigger: '생산중 · 납기 0~6일 · 용접작업 미착수', target: contactTarget(INTERNAL_ALERT_CONTACTS.welding),
      timing: '월~금 08:40 KST', scheduled: true,
    }, env),
    internalRule({
      id: 'internal_assembly_due', name: '조립 작업 납기 알림', milestone: 'internal_assembly_due',
      trigger: '생산중 · 납기 0~4일 · 조립작업 미완료', target: contactTarget(INTERNAL_ALERT_CONTACTS.assembly),
      timing: '월~금 08:40 KST', scheduled: true,
    }, env),
    internalRule({
      id: 'internal_packing_due', name: '포장 완료 납기 알림', milestone: 'internal_packing_due',
      trigger: '생산중 · 납기 0~3일 · 포장 미완료', target: contactTarget(INTERNAL_ALERT_CONTACTS.packing),
      timing: '월~금 08:40 KST', scheduled: true,
    }, env),
    internalRule({
      id: 'internal_assembly_daily', name: '조립팀 포장 완료 점검', milestone: 'internal_assembly_daily',
      trigger: '등록 조립작업자가 착수한 주문 중 포장 미완료',
      target: `해당 주문 착수자: ${activeAssemblyWorkers().join(', ')}`,
      timing: '조립 착수 이벤트(주말 제외) · 월~금 08:40 KST 일일 점검', scheduled: true, mixed: true,
    }, env),
    {
      ...internalRule({
        id: 'chonbe_alert', name: '분체 미착수 영업 알림', milestone: 'chonbe_alert',
        trigger: '생산중 · 출고 0~5일 · 분체작업 미착수',
        target: `${sales.label}${sales.fallbackConfigured ? ` · 미매핑 담당자는 대체 수신번호 (${sales.fallbackMaskedPhone})` : ' · 미매핑 담당자는 제외'}`,
        timing: '월~금 08:40 KST', scheduled: true,
      }, env),
      configuration: chonbeConfiguration,
    },
    {
      id: 'sms_delivery_block_admin_alert',
      name: '문자 전달 이상 감시 알림',
      milestone: 'sms_delivery_block_admin_alert',
      milestones: ['sms_delivery_block_admin_alert', 'sms_delivery_final_failure_admin_alert'],
      trigger: '직원 알림의 수신거부·차단 또는 최종 전달 실패가 확인될 때',
      target: `관리자 지정 번호 (${maskPhone(DELIVERY_ALERT_ADMIN_PHONE)})`,
      timing: '월~금 5분 주기',
      policy: policy('active'),
      configuration: monitorConfiguration(env),
    },
    ...Object.values(OVERDUE_REMINDER_DEFINITIONS).map(definition => internalRule({
      id: definition.kind,
      milestone: definition.kind,
      ...definition.overview,
      scheduled: true,
      daily: true,
    }, env)),
  ].map(item => withExample(withCheckedAt(item, checkedAt), now));

  return [
    { id: 'customer', label: '고객 알림', items: customer },
    { id: 'internal', label: '사내·관리 알림', items: internal },
  ];
}

function classifyRecent(row) {
  const deliveryStatusCode = String(row?.delivery_status_code || '');
  if (deliveryStatusCode === '4000') return 'received';
  if (['2000', '3000'].includes(deliveryStatusCode)) return 'processing';
  if (/^[123]\d{3}$/.test(deliveryStatusCode)) return 'failed';
  if (deliveryStatusCode) return 'other';
  if (row?.status === 'success') return 'accepted';
  if (row?.status === 'failed') return 'failed';
  if (row?.status === 'dry_run') return 'dry_run';
  return 'other';
}

function matchesMilestone(item, logMilestone) {
  if (item.milestone === 'rescheduled') return String(logMilestone || '').startsWith('rescheduled:');
  return (item.milestones || [item.milestone]).includes(logMilestone);
}

function emptyCounts() {
  return { total: 0, received: 0, processing: 0, accepted: 0, failed: 0, dry_run: 0, other: 0 };
}

export function attachRecentResults(groups, rows, { available = true } = {}) {
  return groups.map(group => ({
    ...group,
    items: group.items.map(item => {
      if (!available) {
        return {
          ...item,
          recent: { state: 'unavailable', counts: emptyCounts(), latest: null },
        };
      }
      const matching = (rows || []).filter(row => matchesMilestone(item, row.milestone));
      const counts = emptyCounts();
      for (const row of matching) {
        const result = classifyRecent(row);
        counts.total += 1;
        counts[result] += 1;
      }
      const latestRow = matching[0] || null;
      const latestStatus = latestRow ? classifyRecent(latestRow) : null;
      return {
        ...item,
        recent: {
          state: matching.length ? 'available' : 'empty',
          counts,
          latest: latestRow ? {
            status: latestStatus,
            label: RECENT_STATUS_LABELS[latestStatus],
            channel: latestRow.channel || null,
            occurred_at: latestRow.created_at || null,
          } : null,
        },
      };
    }),
  }));
}

function safeHistoryName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 120) : fallback;
}

function unknownHistoryRule(row, checkedAt) {
  const milestone = String(row?.milestone || '');
  const createdAtMs = Date.parse(String(row?.created_at || ''));
  const publicHistory = Number.isFinite(createdAtMs) && createdAtMs >= PUBLIC_INTERNAL_HISTORY_START_MS;
  const messageText = publicHistory ? String(row?.message_text || '').trim() : '';
  const messageSubject = publicHistory ? String(row?.message_subject || '').trim() : '';
  return {
    id: milestone,
    name: safeHistoryName(messageSubject, milestone),
    milestone,
    trigger: UNKNOWN_HISTORY_TEXT,
    target: UNKNOWN_HISTORY_TEXT,
    timing: UNKNOWN_HISTORY_TEXT,
    policy: policy('unknown'),
    configuration: configuration('unknown', UNKNOWN_HISTORY_TEXT, row?.channel || '확인 불가'),
    checked_at: checkedAt,
    example_message: messageText ? {
      subject: messageSubject,
      text: messageText,
      label: '최근 실제 발송 문구',
      source: 'history',
    } : null,
  };
}

export async function loadNotificationOverview(db, env = process.env, now = new Date()) {
  const checkedAt = new Date(now).toISOString();
  const baseGroups = buildNotificationCatalog(env, now);
  const periodStart = new Date(new Date(now).getTime() - NOTIFICATION_OVERVIEW_DAYS * 86400000).toISOString();
  const knownMilestones = [...new Set(baseGroups.flatMap(group => group.items.flatMap(item => (
    item.milestones || [item.milestone]
  ))))];
  const recentExactMilestones = knownMilestones.filter(milestone => milestone !== 'rescheduled' && !milestone.startsWith('internal_'));
  const recentPlaceholders = recentExactMilestones.map(() => '?').join(', ');
  const discoveryPlaceholders = knownMilestones.map(() => '?').join(', ');

  const [recentResult, discoveryResult] = await Promise.allSettled([
    db.execute({
      sql: `SELECT milestone, channel, created_at, status, delivery_status_code, message_subject, message_text
              FROM notification_log
             WHERE created_at >= ?
               AND (
                 milestone IN (${recentPlaceholders})
                 OR milestone LIKE 'rescheduled:%'
                 OR LEFT(milestone, 9) = 'internal_'
               )
             ORDER BY created_at DESC, id DESC`,
      args: [periodStart, ...recentExactMilestones],
    }),
    db.execute({
      sql: `SELECT milestone, channel, created_at, status, delivery_status_code, message_subject, message_text
              FROM (
                SELECT DISTINCT ON (milestone)
                       milestone, channel, created_at, status, delivery_status_code, message_subject, message_text
                  FROM notification_log
                 WHERE LEFT(milestone, 9) = 'internal_'
                   AND milestone NOT IN (${discoveryPlaceholders})
                 ORDER BY milestone, created_at DESC, id DESC
              ) latest
             ORDER BY created_at DESC, milestone
             LIMIT 201`,
      args: knownMilestones,
    }),
  ]);

  const recentAvailable = recentResult.status === 'fulfilled';
  const recentRows = recentAvailable ? recentResult.value.rows || [] : [];
  let groups = baseGroups;
  let catalogStatus = { state: 'unavailable', message: '추가 사내 알림 발송 기록을 조회할 수 없습니다.' };
  if (discoveryResult.status === 'fulfilled') {
    const known = new Set(knownMilestones);
    const discovered = [];
    const seen = new Set();
    for (const row of discoveryResult.value.rows || []) {
      const milestone = String(row?.milestone || '');
      if (!milestone.startsWith('internal_') || known.has(milestone) || seen.has(milestone)) continue;
      seen.add(milestone);
      discovered.push(row);
      if (discovered.length === 200) break;
    }
    const internalIndex = groups.findIndex(group => group.id === 'internal');
    if (internalIndex >= 0 && discovered.length) {
      groups = groups.map((group, index) => index === internalIndex ? {
        ...group,
        items: [...group.items, ...discovered.map(row => unknownHistoryRule(row, checkedAt))],
      } : group);
    }
    const partial = (discoveryResult.value.rows || []).length > 200;
    catalogStatus = partial
      ? { state: 'partial', message: '추가 사내 알림이 200개를 넘어 최신 200개만 표시합니다.' }
      : { state: 'available' };
  }

  return {
    checked_at: checkedAt,
    recent_period: { days: NOTIFICATION_OVERVIEW_DAYS, from: periodStart, to: checkedAt },
    log_status: recentAvailable
      ? { state: 'available', message: '최근 처리 기록을 조회했습니다.' }
      : { state: 'unavailable', message: '정책과 설정은 확인했지만 최근 처리 기록은 조회할 수 없습니다.' },
    catalog_status: catalogStatus,
    groups: attachRecentResults(groups, recentRows, { available: recentAvailable }),
  };
}
