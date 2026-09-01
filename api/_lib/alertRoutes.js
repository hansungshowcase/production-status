// 납기 지연('분체 미착수') 경보 — 영업담당자(orders.sales_person)별 수신번호 라우팅.
// 이름은 orders.sales_person 값과 정확히 일치해야 함(공백/철자 주의).
export const ALERT_ROUTES = {
  '신은철': '010-7346-7407',
  '신은절': '010-7346-7407', // 데이터 오타(철→절) 대응 — 같은 담당자
  '이준형': '010-7731-4237',
};

export function canonicalAlertRecipientName(value) {
  const name = String(value || '').trim();
  if (name === '신은철' || name === '신은절') return '신은철';
  if (name === '이준형') return '이준형';
  return '';
}

// 매핑 없는 담당자(미지정/김보수 등) 경보의 수신번호. env ALERT_FALLBACK 로 설정.
// 비어 있으면 발송하지 않고 응답/로그에 '미라우팅'으로만 남김(잘못된 사람에게 안 감).
export function alertFallbackPhone() {
  return String(process.env.ALERT_FALLBACK || '').trim();
}

// routeAlerts(alerts, routes?, fallback?)
//   alerts: [{ sales_person, client_name, days_left, current_step }]
//   → { byPhone: Map<digits, {persons:Set, items:[]}>, unrouted: [{...alert, person}] }
export function routeAlerts(alerts, routes = ALERT_ROUTES, fallback = alertFallbackPhone()) {
  const byPhone = new Map();
  const unrouted = [];
  for (const a of (alerts || [])) {
    const person = a.sales_person == null ? '' : String(a.sales_person).trim();
    const phone = routes[person] || fallback || '';
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) { unrouted.push({ ...a, person: person || '(미지정)' }); continue; }
    if (!byPhone.has(digits)) byPhone.set(digits, { persons: new Set(), items: [] });
    const g = byPhone.get(digits);
    g.persons.add(person || '(미지정)');
    g.items.push(a);
  }
  return { byPhone, unrouted };
}
