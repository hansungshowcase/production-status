const CHANNEL = 'KA01PF241111145751437aCGtcFdsD2M';
const BLOG_LINK = 'https://m.cafe.naver.com/01027857623/1657';
const SNS_LINK = 'https://cafe.naver.com/01027857623/1757';

export const REVIEW_CAMPAIGNS = Object.freeze([
  Object.freeze({
    id: 'blog', name: '블로그 리뷰 7만원 이벤트', source: 'Make · SOLAPI',
    status: '기존 발송 확인 · 신규 발송 연결 필요',
    subject: '블로그 리뷰 이벤트',
    preview: '안녕하세요 [고객명] 대표님 한성쇼케이스입니다\n\n한 달 동안만 진행되는 블로그 리뷰 이벤트입니다.\n리뷰를 남겨주실 경우 현금 7만원이 지급됩니다.\n\n[리뷰 남기고 7만원 받기]',
    channel: '카카오 브랜드 메시지 (BMS_FREE)', replacement: '실패 시 기존 장문문자(LMS) 대체 발송',
    cost_note: '기존 Make·SOLAPI 요금 적용. 실패 후 LMS 수신 건은 49.5원(VAT 포함)이 확인됐습니다.',
    sourceAppId: 'JfpLPhLYJqGV', sourceVersion: '1.3.0',
    sourceGroupId: 'G4V20261023115915DTEKT5UBCG6X959',
    sourceMessageId: 'M4V20261023115915ZSHZKXBNEEQG1PG',
  }),
  Object.freeze({
    id: 'sns', name: 'SNS 리뷰 4만원 이벤트', source: 'Make · SOLAPI',
    status: '기존 발송 확인 · 신규 발송 연결 필요',
    subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트',
    preview: `기존 리뷰 안내 이미지와 참여 안내 링크를 보내는 이미지문자입니다.\n${SNS_LINK}`,
    channel: '이미지문자 (MMS)', replacement: '별도 대체 발송 없음',
    cost_note: '기존 Make·SOLAPI MMS 단가 110원(VAT 별도)을 확인했습니다.',
    sourceAppId: 'JfpLPhLYJqGV', sourceVersion: '1.3.0',
    sourceGroupId: 'G4V202610231202404Z7OSPO19Y745DY',
    sourceMessageId: 'M4V20261023120240BS2HYWC29SVHYEL',
  }),
]);

export function publicReviewCampaigns() {
  return REVIEW_CAMPAIGNS.map(({ sourceAppId, sourceVersion, sourceGroupId, sourceMessageId, ...campaign }) => campaign);
}

export function matchReviewCampaign(message = {}) {
  const fields = message.customFields || {};
  if (['hookId', 'hook_id', 'storeId', 'store_id', 'productOrderId'].some(key => fields[key] != null)) return null;
  const from = String(message.from || '').replace(/\D/g, '');
  const text = String(message.text || '');
  const options = message.kakaoOptions || {};
  const blogBody = /블로그\s*리뷰/.test(text) && /7만원/.test(text);
  const blogButton = [...(options.buttons || []), ...(options.bms?.buttons || [])]
    .some(button => [button.linkMo, button.linkPc, button.linkMobile].includes(BLOG_LINK));
  if (from === '0319862458' && blogBody && (
    (message.type === 'BMS_FREE' && options.pfId === CHANNEL
      && (options.imageId || options.bms?.imageId) === 'ST01FZ2505130310261327Bv7ZA8LMi2' && blogButton)
    || (message.type === 'LMS' && message.replacement === true && text.includes(BLOG_LINK))
  )) return REVIEW_CAMPAIGNS[0];
  if (from === '01077314237' && message.type === 'MMS'
    && message.imageId === 'ST01FZ260403024713590g9o1ZF4G1JG'
    && message.subject === '한성쇼케이스 SNS 리뷰 4만원 지급이벤트'
    && text.trim() === SNS_LINK) return REVIEW_CAMPAIGNS[1];
  return null;
}
