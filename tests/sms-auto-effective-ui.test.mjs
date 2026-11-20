import test from 'node:test';
import assert from 'node:assert/strict';
import { autoEffective, autoLightClass } from '../shared/smsAutoEffective.js';
import { autoTargetText, autoStatusLine } from '../src/components/smsconsole/smsTextTemplateFormModel.js';
import { itemLight } from '../src/components/smsconsole/smsTemplateListModel.js';

test('autoEffective: 상태 없음·꺼짐·정상', () => {
  assert.deepEqual(autoEffective(null), { tone: 'unknown', text: '확인 중', blocked: false });
  assert.deepEqual(autoEffective({ enabled: false, no_provider: true }), { tone: 'off', text: '꺼짐', blocked: false });
  assert.deepEqual(autoEffective({ enabled: true, sent_7d: 3 }), { tone: 'on', text: '켜짐', blocked: false });
});

test('autoEffective: 막힘 사유별 한 건씩과 우선순위', () => {
  const on = { enabled: true };
  assert.equal(autoEffective({ ...on, no_provider: true }).text, '켜짐(막힘: 발송 업체 설정 없음)');
  assert.equal(autoEffective({ ...on, enable_blocked_reason: 'cafe24_not_connected' }).text, '켜짐(막힘: 카페24 연결이 아직 안 됐습니다)');
  assert.equal(autoEffective({ ...on, enable_blocked_reason: 'zzz_unknown' }).text, '켜짐(막힘: 설정 확인 필요)');
  assert.equal(autoEffective({ ...on, auto_skip_reason: 'weekend' }).text, '켜짐(막힘: weekend)');
  assert.equal(autoEffective({ ...on, ata_backoff: true }).text, '켜짐(막힘: 알림톡 연속 실패로 잠시 쉼)');
  assert.equal(autoEffective({ ...on, failed_7d: 5, sent_7d: 2 }).text, '켜짐(막힘: 최근 7일 실패가 성공보다 많음)');
  assert.equal(autoEffective({ ...on, failed_7d: 2, sent_7d: 2 }).tone, 'on');
  assert.equal(autoEffective({ ...on, no_provider: true, ata_backoff: true }).text, '켜짐(막힘: 발송 업체 설정 없음)');
  assert.equal(autoEffective({ ...on, ata_backoff: true }).blocked, true);
});

test('autoEffective: 일괄 발송 멈춤·하루 상한 도달은 part(정상 운영), 색 이름', () => {
  const part = autoEffective({ enabled: true, catchup_paused: true, catchup_error: '템플릿 오류' });
  assert.deepEqual(part, { tone: 'part', text: '켜짐 · 일괄 발송 멈춤(템플릿 오류)', blocked: false });
  const capped = autoEffective({ enabled: true, auto_skip_reason: '하루 상한 50건 도달, 남은 278건 다음 날' });
  assert.deepEqual(capped, { tone: 'part', text: '켜짐 · 하루 상한 50건 도달, 남은 278건 다음 날', blocked: false });
  assert.deepEqual(['on', 'part', 'blocked', 'off', 'unknown'].map((tone) => autoLightClass({ tone })), ['on', 'part', 'part', 'off', 'unknown']);
});

test('autoTargetText: 종류별 실제 조건', () => {
  assert.equal(autoTargetText({ autoKind: 'ship_plus_days', autoDays: 20 }), '주문 상태 출고완료 · 출고일+20일=오늘(3일 지난 건까지) · 수신거부·중복번호 제외 · 번호당 1회');
  assert.equal(autoTargetText({ autoKind: 'order_plus_days', autoDays: 5, autoRepeat: 2, autoInterval: 30 }), '주문일+5일=오늘(3일 지난 건까지) · 취소 주문 제외 · 수신거부·중복번호 제외 · 번호당 2회(30일 간격)');
  assert.equal(autoTargetText({ autoKind: 'due_date', autoOffset: -3, autoWeekdays: true, autoUnlessStep: '레이저', autoUnlessMode: 'completed' }), '주문 상태 제작 중 · 납기일 3일 전=오늘 · 평일만(토·일 안 보냄) · 레이저 공정 미완료인 주문만 · 번호·주문당 1번');
  assert.match(autoTargetText({ autoKind: 'ship_or_due', autoOffset: 0 }), /^주문 상태 제작 중 · 출고예정일\(없으면 납기일\) 당일=오늘/);
  assert.match(autoTargetText({ autoKind: 'ship_scheduled', autoOffset: -1, autoDaily: 'until' }), /출고예정일 1일 전부터 당일까지 매일=오늘.*하루 1번/);
  assert.equal(autoTargetText({ autoKind: 'lead_plus_days', autoDays: 3, autoLeadSource: 'cafe24' }), '카페24 회원가입 접수일+3일=오늘 · 번호가 남아 있는 접수만 · 번호당 1번');
  assert.equal(autoTargetText({ autoKind: 'member_joined' }), '카페24 회원가입 즉시(켠 뒤 24시간 안 가입) · 번호당 1번');
  assert.match(autoTargetText({ autoKind: 'order_created' }), /^주문 등록 즉시.*취소 주문 제외/);
  assert.match(autoTargetText({ autoKind: 'process_started', autoStep: '도면설계' }), /^도면설계 공정 시작 시각이 기록된 주문/);
  assert.match(autoTargetText({ autoKind: 'process_completed', autoStep: '조립' }), /^조립 공정 완료 시각이 기록된 주문/);
  assert.equal(autoTargetText({ autoKind: '' }), '');
  assert.equal(autoTargetText(null), '');
});

test('autoStatusLine: 실제 판정 글자가 앞에 온다', () => {
  assert.ok(autoStatusLine({ enabled: true, no_provider: true }).startsWith('켜짐(막힘: 발송 업체 설정 없음) · 오늘 대상 0'));
  assert.ok(autoStatusLine({ enabled: false }).startsWith('꺼짐 · '));
  assert.equal(autoStatusLine(null), '');
});

test('itemLight: 테스트 기록만, 메이크 수집 결과 없음·있음', () => {
  assert.deepEqual(itemLight({ config: { status: 'test' } }), { tone: 'part', text: '켜짐(막힘: 제공사 설정 없음 · 테스트 기록만)' });
  const ext = { external: true, sender: '메이크', active: true, count: 0 };
  assert.deepEqual(itemLight(ext), { tone: 'unknown', text: '확인 안 됨' });
  assert.deepEqual(itemLight({ ...ext, make_on: false }), { tone: 'off', text: '꺼짐' });
  assert.equal(itemLight({ ...ext, make_on: true, make_last_run: new Date().toISOString() }).tone, 'on');
  assert.deepEqual(itemLight({ ...ext, make_on: true, make_last_run: '2020-01-01T00:00:00Z' }), { tone: 'part', text: '켜짐(최근 실행 없음)' });
  assert.equal(itemLight({ ...ext, count: 4 }).tone, 'on');
  assert.deepEqual(itemLight({ sender: '제작현황', active: true }), { tone: 'on', text: '켜짐' });
});
