import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/pages/SmsHistoryPage.css', import.meta.url), 'utf8');
const variablesCss = readFileSync(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
const filterSource = readFileSync(new URL('../src/pages/smsHistoryFilters.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/internalNotifications.js', import.meta.url), 'utf8');

test('문자 발송내역은 인증 없이 여는 지연 로딩 경로로 연결된다', () => {
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/SmsHistoryPage'\)\)/);
  assert.match(appSource, /<Route path="\/sms-history" element=\{<SmsHistoryPage \/>\} \/>/);
  assert.doesNotMatch(pageSource, /SalesLoginPage|requireAuth|authClient|getToken/);
  assert.match(apiSource, /new URLSearchParams/);
  assert.match(apiSource, /cache:\s*'no-store'/);
});

test('문자 발송내역 화면은 모든 수신자를 한 필터에서 선택하고 쏠라피 접수 상태를 제공한다', () => {
  assert.doesNotMatch(pageSource, /label:\s*'간부'/);
  assert.doesNotMatch(pageSource, /label:\s*'팀원'/);
  assert.match(pageSource, /쏠라피 접수 성공/);
  assert.match(pageSource, /발송 요청 실패/);
  assert.match(pageSource, /테스트 기록/);
  assert.match(pageSource, /aria-label="수신자별 발송내역"/);
  assert.match(pageSource, /aria-pressed=/);
});

test('상단에서 문자 수신자 전원과 날짜를 선택하고 최신 날짜순으로 묶어 본다', () => {
  for (const name of [
    '이시아 부장', '최우석 이사', '이정섭 부장', '김보수 팀장', '박상규 공장장', '정영호 팀장',
    '신은철', '이준형', '강종효', '카우사르', '나타왓', '마카라', '백승정', '까지',
  ]) {
    assert.match(filterSource, new RegExp(name));
  }
  assert.match(pageSource, /전체 수신자/);
  assert.match(pageSource, /최신 날짜순 자동 정렬/);
  assert.match(pageSource, /type="date"/);
  assert.match(pageSource, /aria-label="발송 날짜"/);
  assert.match(pageSource, /전체 날짜/);
  assert.match(pageSource, /groupNotificationsByKstDate/);
  assert.match(pageSource, /sms-history-date-group/);
  assert.doesNotMatch(apiSource, /params\.set\('audience'/);
  assert.match(apiSource, /params\.set\('recipient'/);
  assert.match(apiSource, /params\.set\('date'/);
});

test('발송내역은 10건씩 이전·페이지 번호·다음으로 이동한다', () => {
  assert.match(pageSource, /limit:\s*10/);
  assert.match(apiSource, /params\.set\('page'/);
  assert.match(pageSource, /aria-label="문자 발송내역 페이지"/);
  assert.match(pageSource, /notificationPageNumbers/);
  assert.match(pageSource, /sms-history-keep-together/);
  assert.match(pageSource, />\s*이전\s*</);
  assert.match(pageSource, />\s*다음\s*</);
  assert.match(pageSource, /setPage\(1\)/);
});

test('발송 본문은 접근 가능한 펼침 버튼으로 확인하고 과거 기록은 안내 문구를 쓴다', () => {
  assert.match(pageSource, /aria-expanded=/);
  assert.match(pageSource, /aria-controls=/);
  assert.match(pageSource, /내용 저장 전 기록/);
  assert.match(pageSource, /Intl\.DateTimeFormat\('ko-KR'/);
  assert.match(pageSource, /timeZone:\s*'Asia\/Seoul'/);
  assert.match(pageSource, /role="status"/);
  assert.match(pageSource, /className="sms-history-live-status"/);
  assert.match(pageSource, /aria-live="polite"/);
  assert.match(pageSource, /aria-atomic="true"/);
  assert.match(pageSource, /다시 불러오기/);
});

test('발송내역 스타일은 공통 토큰과 모바일·태블릿·데스크톱 폭을 지원한다', () => {
  assert.match(pageCss, /width:\s*min\([^)]+1000px\)/);
  assert.match(pageCss, /var\(--surface\)/);
  assert.match(pageCss, /var\(--border\)/);
  assert.match(variablesCss, /--space-2:\s*8px/);
  assert.match(variablesCss, /--space-1:\s*4px/);
  assert.match(variablesCss, /--space-3:\s*12px/);
  assert.match(pageCss, /padding:\s*var\(--space-2\) var\(--space-3\)/);
  assert.match(variablesCss, /--control-min-inline-size:\s*104px/);
  assert.match(pageCss, /minmax\(var\(--control-min-inline-size\), 1fr\)/);
  assert.doesNotMatch(pageCss, /border-radius:\s*9px/);
  assert.doesNotMatch(pageCss, /border-color:\s*rgba\(37, 99, 235, 0\.16\)/);
  assert.match(pageCss, /@media\s*\(min-width:\s*768px\)/);
  assert.match(pageCss, /@media\s*\(max-width:\s*480px\)/);
  assert.match(pageCss, /overflow-wrap:\s*anywhere/);
  assert.match(pageCss, /\.sms-history-body\s*\{[^}]*word-break:\s*keep-all/s);
  assert.match(pageCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(pageCss, /:focus-visible/);
  assert.match(pageCss, /outline:\s*3px solid var\(--blue\)/);
  assert.match(pageCss, /gap:\s*var\(--space-1\)/);
});
