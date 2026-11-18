import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCostOf } from '../api/_lib/smsAutoSend.js';
import { isKakaoEntry } from '../src/components/smsconsole/smsTemplateListModel.js';
import { sendCostText } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

const PRICE = { SMS: 18, LMS: 45, MMS: 110 };
const vendor = {
  estimate: ({ type, count }) => ({ total: PRICE[type] * count }),
  estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }),
  estimateBms: ({ count }) => ({ unit: 100, total: 100 * count, fallback_unit: 45 }),
};

test('isKakaoEntry: 브랜드메시지·알림톡은 카톡, 빈 값은 아님', () => {
  assert.equal(isKakaoEntry({ autoKind: 'review', autoAtaTemplate: 'BMS_FREE' }), true);
  assert.equal(isKakaoEntry({ autoKind: 'review', autoAtaTemplate: 'KA01TP000' }), true);
  assert.equal(isKakaoEntry({ autoKind: 'review', autoAtaTemplate: '' }), false);
  assert.equal(isKakaoEntry(undefined), false);
});

test('sendCostOf: 브랜드메시지·알림톡·문자·사진 광고', () => {
  const kind = 'ship_plus_days';
  assert.deepEqual(sendCostOf({ auto_kind: kind, auto_ata_template: 'BMS_FREE', body: 'x' }, vendor, {}), { type: 'BMS', unit: 100, parts: [{ type: 'BMS', count: 1 }], fallback_unit: 45 });
  assert.deepEqual(sendCostOf({ auto_kind: kind, auto_ata_template: 'KA01TP000', body: 'x' }, vendor, {}), { type: 'ATA', unit: 13, parts: [{ type: 'ATA', count: 1 }] });
  const sms = sendCostOf({ name: 'a', body: '짧은 글' }, vendor, {});
  assert.equal(sms.type, 'SMS'); assert.equal(sms.unit, 18);
  const photo = sendCostOf({ name: 'a', body: '광고 본문 '.repeat(30), image_count: 3 }, vendor, {});
  assert.deepEqual(photo.parts, [{ type: 'MMS', count: 3 }, { type: 'LMS', count: 1 }]);
  assert.equal(photo.unit, 375);
  assert.equal(sendCostOf({ body: 'x' }, null, {}), null);
});

test('sendCostText: 출력 형식', () => {
  assert.equal(sendCostText({ type: 'BMS', unit: 100, parts: [{ type: 'BMS', count: 1 }], fallback_unit: 45 }), '브랜드메시지 · 건당 100원 · 친구 아니면 장문 문자 45원');
  assert.equal(sendCostText({ type: 'ATA', unit: 13, parts: [{ type: 'ATA', count: 1 }] }), '알림톡 · 건당 13원');
  assert.equal(sendCostText({ type: 'MMS', unit: 375, parts: [{ type: 'MMS', count: 3 }, { type: 'LMS', count: 1 }] }), '사진 문자 3통 + 장문 문자 1통 · 건당 375원');
  assert.equal(sendCostText({ type: 'SMS', unit: 18, parts: [{ type: 'SMS', count: 1 }] }), '단문 문자 · 건당 18원');
  assert.equal(sendCostText(null), '');
});
