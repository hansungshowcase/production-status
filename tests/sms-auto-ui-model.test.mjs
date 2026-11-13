import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoConditionLine, autoConfirmLine, autoStatusLine, buildSaveBody, ensureAutoSection, imageUrlsFromItem, myTextSection,
  formInitialFromItem, normalizeDays, testPhoneDigits, toggleRejectText, validateTextForm,
} from '../src/components/smsconsole/smsTextTemplateFormModel.js';

test('저장 요청: 사진은 images 배열(최대 3), auto 는 일수 1~365', () => {
  const body = buildSaveBody({ name: 'a', body: 'b', images: [{ data: 'A', url: 'x' }, { data: 'B' }, { data: 'C' }, { data: 'D' }], auto: { kind: 'ship_plus_days', days: '20' } });
  assert.deepEqual(body.images, [{ data: 'A' }, { data: 'B' }, { data: 'C' }]);
  assert.deepEqual(body.auto, { kind: 'ship_plus_days', days: 20 });
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', images: [], auto: { kind: '', days: '20' } }), { name: 'a', body: 'b', auto: { kind: '' } });
  assert.equal(normalizeDays('0'), null);
  assert.equal(normalizeDays('366'), null);
  assert.equal(normalizeDays('365'), 365);
  assert.equal(validateTextForm({ name: 'a', body: '가', autoKind: 'ship_plus_days', days: '' }).reason, 'days');
});

test('카드 글: 조건 한 줄·현황 한 줄·켜기 거절 이유·확인 줄', () => {
  const section = myTextSection([{ id: 1, name: 'A', body: 'x', image_count: 2, auto_kind: 'ship_plus_days', auto_days: 20, auto_enabled: false }, { id: 2, name: 'B', body: 'y', has_image: true }]);
  assert.equal(autoConditionLine(section.items[0]), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  assert.equal(section.items[0].imageCount, 2);
  assert.equal(section.items[1].imageCount, 1);
  assert.equal(autoConditionLine(section.items[1]), '');
  assert.equal(autoStatusLine({ enabled: true, today_targets: 3, sent_7d: 12, sent_total: 40, uncertain_total: 0, last_sent_date: '2026-11-20' }), '켜짐 · 오늘 대상 3 · 최근 7일 12 · 누적 40 · 확인 필요 0 · 마지막 11/20');
  assert.match(autoStatusLine({ enabled: false }), /^꺼짐 .*마지막 없음$/);
  assert.match(toggleRejectText('no_ad_prefix'), /\(광고\)/);
  assert.match(toggleRejectText('no_optout_080'), /080/);
  assert.equal(autoConfirmLine({ targets: 3, parts: 2, cost: 1500 }), '오늘 대상 3명 · 1명당 2통 · 예상 비용 1,500원');
});

test('사진 여러 장 조회, 시험 번호, 발송 중 묶음에 자동 문구 칸 만들기', () => {
  assert.deepEqual(imageUrlsFromItem({ images: ['A', 'B'] }), ['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B']);
  assert.deepEqual(imageUrlsFromItem({ image: 'A' }), ['data:image/jpeg;base64,A']);
  assert.equal(testPhoneDigits('010-1234-5678'), '01012345678');
  assert.equal(testPhoneDigits('123'), '');
  const made = ensureAutoSection([{ group: '직원', count: 1, kinds: [] }], 1);
  assert.equal(made.find((aud) => aud.group === '고객').kinds[0].kind, '이벤트·혜택');
  const base = [{ group: '고객', count: 1, kinds: [{ kind: '이벤트·혜택', items: [1] }] }];
  assert.equal(ensureAutoSection(base, 1), base);
  assert.equal(ensureAutoSection(base, 0), base);
});

test('발송 조건 확장: 기본값 카드 글자 유지, 반복·시작일 덧붙임, 주문 기준, 저장 본문, 범위 밖 거절', () => {
  const base = { id: 1, name: 'A', body: 'x', auto_kind: 'ship_plus_days', auto_days: 20, auto_repeat: 1, auto_interval: 30 };
  assert.equal(autoConditionLine(myTextSection([base]).items[0]), '출고 완료 후 20일 뒤 · 오전 10시 · 고객');
  const more = myTextSection([{ ...base, auto_kind: 'order_plus_days', auto_send_from: '2026-11-20', auto_repeat: 3, auto_interval: 30 }]).items[0];
  assert.equal(more.autoKind, 'order_plus_days');
  assert.equal(autoConditionLine(more), '주문 등록 후 20일 뒤 · 오전 10시 · 고객 · 11/20부터 · 3번(30일 간격)');
  const saved = buildSaveBody({ id: 7, name: 'a', body: 'b', auto: { kind: 'order_plus_days', days: '5', sendFrom: '2026-11-20', repeat: '3', interval: '14' } });
  assert.equal(saved.id, 7);
  assert.deepEqual(saved.auto, { kind: 'order_plus_days', days: 5, send_from: '2026-11-20', repeat: 3, interval: 14 });
  const ok = { name: 'a', body: '가', autoKind: 'ship_plus_days', days: '20' };
  assert.equal(validateTextForm({ ...ok, repeat: '11', interval: '30' }).reason, 'repeat');
  assert.equal(validateTextForm({ ...ok, repeat: '2', interval: '0' }).reason, 'interval');
  assert.equal(validateTextForm({ ...ok, repeat: '1', interval: '0' }).ok, true);
  assert.equal(validateTextForm({ ...ok, sendFrom: '2026-13-40' }).reason, 'sendFrom');
  assert.equal(formInitialFromItem({ id: 7, name: 'n', body: 'b', images: ['A'], auto_kind: 'ship_plus_days', auto_days: 20 }).images[0].url, 'data:image/jpeg;base64,A');
});
