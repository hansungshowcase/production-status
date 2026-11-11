import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canSelectReviewCustomer,
  customerDeliveryTone,
  customerRequestLabel,
  formatCustomerSmsTime,
  todayInKst,
} from '../src/components/customerSmsPresentation.js';
import { CONSOLE_MENUS, parseConsoleQuery } from '../shared/smsConsole.js';

const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/components/CustomerSmsPanel.jsx', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../src/components/CustomerSmsPanel.css', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/customerNotifications.js', import.meta.url), 'utf8');

test('사이드바 메뉴(현황판 기본·발송 내역·고객/직원 관리) 안에 기존 패널이 함께 유지된다', () => {
  // 11/11 장부 20번: 가로 탭 3개 → 쏠라피식 왼쪽 사이드바. 메뉴 이름은 shared/smsConsole.js 한 곳에서 관리.
  assert.match(pageSource, /parseConsoleQuery\(/);
  assert.match(pageSource, /<SmsConsoleSidebar /);
  assert.deepEqual(CONSOLE_MENUS.map(menu => menu.label), ['현황판', '발송 내역', '알림톡 템플릿', '고객 문자 관리', '직원 문자 관리']);
  assert.equal(parseConsoleQuery(new URLSearchParams('')).menu, 'dashboard');
  assert.match(pageSource, /<SolapiMessageLog[\s>]/);
  assert.match(pageSource, /<CustomerSmsPanel \/>/);
  // 고객 메뉴: 고객 자동 문자 등록 현황(고객 대상만) + 발송 내역, 직원 메뉴: 직원 대상만
  assert.match(pageSource, /id="sms-history-audience-panel-customer"[\s\S]*<NotificationOverview group="customer" \/>[\s\S]*<CustomerSmsPanel \/>/);
  assert.match(pageSource, /id="sms-history-audience-panel-employee"[\s\S]*<NotificationOverview group="internal" \/>/);
  assert.doesNotMatch(pageSource, /<NotificationOverview\s*\/>/);
  assert.match(pageSource, /id="sms-history-recipient"/);
  assert.match(pageSource, /id="sms-history-date"/);
});

test('고객 조회 API는 GET 필터만 구성하고 발송 POST를 만들지 않는다', () => {
  assert.match(apiSource, /\/customer-notifications\?/);
  assert.match(apiSource, /params\.set\('date'/);
  assert.match(apiSource, /params\.set\('kind'/);
  assert.match(apiSource, /\/customer-reviews\?/);
  assert.match(apiSource, /params\.set\('campaign'/);
  assert.match(apiSource, /cache:\s*'no-store'/);
  assert.doesNotMatch(apiSource, /method:\s*'POST'/);
});

test('고객 발송이력은 이름, 마스킹 번호, 유형, 상태, 시간과 미보관 본문을 표시한다', () => {
  assert.match(panelSource, /item\.customer_name/);
  assert.match(panelSource, /item\.phone/);
  assert.match(panelSource, /item\.kind_label/);
  assert.match(panelSource, /item\.delivery\?\.label/);
  assert.match(panelSource, /formatCustomerSmsTime\(item\.sent_at\)/);
  assert.match(panelSource, /발송 당시 본문 미보관/);
  assert.match(panelSource, /item\.channel/);
  assert.match(panelSource, /item\.attempts/);
  assert.match(panelSource, /attempt\.channel/);
  assert.match(panelSource, /attempt\.code/);
  assert.doesNotMatch(panelSource, />[^<]*\{item\.order_id\}[^<]*</);
});

test('고객 이력은 한국시간 오늘을 기본값과 초기화값으로 쓰고 리뷰 동기화 상태를 알린다', () => {
  assert.equal(todayInKst(new Date('2026-10-25T15:30:00.000Z')), '2026-10-26');
  assert.match(panelSource, /useState\(todayInKst\)/);
  assert.match(panelSource, /setDate\(todayInKst\(\)\)/);
  assert.match(panelSource, /data\?\.review_sync/);
  assert.match(panelSource, /history\.reviewSync\.notice/);
  assert.match(panelSource, /role="status"/);
  assert.doesNotMatch(panelSource, /toISOString/);
});

test('리뷰 이벤트 대상 선택은 발송 연결과 적격 상태가 모두 준비된 경우만 허용한다', () => {
  assert.equal(canSelectReviewCustomer({ eligibility: 'ready' }, { canSend: true }), true);
  assert.equal(canSelectReviewCustomer({ eligibility: 'blocked' }, { canSend: true }), false);
  assert.equal(canSelectReviewCustomer({ eligibility: 'ready' }, { canSend: false }), false);
  assert.match(panelSource, /disabled=\{!selectable\}/);
  assert.match(panelSource, /disabled=\{!reviews\.connection\.canSend \|\| selected\.length === 0\}/);
  assert.match(panelSource, /reviews\.connection\.notice/);
  assert.match(panelSource, /스마트스토어를 제외/);
});

test('알 수 없는 상태는 성공으로 꾸미지 않고 접근 가능한 44px 컨트롤을 유지한다', () => {
  assert.equal(customerRequestLabel('future'), '요청 상태 미확인');
  assert.equal(customerDeliveryTone('future'), 'uncertain');
  assert.match(formatCustomerSmsTime('2026-10-26T00:00:00.000Z'), /2026/);
  assert.match(panelCss, /min-height:\s*var\(--control-min-height\)/);
  assert.match(panelCss, /:focus-visible/);
  assert.match(panelCss, /@media \(max-width: 480px\)/);
  assert.match(panelCss, /overflow-wrap:\s*anywhere/);
});
