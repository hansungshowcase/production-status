import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
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

test('최근 결과는 상단 합계와 닫힌 상세에만 두고 모든 규칙은 compact 행으로 노출한다', () => {
  assert.match(componentSource, /className="notification-overview-summary"/);
  assert.match(componentSource, /className="notification-overview-item__row"/);
  assert.doesNotMatch(componentSource, /className="notification-overview-recent"/);
  assert.match(componentCss, /grid-template-columns:\s*minmax\(152px, 0\.8fr\)[^;]+84px/);
});

test('375px 화면에서는 이름·상태 뒤에 대상과 조건을 label-content 행으로 모두 노출한다', () => {
  assert.match(componentCss, /@media \(max-width: 767px\)[\s\S]*grid-template-columns:\s*64px minmax\(0, 1fr\)/);
  assert.match(componentCss, /@media \(max-width: 480px\)/);
  assert.match(componentCss, /overflow-wrap:\s*anywhere/);
  assert.match(componentCss, /min-width:\s*0/);
  assert.doesNotMatch(componentCss, /#[0-9a-f]{3,8}/i);
});

test('작은 상태 배지는 기존 배경 토큰과 고대비 text 토큰을 사용한다', () => {
  assert.match(componentCss, /notification-overview-badge--ready[\s\S]*background:\s*var\(--green-light\)[\s\S]*color:\s*var\(--text\)/);
  assert.match(componentCss, /notification-overview-badge--incomplete[\s\S]*background:\s*var\(--red-light\)[\s\S]*color:\s*var\(--text\)/);
});
