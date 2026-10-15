import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/pages/SmsHistoryPage.css', import.meta.url), 'utf8');
const componentSource = readFileSync(new URL('../src/components/NotificationOverview.jsx', import.meta.url), 'utf8');
const componentCss = readFileSync(new URL('../src/components/NotificationOverview.css', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/notificationOverview.js', import.meta.url), 'utf8');
const overviewSource = readFileSync(new URL('../api/_lib/notificationOverview.js', import.meta.url), 'utf8');

test('자동 알림 현황은 기존 직원 발송내역 위에 독립 컴포넌트로 표시된다', () => {
  assert.match(pageSource, /import NotificationOverview/);
  assert.match(pageSource, /<NotificationOverview\s*\/>[\s\S]*직원 알림 발송내역/);
  assert.match(componentSource, /data-notification-overview/);
  assert.match(overviewSource, /label: '고객 알림'/);
  assert.match(overviewSource, /label: '사내·관리 알림'/);
  assert.match(apiSource, /\/notification-overview/);
  assert.match(apiSource, /cache:\s*'no-store'/);
  assert.match(pageSource, /자동문자 운영 현황/);
});
test('현황 조회 상태와 재시도는 기존 발송내역 요청과 분리된다', () => {
  assert.match(componentSource, /useState\('loading'\)/);
  assert.match(componentSource, /setStatus\('error'\)/);
  assert.match(componentSource, /현황 다시 불러오기/);
  assert.match(componentSource, /아래 직원 알림 발송내역은 계속 확인/);
  assert.doesNotMatch(pageSource, /fetchNotificationOverview/);
});

test('규칙 상세는 키보드 버튼 의미와 상태 연결을 제공한다', () => {
  assert.match(componentSource, /className="notification-overview-disclosure"/);
  assert.match(componentSource, /aria-expanded=\{expanded\}/);
  assert.match(componentSource, /aria-controls=\{detailsId\}/);
  assert.match(componentCss, /\.notification-overview-disclosure:focus-visible/);
  assert.match(componentCss, /outline:\s*3px solid var\(--blue\)/);
  assert.match(componentSource, /item\.policy\.status !== 'paused'/);
});

test('현황은 요약과 고객·사내 그룹 탭을 고정하고 선택 그룹만 노출한다', () => {
  assert.match(componentSource, /className="notification-overview-summary"/);
  assert.match(componentSource, /고객 알림/);
  assert.match(componentSource, /사내·관리/);
  assert.match(componentSource, /정책 중단/);
  assert.match(componentSource, /role="tablist"/);
  assert.match(componentSource, /activeGroupId/);
  assert.match(componentSource, /hidden=\{activeGroupId !== group\.id\}/);
  assert.match(componentSource, /expandedByGroup\[group\.id\]/);
  assert.match(componentSource, /className="notification-overview-item__row"/);
  assert.doesNotMatch(componentSource, /className="notification-overview-recent"/);
  assert.match(componentCss, /\.notification-overview-scroll\s*\{[\s\S]*overflow-y:\s*auto/);
});

test('규칙 기본 행은 전체 대상을 보이고 조건과 최근 결과는 하나의 상세에 보존한다', () => {
  assert.match(componentSource, /<dt>대상<\/dt>/);
  assert.match(componentSource, /조건·최근 결과/);
  assert.match(componentSource, /<dt>발송 조건<\/dt>/);
  assert.match(componentSource, /<dt>최근 결과<\/dt>/);
  assert.match(componentCss, /@media \(max-width: 480px\)/);
  assert.match(componentCss, /overflow-wrap:\s*anywhere/);
  assert.match(componentCss, /min-width:\s*0/);
  assert.doesNotMatch(componentCss, /#[0-9a-f]{3,8}/i);
});

test('데스크톱은 44대56 패널과 독립 스크롤, 좁은 화면은 상태 보존 탭을 사용한다', () => {
  assert.match(pageSource, /useState\('history'\)/);
  assert.match(pageSource, /data-sms-panel="overview"/);
  assert.match(pageSource, /data-sms-panel="history"/);
  assert.match(pageSource, /data-history-scroll/);
  assert.match(pageCss, /@media \(min-width: 1100px\)[\s\S]*grid-template-columns:\s*minmax\(0, 44fr\) minmax\(0, 56fr\)/);
  assert.match(pageCss, /#root:has\(\.sms-history-page\)[\s\S]*height:\s*100%/);
  assert.match(pageCss, /\.sms-history-list-scroll\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(pageCss, /\.sms-history-workspace-panel\s*\{\s*display:\s*none/);
  assert.match(pageCss, /\.sms-history-workspace-panel\.is-active\s*\{\s*display:\s*block/);
  assert.match(pageCss, /grid-template-areas:[\s\S]*'heading action'[\s\S]*'body body'/);
  assert.match(componentCss, /\.notification-overview-disclosure\s*\{[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1/);
});

test('작은 상태 배지는 기존 배경 토큰과 고대비 text 토큰을 사용한다', () => {
  assert.match(componentCss, /notification-overview-badge--ready[\s\S]*background:\s*var\(--green-light\)[\s\S]*color:\s*var\(--text\)/);
  assert.match(componentCss, /notification-overview-badge--incomplete[\s\S]*background:\s*var\(--red-light\)[\s\S]*color:\s*var\(--text\)/);
});
