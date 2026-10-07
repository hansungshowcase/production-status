import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_INSTRUCTION_RECEIPT_PENDING_MODE,
  WORK_INSTRUCTION_RECEIVERS,
  getWorkInstructionHandoverState,
  hasValidWorkInstructionReceipt,
  isWorkInstructionReceiver,
} from '../shared/workInstructionReceipt.js';

test('작업지시서 수령자는 현재 명시 레이저 매핑 한 명만 허용한다', () => {
  assert.deepEqual(WORK_INSTRUCTION_RECEIVERS, ['이정섭 부장']);
  assert.equal(isWorkInstructionReceiver('이정섭 부장'), true);
  assert.equal(isWorkInstructionReceiver(' 이정섭 부장 '), true);
  assert.equal(isWorkInstructionReceiver('김보수 팀장'), false);
  assert.equal(isWorkInstructionReceiver('신은철'), false);
  assert.equal(isWorkInstructionReceiver('임의 작업자'), false);
});

test('수령 유효성은 현재 개정과 수령 개정이 같고 시간과 수령자가 모두 있을 때만 성립한다', () => {
  const valid = {
    work_instruction_revision: 3,
    work_instruction_received_revision: 3,
    work_instruction_received_at: '2026-10-07T01:02:03.000Z',
    work_instruction_received_by: '이정섭 부장',
  };
  assert.equal(hasValidWorkInstructionReceipt(valid), true);
  assert.equal(hasValidWorkInstructionReceipt({ ...valid, work_instruction_received_revision: 2 }), false);
  assert.equal(hasValidWorkInstructionReceipt({ ...valid, work_instruction_revision: 0, work_instruction_received_revision: null }), false);
  assert.equal(hasValidWorkInstructionReceipt({ ...valid, work_instruction_revision: '', work_instruction_received_revision: 0 }), false);
  assert.equal(hasValidWorkInstructionReceipt({ ...valid, work_instruction_received_at: null }), false);
  assert.equal(hasValidWorkInstructionReceipt({ ...valid, work_instruction_received_by: '  ' }), false);
});

test('도면 완료 뒤 레이저 대기 주문만 수령 대기로 표시하고 기존 진행 주문은 소급 차단하지 않는다', () => {
  const order = {
    status: 'in_production',
    work_instruction_revision: 1,
    work_instruction_received_revision: null,
    work_instruction_received_at: null,
    work_instruction_received_by: null,
  };
  const pendingSummary = {
    도면설계: { status: 'completed' },
    레이저작업: { status: 'waiting' },
    'V-커팅작업': { status: 'waiting' },
  };
  assert.equal(getWorkInstructionHandoverState(order, pendingSummary), 'pending');
  assert.equal(
    getWorkInstructionHandoverState(order, {
      ...pendingSummary,
      레이저작업: { status: 'in_progress' },
    }),
    'legacy_active',
  );
  assert.equal(
    getWorkInstructionHandoverState(order, {
      ...pendingSummary,
      도면설계: { status: 'in_progress' },
    }),
    'not_required',
  );
  assert.equal(
    getWorkInstructionHandoverState({ ...order, status: 'shipped' }, pendingSummary),
    'not_required',
  );
});

test('유효 수령은 공정 표시보다 우선하며 별도 pending 조회 모드는 고정 문자열이다', () => {
  const order = {
    status: 'in_production',
    work_instruction_revision: 4,
    work_instruction_received_revision: 4,
    work_instruction_received_at: '2026-10-07T01:02:03.000Z',
    work_instruction_received_by: '이정섭 부장',
  };
  assert.equal(getWorkInstructionHandoverState(order, {}), 'received');
  assert.equal(WORK_INSTRUCTION_RECEIPT_PENDING_MODE, 'work_instruction_receipt_pending');
});
