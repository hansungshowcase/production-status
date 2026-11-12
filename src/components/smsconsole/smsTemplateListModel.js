// 문자 템플릿 목록 계산(순수 함수). /api/notification-overview 카탈로그를 카드 목록으로 바꾼다.
// 카탈로그 칸: groups[].id(customer|internal) / items[].{id,name,trigger,target,policy{status,label},
// configuration{status,label},example_message{subject,text},recent{state,counts{total}}}

export function audienceOf(group, item) {
  if (/admin/.test(String(item?.id || ''))) return { id: 'admin', label: '관리자' };
  return group?.id === 'customer' ? { id: 'customer', label: '고객' } : { id: 'staff', label: '직원' };
}

// 최근 7일 건수. 조회 못 했으면 null
export function recentCount(item) {
  const recent = item?.recent;
  if (!recent || recent.state === 'unavailable') return null;
  return Number(recent.counts?.total) || 0;
}

// 카탈로그 → [{id,name,audience,trigger,count,policy,config,example,order}] (정렬 전, 카탈로그 순서가 order)
export function buildSmsItems(overview) {
  const out = [];
  for (const group of Array.isArray(overview?.groups) ? overview.groups : []) {
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      out.push({
        id: item.id,
        name: item.name || item.id,
        audience: audienceOf(group, item),
        trigger: item.trigger || '',
        count: recentCount(item),
        policy: item.policy || null,
        config: item.configuration || null,
        example: typeof item.example_message?.text === 'string' ? item.example_message : null,
        order: out.length,
      });
    }
  }
  return out;
}

export const isInUse = (item) => (item?.count ?? 0) > 0;

// 최근 7일 건수 많은 순, 같으면 카탈로그 순서
export function sortSmsItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => ((b.count ?? 0) - (a.count ?? 0)) || (a.order - b.order));
}

export function smsPills(items) {
  const list = Array.isArray(items) ? items : [];
  return [
    { id: 'in_use', label: '발송 중', count: list.filter(isInUse).length },
    { id: 'all', label: '전체', count: list.length },
  ];
}

export function filterSmsItems(items, status) {
  const list = Array.isArray(items) ? items : [];
  return status === 'in_use' ? list.filter(isInUse) : list;
}

export function defaultSmsFilter(items) {
  return (Array.isArray(items) ? items : []).some(isInUse) ? 'in_use' : 'all';
}

// 카드 배지 [{tone,text}]: 최근 7일 건수 + 정책 중단 + 설정 미완료
export function smsBadges(item) {
  const badges = [];
  if (item.count === null) badges.push({ tone: 'muted', text: '사용 여부 확인 못 함' });
  else if (item.count > 0) badges.push({ tone: 'warn', text: `최근 7일 ${item.count}건` });
  else badges.push({ tone: 'muted', text: '최근 7일 0건' });
  if (item.policy?.status === 'paused') badges.push({ tone: 'muted', text: item.policy.label || '정책 중단' });
  if (item.config?.status === 'incomplete') badges.push({ tone: 'danger', text: item.config.label || '설정 미완료' });
  return badges;
}
