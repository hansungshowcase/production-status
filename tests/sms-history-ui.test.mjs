import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/pages/SmsHistoryPage.css', import.meta.url), 'utf8');
const variablesCss = readFileSync(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
const filterSource = readFileSync(new URL('../src/pages/smsHistoryFilters.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/internalNotifications.js', import.meta.url), 'utf8');
const staffSource = readFileSync(new URL('../src/components/StaffSmsPanel.jsx', import.meta.url), 'utf8');
const staffCss = readFileSync(new URL('../src/components/StaffSmsPanel.css', import.meta.url), 'utf8');

test('문자 발송내역은 인증 없이 여는 지연 로딩 경로로 연결된다', () => {
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/SmsHistoryPage'\)\)/);
  assert.match(appSource, /<Route path="\/sms-history" element=\{<SmsHistoryPage \/>\} \/>/);
  assert.doesNotMatch(pageSource, /SalesLoginPage|requireAuth|authClient|getToken/);
  assert.match(apiSource, /new URLSearchParams/);
  assert.match(apiSource, /cache:\s*'no-store'/);
});

// 2026-11-11 사장님 결정(장부 25): 직원 문자 관리 발송내역은 미니멀하게 — 안내 문구·요약 6칸·수신자 선택칸·쪽 넘김 없음,
// 등록된 직원 이름 (끝 4자리) 버튼을 누르면 그날 그 사람 문자, [전체보기]는 그날 전체를 발송 순서(먼저 보낸 것 위)로.
test('직원 문자 발송내역에는 안내 문구·요약 칸·선택칸·쪽 넘김이 없다', () => {
  const both = pageSource + staffSource;
  assert.match(pageSource, /<StaffSmsPanel active=\{state\.menu === 'staff'\} \/>/);
  assert.doesNotMatch(both, /실제 수신 여부와는 다릅니다/);
  for (const label of ['조회 기록', '발송 요청 완료', '요청 실패', '수신 완료', '전달 실패', '확인 중·미확인']) {
    assert.doesNotMatch(both, new RegExp(`<span>${label}</span>`));
  }
  assert.doesNotMatch(both, /id="sms-history-recipient"|<select/);
  assert.doesNotMatch(both, /aria-label="문자 발송내역 페이지"|notificationPageNumbers/);
});

test('등록된 직원 이름 (끝 4자리) 버튼과 전체보기로 그날 문자를 발송 순서대로 본다', () => {
  assert.match(apiSource, /params\.set\('view', 'day'\)/);
  assert.match(staffSource, /fetchInternalNotifications\(\{ view: 'day', date \}\)/);
  assert.match(staffSource, /getKstToday\(\)/);
  assert.match(staffSource, /type="date"/);
  assert.match(staffSource, /aria-label="발송 날짜"/);
  assert.match(staffSource, /role="group" aria-label="받는 사람"/);
  assert.match(staffSource, />\s*<span>전체보기<\/span>/);
  assert.match(staffSource, /aria-pressed=\{selected === person\.name\}/);
  assert.match(staffSource, /<span>\{person\.name\}<\/span>\s*\{person\.tail && <span>\(\{person\.tail\}\)<\/span>\}/);
  assert.match(staffCss, /\.staff-sms__who > span \{ white-space: nowrap; \}/);
  assert.match(staffSource, /items\.filter\(item => item\.recipient_name === selected\)/);
  assert.match(staffSource, /\[\.\.\.data\.items\]\.sort\(sentOrder\)/);
  assert.match(staffSource, /return safeLeft - safeRight/);
  // 명단 밖 이름으로 간 문자가 있으면 버튼을 덧붙여 전체보기와 합계가 맞게
  assert.match(staffSource, /if \(known\.has\(item\.recipient_name\)\) continue;/);
});

test('발송 본문은 접근 가능한 펼침 버튼으로 확인하고 실패·시험만 작은 점으로 알린다', () => {
  assert.match(staffSource, /aria-expanded=/);
  assert.match(staffSource, /aria-controls=/);
  assert.match(staffSource, /내용 저장 전 기록/);
  assert.match(staffSource, /timeZone:\s*'Asia\/Seoul'/);
  assert.match(staffSource, /role="status"/);
  assert.match(staffSource, /다시 불러오기/);
  assert.match(staffSource, /className=\{`staff-sms__dot staff-sms__dot--\$\{problem\.tone\}`\}/);
  assert.match(staffSource, /if \(item\?\.status === 'dry_run'\) return \{ tone: 'test', short: '시험', label: '시험 기록' \}/);
  assert.match(staffSource, /return \{ tone: 'failed', short: '실패',/);
  assert.match(staffSource, /\{problem\.short\}/);
  // 명단 밖 이름을 골라 둔 채 날짜를 바꾸면 전체보기로
  assert.match(staffSource, /if \(selected && !recipients\.some\(person => person\.name === selected\)\) setSelected\(''\);/);
  assert.match(staffCss, /@media \(max-width: 480px\)[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});

test('발송내역 스타일은 공통 토큰과 모바일·태블릿·데스크톱 폭을 지원한다', () => {
  assert.match(pageCss, /@media \(min-width: 1100px\)[\s\S]*width:\s*calc\(100% - 48px\)/);
  assert.match(pageCss, /\.sms-history-main\s*\{[\s\S]*width:\s*calc\(100% - 32px\)/);
  assert.match(pageCss, /grid-template-columns:\s*minmax\(0, 44fr\) minmax\(0, 56fr\)/);
  assert.match(pageCss, /var\(--surface\)/);
  assert.match(pageCss, /var\(--border\)/);
  assert.match(variablesCss, /--space-2:\s*8px/);
  assert.match(variablesCss, /--space-1:\s*4px/);
  assert.match(variablesCss, /--space-3:\s*12px/);
  assert.match(pageCss, /padding:\s*var\(--space-2\) var\(--space-3\)/);
  assert.match(variablesCss, /--control-min-inline-size:\s*104px/);
  assert.match(pageCss, /min-height:\s*var\(--control-min-height\)/);
  assert.doesNotMatch(pageCss, /border-radius:\s*9px/);
  assert.doesNotMatch(pageCss, /border-color:\s*rgba\(37, 99, 235, 0\.16\)/);
  assert.match(pageCss, /@media\s*\(min-width:\s*1100px\)/);
  assert.match(pageCss, /@media\s*\(max-width:\s*480px\)/);
  assert.match(pageCss, /overflow-wrap:\s*anywhere/);
  assert.match(pageCss, /\.sms-history-body\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(pageCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(pageCss, /:focus-visible/);
  assert.match(pageCss, /outline:\s*3px solid var\(--blue\)/);
  assert.match(pageCss, /gap:\s*var\(--space-1\)/);
});
