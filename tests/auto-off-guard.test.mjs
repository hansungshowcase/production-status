import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadNotificationOverview, loadConsoleDisabledRecent } from '../api/_lib/notificationOverview.js';
import { notificationStatusPresentation } from '../src/components/notificationOverviewPresentation.js';

// 2026-11-19: 본문 저장으로 자동 발송이 꺼진 문구 4개를 3시간 넘게 몰랐다. 저장 직후 경고와 현황판 경고를 지킨다.
const formSource = readFileSync(new URL('../src/components/smsconsole/SmsTextTemplateForm.jsx', import.meta.url), 'utf8');
const sendPanelSource = readFileSync(new URL('../src/components/smsconsole/SendPanel.jsx', import.meta.url), 'utf8');
const NOW = new Date('2026-11-19T13:00:00.000Z');
const env = { POSTGRES_URL: 'configured' };

test('1. 저장 응답에 auto_disabled 가 있으면 꺼짐 경고와 [다시 켜기]가 렌더된다', () => {
  assert.match(formSource, /out\.item\?\.auto_disabled === true\) setOffItems/);
  assert.match(formSource, /offItems\.map\(item => <AutoOffNotice /);
  assert.match(formSource, /자동 발송이 꺼졌습니다\. 다시 켜야 고객에게 나갑니다/);
  assert.match(formSource, /'다시 켜기'/);
  assert.match(formSource, /role="alert" data-auto-off-notice/);
  // 다시 켜기는 목록의 켜기와 같은 auto_toggle 흐름(dry_run 확인 → 켜기)을 쓴다
  assert.match(formSource, /postSmsConsole\('auto_toggle', \{ id, enabled: true, dry_run: true \}\)/);
  assert.match(formSource, /postSmsConsole\('auto_toggle', \{ id, enabled: true \}\)/);
  assert.match(formSource, /다시 켰습니다/);
  // 문구를 저장하는 다른 화면(보내기 화면)도 같은 경고를 쓴다
  assert.match(sendPanelSource, /item\.auto_disabled === true\) setAutoOffId/);
  assert.match(sendPanelSource, /<AutoOffNotice /);
});

test('2. auto_disabled 가 없으면 경고가 렌더되지 않는다', () => {
  // 경고 상태는 auto_disabled 가 정확히 true 일 때만 채워지고, 목록이 비면 아무것도 그리지 않는다
  assert.doesNotMatch(formSource, /auto_disabled\)\s*setOffItems/);
  assert.doesNotMatch(formSource, /auto_disabled !==|!out\.item\?\.auto_disabled/);
  assert.match(formSource, /useState\(\[\]\); \/\/ 저장 응답이 auto_disabled/);
  assert.doesNotMatch(sendPanelSource, /item\.auto_disabled\)\s*setAutoOffId/);
});

function overviewDb({ disabledRows, failDisabled = false, autoRows = [] }) {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      if (query.sql.includes('t.auto_enabled = false')) {
        if (failDisabled) throw new Error('boom');
        return { rows: disabledRows };
      }
      if (query.sql.includes('FROM sms_text_templates')) return { rows: autoRows };
      return { rows: [] };
    },
  };
}

test('3. 7일 안에 발송 기록이 있고 지금 꺼진 고객 문구는 현황판 경고 맨 앞에 나온다', async () => {
  const db = overviewDb({ disabledRows: [{ id: 4, name: '문구 4', auto_enabled: false }, { id: 23, name: '문구 23', auto_enabled: false }] });
  const result = await loadNotificationOverview(db, env, NOW);
  const customer = result.groups.find(group => group.id === 'customer').items;
  assert.equal(customer[0].id, 'console_disabled_recent');
  assert.equal(customer[0].name, '최근 발송하던 문구가 꺼져 있습니다');
  assert.match(customer[0].target, /문구 4, 문구 23 \(2개\)/);
  assert.deepEqual(customer[0].disabled_template_ids, [4, 23]);
  assert.equal(customer.length, 6); // 기존 5종은 그대로
  assert.equal(notificationStatusPresentation(customer[0]).key, 'off'); // 빨강 표시
  const query = db.calls.find(call => call.sql.includes('t.auto_enabled = false'));
  assert.match(query.sql, /sms_auto_sends WHERE status = 'sent' AND kst_date >= \?/);
  assert.match(query.sql, /sms_event_sends WHERE status = 'sent' AND kst_date >= \?/);
  assert.deepEqual(query.args, ['2026-11-13', '2026-11-13']);
});

test('4. 발송 기록이 없는 꺼진 문구는 경고에 나오지 않는다', async () => {
  // 기록이 없으면 조회 결과가 비어 경고 항목 자체가 없다
  const result = await loadNotificationOverview(overviewDb({ disabledRows: [] }), env, NOW);
  const customer = result.groups.find(group => group.id === 'customer').items;
  assert.equal(customer.some(item => item.id === 'console_disabled_recent'), false);
  assert.equal(customer.length, 5);
  // 켜져 있는 문구 행이 섞여 돌아와도 경고에 넣지 않는다
  assert.deepEqual(await loadConsoleDisabledRecent(overviewDb({ disabledRows: [{ id: 9, name: '켜짐', auto_enabled: true }] }), NOW, 'x'), []);
});

test('5. staff·sales 문구는 경고 조회에서 빠진다', async () => {
  const db = overviewDb({ disabledRows: [] });
  await loadNotificationOverview(db, env, NOW);
  const query = db.calls.find(call => call.sql.includes('t.auto_enabled = false'));
  assert.match(query.sql, /COALESCE\(t\.auto_audience, 'customer'\) NOT IN \('staff', 'sales'\)/);
});

test('6. 경고 집계 쿼리가 실패해도 기존 콘솔 항목은 그대로 나온다', async () => {
  const autoRows = [{ id: 23, name: 'SNS 설비+2', body: '안내', auto_kind: 'ship_plus_days', auto_days: 2, auto_ata_template: '', auto_audience: 'customer', auto_send_time: '12:30', has_image: false }];
  const db = overviewDb({ disabledRows: [], failDisabled: true, autoRows });
  const result = await loadNotificationOverview(db, env, NOW);
  const customer = result.groups.find(group => group.id === 'customer').items;
  assert.equal(customer.some(item => item.id === 'console_disabled_recent'), false);
  assert.equal(customer[5].id, 'console_auto_23');
  assert.equal(customer.length, 6);
});
