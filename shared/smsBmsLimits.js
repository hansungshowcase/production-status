// 브랜드메시지(자유형, BMS_FREE) 화면·서버 공용 규칙 (2026-11-17). 출처: solapi.com/guides/kakao-bms-guide 메시지 규격표.
// - 자유형 텍스트 1,300자(줄바꿈 99) · 이미지형 400자(줄바꿈 29) · 버튼 이름 14자 · 버튼 최대 5개 · 이미지 jpg/png 5MB, 가로:세로 2:1~3:4
export const BMS_TEMPLATE_ID = 'BMS_FREE'; // 문구의 수단 칸(auto_ata_template)에 이 값이 있으면 브랜드메시지(자유형)
export const BMS_LIMITS = Object.freeze({ textChars: 1300, textLines: 99, imageChars: 400, imageLines: 29, buttons: 5, buttonName: 14, link: 1000, nameChars: 20, ratioMin: 0.75, ratioMax: 2 });

const countChars = text => [...String(text ?? '')].length;
const countLines = text => (String(text ?? '').match(/\n/g) || []).length;
export const BMS_LINK_RE = /^https:\/\/[^\s]+$/i;

// 본문 길이 검사: #{고객명} 은 최대 20자로 보고 센다. 이미지와 함께면 400자·줄바꿈 29, 글만이면 1300자·줄바꿈 99. 문제가 없으면 ''.
export function bmsTextError(body, hasImage) {
  const text = String(body ?? '').trim().replace(/#\{고객명\}/g, '가'.repeat(BMS_LIMITS.nameChars));
  const maxChars = hasImage ? BMS_LIMITS.imageChars : BMS_LIMITS.textChars;
  const maxLines = hasImage ? BMS_LIMITS.imageLines : BMS_LIMITS.textLines;
  if (countChars(text) > maxChars) return `${hasImage ? '이미지와 함께면' : '글만 보내면'} ${maxChars}자까지 넣을 수 있습니다(고객명은 20자로 계산).`;
  if (countLines(text) > maxLines) return `${hasImage ? '이미지와 함께면' : '글만 보내면'} 줄바꿈은 ${maxLines}번까지 넣을 수 있습니다.`;
  return '';
}

// 버튼 입력 검사 → { buttons:[{name,link}] } | { error, reason:'bms_button' }. 이름·링크가 둘 다 빈 줄은 건너뛴다.
export function bmsButtonsCheck(list) {
  const buttons = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name ?? '').trim();
    const link = String(item?.link ?? '').trim();
    if (!name && !link) continue;
    if (!name || !link) return { error: '버튼은 이름과 링크를 둘 다 넣어 주세요.', reason: 'bms_button' };
    if (countChars(name) > BMS_LIMITS.buttonName) return { error: `버튼 이름은 ${BMS_LIMITS.buttonName}자까지 넣을 수 있습니다.`, reason: 'bms_button' };
    if (link.length > BMS_LIMITS.link || !BMS_LINK_RE.test(link)) return { error: '버튼 링크는 https:// 로 시작하는 주소로 넣어 주세요.', reason: 'bms_button' };
    buttons.push({ name, link });
  }
  if (buttons.length > BMS_LIMITS.buttons) return { error: `버튼은 최대 ${BMS_LIMITS.buttons}개까지 넣을 수 있습니다.`, reason: 'bms_button' };
  return { buttons };
}
