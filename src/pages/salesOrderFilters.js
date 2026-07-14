import { PROCESS_STEPS } from '../constants.js';
import { extractDueDateFromOrder, formatDueStatus } from '../utils/dateUtils.js';

const PACKING_STEP_NAME = '포장';

export function parseProcessSummary(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

export function isShipped(order) {
  return order?.status === 'shipped' || order?.status === '출고완료' || !!order?.ship_date;
}

export function isOverdue(order) {
  const ds = formatDueStatus(extractDueDateFromOrder(order), order?.status);
  return ds.isOverdue;
}

export function isInProduction(order) {
  return !isShipped(order);
}

export function isPackingCompletedForShipping(order) {
  if (!order || isShipped(order)) return false;

  const summary = parseProcessSummary(order.process_summary);
  if (summary?.[PACKING_STEP_NAME]?.status === 'completed') return true;

  const processes = Array.isArray(order.processes) ? order.processes : [];
  return processes.some(process =>
    process?.step_name === PACKING_STEP_NAME && process?.status === 'completed'
  );
}

export function hasReachedPacking(order) {
  const packingStepIndex = PROCESS_STEPS.indexOf(PACKING_STEP_NAME);
  if (packingStepIndex < 0) return false;

  const summary = parseProcessSummary(order?.process_summary);
  const packing = summary[PACKING_STEP_NAME];
  if (packing?.status === 'in_progress' || packing?.status === 'completed') {
    return true;
  }

  const priorSteps = PROCESS_STEPS.slice(0, packingStepIndex);
  return priorSteps.length > 0 && priorSteps.every(step => summary[step]?.status === 'completed');
}

export function filterSalesOrders(orders, filter) {
  const list = Array.isArray(orders) ? orders : [];
  if (filter === 'in_production') return list.filter(isInProduction);
  if (filter === 'packing_completed') return list.filter(isPackingCompletedForShipping);
  if (filter === 'shipped') return list.filter(isShipped);
  if (filter === 'overdue') return list.filter(isOverdue);
  return list;
}

export function countSalesOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  return {
    totalCount: list.length,
    shippedCount: list.filter(isShipped).length,
    inProductionCount: list.filter(isInProduction).length,
    overdueCount: list.filter(isOverdue).length,
    packingCompletedCount: list.filter(isPackingCompletedForShipping).length,
  };
}

export function getVisibleSalesOrders(orders, visibleCount) {
  const list = Array.isArray(orders) ? orders : [];
  const limit = Math.max(0, Number(visibleCount) || 0);
  const visibleOrders = list.slice(0, limit);
  return {
    visibleOrders,
    hiddenOrderCount: Math.max(0, list.length - visibleOrders.length),
  };
}
