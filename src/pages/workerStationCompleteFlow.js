export function shouldStartNextStepOnServer(currentStep, selectedNextStep) {
  return Boolean(currentStep && selectedNextStep && currentStep !== '도면설계');
}

export function getCompletionDestination(currentStep, selectedNextStep) {
  if (currentStep === '도면설계') return '작업지시서 수령 대기';
  return selectedNextStep || null;
}

export function getConfirmedNextStep({ processSteps, currentStep, selectedNextStep }) {
  if (selectedNextStep) return selectedNextStep;
  const currentStepIndex = processSteps.indexOf(currentStep);
  return currentStepIndex >= 0 && currentStepIndex < processSteps.length - 1
    ? processSteps[currentStepIndex + 1]
    : null;
}

export function shouldStartSelectedNextStepInClient({ currentStep, selectedNextStep, targetStatus }) {
  if (!selectedNextStep) return false;
  if (currentStep === '도면설계') return false;
  if (shouldStartNextStepOnServer(currentStep, selectedNextStep)) return false;
  return targetStatus !== 'in_progress' && targetStatus !== 'completed';
}

export function buildCompleteProcessPayload({ actor, currentStep, selectedNextStep }) {
  const payload = { actor };
  if (shouldStartNextStepOnServer(currentStep, selectedNextStep)) {
    payload.start_next_step = selectedNextStep;
    payload.assigned_worker = actor;
    payload.assigned_team = selectedNextStep;
  }
  return payload;
}
