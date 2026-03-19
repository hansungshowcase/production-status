import request from './client';

export function startProcess(processId, data = {}) {
  return request(`/processes/${processId}/start`, { method: 'PATCH', body: data });
}

export function completeProcess(processId, data = {}) {
  return request(`/processes/${processId}/complete`, { method: 'PATCH', body: data });
}

export function getProcessesByStep(stepName) {
  return request(`/processes/by-step/${encodeURIComponent(stepName)}`);
}

export function revertProcess(processId) {
  return request(`/processes/${processId}/revert`, { method: 'PATCH' });
}
