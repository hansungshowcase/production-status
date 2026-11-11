import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_MENUS, kindOfType, extractVariables, validateTemplateInput, toSolapiTemplateBody,
  parseConsoleQuery, buildConsoleQuery, activeSubId,
} from '../shared/smsConsole.js';

test('메뉴 순서는 설계 그대로 5개', () => {
  assert.deepEqual(CONSOLE_MENUS.map(m => m.id), ['dashboard', 'log', 'templates', 'customer', 'staff']);
  assert.equal(CONSOLE_MENUS[1].subs.length, 5);
});

test('kindOfType: 문자·알림톡·기타', () => {
  for (const t of ['SMS', 'lms', 'MMS']) assert.equal(kindOfType(t), 'sms');
  for (const t of ['ATA', 'cta', 'CTI', 'BMS_TEXT', 'bms_image']) assert.equal(kindOfType(t), 'kakao');
  for (const t of ['', null, undefined, 'VOICE', 'FAX', 'NSA', 'RCS_SMS']) assert.equal(kindOfType(t), 'other');
});

test('extractVariables: 중복 제거·순서 유지', () => {
  assert.deepEqual(extractVariables('#{이름}님 #{주문번호} 안내 #{이름}'), ['이름', '주문번호']);
  assert.deepEqual(extractVariables(''), []);
  assert.deepEqual(extractVariables(null), []);
});

const base = () => ({
  target: { kind: 'channel', id: 'KA01PF000000000000000001' },
  name: ' 출고 안내 ', content: '#{이름}님 출고되었습니다.', categoryCode: '',
  messageType: 'BA', emphasizeType: 'NONE', securityFlag: false, buttons: [],
});

test('validateTemplateInput: 정상 입력은 깨끗한 값', () => {
  const r = validateTemplateInput(base());
  assert.equal(r.ok, true);
  assert.equal(r.value.name, '출고 안내');
  assert.equal(r.value.categoryCode, '999999');
  assert.deepEqual(r.value.target, { kind: 'channel', id: 'KA01PF000000000000000001' });
  assert.equal('extra' in r.value, false);
  assert.equal('emphasizeTitle' in r.value, false);
});

test('validateTemplateInput: 경계값', () => {
  assert.equal(validateTemplateInput({ ...base(), name: 'ㄱ'.repeat(100) }).ok, true);
  assert.ok(validateTemplateInput({ ...base(), name: 'ㄱ'.repeat(101) }).errors.name);
  assert.ok(validateTemplateInput({ ...base(), name: '   ' }).errors.name);
  assert.equal(validateTemplateInput({ ...base(), content: 'a'.repeat(1000) }).ok, true);
  assert.ok(validateTemplateInput({ ...base(), content: 'a'.repeat(1001) }).errors.content);
  assert.ok(validateTemplateInput({ ...base(), content: '#{이름 있음} 띄어쓰기는 변수 아님 #{bad-name}' }).errors.content);
});

test('validateTemplateInput: 대상·유형 오류', () => {
  assert.ok(validateTemplateInput({ ...base(), target: null }).errors.target);
  assert.ok(validateTemplateInput({ ...base(), target: { kind: 'x', id: 'a' } }).errors.target);
  assert.ok(validateTemplateInput({ ...base(), target: { kind: 'group', id: 'a b' } }).errors.target);
  assert.equal(validateTemplateInput({ ...base(), target: null }, { requireTarget: false }).ok, true);
  assert.ok(validateTemplateInput({ ...base(), messageType: 'AD' }).errors.messageType);
  assert.ok(validateTemplateInput({ ...base(), emphasizeType: 'IMAGE' }).errors.emphasizeType);
});

test('validateTemplateInput: 강조표기형·부가정보형', () => {
  assert.ok(validateTemplateInput({ ...base(), emphasizeType: 'TEXT' }).errors.emphasizeTitle);
  const ok = validateTemplateInput({ ...base(), emphasizeType: 'TEXT', emphasizeTitle: '출고 완료', emphasizeSubtitle: '주문 안내' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.emphasizeSubtitle, '주문 안내');
  assert.ok(validateTemplateInput({ ...base(), messageType: 'EX' }).errors.extra);
  assert.ok(validateTemplateInput({ ...base(), messageType: 'EX', extra: '문의 https://a.kr' }).errors.extra);
  assert.ok(validateTemplateInput({ ...base(), messageType: 'EX', extra: '#{이름} 문의' }).errors.extra);
  assert.equal(validateTemplateInput({ ...base(), messageType: 'EX', extra: '문의는 대표번호로' }).value.extra, '문의는 대표번호로');
});

test('validateTemplateInput: 버튼', () => {
  const six = Array.from({ length: 6 }, () => ({ type: 'DS', name: '배송조회' }));
  assert.ok(validateTemplateInput({ ...base(), buttons: six }).errors.buttons);
  assert.ok(validateTemplateInput({ ...base(), buttons: [{ type: 'WL', name: '보기' }] }).errors['buttons.0']);
  assert.ok(validateTemplateInput({ ...base(), buttons: [{ type: 'WL', name: '보기', linkMo: 'javascript:alert(1)' }] }).errors['buttons.0']);
  assert.ok(validateTemplateInput({ ...base(), buttons: [{ type: 'AL', name: '앱' }] }).errors['buttons.0']);
  assert.ok(validateTemplateInput({ ...base(), buttons: [{ type: 'DS', name: 'ㄱ'.repeat(15) }] }).errors['buttons.0']);
  const r = validateTemplateInput({ ...base(), buttons: [
    { type: 'WL', name: '주문 보기', linkMo: 'https://a.kr/#{번호}', linkPc: '', extra: 'x' },
    { type: 'WL', name: '변수 링크', linkMo: '#{링크}' },
    { type: 'BK', name: '상담', linkMo: 'https://ignored' },
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.buttons, [
    { type: 'WL', name: '주문 보기', linkMo: 'https://a.kr/#{번호}' },
    { type: 'WL', name: '변수 링크', linkMo: '#{링크}' },
    { type: 'BK', name: '상담' },
  ]);
});

test('toSolapiTemplateBody: 채널/그룹 중 하나만, 요청 칸 이름', () => {
  const v = validateTemplateInput({ ...base(), emphasizeType: 'TEXT', emphasizeTitle: '제목', emphasizeSubtitle: '보조',
    buttons: [{ type: 'WL', name: '보기', linkMo: 'https://a.kr' }] }).value;
  const body = toSolapiTemplateBody(v);
  assert.equal(body.channelId, 'KA01PF000000000000000001');
  assert.equal('channelGroupId' in body, false);
  assert.equal(body.emphasizeSubTitle, '보조');
  assert.deepEqual(body.buttons, [{ buttonType: 'WL', buttonName: '보기', linkMo: 'https://a.kr' }]);
  const group = toSolapiTemplateBody({ ...v, target: { kind: 'group', id: 'G1' } });
  assert.equal(group.channelGroupId, 'G1');
  assert.equal('channelId' in group, false);
  const upd = toSolapiTemplateBody(v, { forUpdate: true });
  assert.equal('channelId' in upd || 'channelGroupId' in upd, false);
});

test('parseConsoleQuery: 틀린 값은 기본값', () => {
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('')), { menu: 'dashboard', aud: 'all', ch: 'all', tpl: '', mode: '' });
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('menu=zzz&aud=x&ch=fax&tpl=a%20b&mode=del')),
    { menu: 'dashboard', aud: 'all', ch: 'all', tpl: '', mode: '' });
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('menu=log&aud=staff&ch=kakao')),
    { menu: 'log', aud: 'staff', ch: 'kakao', tpl: '', mode: '' });
  assert.equal(parseConsoleQuery({ menu: 'templates', mode: 'edit' }).mode, '');
  assert.equal(parseConsoleQuery({ menu: 'templates', mode: 'edit', tpl: 'KA01TP1' }).mode, 'edit');
});

test('buildConsoleQuery: 기본값·안 쓰는 값 생략, 왕복 일치', () => {
  assert.equal(buildConsoleQuery({}), '');
  assert.equal(buildConsoleQuery({ menu: 'log', aud: 'customer', ch: 'sms' }), 'menu=log&aud=customer&ch=sms');
  assert.equal(buildConsoleQuery({ menu: 'customer', aud: 'staff', tpl: 'X1' }), 'menu=customer');
  assert.equal(buildConsoleQuery({ menu: 'templates', tpl: 'KA01TP1', mode: 'edit' }), 'menu=templates&tpl=KA01TP1&mode=edit');
  const q = 'menu=log&aud=staff&ch=kakao';
  assert.equal(buildConsoleQuery(parseConsoleQuery(new URLSearchParams(q))), q);
});

test('activeSubId', () => {
  assert.equal(activeSubId({ menu: 'log' }), 'all');
  assert.equal(activeSubId({ menu: 'log', aud: 'customer', ch: 'kakao' }), 'customer-kakao');
  assert.equal(activeSubId({ menu: 'log', aud: 'other' }), null);
  assert.equal(activeSubId({ menu: 'log', aud: 'customer' }), null);
  assert.equal(activeSubId({ menu: 'templates' }), 'list');
  assert.equal(activeSubId({ menu: 'templates', mode: 'new' }), 'new');
  assert.equal(activeSubId({ menu: 'dashboard' }), null);
});
