import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_KINDS, EXTERNAL_TEMPLATES, KINDS, SENDERS, SMS_CHANNELS, classify, templateMeta,
} from '../shared/smsTemplateKinds.js';
import { buildKindedItems, kindSections } from '../src/components/smsconsole/smsTemplateListModel.js';
import { readOnlyKakaoItems, templateExtras } from '../src/components/smsconsole/templateListModel.js';
import { handleSmsConsole, _resetConsoleCacheForTest } from '../api/sms-console.js';

// 2026-11-12 쏠라피 30일 발송 묶음(문자 24·알림톡 6)을 개인 정보 없는 요약 줄로 옮긴 시험 자료.
// 처음 보낸 종류(type)·템플릿 ID·제목·본문 첫머리만 둔다. 이름·번호는 자리표시.
const TID = {
  inquiry: 'KA01TP241203032306319qTEW1CUj8Hl', ship: 'KA01TP260812073741858iPCG0dqPx6Z',
  youtube: 'KA01TP260427071128256TBi5mAg9hvT', orderDone: 'KA01TP250321073813462yOWUEV6y7Fz',
};
const P = SENDERS.program;
const ROWS = [
  // 문자 24
  ['주의사항 안내(이미지문자)', { type: 'MMS', subject: '한성쇼케이스 주의사항 안내', text: '한성쇼케이스 주의사항 안내' }, 'caution_notice', '주문·출고 안내', SENDERS.make],
  ['납기 지연 설비작업 미완료', { type: 'LMS', text: '[생산현황 납기 지연 설비작업 미완료]\n[담당자] 공장장님,\n기준일: 2026-10-26' }, 'internal_overdue_equipment', '직원 작업 알림', P],
  ['SNS 리뷰 4만원(이미지문자)', { type: 'MMS', subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', text: 'https://cafe.naver.com/[카페아이디]/1757' }, 'review_sns', '이벤트·혜택', SENDERS.make],
  ['자재 입고 요청', { type: 'LMS', text: '[한성쇼케이스 자재 입고 요청]\n[담당자] 부장님,\n대상: 1건' }, 'internal_vcut_completed', '직원 작업 알림', P],
  ['무료 지원 이벤트(BMS→LMS)', { type: 'BMS_FREE', text: '(광고)한성쇼케이스그룹\n[한성쇼케이스 무료 지원 이벤트]\n\n안녕하세요 [고객명] 대표님' }, 'event_free_support', '이벤트·혜택', SENDERS.make],
  ['주문 접수 안내(프로그램 LMS)', { type: 'LMS', text: '[고객명]님, 주문이 정상 접수되었습니다.\n\n- 주문번호: HS-2026-0733' }, 'customer_ordered', '주문·출고 안내', P],
  ['블로그 리뷰 7만원(BMS→LMS)', { type: 'BMS_FREE', text: '(광고)한성쇼케이스그룹\n안녕하세요\n\n[상호] 대표님 한성쇼케이스입니다\n\n한 달 동안만 진행되는\n\n블로그 리뷰 이벤트입니다\n\n리뷰를 남겨주실 경우\n\n현금 7만원이' }, 'review_blog', '이벤트·혜택', SENDERS.make],
  ['포장 완료 점검', { type: 'LMS', text: '[한성쇼케이스 포장 완료 점검]\n[담당자]님,\n확인 대상 18건입니다.' }, 'internal_overdue_packing', '직원 작업 알림', P],
  ['분체 미착수 경보', { type: 'LMS', text: '[한성쇼케이스 분체 미착수 경보 2026-10-26]\n[담당자]님,\n대상: 9건' }, 'chonbe_alert', '직원 작업 알림', P],
  ['납기 지연 출고 미완료', { type: 'LMS', text: '[생산현황 납기 지연 출고 미완료]\n[담당자]님,\n기준일: 2026-11-10' }, 'internal_overdue_unshipped', '직원 작업 알림', P],
  ['주문 감사 안내(스마트스토어 연동 문자)', { type: 'LMS', text: '안녕하세요, [고객명]님. 주문해주셔서 대단히 감사합니다.\n한성쇼케이스그룹입니다.' }, 'smartstore_thanks', '이벤트·혜택', SENDERS.commerce],
  ['용접 착수 점검', { type: 'LMS', text: '[한성쇼케이스 용접 착수 점검]\n[담당자] 이사님,\n대상: 12건' }, 'internal_welding_due', '직원 작업 알림', P],
  ['포장 완료 요청(생산현황)', { type: 'LMS', text: '[생산현황 포장 완료 요청]\n[담당자] 팀장님,\n대상: 45건' }, 'internal_overdue_packing', '직원 작업 알림', P],
  ['조립 진행 요청', { type: 'LMS', text: '[한성쇼케이스 조립 진행 요청]\n[담당자] 공장장님,\n대상: 17건' }, 'internal_assembly_due', '직원 작업 알림', P],
  ['레이저 작업 요청', { type: 'LMS', text: '[한성쇼케이스 레이저 작업 요청]\n[담당자] 부장님,\n작업 9건입니다.' }, 'internal_laser_due', '직원 작업 알림', P],
  ['납기 지연 포장 미완료', { type: 'LMS', text: '[생산현황 납기 지연 포장 미완료]\n수신: [담당자] 공장장\n대상: 62건' }, 'internal_overdue_packing', '직원 작업 알림', P],
  ['도면 작업 요청', { type: 'LMS', text: '[한성쇼케이스 도면 작업 요청]\n[담당자] 팀장님,\n대상: 4건' }, 'internal_design_due', '직원 작업 알림', P],
  ['대표님 안내(스마트스토어 연동 문자)', { type: 'LMS', text: '안녕하세요,\n[고객명] 대표님!\n한성쇼케이스그룹입니다.\n\n저희 제품을 믿고 선택해 주셔서 진심으로' }, 'smartstore_confirmed', '이벤트·혜택', SENDERS.commerce],
  ['문의 접수 완료 알림톡(→LMS)', { type: 'ATA', templateId: TID.inquiry, text: '안녕하세요 한성입니다\n\n문의 접수가 완료되었습니다 대표님' }, 'inquiry_received', '상담·문의', SENDERS.app],
  ['포장 완료 요청(한성쇼케이스)', { type: 'LMS', text: '[한성쇼케이스 포장 완료 요청]\n[담당자] 팀장님,\n작업 13건입니다.' }, 'internal_overdue_packing', '직원 작업 알림', P],
  ['문자 수신 이상', { type: 'LMS', text: '[한성쇼케이스 문자 수신 이상]\n수신자: [담당자]\n알림 종류: internal_overdue_equipment' }, 'sms_delivery_block_admin_alert', '관리자·시스템', P],
  ['오늘 출고 예정', { type: 'LMS', text: '[생산현황 오늘 출고 예정]\n[담당자]님,\n대상: 4건' }, 'internal_ship_day', '직원 작업 알림', P],
  ['출고 완료 안내(프로그램 LMS)', { type: 'LMS', text: '[고객명]님, 주문하신 제품이 출고되었습니다.\n\n- 주문번호: HS-2026-0527' }, 'customer_shipped', '주문·출고 안내', P],
  ['출고일정안내(알림톡→LMS)', { type: 'ATA', templateId: TID.ship, text: '안녕하세요 [상호] 대표님\n한성쇼케이스입니다.\n\n구매하신 제품의 출고일정이' }, 'ship_schedule', '주문·출고 안내', SENDERS.make],
  // 알림톡·브랜드메시지 6
  ['유튜브 인터뷰 혜택 안내', { type: 'ATA', templateId: TID.youtube, text: '안녕하세요, [상호] 대표님.\n한성쇼케이스 제품을 구매해 주셔서 감사합니다.' }, 'youtube_interview', '이벤트·혜택', SENDERS.make],
  ['블로그 리뷰 7만원(BMS)', { type: 'BMS_FREE', text: '안녕하세요\n\n[상호] 대표님 한성쇼케이스입니다\n\n한 달 동안만 진행되는\n\n블로그 리뷰 이벤트입니다\n\n리뷰를 남겨주실 경우\n\n현금 7만원이' }, 'review_blog', '이벤트·혜택', SENDERS.make],
  ['문의 접수 완료 알림톡', { type: 'ATA', templateId: TID.inquiry, text: '안녕하세요 한성입니다\n\n문의 접수가 완료되었습니다 대표님' }, 'inquiry_received', '상담·문의', SENDERS.app],
  ['무료 지원 이벤트(BMS)', { type: 'BMS_FREE', text: '[한성쇼케이스 무료 지원 이벤트]\n\n안녕하세요 [고객명] 대표님, 한성쇼…' }, 'event_free_support', '이벤트·혜택', SENDERS.make],
  ['출고일정안내-김보수', { type: 'ATA', templateId: TID.ship, text: '원활한 출고를 위해 꼭 회신 부탁드립니다.' }, 'ship_schedule', '주문·출고 안내', SENDERS.make],
  ['한성쇼케이스 주문완료', { type: 'ATA', templateId: TID.orderDone, text: '안녕하세요\n\n[고객명] 대표님\n\n쇼케이스 업계 1위 한성입니다' }, 'smartstore_order_done', '주문·출고 안내', SENDERS.commerce],
];

test('분류: 30일 묶음 30줄이 기대한 key·kind·sender 로 판정되고 미분류가 0 이다', () => {
  assert.equal(ROWS.length, 30);
  for (const [name, message, key, kind, sender] of ROWS) {
    const r = classify(message);
    assert.equal(r.key, key, name);
    assert.equal(r.kind, kind, name);
    assert.equal(r.sender, sender, name);
    assert.ok(KINDS.includes(r.kind), name);
  }
});

test('분류: 모르는 문구는 미분류(출처 칸으로 보내는 곳 추정), 이름이 들어갈 제목은 남기지 않는다', () => {
  const a = classify({ type: 'LMS', subject: '새 이벤트 안내', text: '내용', source: 'AUTO' });
  assert.equal(a.kind, '미분류'); assert.equal(a.sender, SENDERS.auto); assert.equal(a.key, '미분류/LMS/');
  assert.equal(classify({ type: 'LMS', text: '홍길동 대표님 안녕하세요' }).key, '미분류/LMS/');
  assert.equal(classify({ type: 'LMS', text: '무언가', customFields: { storeId: true } }).sender, SENDERS.commerce);
  assert.equal(classify({ type: 'LMS', text: '무언가' }).sender, SENDERS.unknown);
  assert.equal(classify({ type: 'LMS', text: '(광고) 무언가' }).ad, true);
});

test('외부 문구 표: 키 중복 0·종류 6개 안·세이프마케팅 것 없음·직원 실명·고객 번호 없음', () => {
  const keys = EXTERNAL_TEMPLATES.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const e of EXTERNAL_TEMPLATES) {
    assert.ok(KINDS.includes(e.kind), e.key);
    assert.ok(['SMS', 'LMS', 'MMS', 'ATA', 'BMS'].includes(e.channel), e.key);
    assert.ok(Object.values(SENDERS).includes(e.sender), e.key);
    assert.ok(e.match && typeof e.match === 'object', e.key);
  }
  const everything = JSON.stringify(EXTERNAL_TEMPLATES);
  assert.doesNotMatch(everything, /세이프/);
  for (const name of ['박상규', '이정섭', '정경호', '김보수', '이준형', '최희선', '이시아', '백승정', '정영호']) assert.ok(!everything.includes(name), name);
  // 회사 번호(이벤트 접수·고객 지원·대표번호) 말고 다른 휴대폰 번호는 없어야 한다
  const phones = [...new Set(everything.replace(/KA01TP\w+/g, '').match(/01\d-?\d{3,4}-?\d{4}/g) || [])].sort();
  assert.deepEqual(phones, ['010-5879-2438', '010-7731-4237']);
  // 자리표시([고객명]·[상호]·[담당자])로만 쓰고 메이크 변수 꼴은 남기지 않는다
  assert.doesNotMatch(everything, /\[변수/);
});

test('외부 문구 표: 카페24 자동 알림 44개는 종류·대상·키가 맞고 빈 문구는 지어내지 않는다', () => {
  const cafe = EXTERNAL_TEMPLATES.filter(e => e.via === SENDERS.cafe24);
  assert.equal(cafe.length, 44);
  assert.equal(new Set(cafe.map(e => e.key)).size, 44);
  for (const e of cafe) {
    assert.ok(KINDS.includes(e.kind), e.key);
    assert.ok(['고객', '직원'].includes(e.audience), e.key);
    assert.equal(e.sender, SENDERS.cafe24, e.key);
    assert.ok(e.trigger, e.key);
    assert.equal(typeof e.active, 'boolean', e.key);
    assert.equal(typeof e.body, 'string', e.key);
  }
  assert.equal(cafe.filter(e => e.active).length, 44);
});

test('외부 문구 표: 메이크 항목은 시나리오·언제 나가나·켜짐 여부를 가진다', () => {
  for (const e of EXTERNAL_TEMPLATES.filter(item => item.via === SENDERS.make)) {
    assert.equal(e.sender, SENDERS.make); assert.ok(e.scenario, e.key); assert.ok(e.trigger, e.key); assert.equal(typeof e.active, 'boolean', e.key);
  }
  assert.ok(EXTERNAL_TEMPLATES.some(e => e.active === false));
  assert.equal(templateMeta(TID.ship).sender, SENDERS.make);
  assert.equal(templateMeta('KA01TP260708084934111VLwWvP3SNic').sender, SENDERS.program);
  assert.equal(templateMeta('nope'), null);
});

const mk = (id, total) => ({
  id, name: `카탈로그 ${id}`, trigger: '상황', policy: { status: 'active', label: '정책 사용' },
  configuration: { status: 'ready', label: '발송 설정 완료' }, example_message: { text: `${id} 예시` },
  recent: { state: 'available', counts: { total } },
});
const catalogOverview = () => ({
  groups: [
    { id: 'customer', items: ['customer_ordered', 'customer_started', 'customer_packed', 'customer_rescheduled', 'customer_shipped'].map((id, i) => mk(id, i)) },
    { id: 'internal', items: Object.keys(CATALOG_KINDS).slice(5).map((id, i) => mk(id, i % 3)) },
  ],
});

test('문자 목록 모델: 카탈로그 16개 유지, 같은 key 중복 0, 외부 문자 4개와 보낸 묶음이 합쳐진다', () => {
  assert.equal(Object.keys(CATALOG_KINDS).length, 16);
  const sent = [
    { key: 'customer_ordered', kind: '주문·출고 안내', sender: P, channel: 'LMS', count7: 99, ad: false },
    { key: 'review_sns', kind: '이벤트·혜택', sender: SENDERS.make, channel: 'MMS', count7: 7, ad: false },
    { key: '미분류/LMS/새 안내', kind: '미분류', sender: SENDERS.auto, channel: 'LMS', count7: 2, ad: false },
    { key: 'review_blog', kind: '이벤트·혜택', sender: SENDERS.make, channel: 'BMS', count7: 5, ad: true },
  ];
  const items = buildKindedItems(catalogOverview(), sent);
  const ids = items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(items.filter(i => !i.external).length, 16);
  assert.equal(items.filter(i => i.external && SMS_CHANNELS.includes(i.channel)).length, 8); // 외부 문자 4 + 카페24 운영자 문자 3 + 미분류 1
  assert.equal(items.find(i => i.id === 'customer_ordered').count, 0); // 카탈로그 카드 건수는 카탈로그 값 그대로
  assert.equal(items.find(i => i.id === 'review_sns').count, 7);
  assert.equal(items.find(i => i.id === 'caution_notice').count, 0);
  assert.ok(!ids.includes('review_blog')); // 브랜드메시지는 알림톡 화면 몫
  // 카탈로그 순서가 그대로
  assert.deepEqual(items.slice(0, 16).map(i => i.id), Object.keys(CATALOG_KINDS));
  const all = kindSections(items, 'all');
  assert.deepEqual(all.map(s => s.kind), ['주문·출고 안내', '이벤트·혜택', '직원 작업 알림', '관리자·시스템', '미분류']);
  const use = kindSections(items, 'in_use');
  assert.ok(use.every(s => s.items.every(i => i.count > 0)));
  // 종류 안은 7일 건수 많은 순
  for (const s of all) for (let i = 1; i < s.items.length; i += 1) assert.ok((s.items[i - 1].count ?? 0) >= (s.items[i].count ?? 0));
  // 카탈로그 카드의 종류
  assert.equal(items.find(i => i.id === 'sms_delivery_block_admin_alert').kind, '관리자·시스템');
});

test('문자 목록 모델: sent 를 못 받으면 외부 카드 건수는 모름(null)이고 카탈로그는 그대로', () => {
  const items = buildKindedItems(catalogOverview(), null);
  assert.equal(items.find(i => i.id === 'review_sns').count, null);
  assert.equal(items.filter(i => !i.external).length, 16);
});

test('알림톡 모델: 읽기 전용 구역은 목록에 없는 브랜드메시지·친구톡만, 발송 중은 7일 1건 이상만', () => {
  const sent = [
    { key: 'review_blog', kind: '이벤트·혜택', sender: SENDERS.make, channel: 'BMS', count7: 163, replaced7: 94, ad: true },
    { key: 'event_free_support', kind: '이벤트·혜택', sender: SENDERS.make, channel: 'BMS', count7: 65, replaced7: 3, ad: true },
    { key: 'youtube_interview', kind: '이벤트·혜택', sender: SENDERS.make, channel: 'ATA', count7: 227, replaced7: 0, ad: false },
    { key: 'customer_ordered', kind: '주문·출고 안내', sender: P, channel: 'ATA', count7: 3, replaced7: 0, ad: false },
  ];
  const listed = [{ id: TID.youtube, name: '유튜브 인터뷰 혜택 안내(요청고객용)' }, { id: TID.ship, name: '출고일정안내' }];
  const all = readOnlyKakaoItems(listed, sent, { status: 'all' });
  assert.ok(all.length >= 12);
  assert.ok(all.every(i => i.channel === 'BMS' || i.channel === 'ATA'));
  assert.ok(!all.some(i => i.id === 'youtube_interview'));
  assert.ok(!all.some(i => i.id === 'customer_ordered'));
  assert.equal(all[0].id, 'review_blog');
  assert.deepEqual(readOnlyKakaoItems(listed, sent, { status: 'in_use' }).map(i => i.id), ['review_blog', 'event_free_support']);
  assert.deepEqual(readOnlyKakaoItems(listed, sent, { status: 'APPROVED' }), []);
  const extras = templateExtras(TID.youtube, sent);
  assert.deepEqual(extras, { sender: SENDERS.make, kind: '이벤트·혜택', replaced7: 0, off: false });
  assert.equal(templateExtras('KA01TP_none', sent), null);
});

// ---- 서버: resource=sent ----
const NOW = Date.parse('2026-11-12T03:00:00Z');
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const request = resource => ({ method: 'GET', query: { resource }, url: '/api/sms-console', socket: { remoteAddress: '8.8.8.8' }, headers: { host: 'production-status.vercel.app' } });
const msg = (over) => ({ messageId: 'M1', groupId: 'G1', to: '01012345678', from: '0319862458', type: 'LMS', statusCode: '4000', dateCreated: '2026-11-12T01:00:00.000Z', text: '', subject: null, replacement: false, customFields: {}, kakaoOptions: { templateId: null }, ...over });

test('resource=sent: 묶음 집계·대체발송·가림, usage 응답 모양 그대로, 같은 훑기 재사용', async () => {
  _resetConsoleCacheForTest();
  let calls = 0;
  const day = async () => {
    calls += 1;
    return {
      partial: false,
      messages: [
        msg({ messageId: 'A1', groupId: 'GA', to: '01011112222', text: '[한성쇼케이스 용접 착수 점검]\n홍길동 이사님,\n대상: 3건' }),
        msg({ messageId: 'A2', groupId: 'GB', to: '01033334444', type: 'ATA', statusCode: '3040', kakaoOptions: { templateId: TID.youtube }, text: '안녕하세요, 김철수 대표님.\n한성쇼케이스 제품을 구매해 주셔서 감사합니다.' }),
        msg({ messageId: 'A3', groupId: 'GB', to: '01033334444', type: 'LMS', replacement: true, statusCode: '4000', text: '안녕하세요, 김철수 대표님.\n한성쇼케이스 제품을 구매해 주셔서 감사합니다.' }),
        msg({ messageId: 'A4', groupId: 'GC', to: '01055556666', type: 'LMS', statusCode: '3040', text: '박민수님 특별 안내입니다', subject: '박민수님 안내' }),
      ],
    };
  };
  const deps = { hasCredentials: () => true, fetchSolapiDay: day, nowMs: NOW, rateLimitCheck: () => true };
  const usage = response(); await handleSmsConsole(request('usage'), usage, deps);
  assert.deepEqual(Object.keys(usage.body).sort(), ['by_template', 'checked_at', 'configured', 'days', 'partial']);
  const res = response(); await handleSmsConsole(request('sent'), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 7, 'usage 와 sent 가 같은 7일 훑기를 쓴다(쏠라피 호출이 늘지 않는다)');
  const byKey = Object.fromEntries(res.body.groups.map(g => [g.key, g]));
  assert.equal(byKey.internal_welding_due.count7, 7);
  assert.equal(byKey.internal_welding_due.sender, SENDERS.program);
  assert.equal(byKey.youtube_interview.channel, 'ATA');
  assert.equal(byKey.youtube_interview.count7, 7);
  assert.equal(byKey.youtube_interview.replaced7, 7);
  assert.equal(byKey.youtube_interview.fail7, 0);
  const unclassified = res.body.groups.find(g => g.kind === '미분류');
  assert.equal(unclassified.fail7, 7);
  assert.deepEqual(Object.keys(res.body.groups[0]).sort(), ['ad', 'audience', 'channel', 'count7', 'fail7', 'key', 'kind', 'last_sent', 'replaced7', 'sender']);
  // 가림: 이름·전화번호 꼴이 응답에 없다
  const json = JSON.stringify(res.body);
  assert.doesNotMatch(json, /홍길동|김철수|박민수/);
  assert.doesNotMatch(json, /01\d[-\s]?\d{3,4}[-\s]?\d{4}/);
  assert.doesNotMatch(json, /"(to|text|subject|from|name)"/);
});

test('resource=sent: 쏠라피 키가 없으면 configured:false 빈 목록', async () => {
  _resetConsoleCacheForTest();
  const res = response();
  await handleSmsConsole(request('sent'), res, { hasCredentials: () => false, nowMs: NOW, rateLimitCheck: () => true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
  assert.deepEqual(res.body.groups, []);
});

test('가림: 이름·번호가 든 미분류 LMS 는 key·반환값에 이름도 번호도 없다', () => {
  const r = classify({ type: 'LMS', subject: '홍길동 사장 견적', text: '견적 문의 회신 010-1234-5678 로 연락 주세요' });
  assert.equal(r.kind, '미분류');
  assert.equal(r.key, '미분류/LMS/');
  assert.doesNotMatch(JSON.stringify(r), /홍길동|010|1234|5678/);
});

test('resource=sent: 미분류 ATA 묶음은 groups 에 없다(세이프마케팅 알림톡 제외)', async () => {
  _resetConsoleCacheForTest();
  const day = async () => ({ partial: false, messages: [
    msg({ messageId: 'B1', groupId: 'GX', to: '01011112222', type: 'ATA', statusCode: '3000', kakaoOptions: { templateId: 'UNKNOWN_TID' }, text: '전혀 모르는 알림톡 문구입니다' }),
    msg({ messageId: 'B2', groupId: 'GY', to: '01033334444', type: 'LMS', statusCode: '3000', text: '모르는 문자 문구입니다' }),
  ] });
  const res = response();
  await handleSmsConsole(request('sent'), res, { hasCredentials: () => true, fetchSolapiDay: day, nowMs: NOW, rateLimitCheck: () => true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.groups.filter(g => g.kind === '미분류' && g.channel === 'ATA').length, 0);
  assert.ok(res.body.groups.some(g => g.kind === '미분류' && g.channel === 'LMS'));
});

test('image 칸이 있는 외부 문구는 그 파일이 public 폴더에 실제로 있다', async () => {
  const { existsSync } = await import('node:fs');
  const withImage = EXTERNAL_TEMPLATES.filter(t => t.image);
  assert.ok(withImage.length >= 3);
  for (const t of withImage) {
    assert.ok(existsSync(new URL(`../public${t.image}`, import.meta.url)), `${t.key} 이미지 없음: ${t.image}`);
  }
});
