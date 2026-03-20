import request from './client';

export function startProcess(processId, data = {}) {
  if (!processId) throw new Error('processId is required');
  return request(`/processes/${processId}/start`, { method: 'PATCH', body: data });
}

export function completeProcess(processId, data = {}) {
  if (!processId) throw new Error('processId is required');
  return request(`/processes/${processId}/complete`, { method: 'PATCH', body: data });
}

export function getProcessesByStep(stepName) {
  if (!stepName) throw new Error('stepName is required');
  return request(`/processes/by-step/${encodeURIComponent(stepName)}`);
}

export function revertProcess(processId) {
  if (!processId) throw new Error('processId is required');
  return request(`/processes/${processId}/revert`, { method: 'PATCH' });
}
