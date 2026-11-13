import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('../src/pages/SmsHistoryPage.jsx', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/pages/SmsHistoryPage.css', import.meta.url), 'utf8');
const componentSource = readFileSync(new URL('../src/components/SmsCampaignManager.jsx', import.meta.url), 'utf8');
const componentCss = readFileSync(new URL('../src/components/SmsCampaignManager.css', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/notificationCampaigns.js', import.meta.url), 'utf8');

test('새 문자 등록 단추는 초안 폼이 아니라 문자 템플릿 등록 팝업으로 연결한다', () => {
  // 초안 저장소는 서버가 canActivate:false 라 발송되지 않아 화면 연결을 끊고, 실제 발송되는 템플릿 등록으로 보낸다(2026-11-14)
  assert.doesNotMatch(pageSource, /<SmsCampaignManager/);
  assert.match(pageSource, /selectMenu\('templates', \{ mode: 'new', kind: KIND_SMS \}\)/);
  assert.match(pageSource, />새 문자 등록<\/button>/);
  assert.ok(pageSource.indexOf('sms-console-new-text') > pageSource.indexOf('<SmsConsoleSidebar'));
  assert.ok(pageSource.indexOf('sms-console-new-text') < pageSource.search(/id="sms-history-audience-panel-customer"/));
  assert.match(pageCss, /grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
});

test('초안 API는 범위 조회, 정확한 등록 본문, revision 포함 수정만 제공한다', () => {
  assert.match(apiSource, /\/notification-campaigns\?/);
  assert.match(apiSource, /method:\s*'POST'/);
  assert.match(apiSource, /method:\s*'PUT'/);
  assert.doesNotMatch(apiSource, /activate|send|phone|consent/i);
  assert.match(componentSource, /audience,\s*name:\s*form\.name\.trim\(\),\s*subject:\s*form\.subject\.trim\(\),\s*text:\s*form\.text,\s*trigger:/s);
  assert.match(componentSource, /revision:\s*form\.revision/);
});

test('직원 문자는 직접 선택과 0일로 고정하고 고객 포장완료는 0일부터 30일까지 받는다', () => {
  assert.match(componentSource, /audience === 'employee' \? 'manual' : 'packing_completed'/);
  assert.match(componentSource, /audience === 'employee' \? 'manual' : form\.trigger/);
  assert.match(componentSource, /delayDays:\s*form\.trigger === 'packing_completed' && audience === 'customer' \? Number\(form\.delayDays\) : 0/);
  assert.match(componentSource, /min="0" max="30" step="1"/);
});

test('네이티브 dialog는 내부 스크롤과 초점 복원, 중복 저장 방지를 제공한다', () => {
  assert.match(componentSource, /<dialog/);
  assert.match(componentSource, /showModal\(\)/);
  assert.match(componentSource, /onClose=\{restoreFocus\}/);
  assert.match(componentSource, /if \(saving \|\| !valid/);
  assert.match(componentSource, /disabled=\{saving \|\| !valid/);
  assert.match(componentCss, /max-height:\s*min\(88dvh, 820px\)/);
  assert.match(componentCss, /sms-campaign-form__scroll[^}]*overflow-y:\s*auto/s);
  assert.match(componentCss, /@media \(max-width: 480px\)/);
});

test('알려진 변수만 평문 미리보기에 치환하고 409는 자동 재저장하지 않는다', () => {
  for (const field of ['maxLength={80}', 'maxLength={40}', 'maxLength={2000}']) assert.match(componentSource, new RegExp(field.replace(/[{}]/g, '\\$&')));
  assert.match(componentSource, /replaceAll\(`\{\$\{variable\.key\}\}`/);
  assert.match(componentSource, /unknownVariables\.length === 0/);
  assert.match(componentSource, /error\?\.status === 409/);
  assert.match(componentSource, /작성 내용은 유지됩니다/);
  assert.match(componentSource, /최신 초안 불러오기/);
  assert.match(componentSource, /messageType === 'error'/);
  assert.match(componentSource, /등록한 문자 확인 중/);
  assert.match(componentSource, /등록한 문자 확인 필요/);
  assert.match(componentCss, /sms-campaign-variables button[^}]*min-height:\s*var\(--control-min-height\)/s);
  assert.match(componentCss, /article > div strong[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(componentSource, /발송 동의|전화번호|활성화 버튼/);
});
