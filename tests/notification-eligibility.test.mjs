import assert from 'node:assert/strict';
import test from 'node:test';

import * as notify from '../api/_lib/notify.js';

const base = {
  phoneFieldChanged: true,
  beforePhone: '번호 없음',
  afterPhone: '010-1234-5678',
  orderStatus: 'in_production',
  orderedState: { status: 'skipped', reason: 'no_phone' },
  eventAt: '2026-10-22T06:00:00.000Z',
  activationAt: '2026-10-22T05:00:00.000Z',
};

test('no_phone recovery requires the exact post-activation invalid-to-valid transition', () => {
  assert.equal(typeof notify.isNoPhoneRecoveryTransition, 'function');
  assert.equal(notify.isNoPhoneRecoveryTransition(base), true);

  const rejected = [
    { phoneFieldChanged: false },
    { beforePhone: '010-9999-8888' },
    { afterPhone: '1234' },
    { orderStatus: 'shipped' },
    { orderedState: { status: 'skipped', reason: 'other' } },
    { orderedState: { status: 'success' } },
    { eventAt: '2026-10-22T04:59:59.999Z' },
    { eventAt: 'invalid' },
    { activationAt: '' },
  ];
  for (const change of rejected) {
    assert.equal(notify.isNoPhoneRecoveryTransition({ ...base, ...change }), false);
  }
});

test('notification phone normalization uses the existing digits and minimum-length rule', () => {
  assert.equal(typeof notify.normalizeNotificationPhone, 'function');
  assert.equal(notify.normalizeNotificationPhone('010-1234-5678'), '01012345678');
  assert.equal(notify.normalizeNotificationPhone(' 02 123 4567 '), '021234567');
  assert.equal(notify.normalizeNotificationPhone('12345678'), null);
  assert.equal(notify.normalizeNotificationPhone(null), null);
});
