export const SHOWCASE_GUIDE_BRAND = {
  name: '한성쇼케이스',
  en: 'HANSUNG',
  freeWarrantyMonths: 12,
  asKakaoChatUrl: 'http://pf.kakao.com/_LxgyRxj/chat',
  asKakaoLabel: '카카오톡 A/S 문의 바로가기',
  asChannelShort: '카카오톡 A/S 접수',
  blogReviewUrl: 'https://m.cafe.naver.com/01027857623/1848',
  blogReviewFormUrl: 'https://forms.gle/LnxodxFTxWjcVwx37',
  snsReviewUrl: 'https://m.cafe.naver.com/01027857623/1757',
  googleReviewUrl: 'https://search.google.com/local/writereview?placeid=ChIJ-bkwLD99fDUR2cot00FbA3c',
  smartstoreReviewMobileUrl: 'https://m.pay.naver.com/o/home/review/registable',
  smartstoreReviewPcUrl: 'https://order.pay.naver.com/home?tabMenu=REVIEW_WRITABLE',
  reviewSubmitPhone: '010-7731-4237',
  reviewSubmitSmsHref: 'sms:01077314237',
  reviewInstagramHandle: '@hansungtech',
  legacyManualUrl: 'https://m.site.naver.com/1ywKu',
  kakaoChatUrl: 'http://pf.kakao.com/_vxmpfn/chat',
};

export const DEFAULT_SHOWCASE_SETTING = {
  key: 'default',
  label: '기본세팅',
  tempRange: '5℃ ~ 7℃',
  factoryTemp: '5℃',
  defrostCycle: '2시간',
  defrostTime: '15분',
  isDirectCooling: false,
};

export const SHOWCASE_GUIDE_PRESETS = [
  {
    key: 'bakery',
    label: '제과',
    tempRange: '5℃ ~ 7℃',
    factoryTemp: '5℃',
    defrostCycle: '3시간',
    defrostTime: '15분',
    isDirectCooling: false,
  },
  {
    key: 'beverage',
    label: '음료 & 주류',
    tempRange: '2℃ ~ 5℃',
    factoryTemp: '5℃',
    defrostCycle: '2시간',
    defrostTime: '10분',
    isDirectCooling: false,
  },
  {
    key: 'wine',
    label: '와인',
    tempRange: '5℃ ~ 10℃',
    factoryTemp: '7℃',
    defrostCycle: '2시간',
    defrostTime: '10분',
    isDirectCooling: false,
  },
  {
    key: 'flower',
    label: '꽃',
    tempRange: '7℃ ~ 12℃',
    factoryTemp: '7℃',
    defrostCycle: '1시간',
    defrostTime: '7분',
    isDirectCooling: false,
  },
  {
    key: 'open',
    label: '오픈',
    tempRange: '5℃ ~ 8℃',
    factoryTemp: '5℃',
    defrostCycle: '2시간',
    defrostTime: '10분',
    isDirectCooling: false,
  },
  {
    key: 'macaron',
    label: '마카롱',
    tempRange: '2℃ ~ 5℃',
    factoryTemp: '5℃',
    defrostCycle: '1시간',
    defrostTime: '7분',
    isDirectCooling: false,
  },
  {
    key: 'sashimi',
    label: '회진열',
    tempRange: '0℃ ~ 3℃',
    factoryTemp: 'OND (직냉)',
    defrostCycle: 'OND (직냉)',
    defrostTime: 'OND (직냉)',
    isDirectCooling: true,
  },
  {
    key: 'butcher',
    label: '정육',
    tempRange: '-3℃ ~ 0℃',
    factoryTemp: '-2℃',
    defrostCycle: '3시간',
    defrostTime: '10분',
    isDirectCooling: false,
  },
  {
    key: 'banchan',
    label: '반찬',
    tempRange: '0℃ ~ 3℃',
    factoryTemp: '5℃',
    defrostCycle: '2시간',
    defrostTime: '12분',
    isDirectCooling: false,
  },
  {
    key: 'top_butcher',
    label: '상부쿨러·하부콤프 (정육)',
    tempRange: '-3℃ ~ 0℃',
    factoryTemp: '-2℃',
    defrostCycle: '4시간',
    defrostTime: '20분',
    isDirectCooling: false,
  },
];

const PRESET_MAP = new Map(SHOWCASE_GUIDE_PRESETS.map((preset) => [preset.key, preset]));

/**
 * 내부 product_type·door_type에서 공식 10종 가이드 프리셋 키만 안전하게 추론한다.
 * 원시 product_type 문자열은 절대 노출하지 않고 닫힌 10개 키 또는 null만 반환한다.
 */
export function resolveGuidePresetKey(productType, doorType = '') {
  const pt = String(productType ?? '').trim();
  const dt = String(doorType ?? '').trim();
  if (!pt && !dt) return null;

  if (/상부쿨러|하부콤프/.test(pt)) return 'top_butcher';
  if (/정육|양념육/.test(pt)) return 'butcher';
  if (/마카롱/.test(pt)) return 'macaron';
  if (/회진열|활어|초밥/.test(pt)) return 'sashimi';
  if (/와인/.test(pt)) return 'wine';
  if (/음료|주류/.test(pt)) return 'beverage';
  if (/반찬/.test(pt)) return 'banchan';
  if (/꽃/.test(pt)) return 'flower';
  if (/오픈/.test(pt) || /오픈/.test(dt)) return 'open';
  if (/제과|베이커리|케이크|디저트|샌드위치/.test(pt)) return 'bakery';

  return null;
}

export function getGuidePresetByKey(key) {
  if (typeof key !== 'string') return null;
  return PRESET_MAP.get(key.trim()) || null;
}

export function formatPresetSummary(preset) {
  if (!preset) {
    return `${DEFAULT_SHOWCASE_SETTING.factoryTemp} · 제상 ${DEFAULT_SHOWCASE_SETTING.defrostCycle} / ${DEFAULT_SHOWCASE_SETTING.defrostTime} (기본)`;
  }
  if (preset.isDirectCooling) {
    return `${preset.tempRange} · OND(직냉)`;
  }
  return `${preset.factoryTemp} · 제상 ${preset.defrostCycle} / ${preset.defrostTime}`;
}

export function formatOrderNo(order) {
  if (!order || order.id == null) return '';
  const idNum = Number(order.id);
  if (!Number.isFinite(idNum) || idNum <= 0) return '';
  const orderYear = String(order.order_date || '').slice(0, 4) || String(new Date().getFullYear());
  return `HS-${orderYear}-${String(Math.trunc(idNum)).padStart(4, '0')}`;
}

function parseCanonicalIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim().slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(probe.getTime())
    || probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, iso: raw };
}

/**
 * 출고일('YYYY-MM-DD')로부터 무상 A/S 12개월 만료일을 순수 달력 연산으로 계산한다.
 * 윤년 2월 29일 출고 시 다음 해 2월 28일로 보정한다.
 */
export function calculateWarrantyEndDate(shipDateIso) {
  const parsed = parseCanonicalIsoDate(shipDateIso);
  if (!parsed) return null;
  const nextYear = parsed.year + 1;
  const maxDayInMonth = new Date(Date.UTC(nextYear, parsed.month, 0)).getUTCDate();
  const safeDay = Math.min(parsed.day, maxDayInMonth);
  return `${nextYear}-${String(parsed.month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

export function formatDotDate(value) {
  const parsed = parseCanonicalIsoDate(value);
  if (!parsed) return '-';
  return `${parsed.year}.${String(parsed.month).padStart(2, '0')}.${String(parsed.day).padStart(2, '0')}`;
}

export function buildGuideUrl(baseOrigin, token, presetKey = null) {
  const origin = String(baseOrigin || 'https://production-status.vercel.app').replace(/\/+$/, '');
  const cleanToken = String(token || '').trim();
  const path = cleanToken ? `/guide/${encodeURIComponent(cleanToken)}` : '/guide';
  const normalizedPreset = typeof presetKey === 'string' ? presetKey.trim() : '';
  let query = '';
  if (normalizedPreset === DEFAULT_SHOWCASE_SETTING.key) {
    query = `?p=${DEFAULT_SHOWCASE_SETTING.key}`;
  } else {
    const validPreset = getGuidePresetByKey(normalizedPreset);
    if (validPreset) {
      query = `?p=${encodeURIComponent(validPreset.key)}`;
    }
  }
  return `${origin}${path}${query}`;
}

export const LABEL_CORE_WARNINGS = [
  {
    id: 'dedicated-outlet',
    highlight: true,
    labelText: '※ 반드시 단독 코드 사용 (멀티탭 금지 · 불이행 시 책임 불가)',
  },
  {
    id: 'power-wait',
    highlight: false,
    labelText: '② 설치 후 2~3시간 뒤 전원 연결 · 냉장전용(냉동 금지)',
  },
  {
    id: 'vent-radiator',
    highlight: false,
    labelText: '③ 통풍구 15~20cm 확보 · 라지에이터 월 1회 청소 (미청소 유상)',
  },
  {
    id: 'def-display',
    highlight: false,
    labelText: "④ 'def' 표시는 정상 제상 중 — 그대로 두면 자동 복구",
  },
];

export const GUIDE_SECTIONS = {
  safetyRules: [
    {
      title: '반드시 단독 코드 사용 (필수)',
      emphasis: true,
      body: '멀티탭이나 다른 가전과 함께 연결하지 마시고 반드시 벽면 단독 콘센트에 연결해 주세요. 불이행에 따른 문제는 당사가 책임을 지지 않습니다.',
    },
    {
      title: '설치 후 2~3시간 뒤 전원 연결',
      body: '운반 중 흔들린 냉매와 오일이 안정화된 뒤 전원을 켜야 콤프레샤 고장을 예방할 수 있습니다.',
    },
    {
      title: '통풍구 15~20cm 이상 거리 확보',
      body: '통풍구(쇼케이스 하부 옆·뒷면)를 막지 마세요. 앞문 제품의 경우 열이 빠져나갈 수 있도록 뒷벽면과 15~20cm 거리를 꼭 두고 사용해 주세요.',
    },
    {
      title: '냉장 전용 · 마감 시 별도 보관',
      body: '본 제품은 냉장 전용이므로 냉동 사용을 금합니다. 쇼케이스는 진열용 냉장고이므로 매장 마감 시에는 필히 제품을 매장 냉장고에 별도 보관해 주세요. (미준수로 인한 제품 손상은 책임지지 않습니다.)',
    },
    {
      title: '물받이통 주기적 확인 및 비우기',
      body: '물받이통이 제자리에 들어가 있는지, 물이 떨어지지 않는지 수시로 확인하고 주기적으로 물을 비워주세요.',
    },
  ],
  controllerNote:
    '배전판 상에는 온도를 내리고 올리는 대로 표시되지만 실제로는 해당 온도만큼 내려가지 않을 수 있습니다. 예: 제과(4~8℃ 사용) 제품을 -10℃로 설정해도 실제로 -10℃까지 내려가지 않으며, 내부가 얼거나 콤프레샤 고장의 원인이 될 수 있으니 품목별 권장 온도를 지켜주세요.',
  defNotice:
    '표시창에 "def"가 표시되는 경우 고장이 아니라 자동 제상(성에 제거) 진행 중이라는 뜻입니다. 그대로 두시면 제상시간이 끝난 후 자동으로 정상 복구됩니다.',
  buttons: [
    {
      name: '전원',
      desc: '전원을 ON/OFF할 때 사용합니다. OFF 모드 시 냉각 출력은 정지되며, 조명과 결로팬은 별도로 작동됩니다.',
    },
    {
      name: '조명',
      desc: '내부 조명 램프(LED)를 켜고 끌 때 사용합니다.',
    },
    {
      name: '결로팬',
      desc: '유리 표면 성에·결로 제거용입니다. 평소에는 꺼두었다가 비가 오거나 습한 날씨에만 작동해 주세요.',
    },
  ],
  tempSteps: [
    '「잠금」 버튼을 약 3초간 눌러 잠금을 해지합니다.',
    '우측 「□ 온도표시」 LED에 불이 들어왔는지 확인합니다.',
    '▼ / ▲ 버튼으로 원하는 온도를 맞춘 뒤 손을 떼면 자동으로 저장되며 다시 잠금 설정됩니다.',
  ],
  defrostSteps: [
    '잠금 해지 후 「설정」 버튼을 눌러 우측 「□ 제상주기」에 불이 들어오면 ▼ / ▲ 버튼으로 주기를 맞춥니다. (예: 2시간, 3시간, 4시간 등)',
    '「설정」 버튼을 한 번 더 눌러 우측 「□ 제상시간」에 불이 들어오면 ▼ / ▲ 버튼으로 제상시간을 맞춥니다. (예: 10분, 20분 등)',
  ],
  radiatorCleaning: {
    steps: [
      '청소 전 제품 전원을 반드시 꺼주세요.',
      '안전을 위해 장갑을 착용하고 청소해 주세요.',
      '동봉된 브러시 또는 부드러운 브러시를 사용하여 위, 아래 방향으로 먼지를 제거해 주세요. (청소 시 힘을 가할 경우 흡입구 핀이 변형될 수 있으니 주의하세요.)',
    ],
    warnings: [
      '라지에이터 청소는 월 1회 이상 주기적으로 해주세요. (매장 환경에 따라 필요 시 더 자주 청소)',
      '먼지로 라지에이터가 막히면 내부 온도가 상승하고 소음의 원인이 됩니다.',
      '라지에이터 청소 불이행 시 고장의 원인이 될 수 있으며, 보증기간 이내라도 유상 A/S로 처리될 수 있습니다.',
    ],
  },
  levelingSteps: [
    '쇼케이스를 사용 위치에 놓은 뒤 각 바퀴 옆 조절좌 볼트 4개를 아래쪽으로 최대한 내려 흔들리지 않도록 고정합니다. (볼트는 왼쪽 방향으로 돌리면 내려옵니다.)',
    '휴대폰 수평계 앱을 사용하여 좌우·전후 수평을 맞춥니다.',
    '그릴에 물을 부어 물통으로 잘 빠져나오는지 확인합니다. 물이 잘 빠지지 않으면 물통 반대쪽 조절좌 볼트 2개를 약 3mm 더 내려 물통 쪽이 살짝 낮아지도록 조정하세요. (볼트를 내릴수록 제품이 올라갑니다.)',
  ],
};

export const SHOWCASE_REVIEW_EVENTS = Object.freeze([
  Object.freeze({
    id: 'blog',
    anchorId: 'review-blog',
    channelBadge: '네이버 블로그',
    title: '블로그 후기 작성',
    shortLabel: '블로그',
    shortReward: '최대 7만원',
    maxReward: '최대 70,000원',
    payoutTiming: '구글폼 제출 후 매주 금요일 입금',
    posterImage: '/sms-templates/review_blog.jpg',
    posterWidth: 800,
    posterHeight: 600,
    posterLayout: 'side-landscape',
    posterAlt: '블로그 리뷰 남기고 현금 7만원 받기 공식 이벤트 안내 이미지',
    showPhotoTip: true,
    rewards: Object.freeze([
      { label: '글 1,000~1,500자 + 사진 4장+', amount: '55,000원' },
      { label: '1분 이상 동영상 1개 추가', amount: '+5,000원' },
      { label: '1분 이상 동영상 2개 추가', amount: '+15,000원 (총 7만원)' },
    ]),
    titleTemplate: '한성 [지역명] [설치제품명] [가격] 직접 구매한 내돈 내산 후기',
    titleExample: '예: 한성 인천 미추홀구 냉장쇼케이스 115만원에 직접 구매한 내돈 내산 후기',
    requirements: Object.freeze([
      '제목 양식 필수 준수: 한성 + 지역 + 설치제품 + 가격 + 직접 구매한 내돈 내산 후기',
      '본문 4줄 이상 · 설치한 제품 키워드 최소 3회 반복 · 색상/조명/사이즈 사양 기입',
      '사진 4장 이상 첨부 · <네이버 검색 허용 / 전체공개> 설정 필수',
    ]),
    primaryCtaLabel: '블로그 후기 입금 신청하기',
    primaryCtaUrl: SHOWCASE_GUIDE_BRAND.blogReviewFormUrl,
    guideCtaLabel: '상세 작성 가이드 보기',
    guideCtaUrl: SHOWCASE_GUIDE_BRAND.blogReviewUrl,
  }),
  Object.freeze({
    id: 'sns',
    anchorId: 'review-sns',
    channelBadge: '인스타그램 · 쓰레드',
    title: '인스타 · 쓰레드',
    shortLabel: '인스타·쓰레드',
    shortReward: '최대 4만원',
    maxReward: '최대 40,000원',
    payoutTiming: '문자 접수 확인 후 당일 현금 입금',
    posterImage: '/sms-templates/review_sns.jpg',
    posterWidth: 526,
    posterHeight: 943,
    posterLayout: 'side-portrait',
    posterAlt: '매장 냉장쇼케이스 사진 찍고 현금 4만원 받기 인스타그램·쓰레드 공식 이벤트 이미지',
    showPhotoTip: true,
    rewards: Object.freeze([
      { label: '글(300자+) + 사진 2장 이상', amount: '15,000원' },
      { label: '글(300자+) + 10초 이상 영상', amount: '20,000원' },
      { label: '인스타 + 쓰레드 모두 올릴 시', amount: '최대 40,000원' },
    ]),
    tagHandle: SHOWCASE_GUIDE_BRAND.reviewInstagramHandle,
    requirements: Object.freeze([
      '매장에 설치된 한성쇼케이스 전체 + HANSUNG 로고가 보이게 사진 2장+(또는 10초+ 영상) 촬영',
      '본문 300자 이상(공백 제외) + @hansungtech 태그 + 제품 키워드(한성쇼케이스 등) 1개 이상 포함',
      '게시물 3개월 이상 유지 필수 (3개월 내 삭제 시 지급금 환수) · 동일 플랫폼 중복 불가',
    ]),
    primaryCtaLabel: `입금 신청 문자 보내기 (${SHOWCASE_GUIDE_BRAND.reviewSubmitPhone})`,
    primaryCtaUrl: `${SHOWCASE_GUIDE_BRAND.reviewSubmitSmsHref}?body=${encodeURIComponent('[한성쇼케이스 인스타·쓰레드 리뷰 신청]\n업체명(대표자명): \n계좌번호(은행·예금주): \n(게시물 링크 또는 캡처 첨부)')}`,
    guideCtaLabel: '인스타·쓰레드 상세 안내 보기',
    guideCtaUrl: SHOWCASE_GUIDE_BRAND.snsReviewUrl,
  }),
  Object.freeze({
    id: 'google',
    anchorId: 'review-google',
    channelBadge: '구글 지도 · 업체',
    title: '구글 리뷰',
    shortLabel: '구글 리뷰',
    shortReward: '최대 3만원',
    maxReward: '최대 30,000원',
    payoutTiming: '문자 접수 확인 후 당일 현금 입금',
    posterImage: '/sms-templates/review_google.jpg',
    posterWidth: 1500,
    posterHeight: 750,
    posterLayout: 'wide-banner',
    posterAlt: '구글 리뷰 남기고 사례금 3만원(사진)·2만원(글) 받아 가세요 공식 이벤트 안내 이미지',
    showPhotoTip: false,
    rewards: Object.freeze([
      { label: '사진 + 300자 내외 리뷰 작성', amount: '30,000원' },
      { label: '글(300자 내외)만 리뷰 작성', amount: '20,000원' },
    ]),
    requirements: Object.freeze([
      '아래 [구글 리뷰 바로 쓰기] 버튼을 눌러 별점 선택 및 300자 내외 이용 후기 작성',
      '제품 실물 사진을 함께 첨부하면 30,000원 대상이 됩니다',
      `작성 후 리뷰 링크(또는 캡처)와 계좌번호(은행·예금주)를 ${SHOWCASE_GUIDE_BRAND.reviewSubmitPhone}로 문자 전송`,
    ]),
    primaryCtaLabel: '구글 리뷰 바로 쓰기',
    primaryCtaUrl: SHOWCASE_GUIDE_BRAND.googleReviewUrl,
    secondaryCtaLabel: `리뷰 링크·계좌 문자 보내기 (${SHOWCASE_GUIDE_BRAND.reviewSubmitPhone})`,
    secondaryCtaUrl: `${SHOWCASE_GUIDE_BRAND.reviewSubmitSmsHref}?body=${encodeURIComponent('[한성쇼케이스 구글 리뷰 신청]\n업체명(대표자명): \n계좌번호(은행·예금주): \n(구글 리뷰 링크 또는 캡처 첨부)')}`,
  }),
  Object.freeze({
    id: 'smartstore',
    anchorId: 'review-store',
    channelBadge: '네이버 스마트스토어',
    title: '스토어 구매 고객 리뷰',
    shortLabel: '스마트스토어',
    shortReward: '3만원 별도',
    maxReward: '30,000원',
    payoutTiming: '제품 수령 30일 이내 참여 · 확인 후 입금',
    posterImage: null,
    posterWidth: null,
    posterHeight: null,
    posterLayout: 'text-only',
    posterAlt: '',
    showPhotoTip: false,
    rewards: Object.freeze([
      { label: '스마트스토어 구매 후기 작성', amount: '30,000원' },
    ]),
    requirements: Object.freeze([
      '네이버 스마트스토어 결제 고객 대상 (제품 수령일로부터 30일 이내 참여 시 적용)',
      `리뷰 작성 화면 캡처와 계좌번호를 ${SHOWCASE_GUIDE_BRAND.reviewSubmitPhone}로 문자 전송`,
    ]),
    primaryCtaLabel: '모바일 스토어 리뷰 쓰기',
    primaryCtaUrl: SHOWCASE_GUIDE_BRAND.smartstoreReviewMobileUrl,
    secondaryCtaLabel: 'PC 스토어 리뷰 쓰기',
    secondaryCtaUrl: SHOWCASE_GUIDE_BRAND.smartstoreReviewPcUrl,
  }),
]);

