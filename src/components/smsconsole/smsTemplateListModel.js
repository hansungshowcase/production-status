import {
  EXTERNAL_TEMPLATES, KINDS, SENDERS, SMS_CHANNELS, UNCLASSIFIED, groupByAudience, kindOfCatalogId, unclassifiedName,
} from '../../../shared/smsTemplateKinds.js';
import { autoConditionLine, autoConditionParts, autoTargetText, LEAD_SOURCE_FLOW_LABEL, photoBadgeText, sendCostText, sendKindLabel, sendTimeLabel, viaLabel } from './smsTextTemplateFormModel.js';
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
  const counts = recent.counts || {};
  // 성공(수신·접수)만 센다. 실패·테스트 기록(dry_run)은 뺀다. 옛 응답(성공 칸 없음)은 total 로 읽는다.
  if (counts.received === undefined && counts.accepted === undefined) return Number(counts.total) || 0;
  return (Number(counts.received) || 0) + (Number(counts.accepted) || 0);
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
        lastSentAt: item.recent?.latest?.occurred_at || '',
        failedCount: Number(item.recent?.counts?.failed) || 0,
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
    { id: 'all', label: '전체', count: list.length }, // 2026-11-16 사장님: 전체 탭이 가장 왼쪽
    { id: 'in_use', label: '발송 중', count: list.filter(isInUse).length },
  ];
}

// 신호등(2026-11-16 사장님 "오프면 빨간색 온이면 초록색 한눈에"): 켜짐 초록 · 꺼짐 빨강 · 일부만 켜짐 노랑
export function itemLight(item) {
  // 설정 미완료(예: 제작 시작 알림 사용 설정이 꺼짐)도 실제로는 안 나가므로 꺼짐
  if (item?.active === false || item?.policy?.status === 'paused' || item?.config?.status === 'incomplete') return { tone: 'off', text: '꺼짐' };
  // 테스트 기록만 남는 설정: 실제 발송 업체로는 나가지 않으므로 막힘
  if (item?.config?.status === 'test') return { tone: 'part', text: '켜짐(막힘: 제공사 설정 없음 · 테스트 기록만)' };
  // 메이크·쏠라피 커머스·앱·카페24 문구: 손으로 적은 active 만으로는 초록을 쓰지 않는다. 메이크 수집 결과(make_on·make_last_run)가 있어야 판정한다
  if (item?.external && item.sender !== SENDERS.program) {
    if (item.make_on === false) return { tone: 'off', text: '꺼짐' };
    if (item.make_on === true) return makeRunFresh(item.make_last_run) ? { tone: 'on', text: '켜짐' } : { tone: 'part', text: '켜짐(최근 실행 없음)' };
    return (item.count ?? 0) - (item.fail ?? 0) > 0 ? { tone: 'on', text: '켜짐' } : { tone: 'unknown', text: '확인 안 됨' };
  }
  return { tone: 'on', text: '켜짐' };
}
const makeRunFresh = (value) => { const ms = Date.parse(value || ''); return Number.isFinite(ms) && Date.now() - ms <= 7 * 86400000; };
export function flowLightTone(on, total) {
  if (!on) return 'off';
  return on >= total ? 'on' : 'part';
}

export function filterSmsItems(items, status) {
  const list = Array.isArray(items) ? items : [];
  return status === 'in_use' ? list.filter(isInUse) : list;
}

// 이미 이 콘솔(내 문구 DB 자동 발송)으로 옮겨 온 메이크 항목은 중복 목록에서 숨긴다.
export function isMigratedExternal(item, textTemplates = []) {
  if (!item?.external || item.sender !== SENDERS.make) return false;
  const rows = (Array.isArray(textTemplates) ? textTemplates : []).filter((row) => row && (row.auto_kind || row.autoKind));
  if (!rows.length) return false;
  const key = String(item.id || item.key || '');
  const ataOf = (row) => String(row.auto_ata_template ?? row.autoAtaTemplate ?? '');
  const leadOf = (row) => String(row.auto_lead_source ?? row.autoLeadSource ?? '');
  const nameOf = (row) => String(row.name || '');
  const bodyOf = (row) => String(row.body ?? row.preview ?? '');
  if (key === 'review_sns') {
    return rows.some((row) => !ataOf(row) && (/sns\s*리뷰/i.test(nameOf(row)) || /\/1757\b/.test(bodyOf(row))));
  }
  if (key === 'caution_notice') {
    return rows.some((row) => !ataOf(row) && /주의사항\s*안내/.test(nameOf(row)));
  }
  if (key === 'review_blog') {
    return rows.some((row) => ataOf(row) === 'BMS_FREE' && /블로그\s*리뷰/.test(nameOf(row)));
  }
  if (key === 'event_free_support' || key === 'cafe24_welcome') {
    return rows.some((row) => ataOf(row) === 'BMS_FREE' && (leadOf(row) === 'cafe24' || /무료\s*지원\s*이벤트|카페24\s*가입\s*이벤트/.test(nameOf(row))));
  }
  return false;
}

// 처음 열리는 탭은 가장 왼쪽의 전체
export function defaultSmsFilter() {
  return 'all';
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
    const sentGroup = sentMap.get(item.id);
    out.push({
      ...item, key: item.id, kind: kindOfCatalogId(item.id), sender: SENDERS.program, ad: false, active: true, channel: '',
      lastSentAt: item.lastSentAt || sentGroup?.last_sent || '',
      failedCount: item.failedCount || Number(sentGroup?.fail7) || 0,
      body: item.example?.text || '', scenario: '', external: false, who: '', image: '',
    });
  }
  externals.forEach((entry, index) => {
    if (!SMS_CHANNELS.includes(entry.channel) || seen.has(entry.key)) return;
    seen.add(entry.key);
    const sentGroup = sentMap.get(entry.key);
    out.push({
      id: entry.key, key: entry.key, name: entry.name, audience: { id: entry.audience === '직원' ? 'staff' : 'customer', label: entry.audience || '고객' },
      trigger: entry.trigger || '', count: orNull(sentGroup, sentKnown),
      lastSentAt: sentGroup?.last_sent || '', failedCount: Number(sentGroup?.fail7) || 0,
      policy: null, config: null, example: null,
      order: 1000 + index, make_on: entry.make_on, make_last_run: entry.make_last_run, kind: entry.kind, sender: entry.sender, ad: Boolean(entry.ad || sentGroup?.ad), active: entry.active !== false,
      channel: entry.channel, body: entry.body || '', scenario: entry.scenario || '', external: true, who: entry.who || '', image: entry.image || '',
    });
  });
  let extra = 0;
  for (const group of sentMap.values()) {
    if (seen.has(group.key) || !SMS_CHANNELS.includes(group.channel)) continue;
    seen.add(group.key);
    out.push({
      id: group.key, key: group.key, name: group.kind === UNCLASSIFIED ? unclassifiedName(group.key) : group.key,
      audience: { id: 'customer', label: group.audience || '고객' }, trigger: '', count: group.count7,
      lastSentAt: group.last_sent || '', failedCount: Number(group.fail7) || 0,
      policy: null, config: null, example: null,
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
  if (people.length > 0) return joinDot(`${staffRecipientsPhrase(people)}에게`, trigger);
  if (/\d{4}/.test(String(item?.target || ''))) return joinDot(`${shortenPhonesInText(item.target)}로`, trigger);
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
  if (/회원 ?가입|견적 ?문의|가입·문의/.test(text)) return '가입·문의';
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
  process_started_plus_days: '공정 시작 후', process_completed_plus_days: '공정 완료 후',
  due_date: '납기일', ship_scheduled: '출고예정일', ship_or_due: '출고·납기일',
  order_created: '주문 등록 시', process_started: '공정 시작 시', process_completed: '공정 완료 시', member_joined: '자사몰 회원가입 시',
};
const OFFSET_KINDS = ['due_date', 'ship_scheduled', 'ship_or_due'];
const IMMEDIATE_FLOW_KINDS = ['order_created', 'process_started', 'process_completed', 'member_joined'];
const stepDays = (entry) => (OFFSET_KINDS.includes(entry.autoKind) ? (Number(entry.autoOffset) || 0) : (Number(entry.autoDays) || 0));

// 알림톡 템플릿이 붙은 자동 문구(알림톡 템플릿 화면에서 보인다)
export const isAtaEntry = (entry) => Boolean(entry?.autoKind && entry?.autoAtaTemplate && entry.autoAtaTemplate !== 'BMS_FREE'); // 브랜드메시지(자유형)는 알림톡이 아니라 문자 목록에 보인다
export const isKakaoEntry = (e) => Boolean(e?.autoKind && e?.autoAtaTemplate); // 카톡으로 나가는 자동 문구(알림톡·브랜드메시지) — 알림톡 화면에 보인다

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
    const key = `${entry.autoKind}|${entry.autoAudience || 'customer'}|${entry.autoStep || ''}${entry.autoKind === 'lead_plus_days' && entry.autoLeadSource ? `|${entry.autoLeadSource}` : ''}`;
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
    flow.label = `${first.autoKind === 'lead_plus_days' && first.autoLeadSource ? `${LEAD_SOURCE_FLOW_LABEL[first.autoLeadSource]} 후` : (FLOW_LABELS[first.autoKind] || '')}${first.autoStep ? `(${first.autoStep})` : ''}`;
    flow.who = parts.who;
    flow.via = [...new Set(flow.steps.map((step) => viaLabel(step)).filter(Boolean))].join('·');
    const times = [...new Set(flow.steps.map((step) => String(step.autoSendTime || '')).filter(Boolean))];
    flow.time = times.length > 1 ? '시각 여러 개' : (times[0] || '');
    flow.total = flow.steps.length;
    flow.on = flow.steps.filter((step) => enabledOf(step)).length;
  });
  return out;
}

// 검색어 포함 여부(이름·본문·조건·보내는 곳·대상, 띄어쓰기 무시 포함). 빈 검색어면 true.
export function matchesSmsQuery(row, query, recipients = null) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if (!row || typeof row !== 'object') return false;
  const qNoSpace = q.replace(/\s+/g, '');
  const parts = [
    row.name,
    row.body,
    row.preview,
    row.trigger,
    row.sender,
    row.who,
    row.scenario,
    row.audience?.label,
    row.autoKind ? autoConditionLine(row) : '',
    row.autoKind ? autoTargetText(row) : conditionLine(row, recipients),
  ];
  return parts.some((value) => {
    const s = String(value || '').toLowerCase();
    return s.includes(q) || (qNoSpace && s.replace(/\s+/g, '').includes(qNoSpace));
  });
}

// 본문을 #{변수} 조각으로 나눈다(미리보기 변수 강조용). 빈 글이면 [].
export function splitMessageVars(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const out = [];
  const re = /#\{[^{}\n]{1,40}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ text: raw.slice(last, m.index), isVar: false });
    out.push({ text: m[0], isVar: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ text: raw.slice(last), isVar: false });
  return out;
}

// 목록 카드 신호등 짧은 라벨(자세한 사유는 상세 화면 배너·title 로 본다)
export function compactLightLabel(effective) {
  if (!effective) return '확인 안 됨';
  if (effective.tone === 'on') return '켜짐';
  if (effective.tone === 'off') return '꺼짐';
  if (effective.tone === 'part') return '켜짐(주의)';
  if (effective.tone === 'blocked') return '발송 막힘';
  return effective.text || '확인 안 됨';
}

// 꺼짐·주의·막힘·확인 안 됨 등 확인이 필요한 신호등인지 판별
export const isAttentionTone = (tone) => tone === 'off' || tone === 'part' || tone === 'blocked' || tone === 'unknown';

const DAY_OFF_LABELS = { sun: '일요일', mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일' };
const DATE_TRIGGER_KINDS = new Set(['due_date', 'ship_scheduled', 'ship_or_due']);
const IMMEDIATE_TRIGGER_KINDS = new Set(['order_created', 'process_started', 'process_completed', 'member_joined']);

const uniqTags = (list) => [...new Set(list.filter(Boolean))];
const phoneTailDigits = (value) => String(value || '').replace(/\D/g, '').slice(-4);
const wonKRW = (value) => `${Number(value).toLocaleString('ko-KR')}원`;

function formatKoreanPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return d.startsWith('02') ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 9 && d.startsWith('02')) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return String(raw || '').trim();
}

// 템플릿 종류(문자·알림톡·브랜드메시지) 및 건당 예상 비용(VAT 미포함 쏠라피 기준 또는 서버 sendCost)
export function channelCostOf(row, { ataUnit = 13 } = {}) {
  const ataPrice = Number.isFinite(Number(ataUnit)) && ataUnit !== null ? Number(ataUnit) : 13;
  const finish = (kindLabel, costShort, costDetail, tone) => ({
    kindLabel,
    costShort,
    costDetail,
    fullLabel: costShort ? `${kindLabel} · ${costShort}` : kindLabel,
    tone,
  });

  if (!row || typeof row !== 'object') return finish('문자', '', '', 'sms');

  // 1. 서버가 계산한 sendCost (내 문구)
  const sc = row.sendCost;
  if (sc && sendKindLabel(sc.type)) {
    const parts = Array.isArray(sc.parts) ? sc.parts : [];
    const kindLabel = parts.length > 1 || (parts[0] && parts[0].count > 1)
      ? parts.map((p) => `${sendKindLabel(p.type)} ${p.count}통`).join(' + ')
      : sendKindLabel(sc.type);
    const unit = sc.unit !== null && sc.unit !== undefined && Number.isFinite(Number(sc.unit)) ? Number(sc.unit) : null;
    const costShort = unit !== null ? wonKRW(unit) : '';
    const fb = sc.fallback_unit != null && Number.isFinite(Number(sc.fallback_unit)) ? Number(sc.fallback_unit) : null;
    const costDetail = unit !== null
      ? (sc.type === 'BMS' && fb !== null ? `건당 ${wonKRW(unit)} (미친구 시 장문 ${wonKRW(fb)})` : `건당 ${wonKRW(unit)}`)
      : '';
    const tone = sc.type === 'BMS' ? 'bms' : (sc.type === 'ATA' ? 'ata' : 'sms');
    return finish(kindLabel, costShort, costDetail, tone);
  }

  // 2. 내 문구 fallback (sendCost 미포함 상태)
  if (row.autoKind || (row.preview !== undefined && !row.sender && !row.external)) {
    if (row.autoAtaTemplate === 'BMS_FREE') {
      return finish('브랜드메시지', '100원', '건당 100원 (미친구 시 장문 45원)', 'bms');
    }
    if (row.autoAtaTemplate) {
      return finish('알림톡', wonKRW(ataPrice), `건당 ${wonKRW(ataPrice)}`, 'ata');
    }
    if (row.hasImage) {
      return finish('사진 문자', '110원', '건당 110원', 'sms');
    }
    return finish('문자', '18~45원', '단문 18원 · 장문 45원', 'sms');
  }

  // 3. 카페24 외부 발송 (별도 정산)
  if (row.sender === SENDERS.cafe24) {
    if (row.channel === 'ATA') return finish('알림톡', '카페24 과금', '카페24 별도 과금', 'ata');
    if (row.channel === 'BMS') return finish('브랜드메시지', '카페24 과금', '카페24 별도 과금', 'bms');
    return finish('문자', '카페24 과금', '카페24 별도 과금', 'sms');
  }

  // 4. 외부 채널 (메이크·쏠라피 자동화 등)
  const ch = String(row.channel || '').toUpperCase();
  if (ch === 'BMS') return finish('브랜드메시지', '100원', '건당 100원 (미친구 시 장문 45원)', 'bms');
  if (ch === 'ATA') return finish('알림톡', wonKRW(ataPrice), `건당 ${wonKRW(ataPrice)}`, 'ata');
  if (ch === 'MMS') return finish('사진 문자', '110원', '건당 110원', 'sms');
  if (ch === 'LMS') return finish('장문 문자', '45원', '건당 45원', 'sms');
  if (ch === 'SMS') return finish('단문 문자', '18원', '건당 18원', 'sms');

  // 5. 제작현황 카탈로그
  const cfgChan = String(row.config?.channel || '');
  if (cfgChan.includes('알림톡')) return finish('알림톡', wonKRW(ataPrice), `건당 ${wonKRW(ataPrice)} (실패 시 장문 45원)`, 'ata');
  if (cfgChan === 'LMS') return finish('장문 문자', '45원', '건당 45원', 'sms');
  if (cfgChan === 'SMS') return finish('단문 문자', '18원', '건당 18원', 'sms');
  if (cfgChan === 'MMS') return finish('사진 문자', '110원', '건당 110원', 'sms');
  if (row.policy?.status === 'paused') return finish('알림톡', '미발송', '정책 중단(미발송)', 'ata');
  return finish('알림톡·문자', '미설정', '설정 완료 후 단가 적용', 'sms');
}

function buildMineConditionSummary(entry) {
  const ch = channelCostOf(entry);
  const howSub = [ch.kindLabel, ch.costDetail].filter(Boolean).join(' · ') || sendCostText(entry.sendCost) || '일반 문자';

  if (!entry.autoKind) {
    const photoStr = entry.hasImage && Number(entry.imageCount) > 1 ? photoBadgeText(entry) : '';
    return {
      manual: true,
      whenMain: '수동 발송',
      whenSub: '보내기 화면에서 직접 골라 보냄',
      whoMain: '직접 고른 받는 사람',
      whoSub: '자동 대상 조건 없음',
      howMain: '원할 때마다 1번씩',
      howSub,
      catchup: '',
      tags: uniqTags([photoStr]),
    };
  }

  const kind = entry.autoKind;
  const days = Number(entry.autoDays) || 0;
  const offset = Number(entry.autoOffset) || 0;
  const step = String(entry.autoStep || '').trim();
  const timeText = sendTimeLabel(entry.autoSendTime) || (entry.autoSendTime || '');
  const aud = entry.autoAudience || 'customer';
  const tags = [];

  let whenMain = '';
  let whenSub = '';

  if (kind === 'ship_plus_days') {
    whenMain = days === 0 ? '출고 완료 당일' : `출고 완료 ${days}일 뒤`;
    whenSub = `${timeText || '오전 10:00'} 발송`;
  } else if (kind === 'order_plus_days') {
    whenMain = days === 0 ? '주문 등록 당일' : `주문 등록 ${days}일 뒤`;
    whenSub = `${timeText || '오전 10:00'} 발송`;
  } else if (kind === 'process_started_plus_days' || kind === 'process_completed_plus_days') {
    const verb = kind === 'process_completed_plus_days' ? '완료' : '시작';
    whenMain = `${step ? `${step} 공정 ` : '공정 '}${verb} ${days === 0 ? '당일' : `${days}일 뒤`}`;
    whenSub = `${timeText || '오전 10:00'} 발송`;
  } else if (DATE_TRIGGER_KINDS.has(kind)) {
    const dateLabel = kind === 'ship_or_due' ? '출고·납기일' : (kind === 'ship_scheduled' ? '출고예정일' : '납기일');
    const t = timeText || '오전 10:00';
    if (entry.autoDaily === 'until') {
      whenMain = `${dateLabel} ${Math.abs(offset)}일 전부터 매일`;
      whenSub = `당일까지 매일 ${t} 발송`;
    } else if (entry.autoDaily === 'ongoing') {
      whenMain = offset > 0 ? `${dateLabel} ${offset}일 지난 뒤 매일` : `${dateLabel} 당일부터 매일`;
      whenSub = `매일 ${t} 발송`;
    } else if (entry.autoDaily === 'once') {
      whenMain = offset < 0 ? `${dateLabel} ${-offset}일 전 1번` : (offset > 0 ? `${dateLabel} ${offset}일 지남` : `${dateLabel} 당일`);
      whenSub = `${t} 발송 · 놓친 건 ${dateLabel} 전까지 1회`;
    } else {
      whenMain = offset === 0 ? `${dateLabel} 당일` : (offset < 0 ? `${dateLabel} ${-offset}일 전` : `${dateLabel} ${offset}일 지남`);
      whenSub = `${t} 발송`;
    }
    if (entry.autoWeekdays) tags.push('평일만 발송 (토·일 제외)');
    if (entry.autoUnlessStep) {
      tags.push(`${entry.autoUnlessStep} 공정 ${entry.autoUnlessMode === 'started' ? '미착수' : '미완료'} 주문만`);
    }
  } else if (kind === 'lead_plus_days') {
    const leadLabel = LEAD_SOURCE_FLOW_LABEL[entry.autoLeadSource || ''] || '가입·문의';
    if (days > 0) {
      whenMain = `${leadLabel} ${days}일 뒤`;
      whenSub = `${timeText || '오전 9:30'} 발송`;
    } else {
      whenMain = `${leadLabel} 즉시 (당일)`;
      whenSub = '접수 확인 후 바로 발송';
    }
  } else if (kind === 'member_joined') {
    whenMain = '자사몰 회원가입 즉시';
    whenSub = '가입 감지 시 실시간 발송 (켠 뒤 24시간 내)';
  } else if (kind === 'order_created') {
    whenMain = '주문 등록 즉시';
    whenSub = '등록 감지 시 실시간 발송 (켠 뒤 24시간 내)';
  } else if (kind === 'process_started' || kind === 'process_completed') {
    const verb = kind === 'process_started' ? '시작' : '완료';
    whenMain = `${step ? `${step} 공정 ` : '공정 '}${verb} 즉시`;
    whenSub = `${verb} 시각 기록 시 실시간 발송`;
  } else {
    whenMain = autoConditionParts(entry).when || '자동 발송';
    whenSub = timeText ? `${timeText} 발송` : '';
  }

  let whoMain = '';
  let whoSub = '';
  if (aud === 'staff') {
    whoMain = Number(entry.autoStaffCount) > 0 ? `등록 직원 ${Number(entry.autoStaffCount)}명` : '지정된 내부 직원';
    whoSub = '내부 업무 알림 수신자';
  } else if (aud === 'sales') {
    whoMain = entry.autoSales ? `영업담당 (${entry.autoSales})` : '담당 영업사원';
    whoSub = entry.autoUnlessStep
      ? `${entry.autoUnlessStep} 공정 ${entry.autoUnlessMode === 'started' ? '미착수' : '미완료'} 주문만`
      : '주문별 지정 영업담당';
  } else if (kind === 'ship_plus_days') {
    whoMain = '출고 완료된 고객';
    whoSub = '수신거부·중복 번호 제외';
  } else if (kind === 'order_plus_days' || kind === 'order_created') {
    whoMain = '주문 고객';
    whoSub = '취소 주문·수신거부·중복 번호 제외';
  } else if (DATE_TRIGGER_KINDS.has(kind)) {
    whoMain = '제작 중인 고객';
    whoSub = entry.autoUnlessStep
      ? `${entry.autoUnlessStep} 공정 ${entry.autoUnlessMode === 'started' ? '미착수' : '미완료'} 주문만`
      : '제작 진행 상태인 주문';
  } else if (kind === 'member_joined') {
    whoMain = '자사몰 회원가입 고객';
    whoSub = '가입 완료 회원';
  } else if (kind === 'lead_plus_days') {
    whoMain = `${LEAD_SOURCE_FLOW_LABEL[entry.autoLeadSource || ''] || '가입·문의'} 고객`;
    whoSub = '연락처가 남은 접수 건';
  } else {
    whoMain = '제작 주문 고객';
    whoSub = '취소 주문 제외';
  }

  if (Array.isArray(entry.autoDaysOff) && entry.autoDaysOff.length > 0) {
    const offNames = entry.autoDaysOff.map((d) => DAY_OFF_LABELS[d]).filter(Boolean).join('·');
    if (offNames) tags.push(`휴무 요일 제외: ${offNames}`);
  }
  if (entry.autoSales && aud !== 'sales') tags.push(`${entry.autoSales} 담당 주문만`);
  if (entry.autoSendFrom) tags.push(`${entry.autoSendFrom} 이후부터 적용`);

  const copyTail = phoneTailDigits(entry.autoCopyTo);
  if (copyTail) tags.push(`관리자 확인 단문: ${copyTail}`);
  if (entry.autoFrom) tags.push(`별도 발신번호: ${formatKoreanPhone(entry.autoFrom)}`);

  let howMain = '';
  if (['ship_plus_days', 'order_plus_days', 'process_started_plus_days', 'process_completed_plus_days'].includes(kind)) {
    const rep = Number(entry.autoRepeat) || 1;
    const interval = Number(entry.autoInterval) || 30;
    howMain = rep > 1 ? `번호당 최대 ${rep}번 (${interval}일 간격)` : '번호당 1번만';
  } else if (DATE_TRIGGER_KINDS.has(kind)) {
    howMain = (entry.autoDaily === 'until' || entry.autoDaily === 'ongoing') ? '대상일 동안 하루 1번' : '주문·번호당 1번';
  } else if (IMMEDIATE_TRIGGER_KINDS.has(kind) && kind !== 'member_joined') {
    howMain = '주문·번호당 1번';
  } else {
    howMain = '번호당 1번만';
  }

  let catchup = '';
  if (kind === 'ship_plus_days' && entry.autoCatchupAt) {
    const atText = String(entry.autoCatchupAt).replace('T', ' ');
    const fromText = entry.autoCatchupFrom ? `${entry.autoCatchupFrom} ~ 오늘` : '처음 ~ 오늘';
    const dailyText = entry.autoCatchupDaily ? ` · 하루 최대 ${entry.autoCatchupDaily}건` : '';
    const doneText = entry.autoCatchupDone ? ' · 발송 완료됨' : '';
    catchup = `기존 출고건 일괄 발송 예약: ${atText} (${fromText} 출고분${dailyText}${doneText})`;
  }

  return { manual: false, whenMain, whenSub, whoMain, whoSub, howMain, howSub, catchup, tags: uniqTags(tags) };
}

function buildCatalogConditionSummary(item, recipients) {
  const triggerParts = String(item.trigger || '').split(' · ').map((s) => s.trim()).filter(Boolean);
  let whenMain = '';
  let whenSub = '';

  if (triggerParts.length >= 2 && triggerParts[0] === '생산중') {
    whenMain = triggerParts.slice(1).join(' · ');
    whenSub = '생산중인 주문 대상';
  } else if (triggerParts.length >= 2) {
    whenMain = triggerParts[0];
    whenSub = triggerParts.slice(1).join(' · ');
  } else if (triggerParts.length === 1) {
    whenMain = triggerParts[0];
  } else {
    whenMain = item.sender === '카페24' ? '쇼핑몰 주문·회원 이벤트' : '자동 조건 확인 필요';
    whenSub = item.sender === '카페24' ? '카페24 설정 조건에 따라 자동 발송' : '';
  }

  let whoMain = '';
  let whoSub = '';
  if (item.audience?.id === 'customer') {
    whoMain = item.external ? (item.who || '고객') : '제작 주문 고객';
    whoSub = item.external ? '외부 연동 고객' : '제작 주문 수신 고객';
  } else if (item.external) {
    whoMain = item.who || item.audience?.label || '직원';
    whoSub = '외부 연동 수신자';
  } else if (Array.isArray(recipients)) {
    const people = staffRecipientsOf(item.target, recipients);
    if (people.length > 0) {
      whoMain = staffRecipientsPhrase(people);
      whoSub = `등록 ${item.audience?.label || '직원'} ${people.length}명`;
    } else if (/\d{4}/.test(String(item.target || ''))) {
      whoMain = shortenPhonesInText(item.target);
      whoSub = item.audience?.label || '직원';
    } else {
      whoMain = staffRecipientsPhrase([]);
      whoSub = item.target ? String(item.target) : '직원 알림 수신자 미등록';
    }
  } else {
    whoMain = item.target ? shortenPhonesInText(item.target) : (item.audience?.label || '직원');
    whoSub = item.target ? (item.audience?.label || '직원') : '수신자 정보 불러오는 중';
  }

  const ch = channelCostOf(item);
  const extraCostNote = ch.costDetail.includes('(') ? ch.costDetail.slice(ch.costDetail.indexOf('(')) : '';
  const countText = item.count === null ? '발송 확인 안 됨' : `최근 7일 ${item.count}건`;
  const howMain = ch.fullLabel;
  const howSub = [item.sender, countText, extraCostNote].filter(Boolean).join(' · ');

  const tags = [];
  if (item.scenario) tags.push(item.sender === '메이크' ? `메이크 시나리오: ${item.scenario}` : `자동화: ${item.scenario}`);
  if (item.ad) tags.push('광고성 문구 (수신동의·표기 적용)');
  if (item.active === false) tags.push('꺼짐 상태 (자동화 꺼져 있음)');
  if (item.policy?.status === 'paused') tags.push(item.policy.label || '정책 중단');
  if (item.config?.status === 'incomplete') tags.push(item.config.label || '설정 미완료');
  if (item.config?.status === 'test') tags.push('테스트 기록만 남음 (실제 미발송)');

  return { manual: false, whenMain, whenSub, whoMain, whoSub, howMain, howSub, catchup: '', tags: uniqTags(tags) };
}

// 상세 카드·목록 카드용 비개발자 친화 발송 조건 요약
export function buildConditionSummary(entryOrItem, { isMine = false, recipients = null } = {}) {
  if (!entryOrItem || typeof entryOrItem !== 'object') {
    return { manual: true, whenMain: '-', whenSub: '', whoMain: '-', whoSub: '', howMain: '-', howSub: '', catchup: '', tags: [] };
  }
  const treatAsMine = Boolean(isMine || entryOrItem.autoKind || (entryOrItem.preview !== undefined && !entryOrItem.sender && !entryOrItem.external));
  return treatAsMine ? buildMineConditionSummary(entryOrItem) : buildCatalogConditionSummary(entryOrItem, recipients);
}

/**
 * Format ISO timestamp or YYYY-MM-DD date string into readable KST last-sent label.
 */
export function formatLastSentLabel(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const todayKst = new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const mmdd = `${dateOnly[2]}/${dateOnly[3]}`;
    return raw === todayKst ? `오늘(${mmdd})` : mmdd;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 3600000);
  const ymd = d.toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16);
  const mmdd = `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
  return ymd === todayKst ? `오늘 ${hhmm}` : `${mmdd} ${hhmm}`;
}

/**
 * Group SMS templates into clear business categories (Reviews grouped together, Referrals/Benefits visible, Staff separated).
 */
export function smsDisplayCategory(row) {
  const audId = row?.audience?.id;
  const autoAud = row?.autoAudience;
  if (audId === 'staff' || audId === 'admin' || autoAud === 'staff' || autoAud === 'sales') {
    return { groupKey: 'staff-alerts', groupLabel: '직원 · 관리자 › 공정 · 납기 알림', tag: '내부 알림', groupMod: 'stl-group--staff', order: 4 };
  }
  const name = String(row?.name || '');
  const body = String(row?.body || row?.preview || '');
  if (/(리뷰|후기)/i.test(name) || row?.id === 'smartstore_thanks' || row?.id === 'smartstore_confirmed' || /(리뷰|후기)\s*(작성|이벤트|남겨)/.test(body)) {
    return { groupKey: 'cust-review', groupLabel: '고객 › 리뷰 이벤트', tag: '리뷰 묶음', groupMod: 'stl-group--mine', order: 1 };
  }
  if (/(소개|혜택|무료\s*지원|이벤트|가입)/i.test(name) || row?.kind === '이벤트·혜택' || row?.autoKind === 'lead_plus_days' || row?.autoKind === 'member_joined') {
    return { groupKey: 'cust-benefit', groupLabel: '고객 › 소개 · 혜택', tag: '이벤트·혜택', groupMod: 'stl-group--mine', order: 2 };
  }
  return { groupKey: 'cust-order', groupLabel: '고객 › 주문 · 출고 · 주의사항', tag: '주문·출고', groupMod: 'stl-group--cust', order: 3 };
}

/**
 * Group Kakao templates (Brand Messages & Alimtalk) into matching business categories.
 */
export function kakaoDisplayCategory(row, kindFallback = '') {
  const aud = String(row?.audience || '');
  const kind = String(row?.kind || kindFallback || '');
  if (aud === '직원' || kind === '직원 작업 알림' || kind === '관리자·시스템') {
    return { groupKey: 'k-staff', groupLabel: '직원 · 관리자 › 업무 알림', groupMod: 'stl-group--staff', order: 5 };
  }
  const name = String(row?.name || '');
  if (/(리뷰|후기)/i.test(name)) {
    return { groupKey: 'k-review', groupLabel: '고객 › 리뷰 이벤트', groupMod: 'stl-group--mine', order: 1 };
  }
  if (/(소개|혜택|무료\s*지원|이벤트|가입|인터뷰)/i.test(name) || kind === '이벤트·혜택') {
    return { groupKey: 'k-benefit', groupLabel: '고객 › 소개 · 혜택 · 이벤트', groupMod: 'stl-group--mine', order: 2 };
  }
  if (kind === '상담·문의' || /문의|상담/.test(name)) {
    return { groupKey: 'k-inquiry', groupLabel: '고객 › 상담 · 문의', groupMod: 'stl-group--cust', order: 4 };
  }
  return { groupKey: 'k-order', groupLabel: '고객 › 주문 · 출고 안내', groupMod: 'stl-group--cust', order: 3 };
}
