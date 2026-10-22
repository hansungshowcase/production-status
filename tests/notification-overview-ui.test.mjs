import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  notificationChannelPresentation,
  notificationRecentLabelPresentation,
  notificationReasonPresentation,
  notificationStatusPresentation,
  notificationTextPresentation,
} from '../src/components/notificationOverviewPresentation.js';

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
  assert.doesNotMatch(componentSource, /item\.policy\.label|item\.configuration\.label/);
});

test('현황은 요약과 고객·사내 그룹 탭을 고정하고 선택 그룹만 노출한다', () => {
  assert.match(componentSource, /className="notification-overview-summary"/);
  assert.match(componentSource, /고객 알림/);
  assert.match(componentSource, /직원 알림/);
  assert.match(componentSource, /보내지 않음/);
  assert.match(componentSource, /role="tablist"/);
  assert.match(componentSource, /activeGroupId/);
  assert.match(componentSource, /hidden=\{activeGroupId !== group\.id\}/);
  assert.match(componentSource, /expandedByGroup\[group\.id\]/);
  assert.match(componentSource, /className="notification-overview-item__row"/);
  assert.doesNotMatch(componentSource, /className="notification-overview-recent"/);
  assert.match(componentCss, /\.notification-overview-scroll\s*\{[\s\S]*overflow-y:\s*auto/);
});

test('규칙 기본 행은 전체 대상을 보이고 조건과 최근 결과는 하나의 상세에 보존한다', () => {
  assert.match(componentSource, /<dt>받는 사람<\/dt>/);
  assert.match(componentSource, /자세히 보기/);
  assert.match(componentSource, /<dt>언제 보내나<\/dt>/);
  assert.match(componentSource, /<dt>최근 결과<\/dt>/);
  assert.match(componentSource, /<dt>발송 시간<\/dt>/);
  assert.match(componentSource, /<dt>보내는 방법<\/dt>/);
  assert.match(componentSource, /<dt>확인 시각<\/dt>/);
  assert.match(componentSource, /<dt>마지막 기록<\/dt>/);
  assert.doesNotMatch(componentSource, /이 상태로 표시한 이유|notificationReasonPresentation/);
  assert.match(componentCss, /@media \(max-width: 480px\)/);
  assert.match(componentCss, /overflow-wrap:\s*anywhere/);
  assert.match(componentCss, /min-width:\s*0/);
});

test('상세 패널은 유효한 예시 문구만 원문 줄바꿈으로 표시한다', () => {
  assert.match(componentSource, /item\.example_message/);
  assert.match(componentSource, /exampleMessage\?\.text/);
  assert.match(componentSource, /예시 발송 문구/);
  assert.match(componentSource, /exampleMessage\.label/);
  assert.match(componentSource, /exampleMessage\.subject/);
  assert.match(componentSource, /data-notification-example-message/);
  assert.match(componentCss, /notification-overview-example-message__text[\s\S]*white-space:\s*pre-wrap/);
  assert.match(componentCss, /notification-overview-example-message__text[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(componentCss, /notification-overview-example-message\s*\{[\s\S]*max-width:\s*100%/);
});

test('자동 알림 종류 조회 문제가 있을 때만 기존 경고 표면을 재사용한다', () => {
  assert.match(componentSource, /function notificationCatalogWarning/);
  assert.match(componentSource, /state === 'partial'/);
  assert.match(componentSource, /state === 'unavailable'/);
  assert.match(componentSource, /catalog_status/);
  assert.match(componentSource, /className="notification-overview__log-warning"/);
  assert.match(componentSource, /return ''/);
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

test('상태는 우선순위에 따라 쉬운 문구 하나로 표시하고 미지원 값은 단정하지 않는다', () => {
  assert.deepEqual(
    notificationStatusPresentation({ policy: { status: 'paused' }, configuration: { status: 'ready' } }),
    { key: 'paused', label: '보내지 않음' },
  );
  assert.deepEqual(
    notificationStatusPresentation({
      id: 'customer_started',
      policy: { status: 'active' },
      configuration: { status: 'incomplete', reason: '제작 시작 알림 사용 설정이 꺼져 있습니다.' },
    }),
    { key: 'off', label: '알림 꺼짐' },
  );
  for (const [status, label] of [
    ['test', '시험 모드'],
    ['incomplete', '설정 필요'],
    ['ready', '자동 발송 설정됨'],
    ['conditional', '추가 확인 필요'],
    ['unknown', '상태 확인 필요'],
  ]) {
    assert.equal(notificationStatusPresentation({ policy: { status: 'active' }, configuration: { status } }).label, label);
  }
  assert.equal(
    notificationStatusPresentation({
      id: 'different_rule',
      policy: { status: 'active' },
      configuration: { status: 'incomplete', reason: '제작 시작 알림 사용 설정이 꺼져 있습니다.' },
    }).label,
    '설정 필요',
  );
  assert.equal(notificationStatusPresentation({ policy: { status: 'active' }, configuration: { status: 'future-mode' } }).label, '상태 확인 필요');
  for (const unsupportedStatus of ['off', 'paused', '__proto__', 'toString']) {
    assert.equal(
      notificationStatusPresentation({ policy: { status: 'active' }, configuration: { status: unsupportedStatus } }).label,
      '상태 확인 필요',
    );
  }
  assert.equal(notificationStatusPresentation({ policy: { status: 'future-policy' }, configuration: { status: 'ready' } }).label, '상태 확인 필요');
  assert.equal(notificationReasonPresentation('지원하지 않는 새 사유'), '자세한 이유는 확인이 필요합니다.');
  assert.notEqual(
    notificationReasonPresentation('평일 예약 실행과 LMS 발송 조건이 충족되었습니다.'),
    notificationReasonPresentation('이벤트 발생 시 LMS 발송 조건이 충족되었습니다.'),
  );
  assert.doesNotMatch(componentSource, /정책 사용/);
});

test('기술 용어는 정해진 쉬운 말로만 바꾸고 의미와 조건을 보존한다', () => {
  assert.equal(notificationTextPresentation('KST 08:00 · 멱등 발송'), '한국시간 08:00 · 같은 안내를 중복해서 보내지 않음');
  assert.equal(
    notificationTextPresentation('사내 internal_* 및 chonbe_alert의 수신거부·차단 결과 감지'),
    '직원 알림과 분체 미착수 영업 알림에서 수신거부·차단 결과가 확인될 때',
  );
  assert.match(notificationTextPresentation('미매핑 담당자는 제외'), /연락처가 등록되지 않은 담당자는 제외/);
  assert.equal(notificationChannelPresentation('LMS'), '장문문자');
  assert.equal(notificationChannelPresentation('future-channel'), '보내는 방법 확인 필요');
  assert.equal(notificationRecentLabelPresentation('제공사 접수 성공'), '발송 요청 완료');
  assert.equal(notificationRecentLabelPresentation('future-result'), '처리 상태 확인 필요');
});

test('페이지 전용 밝은 상태 팔레트는 지정 색과 텍스트 대비 조합을 사용한다', () => {
  for (const color of ['#FFFFFF', '#172033', '#EAF4FF', '#174EA6', '#1D4ED8', '#DDF8EE', '#065F46', '#FFE4EC', '#9F1239', '#FFF2CC', '#854D0E', '#EEE8FF', '#5B21B6', '#EEF2F7', '#374151']) {
    assert.match(pageCss, new RegExp(color, 'i'));
  }
  assert.match(componentCss, /notification-overview-badge--ready[^}]*background:\s*var\(--sms-employee-bg\)[^}]*color:\s*var\(--sms-employee-ink\)/s);
  assert.match(componentCss, /notification-overview-badge--paused[\s\S]*background:\s*var\(--sms-paused-bg\)[\s\S]*color:\s*var\(--sms-paused-ink\)/);
});
