// 콘솔 화면의 말·숫자·색이 실제 동작과 맞는지(2026-11-18 화면 점검) — 순수 함수 시험
import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixCells, recentGroups } from '../src/components/smsconsole/dashboardModel.js';
import {
  buildSmsItems, groupFlows, itemLight, conditionLine,
} from '../src/components/smsconsole/smsTemplateListModel.js';
import { catchupSpanText } from '../src/components/smsconsole/smsTextTemplateFormModel.js';
import {
  filterTemplates, statusPills, defaultStatusFilter, usageFail, usageSuccess, failBadge, readOnlyKakaoItems, templateExtras,
} from '../src/components/smsconsole/templateListModel.js';
import { EXTERNAL_TEMPLATES, PROGRAM_TEMPLATE_IDS, templateMeta } from '../shared/smsTemplateKinds.js';
import { CONSOLE_MENUS } from '../shared/smsConsole.js';

test('1) 그룹 status 가 FAILED 면 빨강, 카톡 칸 이름', () => {
  const [row] = recentGroups([{ group_id: 'G1', total: 3, success: 0, pending: 0, failed: 0, status: 'FAILED' }]);
  assert.equal(row.tone, 'danger');
  assert.equal(row.stateLabel, '실패');
  assert.equal(recentGroups([{ group_id: 'G2', total: 1, success: 1, pending: 0, failed: 0, status: 'COMPLETE' }])[0].tone, 'ok');
  assert.equal(matrixCells({}).rows[0].cells[1].label, '카톡(알림톡·브랜드)');
  const log = CONSOLE_MENUS.find((m) => m.id === 'log');
  assert.ok(log.subs.filter((s) => s.ch === 'kakao').every((s) => s.label.includes('카톡(알림톡·브랜드)')));
});

const sentRow = (key, count7, fail7) => ({ key, count7, fail7, channel: 'ATA', sender: '메이크', kind: '주문·출고 안내', audience: '고객', ad: false });

test('2) 실패가 섞인 최근 7일: 성공 = 사용 - 실패, 발송 중·켜짐은 성공이 있어야', () => {
  const tid = EXTERNAL_TEMPLATES.find((e) => e.match.templateId).match.templateId;
  const key = templateMeta(tid).key;
  const usage = { by_template: { [tid]: { count: 4 } }, partial: false };
  assert.equal(usageFail(tid, [sentRow(key, 4, 1)]), 1);
  assert.equal(usageSuccess(usage, tid, [sentRow(key, 4, 1)]), 3);
  assert.equal(usageSuccess(usage, tid, [sentRow(key, 4, 4)]), 0);
  assert.equal(usageSuccess({ by_template: {}, partial: true }, tid, []), null);
  assert.deepEqual(failBadge(2), { tone: 'danger', text: '실패 2' });
  assert.equal(failBadge(0), null);
  const items = [{ id: tid, name: 'a', status: 'APPROVED' }];
  assert.equal(filterTemplates(items, { status: 'in_use', usage, sent: [sentRow(key, 4, 4)] }).length, 0);
  assert.equal(filterTemplates(items, { status: 'in_use', usage, sent: [sentRow(key, 4, 1)] }).length, 1);
  assert.equal(statusPills(items, usage, [sentRow(key, 4, 4)])[0].count, 0);
  assert.equal(defaultStatusFilter(statusPills(items, usage, [sentRow(key, 4, 4)]), '', usage, [sentRow(key, 4, 4)]), 'all');
});

test('3) 브랜드메시지·기타 구역 켜짐은 itemLight 로 판정(손으로 적은 active 아님)', () => {
  const rows = readOnlyKakaoItems([], [], { status: 'all' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.external === true));
  const makeRow = rows.find((row) => row.sender !== '프로그램' && row.make_on === undefined && row.count === 0);
  if (makeRow) assert.notEqual(itemLight(makeRow).tone, 'on'); // 수집 결과도 발송도 없으면 초록 아님
  assert.equal(itemLight({ external: true, sender: '메이크', make_on: true, make_last_run: new Date().toISOString(), count: 2, fail: 0 }).tone, 'on');
  assert.equal(itemLight({ external: true, sender: '메이크', count: 3, fail: 3 }).tone, 'unknown'); // 전부 실패한 발송은 켜짐 근거가 아님
  assert.equal(itemLight({ external: true, sender: '메이크', count: 3, fail: 1 }).tone, 'on');
  const failRow = readOnlyKakaoItems([], [sentRow(rows[0].id, 5, 2)], { status: 'all' }).find((row) => row.id === rows[0].id);
  assert.equal(failRow.fail, 2);
});

test('4) 흐름 켜짐 n/N 은 실제 신호등이 켜짐인 것만 센다', () => {
  const steps = [1, 2, 3].map((n) => ({ id: n, name: `${n}일`, autoKind: 'ship_plus_days', autoDays: n, autoAudience: 'customer', autoEnabled: true }));
  const [flow] = groupFlows(steps, (entry) => entry.id !== 2);
  assert.equal(flow.on, 2);
  assert.equal(flow.total, 3);
});

test('5) 직원 문구는 "발송 중" 없이 받는 사람만', () => {
  const staff = { audience: { id: 'staff' }, external: false, trigger: 'V-커팅 완료 시', target: '이시아 부장 (010****4237)' };
  const text = conditionLine(staff, [{ name: '이시아 부장', phone_tail: '4237' }]);
  assert.ok(text.includes('에게'));
  assert.ok(!text.includes('발송 중'));
});

test('6) 흐름 수단 칩: 브랜드메시지는 알림톡이 아니라 브랜드메시지', () => {
  const mk = (ata) => ({ id: ata, name: ata, autoKind: 'ship_plus_days', autoDays: 1, autoAudience: 'customer', autoAtaTemplate: ata });
  assert.equal(groupFlows([mk('BMS_FREE')])[0].via, '브랜드메시지');
  assert.equal(groupFlows([mk('KA01TP1')])[0].via, '알림톡');
});

test('7) 하루를 넘는 일괄 발송은 첫날 분량과 일수로 쓴다', () => {
  assert.equal(catchupSpanText({ eta_minutes: 20, days_needed: 1, daily_max: 100 }), '시작 후 약 20분 안에 모두 나갑니다');
  const text = catchupSpanText({ eta_minutes: 20, days_needed: 3, daily_max: 100 });
  assert.ok(text.includes('첫날 약 20분') && text.includes('하루 100건씩 약 3일'));
  assert.ok(!text.includes('모두 나갑니다'));
});

test('8) 카탈로그 최근 7일 건수는 성공(수신·접수)만', () => {
  const overview = { groups: [{ id: 'customer', items: [{ id: 'x', name: 'x', recent: { state: 'available', counts: { total: 10, received: 3, accepted: 2, failed: 4, dry_run: 1, processing: 0, other: 0 } } }] }] };
  assert.equal(buildSmsItems(overview)[0].count, 5);
  const old = { groups: [{ id: 'customer', items: [{ id: 'y', name: 'y', recent: { state: 'available', counts: { total: 7 } } }] }] };
  assert.equal(buildSmsItems(old)[0].count, 7);
});

test('9) 표에 고정 건수 글이 없고 출고 문의 대상은 납기 기준', () => {
  for (const entry of EXTERNAL_TEMPLATES) assert.ok(!/최근 (1개월|30일)\s*(약\s*)?(\d+건|발송 없음)/.test(entry.trigger || ''), entry.key);
  assert.equal(EXTERNAL_TEMPLATES.find((e) => e.key === 'ship_inquiry').who, '납기 3일 이내 고객');
});

test('10) 출고 완료 프로그램 템플릿은 정책 중단이라 켜짐이 아니다', () => {
  const shippedId = Object.keys(PROGRAM_TEMPLATE_IDS).find((id) => PROGRAM_TEMPLATE_IDS[id] === 'customer_shipped');
  assert.equal(templateMeta(shippedId).active, false);
  assert.equal(templateExtras(shippedId, []).off, true);
  const orderedId = Object.keys(PROGRAM_TEMPLATE_IDS).find((id) => PROGRAM_TEMPLATE_IDS[id] === 'customer_ordered');
  assert.equal(templateExtras(orderedId, []).off, false);
});

test('080 줄이 없어도 발송은 계속되므로 막힘이 아니라 켜짐(주의)이고, 다른 막힘 코드는 그대로 막힘', async () => {
  const { autoEffective } = await import('../shared/smsAutoEffective.js');
  const part = autoEffective({ enabled: true, enable_blocked_reason: 'no_optout_080' });
  assert.equal(part.tone, 'part');
  assert.equal(part.blocked, false);
  assert.equal(part.text, '켜짐 · 080 수신거부 줄 필요(발송은 계속)');
  assert.equal(autoEffective({ enabled: true, enable_blocked_reason: 'no_ad_prefix' }).tone, 'blocked');
  assert.equal(autoEffective({ enabled: false, enable_blocked_reason: 'no_optout_080' }).tone, 'off');
});

test('흐름 켜짐 수는 tone on·part 를 센다(화면 소스 확인)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/smsconsole/SmsTemplateList.jsx', import.meta.url), 'utf8');
  assert.match(src, /groupFlows\(sortedMine, \(entry\) => \['on', 'part'\]\.includes\(effOf\(entry\)\.tone\)\)/);
  const flows = groupFlows([{ id: 1, autoKind: 'order_created', autoEnabled: true }, { id: 2, autoKind: 'order_created', autoEnabled: true }], (e) => ['on', 'part'].includes(e.id === 1 ? 'on' : 'part'));
  assert.equal(flows[0].on, 2);
});

test('알림톡 카드: 이름과 상태 사이에 공백이 있고 연결된 자동 문구의 대상 줄이 있다(소스 확인)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/smsconsole/KakaoTemplateManager.jsx', import.meta.url), 'utf8');
  assert.match(src, /<span className="ktm-card-name">\{item\.name\}<\/span>\s*\{' '\}/);
  assert.match(src, /대상: \{autoTargetText\(targetEntry\)\}/);
  assert.match(src, /linkedTextEntries\(textItems, item\.id\)/);
});
