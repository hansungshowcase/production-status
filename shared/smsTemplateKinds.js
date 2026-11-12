// 문자 관리 콘솔 템플릿 화면의 '종류'·'보내는 곳' 판정과, 제작현황 밖(메이크·쏠라피 자동화·스마트스토어 연동·쏠라피 앱)에서 나가는
// 한성 문구 표. api/ 와 src/ 양쪽에서 import 한다(순수 함수·상수만).
// 표 내용은 2026-11-12 메이크 시나리오 29개·쏠라피 콘솔 원문·30일 발송 묶음을 읽어 손으로 정리했다.
// 본문 틀의 직원 실명은 [담당자], 고객 값은 [고객명]·[상호] 같은 자리표시로 바꿔 적는다(실제 고객 이름·번호는 넣지 않는다).

export const KINDS = Object.freeze(['주문·출고 안내', '이벤트·혜택', '상담·문의', '직원 작업 알림', '관리자·시스템', '미분류']);
export const SENDERS = Object.freeze({
  program: '제작현황', make: '메이크', auto: '쏠라피 자동화', commerce: '스마트스토어 연동', app: '쏠라피 앱', unknown: '확인 안 됨',
  cafe24: '카페24',
});
export const SMS_CHANNELS = Object.freeze(['SMS', 'LMS', 'MMS']);
export const KAKAO_CHANNELS = Object.freeze(['ATA', 'BMS']);
export const UNCLASSIFIED = '미분류';

// 알림톡·브랜드메시지·친구톡은 화면에서 ATA/BMS 두 가지로만 구분한다(BMS_FREE·CTA·CTI 는 BMS).
export function normalizeChannel(type) {
  const raw = String(type || '').trim().toUpperCase();
  if (raw === 'SMS' || raw === 'LMS' || raw === 'MMS' || raw === 'ATA') return raw;
  if (raw.startsWith('BMS') || raw === 'CTA' || raw === 'CTI') return 'BMS';
  return raw;
}

// ---------- 제작현황 카탈로그 16개 → 종류 ----------
export const CATALOG_KINDS = Object.freeze({
  customer_ordered: '주문·출고 안내',
  customer_started: '주문·출고 안내',
  customer_packed: '주문·출고 안내',
  customer_rescheduled: '주문·출고 안내',
  customer_shipped: '주문·출고 안내',
  internal_vcut_completed: '직원 작업 알림',
  internal_design_due: '직원 작업 알림',
  internal_laser_due: '직원 작업 알림',
  internal_welding_due: '직원 작업 알림',
  internal_assembly_due: '직원 작업 알림',
  chonbe_alert: '직원 작업 알림',
  sms_delivery_block_admin_alert: '관리자·시스템',
  internal_overdue_unshipped: '직원 작업 알림',
  internal_overdue_equipment: '직원 작업 알림',
  internal_overdue_packing: '직원 작업 알림',
  internal_ship_day: '직원 작업 알림',
});
export const kindOfCatalogId = id => CATALOG_KINDS[id] || UNCLASSIFIED;

// 고객 알림톡 템플릿 중 제작현황이 직접 쓰는 것(쏠라피 템플릿 ID → 카탈로그 id)
export const PROGRAM_TEMPLATE_IDS = Object.freeze({
  KA01TP260708084934111VLwWvP3SNic: 'customer_ordered',
  KA01TP260709073753747H1g44KpFRrA: 'customer_packed',
  KA01TP260709074805712CBxEItBajnD: 'customer_rescheduled',
  KA01TP260709074214799PHhwnXRp2sM: 'customer_shipped',
});

// 제작현황 문자·알림톡을 제목·본문 틀로 알아본다(DB 조회 없이). [정규식, 카탈로그 id]
const PROGRAM_CUSTOMER = [
  [/주문이 정상 접수|\[한성쇼케이스\] 주문 접수 안내/, 'customer_ordered'],
  [/제작이 시작되었습니다|\[한성쇼케이스\] 제작 시작 안내/, 'customer_started'],
  [/포장이 완료되어|\[한성쇼케이스\] 포장 완료 안내/, 'customer_packed'],
  [/제작 일정에 따라|\[한성쇼케이스\] 출고 예정일 안내/, 'customer_rescheduled'],
  [/주문하신 제품이 출고되었습니다|\[한성쇼케이스\] 출고 완료 안내/, 'customer_shipped'],
];
const PROGRAM_STAFF = [
  [/^\[한성쇼케이스 자재 입고 요청\]/, 'internal_vcut_completed'],
  [/^\[한성쇼케이스 도면 작업 요청\]/, 'internal_design_due'],
  [/^\[한성쇼케이스 레이저 작업 요청\]/, 'internal_laser_due'],
  [/^\[한성쇼케이스 용접 착수 점검\]/, 'internal_welding_due'],
  [/^\[한성쇼케이스 조립 진행 요청\]/, 'internal_assembly_due'],
  [/^\[한성쇼케이스 분체 미착수 경보/, 'chonbe_alert'],
  [/^\[한성쇼케이스 문자 수신 이상\]/, 'sms_delivery_block_admin_alert'],
  [/^\[생산현황 납기 지연 출고 미완료\]/, 'internal_overdue_unshipped'],
  [/^\[생산현황 납기 지연 설비작업 미완료\]/, 'internal_overdue_equipment'],
  // 포장 완료 알림은 이름이 두 번 바뀌었다(포장 완료 점검·요청 → 납기 지연 포장 미완료 → 포장 완료 요청). 카탈로그에서는 한 항목이다.
  [/^\[한성쇼케이스 포장 완료 (점검|요청)\]/, 'internal_overdue_packing'],
  [/^\[생산현황 (납기 지연 포장 미완료|포장 완료 요청)\]/, 'internal_overdue_packing'],
  [/^\[생산현황 오늘 출고 예정\]/, 'internal_ship_day'],
];

// ---------- 제작현황 밖에서 나가는 한성 문구 표 ----------
// key, name, channel(SMS/LMS/MMS/ATA/BMS), sender, kind, ad, audience, body(틀 전문·없으면 ''), via('메이크' 또는 ''), scenario, trigger, active,
// match: { templateId | review | types+words } — 같은 문구가 메이크와 쏠라피 콘솔에 둘 다 있으면 한 항목(본문은 더 완전한 쪽).
const MAKE = SENDERS.make;
const COMMERCE = SENDERS.commerce;
const APP = SENDERS.app;
const CAFE24 = SENDERS.cafe24;
const KAKAO_TYPES = ['BMS', 'CTA', 'CTI'];

export const EXTERNAL_TEMPLATES = Object.freeze([
  // ---- 켜져 있는 메이크 시나리오 ----
  {
    key: 'review_blog', name: '블로그 리뷰 7만원 이벤트', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: true, audience: '고객', who: '리뷰 안내 대상 고객',
    via: MAKE, scenario: '리뷰 카톡발송 (같은 문구: 리뷰(1개월 텀) 작업일보 — 꺼짐)', trigger: '매일 11:59 · 구글시트에 리뷰 안내 대상 행이 있을 때', active: true,
    body: '안녕하세요\n\n[상호] 대표님 한성쇼케이스입니다\n\n한 달 동안만 진행되는\n\n블로그 리뷰 이벤트입니다\n\n리뷰를 남겨주실 경우\n\n현금 7만원이 바로 지급됩니다\n\n놓치지 마세요..!\n\n[버튼] 리뷰 남기고 7만원 받기 (상단에 이미지 1장)\n알림톡이 실패하면 (광고)한성쇼케이스그룹 머리말을 붙인 장문문자로 대체 발송',
    match: { review: 'blog', types: KAKAO_TYPES, words: ['블로그 리뷰 이벤트'] },
    image: '/sms-templates/review_blog.jpg',
  },
  {
    key: 'event_free_support', name: '무료 지원 이벤트', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: true, audience: '고객', who: '카페24 회원가입 고객',
    via: MAKE, scenario: '카페24 회원가입 대상 이벤트 발송', trigger: '90분 간격(시간대 제한) · 카페24 가입 5~10일 지난 고객이 시트에 있을 때', active: true,
    body: '[한성쇼케이스 무료 지원 이벤트]\n\n안녕하세요 [고객명] 대표님, 한성쇼케이스입니다 :)\n\n하루하루 쉽지 않은 상황 속에서도\n묵묵히 매장을 지켜가고 계신 자영업자 대표님들께\n작게나마 힘이 되어드리고 싶어\n쇼케이스 냉장고 무료 지원 이벤트를 진행하고 있습니다.\n\n매월 단 2분을 선정하여\n대표님의 매장에 필요한 쇼케이스 냉장고를 무료로 지원해드립니다.\n\n카페, 꽃집, 정육점, 반찬가게 등\n쇼케이스가 필요하셨지만 여러 이유로 미뤄오셨다면\n이번 기회에 대표님의 이야기를 들려주세요.\n\n아래 구글폼에\n쇼케이스가 필요한 이유와 대표님의 사연을 남겨주셔야\n최종 참여가 완료됩니다.\n\n👉 신청 링크\n\n구글폼 링크 : https://forms.gle/3DkjR2PhYdgpsNza6\n\n보내주신 사연은 꼼꼼히 확인 후,\n최종 선정되신 분께 개별 연락드리겠습니다.\n\n대표님의 진심 어린 이야기를 기다리겠습니다.\n감사합니다 :)',
    match: { types: KAKAO_TYPES, words: ['한성쇼케이스 무료 지원 이벤트'] },
  },
  {
    key: 'youtube_interview', name: '유튜브 인터뷰 혜택 안내(요청 고객용)', channel: 'ATA', sender: MAKE, kind: '이벤트·혜택', ad: false, audience: '고객', who: '유튜브 인터뷰를 요청한 고객',
    via: MAKE, scenario: '유튜브 인터뷰 발송', trigger: '매일 17:59 · 구글시트에 유튜브 인터뷰를 요청한 고객 행이 있을 때', active: true,
    body: '안녕하세요, [상호] 대표님.\n한성쇼케이스 제품을 구매해 주셔서 감사합니다.\n\n문의주신 유튜브 인터뷰 촬영 혜택 안내드립니다.\n\n■ 대상: 당사 제품 구매 고객\n■ 내용: 매장 운영 관련 유튜브 인터뷰 촬영\n■ 참여 시 제공 사항\n  - 배송 운임비 50% 지원\n  - 매장 홍보용 쇼츠 영상 제작 제공\n■ 모집 인원: 10명 (선착순 마감)\n■ 모집 기간: 한 달간\n\n더 자세한 정보를 안내받으시려면\n010-5879-2438로 연락 부탁드립니다.',
    match: { templateId: 'KA01TP260427071128256TBi5mAg9hvT' },
  },
  {
    key: 'review_sns', name: 'SNS 리뷰 4만원 이벤트(이미지 문자)', channel: 'MMS', sender: MAKE, kind: '이벤트·혜택', ad: false, audience: '고객', who: 'SNS 리뷰 안내 대상 고객',
    via: MAKE, scenario: '쓰레드 인스타 이벤트 한성', trigger: '매일 12:01 · 구글시트에 SNS 리뷰 안내 대상 행이 있을 때', active: true,
    body: '[사진 첨부] 한성쇼케이스 SNS 리뷰 4만원 지급이벤트\nhttps://cafe.naver.com/[카페아이디]/1757',
    match: { review: 'sns', types: ['MMS'], words: ['cafe.naver.com', '/1757'] },
    image: '/sms-templates/review_sns.jpg',
  },
  {
    key: 'caution_notice', name: '주의사항 안내(이미지 문자)', channel: 'MMS', sender: MAKE, kind: '주문·출고 안내', ad: false, audience: '고객',
    via: MAKE, scenario: '한성쇼케이스 주의사항 안내문자', trigger: '매일 18:00 · 구글시트에 새 행이 올라오면', active: true,
    body: '[사진 첨부] 한성쇼케이스 주의사항 안내',
    match: { types: ['MMS'], words: ['한성쇼케이스 주의사항 안내'] },
    image: '/sms-templates/caution_notice.jpg',
  },
  {
    key: 'ship_schedule', name: '출고일정 안내(담당자 회신 요청)', channel: 'ATA', sender: MAKE, kind: '주문·출고 안내', ad: false, audience: '고객', who: '출고 일정이 가까운 고객',
    via: MAKE, scenario: '출고알림톡발송', trigger: '웹훅으로 요청이 올 때(실시간)', active: true,
    body: '원활한 출고를 위해 꼭 회신 부탁드립니다.\n\n출고일정 안내\n\n안녕하세요 [상호] 대표님\n한성쇼케이스입니다.\n\n구매하신 제품의 출고일정이 가까워져 안내드립니다.\n아래 사항을 남겨주시면 출고담당자가 연락드릴예정입니다.\n\n(회신이 없으면 출고 일정에 차질이 생길 수 있으니 꼭 회신 부탁드립니다.)\n\n업체명\n연락처\n제품 수령일자\n기타 전달사항(선택)',
    match: { templateId: 'KA01TP260812073741858iPCG0dqPx6Z' },
  },
  // ---- 쏠라피 스마트스토어 연동(커머스 자동화)·쏠라피 앱 ----
  {
    key: 'smartstore_thanks', name: '주문 감사 안내(스마트스토어 연동 문자)', channel: 'LMS', sender: COMMERCE, kind: '이벤트·혜택', ad: false, audience: '고객', who: '스마트스토어 주문 고객',
    via: '', scenario: '쏠라피 커머스 자동화 · 한성쇼케이스', trigger: "스마트스토어 상품 주문 상태가 '배송중'으로 바뀔 때", active: true,
    body: '안녕하세요, [고객명]님. 주문해주셔서 대단히 감사합니다.\n한성쇼케이스그룹입니다.\n\n제품 받으신 후 네이버 스토어에 리뷰를 남겨주시면\n현금 30,000원을 입금해 드립니다.\n리뷰 이벤트는 제품 받으신 날로부터 30일 이내 참여 시 적용됩니다.\n혜택을 놓치지 마세요!!\n\n리뷰 남기신 후 [리뷰 캡처 이미지]와 [계좌번호]를\n010-7731-4237로 보내주시면 확인 후 입금해 드립니다.\n\n리뷰 한 줄 한 줄이 저희에게는 정말 무엇과도 바꿀 수 없는 큰 힘과 격려가 되고 있습니다.\n가능하시다면 긍정적인 리뷰로 저희를 한 번 더 웃게 해주시면 정말 감사하겠습니다!\n\n최대한 빠르게 배송하겠습니다.\n건강 유의하셔서 사업 번창하십시오😊😊\n\n▶ 리뷰 작성하기\n모바일: https://m.pay.naver.com/o/home/review/registable\nPC: https://order.pay.naver.com/home?tabMenu=REVIEW_WRITABLE',
    match: { types: ['LMS', 'SMS'], words: ['주문해주셔서 대단히 감사합니다'] },
  },
  {
    key: 'smartstore_confirmed', name: '구매확정 안내(스마트스토어 연동 문자)', channel: 'LMS', sender: COMMERCE, kind: '이벤트·혜택', ad: false, audience: '고객', who: '스마트스토어 구매 고객',
    via: '', scenario: '쏠라피 커머스 자동화 · 한성쇼케이스 구매확정 문자(냉장고마켓 구매확정 문자도 같은 문구)', trigger: '스마트스토어 구매가 확정될 때', active: true,
    body: '안녕하세요,\n[고객명] 대표님!\n한성쇼케이스그룹입니다.\n\n저희 제품을 믿고 선택해 주셔서 진심으로 감사드립니다. 😊\n\n현재 저희 제품을 구매해 주시는 대부분의 대표님께서 소중한 후기를 남겨주고 계시는데요.\n\n대표님께서 정성스럽게 적어주시는 리뷰 한 줄 한 줄이 저희에게는 정말 무엇과도 바꿀 수 없는 큰 힘과 격려가 되고 있습니다.\n\n바쁘시겠지만, [고객명] 대표님께서도 제품을 받아보신 후 소중한 리뷰를 남겨주시면 저희 팀원들에게 더 없이 큰 응원이 될 것 같습니다.\n\n가능하시다면 긍정적인 리뷰로 저희를 한 번 더 웃게 해주시면 정말 감사하겠습니다!\n\n🎁 네이버 스토어 리뷰 작성 이벤트 안내\n\n리뷰를 남겨주신 후,\n[리뷰 캡처 이미지]와 [계좌번호]를 010-7731-4237 이쪽으로\n보내주시면 감사의 마음을 담아 현금 30,000원을 입금해 드립니다.\n\n이벤트 기간: 제품 받으신 날로부터 30일 이내 참여 시\n\n혜택: 현금 30,000원 즉시 입금 (놓치지 마세요!)\n\n🛠 불편 사항 및 고객 지원\n\n혹시라도 제품 사용 중 불편하신 점이나 문의 사항이 있으시면 아래 연락처로 언제든 연락 주세요.\n저희가 확인하는 즉시 가장 빠르게 해결을 도와드리겠습니다!\n\n고객 지원 문의: 010-5879-2438\n\n고객 A/S 센터: http://pf.kakao.com/_LxgyRxj\n\n🔗 리뷰 작성하기\n모바일: https://m.pay.naver.com/o/home/review/registable\nPC: https://order.pay.naver.com/home?tabMenu=REVIEW_WRITABLE',
    match: { types: ['LMS', 'SMS'], words: ['저희 제품을 믿고'] },
  },
  {
    key: 'smartstore_order_done', name: '한성쇼케이스 주문완료(스마트스토어 연동)', channel: 'ATA', sender: COMMERCE, kind: '주문·출고 안내', ad: false, audience: '고객', who: '스마트스토어 주문자',
    via: '', scenario: '쏠라피 커머스 자동화 · 결제 완료 시 주문자에게 알림톡 발송', trigger: '스마트스토어 결제가 완료될 때', active: true,
    body: '안녕하세요\n\n[고객명] 대표님\n\n쇼케이스 업계 1위 한성입니다\n\n주문이 정상적으로 완료되었습니다\n\n주문일자 : [날짜]\n주문상품 : [상품명]\n\n현재 주문량 폭주로 인해\n\n생산 기간이 최소 2~4주 소요됩니다\n\n조금만 기다려 주시면 배송 관련 담당자가 통화드릴 예정입니다\n\n고객센터 운영시간\n오전9시~오후6시\n\n[버튼] 채널 추가 / 쇼핑몰 바로가기',
    match: { templateId: 'KA01TP250321073813462yOWUEV6y7Fz' },
  },
  {
    key: 'inquiry_received', name: '문의 접수 완료 안내', channel: 'ATA', sender: APP, kind: '상담·문의', ad: false, audience: '고객', who: '문의를 접수한 고객',
    via: '', scenario: '', trigger: '문의가 접수될 때(쏠라피 앱에서 발송)', active: true,
    body: '안녕하세요 한성입니다\n\n문의 접수가 완료되었습니다 대표님\n\n현재 상담 건이 많이 밀려있어\n\n최대한 빠른 시일내에 담당자가 연락드릴 예정입니다\n\n문의에 앞서 자세한 내용은 아래 쇼핑몰에서도 확인이 가능합니다 .\n\n잘만든 쇼케이스는 매장을 바꿉니다.\n-한성쇼케이스\n\n[버튼] 쇼핑몰 바로가기 (상단에 이미지 1장)',
    match: { templateId: 'KA01TP241203032306319qTEW1CUj8Hl' },
  },
  // ---- 꺼져 있는 메이크 시나리오(한성 것) ----
  {
    key: 'startup_tips', name: '창업팁 안내(친구톡)', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: false, audience: '고객',
    via: MAKE, scenario: '창업팁 발송 (같은 문구: Integration Webhooks, SOLAPI)', trigger: '90분 간격(시간대 제한) · 구글시트에 새 행이 올라오면', active: false,
    body: '초기 자영업 사장님을 위한\n5가지 생존 전략\n\n안녕하세요, [상호] 대표님!\n한성 쇼케이스 그룹입니다.\n\n자영업 초기 1년\n생존율이 40% 이하인 현실에서\n성공하는 매장들의\n비결을 알려드립니다.\n\n수천 개의 매장을 현장에서 지켜본\n한성의 5가지 생존 전략\n\n1. 단골을 만드는 첫날의 전략\n(동선, 응대, SNS 연결 팁)\n\n2. 리뷰를 매출로 바꾸는 법\n(실제 문구 예시 포함)\n\n3. 매장사진 전략\n(촬영 팁, 진열 포인트)\n\n4. 숫자 관리의 중요성\n(일매출·객단가·재고 회전율)\n\n5. 혼자 하지 않는 법\n(조력자·커뮤니티·정보 채널 활용법)\n\n솔직하고 현실적인 노하우를 지금 확인하세요!\n\n[버튼] 창업팁 바로보기',
    match: { types: KAKAO_TYPES, words: ['5가지 생존 전략'] },
  },
  {
    key: 'friend_referral', name: '지인 추천 현금 50만원 이벤트', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: true, audience: '고객', who: '지인 추천 대상 고객',
    via: MAKE, scenario: '지인추천 친구톡 발송 (같은 문구: 지인소개 (1개월 텀) 연락처 입력시)', trigger: '매주 월요일 11:59 또는 매월 1일 12:00 · 구글시트 대상 행', active: false,
    body: '안녕하세요\n\n[상호] 대표님 한성쇼케이스입니다\n\n30개 업체만 선정하여 발송하는\n\n이벤트입니다\n\n참여만 하셔도 현금 50만원\n\n스타벅스 커피쿠폰\n\n보유하신 한성 제품 보증기간 2개월이 연장됩니다\n\n쇼케이스가 필요한 지인에게\n\n저희 한성을 소개만 해주시면 됩니다\n\n자세한 내용이 궁금하시다면\n\n바로 아래 버튼을 눌러주세요..!!\n\n[버튼] 현금 50만원 받기 (상단에 이미지 1장)',
    match: { types: KAKAO_TYPES, words: ['현금 50만원', '지인에게'] },
  },
  {
    key: 'showcase_guide', name: '쇼케이스 선택 가이드', channel: 'BMS', sender: MAKE, kind: '상담·문의', ad: false, audience: '고객',
    via: MAKE, scenario: '쇼케이스 선택가이드 자동발송', trigger: '30분 간격(시간대 제한) · 구글시트에 새 행이 올라오면', active: false,
    body: '안녕하세요, [상호] 대표님!\n한성 쇼케이스 그룹입니다.\n\n쇼케이스를 처음 선택하실 때,\n무엇을 기준으로 골라야 할지 고민되시죠?\n\n❗업종에 따라 필요한 냉장 방식이 다르고\n❗공간, 디자인, 실용성까지 꼼꼼히 따져봐야 합니다.\n\n이에 한성쇼케이스에서는\n업종별로 꼭 확인하셔야 할 체크포인트를\n한눈에 보실 수 있도록 ‘선택 가이드’를 준비했습니다.\n\n고민 중이신 고객님께\n분명 도움이 될 수 있을 거라 생각합니다.\n\n아래 버튼에서 상세 내용을 확인해보세요.\n\n[버튼] 꽃·반찬·음료·정육점·카페 쇼케이스 선택 가이드 (상단에 이미지 1장)',
    match: { types: KAKAO_TYPES, words: ['선택 가이드'] },
  },
  {
    key: 'blog_program_free', name: '블로그 배포 프로그램 무료 체험 안내', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: true, audience: '고객',
    via: MAKE, scenario: 'Integration Google Sheets', trigger: '15분 간격 · 구글시트에 새 행이 올라오면', active: false,
    body: '안녕하세요\n\n[상호] 대표님\n\n한성쇼케이스입니다!\n\n한성에서\n블로그 배포 프로그램을 개발했습니다\n\n네이버 블로그 포스팅 5건을 무료로 사용해보실 수 있습니다\n\n한 달 동안만 무료로 배포하고 있습니다 [상호] 대표님 사용하셔서 사업에 조금이나마 도움이 되셨으면 합니다\n\n한성을 이용 해주시는 대표님들께 또 좋은 기회가 있다면 안내드리도록 하겠습니다.\n\n항상 노력하는 한성이 되겠습니다.\n\n한성 쇼케이스는 끝까지 대표님들의 편입니다. 감사합니다.\n\n해당 이벤트에 관심이 있으시다면 [자세히보기] 버튼을 클릭하세요.',
    match: { types: KAKAO_TYPES, words: ['블로그 배포 프로그램'] },
  },
  {
    key: 'cafe24_welcome', name: '카페24 신규회원 무료 지원 이벤트 안내', channel: 'BMS', sender: MAKE, kind: '이벤트·혜택', ad: false, audience: '고객', who: '카페24 신규 회원',
    via: MAKE, scenario: '카페24 신규회원', trigger: '웹훅으로 가입 알림이 올 때(실시간)', active: true,
    body: '안녕하세요!\n한성쇼케이스 그룹 입니다.\n\n날이 갈수록 어려워지는 경제 침체 속에서\n저희 한성이 자영업자분들을 응원하기 위해 특별한 이벤트를 준비했습니다 ✨\n\n자영업자분들의 부담을 덜고, 사업에 활력을 불어넣어드리고자\n쇼케이스 무료 지원 이벤트를 진행합니다 !\n\n해당 이벤트는 이번 한 달간 한시적으로 진행될 예정입니다.\n많은 관심 부탁드립니다.\n\n저희 한성은 자영업자분들의 든든한 파트너로서 항상 함께하겠습니다.\n한성쇼케이스는 여러분의 성장을 응원합니다.\n\n✅ 당첨자 발표 : 25년 03월 10일\n\n✅ 당첨자 유튜브 발표 링크\n✅ 당첨자 후기 링크 : 당첨자 후기\n\n✅ 본사 사무실 : 031-****-2458\n(문의량 폭주로 인해 통화 문의가 어려울 수 있다는 점 양해부탁드립니다.)\n\n✅ 1200 사이즈 아래로 용도에 관계없이 당첨 시 원하시는 제품으로 배송됩니다.\n(설치 및 운임비 만 부담해주시면 됩니다)\n\n★★★ 홈페이지 회원 가입 후 정확한 회원 가입 아이디를 남겨주셔야 추후 원활한 배송이 가능합니다 ★★★\n\n★★★ 허위 작성 발견 시 추후 진행되는 모든 이벤트에서 자격이 박탈됩니다 ★★★\n\n★★★ 당첨자는 대표님의 하루 일상 또는 당첨 후기 영상을 촬영하고 있습니다 ★★★\n\n★★★ 촬영 후 인터뷰는 추후 유튜브를 통해 업로드 됩니다. (얼굴 공개) ★★★\n\n이벤트 참여를 원하시면 아래의 폼을 제출 부탁드립니다 ^^\n\nhttps://forms.gle/7HbbBZGwZnU464yo6',
    match: { types: KAKAO_TYPES, words: ['당첨자 발표', '허위 작성 발견 시'] },
  },
  {
    key: 'shipping_due_7', name: '납기 7일 남은 업체 명단(출고 담당·부사장)', channel: 'BMS', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '출고 담당자·부사장',
    via: MAKE, scenario: '출고담당자,부사장님 출고 관리용 (오류 상태)', trigger: '240분 간격(시간대 제한) · 납기 7일 남은 업체가 시트에 있을 때', active: false,
    body: '안녕하세요, [담당자]님.\n납기일이 7일 앞으로 다가온 업체 명단입니다.\n확인 해주시길 바랍니다.\n\n납기 7일 남은 업체\n[업체 명단]',
    match: { types: KAKAO_TYPES, words: ['납기일이 7일 앞으로 다가온 업체 명단'] },
  },
  {
    key: 'shipping_due_3', name: '납기 3일 이내 업체 명단(출고 담당·부사장)', channel: 'BMS', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '출고 담당자·부사장',
    via: MAKE, scenario: '출고담당자,부사장님 출고 관리용 (오류 상태)', trigger: '240분 간격(시간대 제한) · 납기 3일 이내 업체가 시트에 있을 때', active: false,
    body: '안녕하세요, [담당자]님.\n납기일이 3일 앞으로 다가온 업체 명단입니다.\n확인 해주시길 바랍니다.\n\n납기 3일이내 업체\n[업체 명단]',
    match: { types: KAKAO_TYPES, words: ['납기일이 3일 앞으로 다가온 업체 명단'] },
  },
  {
    key: 'shipping_overdue', name: '납기일 지난 업체 명단(출고 담당·부사장)', channel: 'BMS', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '출고 담당자·부사장',
    via: MAKE, scenario: '출고담당자,부사장님 출고 관리용 (오류 상태)', trigger: '240분 간격(시간대 제한) · 납기일이 지난 업체가 시트에 있을 때', active: false,
    body: '안녕하세요, [담당자]님.\n납기일이 지난 업체 명단입니다.\n확인 해주시길 바랍니다.\n\n납기일 지난 업체 명단\n[업체 명단]',
    match: { types: KAKAO_TYPES, words: ['납기일이 지난 업체 명단입니다'] },
  },
  {
    key: 'automation_request_alert', name: '자동화 업무 요청 대기 알림', channel: 'BMS', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '자동화 업무 요청자',
    via: MAKE, scenario: '자동화 업무 알람 (한성냉동테크 채널)', trigger: '매일 11:59 · 구글시트에 자동화 업무 요청 행이 있을 때', active: false,
    body: '안녕하세요 [담당자] 님\n요청하신 자동화 업무 : [업무명]\n\n[날짜]  해당날짜부터 대기중입니다.\n\n요청하신 업무를 신속히 끝내기 위해서는 피드백이 필요하니 빠른 피드백 부탁드립니다.',
    match: { types: KAKAO_TYPES, words: ['요청하신 자동화 업무'] },
  },
  {
    key: 'company_info_forward', name: '업체 정보 전달', channel: 'BMS', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원',
    via: MAKE, scenario: '업체정보 자동 보내기 (한성냉동테크 채널)', trigger: '10분 간격(시간대 제한) · 에어테이블에 새 기록이 생기면', active: false,
    body: '연락처:[고객 연락처]\n업체명:[상호]\n제품타입:[제품 타입]\n특이사항:[메모]',
    match: { types: KAKAO_TYPES, words: ['제품타입:', '특이사항:'] },
  },
  {
    key: 'laser_team_alert', name: '레이저 작업 팀장 알림', channel: 'ATA', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '레이저 부서 팀장',
    via: MAKE, scenario: '레이저 팀장님(10일) (오류 상태)', trigger: '240분 간격(시간대 제한) · 구글시트에서 납기 10일 이내 레이저 작업 행이 있을 때', active: false,
    body: '안녕하세요,\n\n레이저 부서 [담당자] 팀장님.\n\n납기일이 10일 앞으로 다가온 업체 중 레이저 가공이 되지 않은 제품 목록입니다.\n\n확인 뒤 작업 바랍니다.\n\n납기 10일 남은 업체\n\n[업체 목록]',
    match: { templateId: 'KA01TP260106022315894hsJZuJnaNGM' },
  },
  {
    key: 'drawing_request', name: '도면 작업 요청 안내(캐드 담당자)', channel: 'ATA', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '캐드 담당자',
    via: MAKE, scenario: '레이저 작업현황 14일전 확인 (오류 상태)', trigger: '240분 간격(시간대 제한) · 구글시트에서 납기 14일 전 작업 행이 있을 때', active: false,
    body: '[도면 작업 요청 안내]\n\n안녕하세요, 캐드 담당자님.\n[상호]의 납기일이 14일 앞으로 다가왔습니다.\n\n도면(레이저) 작업이 필요하니 확인 부탁드립니다.\n\n감사합니다.\n\n[업체 목록]',
    match: { templateId: 'KA01TP2601060225185026a5ruLDA6Um' },
  },
  {
    key: 'foreman_ship_3d', name: '공장장 출고 3일 전 알림', channel: 'ATA', sender: MAKE, kind: '직원 작업 알림', ad: false, audience: '직원', who: '공장장',
    via: MAKE, scenario: '설비부서 공장장(3일전) (오류 상태)', trigger: '180분 간격(시간대 제한) · 구글시트에서 출고 3일 전 작업 행이 있을 때', active: false,
    body: '안녕하세요,\n\n[담당자] 공장장님.\n\n납기일이 3일 앞으로 다가온 업체 중 조립이되지 않은 제품 목록입니다.\n\n확인 뒤 작업 바랍니다.\n\n납기 3일 남은 업체\n\n[업체 목록]\n\n감사합니다.',
    match: { templateId: 'KA01TP260106022745294EhNvcRBVHm1' },
  },
  {
    key: 'ship_inquiry', name: '출고 문의 안내', channel: 'ATA', sender: MAKE, kind: '주문·출고 안내', ad: false, audience: '고객', who: '출고일자가 가까운 고객',
    via: MAKE, scenario: '납기 3일내 담당자 문자 발송 · Integration SOLAPI', trigger: '15분 간격 · 구글시트 조건에 맞는 행이 있을 때', active: false,
    body: '출고문의는 꼭 아래 링크를 통해 문의 바랍니다.\n\n출고일정 안내\n\n안녕하세요 [업체명] 대표님\n한성쇼케이스입니다.\n\n구매하신 제품의 출고일자가 가까워져 안내문자 발송 드립니다\n\n아래 출고문의 카카오톡 링크로 연결후\n업체명/연락처를 남겨주시면\n빠른시간내로 출고팀에서\n연락 드릴 예정 입니다 감사합니다\n\n[버튼] 출고 문의하기',
    match: { templateId: 'KA01TP260701025852899CSGPYIaCwGQ' },
  },
  // ---- 카페24 쇼핑몰 자동 알림(쏠라피를 거치지 않고 카페24 가 직접 보냄 · 2026-11-12 밤 전수 대조로 더함) ----
  {
    key: 'cafe24_admin_member_join', name: '신규 회원 가입 알림(운영자용)', channel: 'SMS', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '직원', who: '쇼핑몰 운영자',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '쇼핑몰 신규 회원 가입 때마다 · 최근 1개월 484건', active: true,
    body: '한성쇼케이스 운영자님, [고객명] 님이 [아이디] ID로 신규 회원 가입하셨어요.',
    match: {},
  },
  {
    key: 'cafe24_admin_inquiry_post', name: '견적문의 새 글 알림(운영자용)', channel: 'SMS', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '직원', who: '쇼핑몰 운영자',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '견적문의 게시판에 새 글이 등록될 때 · 최근 1개월 약 55건', active: true,
    body: '한성쇼케이스 운영자님, 견적문의에 \'[제목]\' 신규 글이 등록되었어요.',
    match: {},
  },
  {
    key: 'cafe24_admin_order', name: '주문 처리 알림(운영자용)', channel: 'SMS', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '직원', who: '쇼핑몰 운영자',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '주문 결제·발송조치·송장 발송·자체배송 처리 때 · 최근 1개월 약 18건', active: true,
    body: '한성쇼케이스 운영자님, [주문번호] 주문 상품이 발송되었어요.\n한성쇼케이스 운영자님, [날짜]에 [금액]원 [주문번호] 주문이…\n한성쇼케이스 운영자님, …주문을 자체배송 …',
    match: {},
  },
  {
    key: 'cafe24_ata_order_done', name: '주문 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '쇼핑몰 주문 고객',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '쇼핑몰 주문이 완료될 때 · 최근 30일 2건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_order_paid', name: '주문 결제 완료', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_deposit_guide', name: '입금 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 2건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_deposit_cancel', name: '입금 전 취소 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '쇼핑몰 주문 고객',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '입금 전에 주문이 취소될 때 · 최근 30일 1건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_deposit_done', name: '무통장 입금 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '무통장 입금이 확인될 때 · 최근 30일 1건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_shipped', name: '발송 조치 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '쇼핑몰 주문 고객',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '주문이 발송 조치될 때 · 최근 30일 1건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_shipped_invoice', name: '송장 포함 발송 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '쇼핑몰 주문 고객',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '송장이 입력되어 발송될 때 · 최근 30일 1건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_password_guide', name: '비밀번호 안내', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '쇼핑몰 회원',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '비밀번호 안내를 요청할 때 · 최근 30일 4건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_password_changed', name: '비밀번호 변경 안내', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '쇼핑몰 회원',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '비밀번호가 변경될 때 · 최근 30일 2건', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_points_given', name: '주문 적립금 지급 안내', channel: 'ATA', sender: CAFE24, kind: '이벤트·혜택', ad: false, audience: '고객', who: '쇼핑몰 주문 고객',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '주문 적립금이 지급될 때 · 최근 30일 2건', active: true,
    body: '',
    match: {},
  },
  // ---- 카페24 에서 켜져 있지만 최근 30일 발송이 없는 자동 알림(전체 보기에서만 보임 · 수신 대상·채널은 카페24 설정에서 확인 필요) ----
  {
    key: 'cafe24_ata_order_deposit_request', name: '입금 요청', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '주문 후 입금을 요청할 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_order_deposit_expiring', name: '입금 만료 예정 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '입금 기한이 다가올 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_order_preparing', name: '배송 준비중 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '주문이 배송 준비 상태가 될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_purchase_confirm_request', name: '구매 확정 요청', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '구매 확정을 요청할 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_purchase_confirmed', name: '구매 확정 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '구매가 확정될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_cancel_received', name: 'CS 취소·반품·교환 접수 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '취소·반품·교환이 접수될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_cancel_requested', name: 'CS 취소·반품·교환 신청 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '취소·반품·교환이 신청될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_cancel_withdrawn', name: 'CS 취소·반품·교환 철회 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '취소·반품·교환이 철회될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_cancel_done', name: 'CS 취소·반품·교환 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '취소·반품·교환이 완료될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_cancel_rejected', name: 'CS 취소·반품·교환 접수 거부 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '취소·반품·교환 접수가 거부될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_extra_deposit', name: 'CS 추가 입금 요청', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_pickup_done', name: 'CS 수거 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_cs_refund', name: 'CS 환불 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '환불이 처리될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_card_cancel_all', name: '카드결제 전체취소 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '카드결제가 전체 취소될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_card_cancel_part', name: '카드결제 부분취소 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '카드결제가 부분 취소될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_pay_done', name: '예약 결제 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문의 결제가 완료될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_deposit_guide', name: '예약 입금 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문의 입금 안내가 나갈 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_deposit_request', name: '예약 입금 요청', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문의 입금을 요청할 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_deposit_done', name: '예약 무통장 입금 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문의 무통장 입금이 확인될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_deposit_expiring', name: '예약 입금 만료 예정 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문의 입금 기한이 다가올 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_reserve_deposit_cancel', name: '예약 입금 전 취소 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '예약 주문이 입금 전에 취소될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_auth_code', name: '본인확인 인증번호 발송', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '본인확인 인증번호를 보낼 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_member_auth_request', name: '회원인증 요청', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '회원인증을 요청할 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_member_auth_guide', name: '회원인증 안내', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_restock_done', name: '재입고 완료 안내', channel: 'ATA', sender: CAFE24, kind: '주문·출고 안내', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_points_expiring', name: '적립금 소멸 안내', channel: 'ATA', sender: CAFE24, kind: '이벤트·혜택', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '적립금이 소멸 예정일 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_coupon_download_expiring', name: '다운로드 쿠폰 만료 예정 안내', channel: 'ATA', sender: CAFE24, kind: '이벤트·혜택', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '내려받은 쿠폰이 만료 예정일 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_dormant_before', name: '휴면 일반회원 전환 사전 안내', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '휴면 회원으로 전환되기 전 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_dormant_after', name: '휴면 일반회원 전환 사후 안내', channel: 'ATA', sender: CAFE24, kind: '관리자·시스템', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '휴면 회원으로 전환된 뒤 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_board_comment', name: '게시판 댓글 등록 안내', channel: 'ATA', sender: CAFE24, kind: '상담·문의', ad: false, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '게시판에 댓글이 등록될 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
  {
    key: 'cafe24_ata_coupon_expiring_ad', name: '쿠폰 만료 예정 안내(광고)', channel: 'ATA', sender: CAFE24, kind: '이벤트·혜택', ad: true, audience: '고객', who: '',
    via: CAFE24, scenario: '카페24 자동 알림(쏠라피를 거치지 않음)', trigger: '쿠폰이 만료 예정일 때 · 최근 30일 발송 없음', active: true,
    body: '',
    match: {},
  },
]);

const byKey = new Map(EXTERNAL_TEMPLATES.map(entry => [entry.key, entry]));
export const externalByKey = key => byKey.get(key) || null;

// 템플릿 ID 로 이 표(또는 제작현황 카탈로그)의 항목을 찾는다. 알림톡 카드에 칩을 더할 때 쓴다.
export function templateMeta(templateId) {
  const id = String(templateId || '');
  if (!id) return null;
  const programKey = PROGRAM_TEMPLATE_IDS[id];
  if (programKey) return { key: programKey, kind: kindOfCatalogId(programKey), sender: SENDERS.program, ad: false, active: true, audience: '고객' };
  const entry = EXTERNAL_TEMPLATES.find(item => item.match.templateId === id);
  return entry ? { key: entry.key, kind: entry.kind, sender: entry.sender, ad: entry.ad, active: entry.active, audience: entry.audience || '고객' } : null;
}

// ---------- 대상(고객 전용 / 직원 전용)으로 먼저 묶기 ----------
export const AUDIENCE_GROUPS = Object.freeze(['고객 전용', '직원 전용', '분류 안 됨']);
export const UNASSIGNED_GROUP = '분류 안 됨';
// 대상 이름('고객'·'직원'·'관리자') → 묶음 이름. 관리자는 직원 전용 안에 둔다. 모르면 '분류 안 됨'.
export function audienceGroupOf(audience) {
  const value = String(audience || '').trim();
  if (value === '고객') return AUDIENCE_GROUPS[0];
  if (value === '직원' || value === '관리자') return AUDIENCE_GROUPS[1];
  return UNASSIGNED_GROUP;
}

// 목록 순서를 지킨 채 [{group, items}] 로 나눈다(빈 묶음은 뺀다).
export function splitByAudience(items, audienceOf) {
  const buckets = new Map(AUDIENCE_GROUPS.map(group => [group, []]));
  for (const item of Array.isArray(items) ? items : []) buckets.get(audienceGroupOf(audienceOf(item))).push(item);
  return AUDIENCE_GROUPS.map(group => ({ group, items: buckets.get(group) })).filter(section => section.items.length > 0);
}

// 대상 → 종류(KINDS 순서) 두 단계. '분류 안 됨'은 종류 머리글 없이 kinds = [{ kind: '', items }].
export function groupByAudience(items, audienceOf, kindOf) {
  return splitByAudience(items, audienceOf).map(({ group, items: list }) => {
    const kinds = group === UNASSIGNED_GROUP
      ? [{ kind: '', items: list }]
      : KINDS.map(kind => ({ kind, items: list.filter(item => (KINDS.includes(kindOf(item)) ? kindOf(item) : UNCLASSIFIED) === kind) })).filter(section => section.items.length > 0);
    return { group, count: list.length, kinds };
  });
}

// 제작현황·EXTERNAL_TEMPLATES 로 안 정해지는 쏠라피 알림톡 템플릿의 대상·종류(2026-11-12 실서버 템플릿 본문을 읽어 정리).
// 본문으로도 판단이 안 서는 템플릿은 넣지 않는다 → 화면에서 '분류 안 됨'.
export const KAKAO_TEMPLATE_AUDIENCE = Object.freeze({
  KA01TP261109062223240MMJpznyrFDY: { audience: '직원', kind: '직원 작업 알림' }, // 오늘 출고 예정 안내(영업담당자)
  KA01TP250416024130837E759TgoqFyK: { audience: '고객', kind: '이벤트·혜택' }, // 창업팁 (회원가입 발송용)
  KA01TP241122133057314REQ1jBe8gM7: { audience: '고객', kind: '상담·문의' }, // 문의 접수 완료 알림톡
  KA01TP241121081728960UBEMQ0TPy6Q: { audience: '고객', kind: '상담·문의' }, // 문의 접수 알림톡
  KA01TP241121080700739kkTF0qGca5t: { audience: '고객', kind: '상담·문의' }, // 이름 없는 템플릿(문의 접수 완료 문구)
  KA01TP241119052633077Yp7fKyfEX3p: { audience: '고객', kind: '상담·문의' }, // 신규 고객 안내 메세지(사본)
  KA01TP2411181325001592SH3EJ4LBy8: { audience: '고객', kind: '상담·문의' }, // 신규 고객 안내 메세지
  KA01TP241111150159713O9K5ysCUpZa: { audience: '고객', kind: '이벤트·혜택' }, // 회원 가입 적립금 이벤트
  KA01TP240112020108095KxWH7XaHaGY: { audience: '고객', kind: '이벤트·혜택' }, // 지인 소개 프로모션
});

// ---------- 판정 ----------
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const channelMatches = (types, channel) => !types || types.some(type => (type === 'BMS' ? channel === 'BMS' : channel === type));

function matchExternal({ channel, templateId, reviewId, hay }) {
  for (const entry of EXTERNAL_TEMPLATES) {
    const m = entry.match;
    if (m.templateId) { if (templateId && templateId === m.templateId) return entry; continue; }
    if (!channelMatches(m.types, channel)) continue;
    if (m.review && reviewId === m.review) return entry;
    if (m.words && m.words.every(word => hay.includes(word))) return entry;
  }
  return null;
}

function programKeyOf({ templateId, subject, text }) {
  if (PROGRAM_TEMPLATE_IDS[templateId]) return PROGRAM_TEMPLATE_IDS[templateId];
  const firstLine = String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
  for (const [pattern, id] of PROGRAM_STAFF) if (pattern.test(subject) || pattern.test(firstLine)) return id;
  const hay = `${subject}\n${text}`;
  for (const [pattern, id] of PROGRAM_CUSTOMER) if (pattern.test(hay)) return id;
  return null;
}

// 이름이 들어 있을 수 있는 제목은 남기지 않는다(응답·화면에 고객 이름이 나오지 않게)
function safeTitle() {
  return ''; // 제목·본문 조각은 key 에 넣지 않는다(고객 이름·번호 노출 방지)
}

function senderFromHints(source, fields) {
  if (source === 'AUTO') return SENDERS.auto;
  if (source === 'COMM') return SENDERS.commerce;
  if (source === 'APP') return SENDERS.app;
  if (fields && (fields.storeId || fields.store_id || fields.productOrderId)) return SENDERS.commerce;
  if (fields && (fields.hookId || fields.hook_id)) return SENDERS.auto;
  return SENDERS.unknown;
}

// message: { type(처음 보낸 종류), templateId, subject, text, reviewId?, source?, customFields? }
// → { key, kind, sender, channel, ad, audience }
// 판정 순서: ① 제작현황 문구(제목·본문 틀) ② 리뷰 이벤트 ③ 템플릿 ID ④ 표의 고정 낱말 ⑤ 남으면 key = '미분류/종류/제목'
export function classify(message = {}) {
  const channel = normalizeChannel(message.type);
  const templateId = String(message.templateId || '').trim();
  const subject = oneLine(message.subject);
  const text = String(message.text ?? '');
  const programId = programKeyOf({ templateId, subject, text });
  if (programId) {
    const kind = kindOfCatalogId(programId);
    return {
      key: programId, kind, sender: SENDERS.program, channel, ad: false,
      audience: kind === '직원 작업 알림' ? '직원' : kind === '관리자·시스템' ? '관리자' : '고객',
    };
  }
  const entry = matchExternal({ channel, templateId, reviewId: message.reviewId, hay: `${subject}\n${text}` });
  if (entry) return { key: entry.key, kind: entry.kind, sender: entry.sender, channel: entry.channel, ad: entry.ad, audience: entry.audience || '고객' };
  const title = safeTitle();
  return {
    key: `${UNCLASSIFIED}/${channel || '?'}/${title}`, kind: UNCLASSIFIED, sender: senderFromHints(message.source, message.customFields),
    channel, ad: /^\s*\(광고\)/.test(text) || /^\s*\(광고\)/.test(subject), audience: '고객',
  };
}

// '미분류/LMS/제목' → 화면에 보일 이름
export function unclassifiedName() {
  return '분류 안 된 문자';
}
