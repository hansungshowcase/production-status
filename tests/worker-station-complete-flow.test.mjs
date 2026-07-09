import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompleteProcessPayload,
  getConfirmedNextStep,
  shouldStartNextStepOnServer,
  shouldStartSelectedNextStepInClient,
} from '../src/pages/workerStationCompleteFlow.js';

test('packing to shipping is handled by the complete API fast path', () => {
  assert.equal(shouldStartNextStepOnServer('포장', '출고'), true);
  assert.equal(shouldStartSelectedNextStepInClient({
    currentStep: '포장',
    selectedNextStep: '출고',
    targetStatus: 'waiting',
  }), false);
});

test('non packing transitions are handled by the complete API instead of client-side chaining', () => {
  assert.equal(shouldStartNextStepOnServer('도면설계', '설비작업'), true);
  assert.equal(shouldStartSelectedNextStepInClient({
    currentStep: '도면설계',
    selectedNextStep: '설비작업',
    targetStatus: 'waiting',
  }), false);
});

test('complete payload requests server-side selected routing for any selected target', () => {
  assert.deepEqual(buildCompleteProcessPayload({
    actor: '작업자A',
    currentStep: '포장',
    selectedNextStep: '출고',
  }), {
    actor: '작업자A',
    start_next_step: '출고',
    assigned_worker: '작업자A',
    assigned_team: '출고',
  });

  assert.deepEqual(buildCompleteProcessPayload({
    actor: '작업자A',
    currentStep: '도면설계',
    selectedNextStep: '설비작업',
  }), {
    actor: '작업자A',
    start_next_step: '설비작업',
    assigned_worker: '작업자A',
    assigned_team: '설비작업',
  });
});

test('confirmed routing uses the selected step instead of the adjacent process', () => {
  assert.equal(getConfirmedNextStep({
    processSteps: ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장', '출고'],
    currentStep: '도면설계',
    selectedNextStep: '설비작업',
  }), '설비작업');

  assert.equal(getConfirmedNextStep({
    processSteps: ['도면설계', '레이저작업', 'V-커팅작업'],
    currentStep: '도면설계',
    selectedNextStep: null,
  }), '레이저작업');
});
