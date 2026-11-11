// 직원 문자 관리 표시용 번호 줄임(2026-11-11 사장님 "받는사람은 성함 (4237) 이렇게 뒷번호만 보이게해").
// 서버가 주는 가린 번호(010****4237)나 전체 번호에서 끝 4자리만 남긴다. 서버 응답 형식은 바꾸지 않는다.

export function phoneTail(phone) {
  const match = String(phone ?? '').trim().match(/(\d{4})$/);
  return match ? match[1] : '';
}

export function recipientWithPhoneTail(name, phone) {
  const cleanName = String(name ?? '').trim();
  const tail = phoneTail(phone);
  if (cleanName && tail) return `${cleanName} (${tail})`;
  if (cleanName) return cleanName;
  return tail ? `이름 미확인 (${tail})` : '이름 미확인';
}

// 글 속 "(010****4237)"·"(010-1234-4237)" 를 "(4237)" 로 줄인다.
export function shortenPhonesInText(text) {
  return String(text ?? '').replace(/\(\s*0\d{1,2}[-*\d\s]*?(\d{4})\s*\)/g, '($1)');
}
