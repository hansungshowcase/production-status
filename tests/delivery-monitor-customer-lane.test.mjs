import assert from 'node:assert/strict';
import test from 'node:test';

import { runSmsDeliveryMonitor } from '../api/_lib/solapiDeliveryMonitor.js';

function row(id, milestone) {
  return {
    id,
    milestone,
    recipient_name: milestone.startsWith('internal_') ? 'internal fixture' : null,
    to_phone: '010****0000',
    provider_msgid: `provider-${id}`,
    created_at: '2026-10-22T00:00:00.000Z',
    delivery_status_code: null,
    delivery_alert_key: null,
  };
}

test('customer and internal delivery lanes each receive twenty slots in one provider batch', async () => {
  const internal = Array.from({ length: 20 }, (_, index) => row(index + 1, 'internal_design_due'));
  const customer = Array.from({ length: 20 }, (_, index) => row(index + 101, index % 2 ? 'packed' : 'ordered'));
  const checked = [];
  const db = {
    async execute({ sql, args = [] }) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      if (compact.startsWith('SELECT') && compact.includes("LEFT(milestone, 9) = 'internal_'")) return { rows: internal };
      if (compact.startsWith('SELECT') && compact.includes("milestone IN ('ordered', 'packed')")) return { rows: customer };
      if (compact.startsWith('UPDATE notification_log')) {
        checked.push(args.at(-1));
        return { rows: [{ id: args.at(-1) }] };
      }
      throw new Error(`Unexpected SQL: ${compact}`);
    },
  };
  const requested = [];

  const summary = await runSmsDeliveryMonitor(db, {
    ensureSchema: async () => {},
    repairPolicy: {
      activationAt: '2026-10-22T00:00:00.000Z',
      deliveryProviderIds: [],
      deliverySourceLogIds: [],
    },
    fetchReports: async (ids) => {
      requested.push(...ids);
      return ids.slice(0, -1).map(messageId => ({
        messageId,
        status: 'COMPLETE',
        statusCode: '4000',
        reason: null,
        dateReported: '2026-10-22T00:01:00.000Z',
        dateReceived: '2026-10-22T00:01:00.000Z',
      }));
    },
    sendAdmin: async () => { throw new Error('customer lane must not alert'); },
  });

  assert.equal(requested.length, 40);
  assert.equal(new Set(requested).size, 40);
  assert.equal(checked.length, 40);
  assert.equal(summary.scanned, 40);
  assert.equal(summary.reported, 39);
  assert.equal(summary.received, 39);
});
