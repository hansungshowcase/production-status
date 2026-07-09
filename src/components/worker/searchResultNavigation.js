import { PROCESS_STEPS } from '../../constants.js';

export function getSearchResultNavigation(order) {
  const stepName = order?.currentStepName || PROCESS_STEPS[order?.currentStep];

  if (!stepName || stepName === '-') {
    return { path: `/worker/update/${order.id}` };
  }

  return {
    path: `/worker/station/${encodeURIComponent(stepName)}`,
    state: { focusOrderId: order.id },
  };
}
