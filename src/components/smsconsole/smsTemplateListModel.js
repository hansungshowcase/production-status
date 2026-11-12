import {
  EXTERNAL_TEMPLATES, KINDS, SENDERS, SMS_CHANNELS, UNCLASSIFIED, groupByAudience, kindOfCatalogId, unclassifiedName,
} from '../../../shared/smsTemplateKinds.js';
import { recipientWithPhoneTail, shortenPhonesInText } from '../../utils/phoneTail.js';

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
        target: typeof item.target === 'string' ? item.target : '',
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

// ---------- 종류별 보기(제작현황 밖에서 나가는 문구 포함) ----------
// sent = GET /api/sms-console?resource=sent 의 groups[] (없으면 null — 건수는 모르는 것으로 둔다)

const sentMapOf = (sent) => new Map((Array.isArray(sent) ? sent : []).map((group) => [group.key, group]));
const orNull = (group, sentKnown) => (group ? group.count7 : (sentKnown ? 0 : null));

// 카탈로그 카드에 종류·보내는 곳을 더하고, 보낸 묶음·외부 문구 표의 문자 항목을 같은 모양의 카드로 합친다. 같은 key 는 한 카드.
export function buildKindedItems(overview, sent = null, externals = EXTERNAL_TEMPLATES) {
  const sentKnown = Array.isArray(sent);
  const sentMap = sentMapOf(sent);
  const seen = new Set();
  const out = [];
  for (const item of buildSmsItems(overview)) {
    seen.add(item.id);
    out.push({
      ...item, key: item.id, kind: kindOfCatalogId(item.id), sender: SENDERS.program, ad: false, active: true, channel: '',
      body: item.example?.text || '', scenario: '', external: false, who: '', image: '',
    });
  }
  externals.forEach((entry, index) => {
    if (!SMS_CHANNELS.includes(entry.channel) || seen.has(entry.key)) return;
    seen.add(entry.key);
    out.push({
      id: entry.key, key: entry.key, name: entry.name, audience: { id: entry.audience === '직원' ? 'staff' : 'customer', label: entry.audience || '고객' },
      trigger: entry.trigger || '', count: orNull(sentMap.get(entry.key), sentKnown), policy: null, config: null, example: null,
      order: 1000 + index, kind: entry.kind, sender: entry.sender, ad: Boolean(entry.ad || sentMap.get(entry.key)?.ad), active: entry.active !== false,
      channel: entry.channel, body: entry.body || '', scenario: entry.scenario || '', external: true, who: entry.who || '', image: entry.image || '',
    });
  });
  let extra = 0;
  for (const group of sentMap.values()) {
    if (seen.has(group.key) || !SMS_CHANNELS.includes(group.channel)) continue;
    seen.add(group.key);
    out.push({
      id: group.key, key: group.key, name: group.kind === UNCLASSIFIED ? unclassifiedName(group.key) : group.key,
      audience: { id: 'customer', label: group.audience || '고객' }, trigger: '', count: group.count7, policy: null, config: null, example: null,
      order: 2000 + (extra += 1), kind: group.kind, sender: group.sender, ad: Boolean(group.ad), active: true, channel: group.channel,
      body: '', scenario: '', external: true, who: '', image: '',
    });
  }
  return out;
}

// 종류 순서대로 [{kind, items}] — 빈 종류는 뺀다. 종류 안은 7일 건수 많은 순(같으면 처음 순서).
export function kindSections(items, status = 'all') {
  const visible = filterSmsItems(items, status);
  return KINDS.map((kind) => ({ kind, items: sortSmsItems(visible.filter((item) => (KINDS.includes(item.kind) ? item.kind : UNCLASSIFIED) === kind)) }))
    .filter((section) => section.items.length > 0);
}

// 대상 → 종류 두 단계 [{group, count, kinds:[{kind, items}]}] — 빈 묶음은 뺀다. 카드의 대상은 카드에 보이는 대상 칩 값 그대로.
export function audienceSections(items, status = 'all') {
  return groupByAudience(sortSmsItems(filterSmsItems(items, status)), (item) => item.audience?.label, (item) => item.kind);
}

// ---------- 받는 사람·조건 한 줄(2026-11-12 사장님 "고객이면 누구누구 구매 후 며칠, 직원이면 누구누구 발송 중") ----------
// recipients = GET /api/internal-notifications?view=day 의 recipients[]({name, phone_tail}) — 직원 문자 관리 화면이 쓰는 등록 현황. 못 받았으면 null.
const joinDot = (...parts) => parts.filter(Boolean).join(' · ');

// 카탈로그 카드의 받는 사람 글(target)에 나오는 등록 직원을 나온 순서대로 [{name, tail}]
export function staffRecipientsOf(target, recipients) {
  const text = String(target || '');
  return (Array.isArray(recipients) ? recipients : [])
    .map((person) => ({ name: String(person?.name || ''), tail: String(person?.phone_tail || ''), at: text.indexOf(String(person?.name || '')) }))
    .filter((person) => person.name && person.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ name, tail }) => ({ name, tail }));
}

// 직원 3명까지 이름(끝 4자리), 넘으면 '외 n명', 0명이면 '받는 직원 없음'
export function staffRecipientsPhrase(people) {
  const list = Array.isArray(people) ? people : [];
  if (list.length === 0) return '받는 직원 없음';
  const shown = list.slice(0, 3).map((person) => recipientWithPhoneTail(person.name, person.tail)).join(', ');
  return list.length > 3 ? `${shown} 외 ${list.length - 3}명` : shown;
}

export function conditionLine(item, recipients = null) {
  const trigger = item?.trigger || '';
  if (item?.audience?.id === 'customer') return joinDot(item.external ? item.who : '제작 주문 고객', trigger);
  if (item?.external) return joinDot(item.who ? `${item.who}에게 발송` : '', trigger);
  if (!Array.isArray(recipients)) return trigger;
  const people = staffRecipientsOf(item?.target, recipients);
  if (people.length > 0) return joinDot(`${staffRecipientsPhrase(people)}에게 발송 중`, trigger);
  if (/\d{4}/.test(String(item?.target || ''))) return joinDot(`${shortenPhonesInText(item.target)}로 발송 중`, trigger);
  return joinDot(staffRecipientsPhrase([]), trigger);
}

// 카드 배지에 더하는 것: 광고·꺼짐(메이크에서 꺼진 시나리오). 건수 배지는 smsBadges 가 만든다.
export function kindBadges(item) {
  const badges = [];
  if (item?.ad) badges.push({ tone: 'info', text: '광고' });
  if (item?.active === false) badges.push({ tone: 'muted', text: '꺼짐' });
  return badges;
}
