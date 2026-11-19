// Make 이전 v4(2026-11-19) S1·S2·S3 저장 검증·화면 모델. 가짜 db 만 쓴다(실제 발송 없음).
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetTextTemplateSchemaForTest, infoCheck, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { autoTargetText, buildSaveBody, normalizeOrderDays, stageOrder, validateTextForm } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

const fakeDb = () => ({ async execute({ sql }) { const t = sql.trim(); if (t.startsWith('INSERT')) return { rows: [{ id: 1 }] }; if (t.startsWith('SELECT COUNT')) return { rows: [{ n: 0 }] }; return { rows: [] }; } });
const save = async input => { _resetTextTemplateSchemaForTest(); try { return await saveTextTemplate(fakeDb(), input, { staff: [] }); } catch (error) { return { thrown: String(error?.message || error) }; } };
const ATA = 'KA01TP260427071128256TBi5mAg9hvT';
const isReject = out => Boolean(out?.error || out?.ok === false || out?.status >= 400);

test('S1: 알림톡 본문에 #{업체명} 허용, 그 밖의 변수는 거절', () => {
  assert.equal(infoCheck('#{업체명} 대표님 #{고객명}', 'customer', 'order_plus_days', true), '');
  assert.equal(infoCheck('#{업체명} 대표님', 'customer', 'lead_plus_days', true), '');
  assert.equal(infoCheck('#{업체명} 대표님', 'customer', 'lead_plus_days', false), 'info_unknown_var'); // 문자는 고객명만(그대로)
  assert.equal(infoCheck('#{주문번호}', 'customer', 'order_plus_days', true), 'info_unknown_var');
});

test('S2: order_plus_days 는 0일 허용, 다른 종류는 0일 거절(그대로)', async () => {
  const order0 = await save({ name: '유튜브', body: '#{업체명} 안내', auto: { kind: 'order_plus_days', days: 0, ata_template: ATA, send_time: '18:00' } });
  assert.ok(!isReject(order0), JSON.stringify(order0));
  for (const kind of ['ship_plus_days']) {
    const out = await save({ name: '출고', body: '#{고객명} 안내', auto: { kind, days: 0, ata_template: ATA } });
    assert.ok(isReject(out), `${kind} 0일은 거절돼야 함: ${JSON.stringify(out)}`);
  }
  const step = await save({ name: '공정', body: '#{고객명} 안내', auto: { kind: 'process_started_plus_days', days: 0, step: '인쇄' } });
  assert.ok(isReject(step), JSON.stringify(step));
  const order1 = await save({ name: '주문1', body: '#{업체명} 안내', auto: { kind: 'order_plus_days', days: 1, ata_template: ATA } });
  assert.ok(!isReject(order1), JSON.stringify(order1));
  const orderNeg = await save({ name: '주문음수', body: '#{업체명} 안내', auto: { kind: 'order_plus_days', days: -1, ata_template: ATA } });
  assert.ok(isReject(orderNeg));
});

test('S3: plain 이면 주문 변수 검사 면제, 아니면 그대로', () => {
  const body = '한성쇼케이스 주의사항 안내';
  assert.equal(infoCheck(body, 'customer', 'order_created'), 'info_needs_order_var');
  assert.equal(infoCheck(body, 'customer', 'order_created', false, { plain: true }), '');
  assert.equal(infoCheck(body, 'customer', 'order_created', false, JSON.stringify({ plain: true, from: '0319862458' })), '');
  assert.equal(infoCheck(body, 'customer', 'order_created', false, { plain: false, subject: 'x' }), 'info_needs_order_var');
  assert.equal(infoCheck(body, 'customer', 'order_created', false, null), 'info_needs_order_var');
  assert.equal(infoCheck('할인 안내', 'customer', 'order_created', false, { plain: true }), 'info_has_ad_words'); // 광고 낱말 검사는 그대로
});

test('화면 모델: 주문 등록 후 0일 입력·저장·대상 문구', () => {
  assert.equal(normalizeOrderDays('0'), 0);
  assert.equal(normalizeOrderDays('366'), null);
  assert.equal(stageOrder({ autoKind: 'order_plus_days', days: '0' }), 0);
  assert.equal(stageOrder({ autoKind: 'ship_plus_days', days: '0' }), null);
  const base = { name: '유튜브', body: '#{업체명} 안내', repeat: '1', interval: '30', ataTemplate: ATA };
  assert.equal(validateTextForm({ ...base, autoKind: 'order_plus_days', days: '0' }).ok, true);
  assert.equal(validateTextForm({ ...base, autoKind: 'ship_plus_days', days: '0' }).ok, false);
  const out = buildSaveBody({ name: '유튜브', body: '#{업체명} 안내', images: [], auto: { kind: 'order_plus_days', days: '0', ataTemplate: ATA, repeat: '1', interval: '30' } });
  assert.equal(out.auto.days, 0);
  assert.match(autoTargetText({ autoKind: 'order_plus_days', autoDays: 0, autoSendTime: '18:00' }), /^주문 등록 당일 18:00/);
  assert.match(autoTargetText({ autoKind: 'order_plus_days', autoDays: 2 }), /주문일\+2일=오늘/);
});
