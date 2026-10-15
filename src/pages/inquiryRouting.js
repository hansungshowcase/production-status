const KAKAO_HREF = 'http://pf.kakao.com/_vxmpfn/chat';
const SMS_HREF = 'sms:01058792438';
const SMS_PHONE = '010-5879-2438';

export function resolveInquiryRoute(managerName) {
  const manager = typeof managerName === 'string' ? managerName.trim() : '';

  if (manager === '이준형') {
    return { kind: 'kakao', manager, href: KAKAO_HREF, phone: null };
  }

  if (manager === '신은철') {
    return { kind: 'sms', manager, href: SMS_HREF, phone: SMS_PHONE };
  }

  return { kind: 'manager', manager: manager || null, href: null, phone: null };
}
