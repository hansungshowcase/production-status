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

  if (manager === '황보민수') {
    return { kind: 'sms', manager, href: 'sms:01029150220', phone: '010-2915-0220' };
  }

  return { kind: 'manager', manager: manager || null, href: null, phone: null };
}
