import {
  EXTERNAL_TEMPLATES, KINDS, SENDERS, SMS_CHANNELS, UNCLASSIFIED, groupByAudience, kindOfCatalogId, unclassifiedName,
} from '../../../shared/smsTemplateKinds.js';
import { autoConditionParts } from './smsTextTemplateFormModel.js';
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

// 목록을 size 행씩 쪽으로 나눈다. page 는 1~pages 로 고정(행이 없으면 1쪽). 머리글은 세지 않는다.
export function paginateRows(rows, page, size = 10) {
  const list = Array.isArray(rows) ? rows : [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const at = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { page: at, pages, rows: list.slice((at - 1) * size, at * size) };
}

// 내 문구 이름을 숫자 인식 순서로(0일, 2일, 3일 … 20일, 40일)
export function sortByNameNumeric(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'ko', { numeric: true }));
}

// 조건 거르기: 행(내 문구 또는 카탈로그·외부 항목) → 묶음 이름
export const CONDITION_GROUPS = ['가입·문의', '주문 등록', '공정', '납기·출고예정일', '출고 완료', '조건 없음'];
export function conditionGroup(row) {
  const text = row?.autoKind ? autoConditionParts(row).when : `${row?.trigger || ''} ${row?.name || ''}`;
  if (!row?.autoKind && row?.preview !== undefined) return '조건 없음';
  // 순서가 뜻이다: '주문의'(문의 아님)·'작업지시서'(공정 아님)·날짜 기준 직원 알림(공정 미완료 조건이 붙어도 날짜 묶음)
  if (/회원 ?가입|견적문의|가입·문의/.test(text)) return '가입·문의';
  if (/주문 (생성|등록|접수|결제)/.test(text)) return '주문 등록';
  if (/납기|출고 ?예정|출고 \d|미출고/.test(text)) return '납기·출고예정일';
  if (/출고 ?완료/.test(text)) return '출고 완료';
  if (/공정|작업|착수|커팅|포장/.test(text)) return '공정';
  if (/주문|구매/.test(text)) return '주문 등록';
  return '조건 없음';
}

// ---------- 흐름(기준 시점) 묶기: 같은 종류·받는 사람(·공정)의 자동 문구를 한 행으로 ----------
const FLOW_LABELS = {
  lead_plus_days: '가입·문의 후', ship_plus_days: '출고 완료 후', order_plus_days: '주문 등록 후',
  due_date: '납기일', ship_scheduled: '출고예정일', ship_or_due: '출고·납기일',
  order_created: '주문 등록 시', process_started: '공정 시작 시', process_completed: '공정 완료 시', member_joined: '자사몰 회원가입 시',
};
const OFFSET_KINDS = ['due_date', 'ship_scheduled', 'ship_or_due'];
const IMMEDIATE_FLOW_KINDS = ['order_created', 'process_started', 'process_completed', 'member_joined'];
const stepDays = (entry) => (OFFSET_KINDS.includes(entry.autoKind) ? (Number(entry.autoOffset) || 0) : (Number(entry.autoDays) || 0));

// 단계 칩 글자: 0 → 당일, N → N일(날짜 기준은 N일 전·N일 지남), 즉시형은 공정 이름 또는 즉시
export function flowStepText(entry) {
  if (IMMEDIATE_FLOW_KINDS.includes(entry?.autoKind)) return entry.autoStep || '즉시';
  const n = stepDays(entry);
  if (OFFSET_KINDS.includes(entry?.autoKind)) return n === 0 ? '당일' : (n < 0 ? `${-n}일 전` : `${n}일 지남`);
  return n === 0 ? '당일' : `${n}일`;
}

// entries(내 문구) → 앞에서 나온 순서대로 [{ key, label, who, via, time, on, total, steps[], single }]
// 조건 없는 문구는 { single: true, entry } 한 줄. enabledOf(entry) 로 켜짐을 센다(없으면 autoEnabled).
export function groupFlows(entries, enabledOf = (entry) => Boolean(entry.autoEnabled)) {
  const out = [];
  const byKey = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry?.autoKind) { out.push({ key: `m-${entry?.id}`, single: true, entry, steps: [] }); return; }
    const key = `${entry.autoKind}|${entry.autoAudience || 'customer'}|${entry.autoStep || ''}`;
    let flow = byKey.get(key);
    if (!flow) {
      flow = { key, single: false, steps: [] };
      byKey.set(key, flow);
      out.push(flow);
    }
    flow.steps.push(entry);
  });
  out.forEach((flow) => {
    if (flow.single) return;
    flow.steps.sort((a, b) => (stepDays(a) - stepDays(b)) || String(a.name || '').localeCompare(String(b.name || ''), 'ko', { numeric: true }));
    const first = flow.steps[0];
    const parts = autoConditionParts(first);
    flow.label = `${FLOW_LABELS[first.autoKind] || ''}${first.autoStep ? `(${first.autoStep})` : ''}`;
    flow.who = parts.who;
    flow.via = flow.steps.some((step) => step.autoAtaTemplate) ? '알림톡' : '';
    const times = [...new Set(flow.steps.map((step) => String(step.autoSendTime || '')).filter(Boolean))];
    flow.time = times.length > 1 ? '시각 여러 개' : (times[0] || '');
    flow.total = flow.steps.length;
    flow.on = flow.steps.filter((step) => enabledOf(step)).length;
  });
  return out;
}
