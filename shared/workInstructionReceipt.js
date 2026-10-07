export const WORK_INSTRUCTION_RECEIPT_PENDING_MODE = 'work_instruction_receipt_pending';

export const WORK_INSTRUCTION_RECEIVERS = Object.freeze(['이정섭 부장']);

const RECEIVER_SET = new Set(WORK_INSTRUCTION_RECEIVERS);
const DOWNSTREAM_STEPS = Object.freeze([
  'V-커팅작업',
  '절곡작업',
  '용접작업',
  '분체작업',
  '조립작업',
  '설비작업',
  '포장',
  '출고',
]);

function parseProcessSummary(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

export function isWorkInstructionReceiver(value) {
  return RECEIVER_SET.has(String(value || '').trim());
}

export function hasValidWorkInstructionReceipt(order) {
  if (!order || typeof order !== 'object') return false;
  if (order.work_instruction_revision === null
    || order.work_instruction_revision === undefined
    || String(order.work_instruction_revision).trim() === ''
    || order.work_instruction_received_revision === null
    || order.work_instruction_received_revision === undefined
    || String(order.work_instruction_received_revision).trim() === '') {
    return false;
  }
  const revision = Number(order.work_instruction_revision);
  const receivedRevision = Number(order.work_instruction_received_revision);
  return Number.isInteger(revision)
    && Number.isInteger(receivedRevision)
    && revision === receivedRevision
    && Boolean(order.work_instruction_received_at)
    && Boolean(String(order.work_instruction_received_by || '').trim());
}

export function getWorkInstructionHandoverState(order, summaryValue = null) {
  if (hasValidWorkInstructionReceipt(order)) return 'received';
  if (!order || order.status !== 'in_production') return 'not_required';

  const summary = parseProcessSummary(summaryValue || order.process_summary);
  if (summary?.도면설계?.status !== 'completed') return 'not_required';

  const laserStatus = summary?.레이저작업?.status;
  if (laserStatus === 'in_progress' || laserStatus === 'completed') return 'legacy_active';
  if (laserStatus !== 'waiting') return 'not_required';

  const downstreamStarted = DOWNSTREAM_STEPS.some((step) => {
    const status = summary?.[step]?.status;
    return status === 'in_progress' || status === 'completed';
  });
  return downstreamStarted ? 'legacy_active' : 'pending';
}
