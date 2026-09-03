import { daysBetween, isKstWeekend, kstToday } from './risk.js';
import { STEPS } from './steps.js';
import { sendAdminLms } from './notify.js';
import { ensureNotifySchema } from './notifySchema.js';

export const INTERNAL_ALERT_CONTACTS = {
  material: { name: '이시아 부장', phone: '010-4221-4237' },
  welding: { name: '최우석 이사', phone: '010-8308-5110' },
  laser: { name: '이정섭 부장', phone: '010-3240-5938' },
  design: { name: '김보수 팀장', phone: '010-9097-4034' },
  assembly: { name: '박상규 공장장', phone: '010-9322-3904' },
  packing: { name: '정영호 팀장', phone: '010-9095-0577' },
};

const ASSEMBLY_WORKER_PHONES = {
  '강종효': '010-9606-0873',
  '카우사르': '010-8302-2576',
  '까우사르': '010-8302-2576',
  '나타왓': '010-2157-9396',
  '마카라': '010-2356-8947',
  '백승정': '010-8725-4464',
  '까지': '010-8470-4537',
};

export function canonicalAssemblyWorkerName(workerName) {
  const name = String(workerName || '').trim();
  if (name === '까우사르') return '카우사르';
  return ASSEMBLY_WORKER_PHONES[name] ? name : '';
}

export function assemblyWorkerPhone(workerName) {
  const canonicalName = canonicalAssemblyWorkerName(workerName);
  return canonicalName ? ASSEMBLY_WORKER_PHONES[canonicalName] : '';
}

const STATUS_RANK = {
  waiting: 1,
  in_progress: 2,
  completed: 3,
};

function summarizeProcesses(processes) {
  const byStep = new Map();
  for (const process of processes) {
    const previous = byStep.get(process.step_name);
    if (!previous || (STATUS_RANK[process.status] || 0) > (STATUS_RANK[previous.status] || 0)) {
      byStep.set(process.step_name, process);
    }
  }

  const inProgress = [...byStep.values()]
    .filter(process => process.status === 'in_progress')
    .sort((a, b) => STEPS.indexOf(b.step_name) - STEPS.indexOf(a.step_name))[0];
  const firstWaiting = STEPS.find(step => byStep.get(step)?.status === 'waiting');
  const lastCompleted = [...byStep.values()]
    .filter(process => process.status === 'completed')
    .sort((a, b) => STEPS.indexOf(b.step_name) - STEPS.indexOf(a.step_name))[0];

  return {
    byStep,
    currentStep: inProgress?.step_name || firstWaiting || lastCompleted?.step_name || STEPS[0],
  };
}

function isCompleted(process) {
  return process?.status === 'completed';
}

function isStarted(process) {
  return process?.status === 'in_progress' || isCompleted(process);
}

function statusLabel(process) {
  if (!process) return '미도달';
  if (process.status === 'completed') return '완료';
  if (process.status === 'in_progress') return '진행중';
  return '대기';
}

function makeAlertItem({ type, contact, order, summary, daysLeft, stateKey, alertDate = null, recipientName = null, phone = null }) {
  return {
    type,
    orderId: Number(order.id),
    order,
    recipientName: recipientName || contact.name,
    phone: phone || contact.phone,
    stateKey,
    alertDate,
    daysLeft,
    currentStep: summary.currentStep,
    stepStates: Object.fromEntries(STEPS.map(step => [step, statusLabel(summary.byStep.get(step))])),
  };
}

export function collectInternalDailyAlerts({ orders = [], processes = [], today }) {
  const processesByOrder = new Map();
  for (const process of processes) {
    const orderId = Number(process.order_id);
    if (!processesByOrder.has(orderId)) processesByOrder.set(orderId, []);
    processesByOrder.get(orderId).push(process);
  }

  const alerts = [];
  for (const order of orders) {
    if (order.status !== 'in_production') continue;
    const effectiveDueDate = order.ship_scheduled_date || order.due_date;
    const daysLeft = daysBetween(today, effectiveDueDate);
    if (daysLeft === null) continue;

    const orderProcesses = processesByOrder.get(Number(order.id)) || [];
    const summary = summarizeProcesses(orderProcesses);
    const design = summary.byStep.get('도면설계');
    const laser = summary.byStep.get('레이저작업');
    const welding = summary.byStep.get('용접작업');
    const assembly = summary.byStep.get('조립작업');
    const packing = summary.byStep.get('포장');

    if (daysLeft >= 0) {
      if (daysLeft <= 9 && !isCompleted(design)) {
        alerts.push(makeAlertItem({
          type: 'design_due', contact: INTERNAL_ALERT_CONTACTS.design, order, summary, daysLeft,
          stateKey: 'internal:design_due',
        }));
      }
      if (daysLeft <= 8 && !isCompleted(laser)) {
        alerts.push(makeAlertItem({
          type: 'laser_due', contact: INTERNAL_ALERT_CONTACTS.laser, order, summary, daysLeft,
          stateKey: 'internal:laser_due',
        }));
      }
      if (daysLeft <= 6 && !isStarted(welding)) {
        alerts.push(makeAlertItem({
          type: 'welding_due', contact: INTERNAL_ALERT_CONTACTS.welding, order, summary, daysLeft,
          stateKey: 'internal:welding_due',
        }));
      }
      if (daysLeft <= 4 && !isCompleted(assembly)) {
        alerts.push(makeAlertItem({
          type: 'assembly_due', contact: INTERNAL_ALERT_CONTACTS.assembly, order, summary, daysLeft,
          stateKey: 'internal:assembly_due',
        }));
      }
      if (daysLeft <= 3 && !isCompleted(packing)) {
        alerts.push(makeAlertItem({
          type: 'packing_due', contact: INTERNAL_ALERT_CONTACTS.packing, order, summary, daysLeft,
          stateKey: 'internal:packing_due',
        }));
      }
    }

    if (!isCompleted(packing)) {
      const assemblyWorkers = new Set();
      for (const process of orderProcesses) {
        const worker = canonicalAssemblyWorkerName(process.started_by);
        if (worker) assemblyWorkers.add(worker);
      }
      for (const worker of assemblyWorkers) {
        alerts.push(makeAlertItem({
          type: 'assembly_daily',
          order,
          summary,
          daysLeft,
          stateKey: `internal:assembly_daily:${worker}`,
          alertDate: today,
          recipientName: worker,
          phone: assemblyWorkerPhone(worker),
        }));
      }
    }
  }
  return alerts;
}

export function groupInternalAlerts(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.type}:${String(item.phone || '').replace(/\D/g, '')}`;
    if (!groups.has(key)) {
      groups.set(key, {
        type: item.type,
        recipientName: item.recipientName,
        phone: item.phone,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function effectiveDueDate(order) {
  return order.ship_scheduled_date || order.due_date || null;
}

function ddayLabel(daysLeft) {
  if (daysLeft === 0) return 'D-DAY';
  if (daysLeft > 0) return `D-${daysLeft}`;
  return `D+${Math.abs(daysLeft)}`;
}

function orderLabel(order) {
  const product = [order.product_type, order.door_type].filter(Boolean).join('/');
  const dimensions = [order.width, order.depth, order.height]
    .filter(value => value !== null && value !== undefined && value !== '')
    .join('x');
  return [order.client_name || `주문 ${order.id}`, product, dimensions].filter(Boolean).join(' / ');
}

function orderLine(item) {
  const dueDate = effectiveDueDate(item.order) || '납기 미입력';
  const due = `${dueDate} (${ddayLabel(item.daysLeft)})`;
  if (item.type === 'welding_due') {
    return `- ${orderLabel(item.order)} | 납기 ${due} | V-커팅 ${item.stepStates['V-커팅작업']} · 절곡 ${item.stepStates['절곡작업']} · 용접 ${item.stepStates['용접작업']}`;
  }
  if (item.type === 'assembly_due') {
    const state = ['대기', '미도달'].includes(item.stepStates['조립작업'])
      ? '조립 미도달'
      : `조립 ${item.stepStates['조립작업']}`;
    return `- ${orderLabel(item.order)} | 납기 ${due} | 현재 ${item.currentStep} · ${state}`;
  }
  if (item.type === 'packing_due') {
    return `- ${orderLabel(item.order)} | 납기 ${due} | 설비 ${item.stepStates['설비작업']} · 포장 ${item.stepStates['포장']}`;
  }
  return `- ${orderLabel(item.order)} | 납기 ${due} | 현재 ${item.currentStep}`;
}

const MESSAGE_CONFIG = {
  design_due: {
    subject: '[한성쇼케이스 도면 작업 요청]',
    intro: count => `납기 9일 이내인데 도면설계가 아직 완료되지 않은 작업 ${count}건입니다.`,
    instruction: '후속 생산공정이 일정대로 시작될 수 있도록 도면 작업을 서둘러 진행해 주세요.',
  },
  laser_due: {
    subject: '[한성쇼케이스 레이저 작업 요청]',
    intro: count => `납기 8일 이내인데 레이저작업이 아직 완료되지 않은 작업 ${count}건입니다.`,
    instruction: '후속 공정이 지연되지 않도록 레이저 가공을 서둘러 진행해 주세요.',
  },
  welding_due: {
    subject: '[한성쇼케이스 용접 착수 점검]',
    intro: count => `납기 6일 이내인데 용접작업이 아직 시작되지 않은 작업 ${count}건입니다.`,
    instruction: '용접작업이 지체 없이 시작될 수 있도록 V-커팅과 절곡 진행 상황을 확인하고 담당자를 지정해 주세요.',
  },
  assembly_due: {
    subject: '[한성쇼케이스 조립 진행 요청]',
    intro: count => `납기 4일 이내인데 조립작업이 아직 완료되지 않은 작업 ${count}건입니다.`,
    instruction: '빠르게 진행 상황을 확인하고 조립 담당자 지정 및 완료 일정을 점검해 주세요.',
  },
  packing_due: {
    subject: '[한성쇼케이스 포장 완료 요청]',
    intro: count => `납기 3일 이내인데 포장이 아직 완료되지 않은 작업 ${count}건입니다.`,
    instruction: '설비작업에서 끝나지 않고 포장 완료까지 이어질 수 있도록 현재 진행 상황을 확인하고 필요한 담당자를 지정해 주세요.',
  },
  assembly_daily: {
    subject: '[한성쇼케이스 포장 완료 점검]',
    intro: count => `본인이 시작한 작업 중 포장이 아직 완료되지 않았습니다. 확인 대상 ${count}건입니다.`,
    instruction: '용접작업에서 끝나는 것이 아니라 포장 완료까지 이어질 수 있도록 진행 상황을 확인해 주세요.\n납기는 한성 팀원 모두의 책임입니다.',
  },
};

export function buildInternalAlertMessage(group) {
  const { type, recipientName, items = [] } = group || {};
  if (type === 'vcut_completed') {
    const item = items[0];
    if (!item) return { subject: '[한성쇼케이스 자재 입고 요청]', text: '' };
    const dueDate = effectiveDueDate(item.order) || '납기 미입력';
    return {
      subject: '[한성쇼케이스 자재 입고 요청]',
      text: [
        '[한성쇼케이스 자재 입고 요청]',
        `${recipientName}님,`,
        `${orderLabel(item.order)} 건의 V-커팅 작업이 완료되었습니다.`,
        '현장 작업이 지체되지 않도록 해당 작업의 자재가 바로 입고될 수 있게 확인해 주세요.',
        `납기: ${dueDate} (${ddayLabel(item.daysLeft)})`,
      ].join('\n'),
    };
  }

  const config = MESSAGE_CONFIG[type];
  if (!config) return { subject: '[한성쇼케이스 생산 알림]', text: '' };
  const listed = items.slice(0, 10).map(orderLine);
  if (items.length > 10) listed.push(`외 ${items.length - 10}건 — 생산현황에서 전체 확인`);
  return {
    subject: config.subject,
    text: [
      config.subject,
      `${recipientName}님,`,
      config.intro(items.length),
      '',
      ...listed,
      '',
      config.instruction,
    ].join('\n'),
  };
}

export function createVcutCompletionAlert({ order, today, completedBy = null }) {
  const daysLeft = daysBetween(today, effectiveDueDate(order));
  return {
    ...makeAlertItem({
      type: 'vcut_completed',
      contact: INTERNAL_ALERT_CONTACTS.material,
      order,
      summary: summarizeProcesses([]),
      daysLeft: daysLeft ?? 0,
      stateKey: 'internal:vcut_completed',
    }),
    completedBy,
  };
}

export function createAssemblyStartAlert({ order, process, workerName, today, nowMs = Date.now() }) {
  const canonicalName = canonicalAssemblyWorkerName(workerName);
  if (!canonicalName || isKstWeekend(nowMs) || order?.status !== 'in_production') return null;
  const daysLeft = daysBetween(today, effectiveDueDate(order));
  if (daysLeft === null) return null;
  const summary = summarizeProcesses([{ ...process, status: 'in_progress', started_by: canonicalName }]);
  return makeAlertItem({
    type: 'assembly_daily',
    order,
    summary,
    daysLeft,
    stateKey: `internal:assembly_daily:${canonicalName}`,
    alertDate: today,
    recipientName: canonicalName,
    phone: assemblyWorkerPhone(canonicalName),
  });
}

const INTERNAL_SENDING_STALE_MS = 5 * 60 * 1000;

async function claimInternalAlert(db, item, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - INTERNAL_SENDING_STALE_MS).toISOString();
  const state = {
    status: 'internal_sending',
    at: nowIso,
    type: item.type,
    recipient: item.recipientName,
    ...(item.alertDate ? { date: item.alertDate } : {}),
  };

  if (item.alertDate) {
    const { rows } = await db.execute({
      sql: `UPDATE orders
               SET notify_state = COALESCE(notify_state, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb)
             WHERE id = ?
               AND (
                 COALESCE(notify_state -> (?::text) ->> 'date', '') <> ?
                 OR COALESCE(notify_state -> (?::text) ->> 'status', '') = 'internal_failed'
                 OR (
                   COALESCE(notify_state -> (?::text) ->> 'status', '') = 'internal_sending'
                   AND COALESCE(notify_state -> (?::text) ->> 'at', '') < ?
                 )
               )
             RETURNING id`,
      args: [
        item.stateKey,
        JSON.stringify(state),
        item.orderId,
        item.stateKey,
        item.alertDate,
        item.stateKey,
        item.stateKey,
        item.stateKey,
        staleBefore,
      ],
    });
    return rows.length > 0;
  }

  const { rows } = await db.execute({
    sql: `UPDATE orders
             SET notify_state = COALESCE(notify_state, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb)
           WHERE id = ?
             AND COALESCE(notify_state -> (?::text) ->> 'status', '') NOT IN ('internal_success', 'internal_dry_run')
             AND NOT (
               COALESCE(notify_state -> (?::text) ->> 'status', '') = 'internal_sending'
               AND COALESCE(notify_state -> (?::text) ->> 'at', '') >= ?
             )
           RETURNING id`,
    args: [
      item.stateKey,
      JSON.stringify(state),
      item.orderId,
      item.stateKey,
      item.stateKey,
      item.stateKey,
      staleBefore,
    ],
  });
  return rows.length > 0;
}

async function finishInternalAlert(db, item, result, nowMs) {
  const status = result.dryRun
    ? 'internal_dry_run'
    : result.ok
      ? 'internal_success'
      : 'internal_failed';
  const state = {
    status,
    at: new Date(nowMs).toISOString(),
    type: item.type,
    recipient: item.recipientName,
    ...(item.alertDate ? { date: item.alertDate } : {}),
    ...(result.msgId ? { msg_id: result.msgId } : {}),
    ...(result.error ? { error: String(result.error).slice(0, 200) } : {}),
  };
  await db.execute({
    sql: `UPDATE orders
             SET notify_state = COALESCE(notify_state, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb)
           WHERE id = ?`,
    args: [item.stateKey, JSON.stringify(state), item.orderId],
  });
}

export async function sendInternalAlertGroup(db, group, options = {}) {
  const sendLms = options.sendLms || sendAdminLms;
  const ensureSchema = options.ensureSchema || ensureNotifySchema;
  const nowMs = options.nowMs ?? Date.now();
  await ensureSchema(db);

  const claimed = [];
  for (const item of group?.items || []) {
    if (await claimInternalAlert(db, item, nowMs)) claimed.push(item);
  }
  const skipped = (group?.items?.length || 0) - claimed.length;
  if (claimed.length === 0) return { sent: 0, failed: 0, skipped };

  const claimedGroup = { ...group, items: claimed };
  const message = buildInternalAlertMessage(claimedGroup);
  let result;
  try {
    result = await sendLms(db, {
      to: group.phone,
      recipientName: group.recipientName,
      subject: message.subject,
      text: message.text,
      tag: `internal_${group.type}`,
    });
  } catch (error) {
    result = { ok: false, channel: 'lms', error: error?.message || String(error) };
  }

  for (const item of claimed) {
    await finishInternalAlert(db, item, result, nowMs);
  }
  if (result.ok || result.dryRun) {
    return { sent: claimed.length, failed: 0, skipped, dryRun: Boolean(result.dryRun) };
  }
  return { sent: 0, failed: claimed.length, skipped, error: result.error || null };
}

export async function notifyInternalProcessCompletion(db, payload = {}, options = {}) {
  const completedStepNames = Array.isArray(payload.completedStepNames)
    ? payload.completedStepNames
    : [];
  if (!payload.order || !completedStepNames.includes('V-커팅작업')) {
    return { sent: 0, failed: 0, skipped: 'not_vcut' };
  }

  const item = createVcutCompletionAlert({
    order: payload.order,
    completedBy: payload.completedBy || null,
    today: payload.today || kstToday(),
  });
  const group = groupInternalAlerts([item])[0];
  const sendGroup = options.sendGroup || sendInternalAlertGroup;
  return sendGroup(db, group, options);
}

export async function notifyInternalProcessStart(db, payload = {}, options = {}) {
  const item = createAssemblyStartAlert({
    order: payload.order,
    process: payload.process,
    workerName: payload.workerName,
    today: payload.today || kstToday(),
    nowMs: payload.nowMs ?? Date.now(),
  });
  if (!item) return { sent: 0, failed: 0, skipped: 'not_target' };

  const group = groupInternalAlerts([item])[0];
  const sendGroup = options.sendGroup || sendInternalAlertGroup;
  return sendGroup(db, group, options);
}
