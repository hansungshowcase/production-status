// 문자 관리 콘솔(/sms-history) 공용 상수·순수 함수. api/ 와 src/ 양쪽에서 import 한다.

export const CONSOLE_MENUS = Object.freeze([
  { id: 'dashboard', label: '현황판' },
  { id: 'send', label: '보내기' },
  {
    id: 'log', label: '발송 내역', subs: [
      { id: 'all', label: '전체', aud: 'all', ch: 'all' },
      { id: 'customer-sms', label: '고객 · 문자', aud: 'customer', ch: 'sms' },
      { id: 'customer-kakao', label: '고객 · 알림톡', aud: 'customer', ch: 'kakao' },
      { id: 'staff-sms', label: '직원 · 문자', aud: 'staff', ch: 'sms' },
      { id: 'staff-kakao', label: '직원 · 알림톡', aud: 'staff', ch: 'kakao' },
    ],
  },
  {
    id: 'templates', label: '템플릿', subs: [
      { id: 'sms', label: '문자 템플릿', ch: 'sms' },
      { id: 'kakao', label: '알림톡 템플릿', ch: 'kakao' },
      { id: 'new', label: '새 템플릿 등록', mode: 'new' },
    ],
  },
  { id: 'customer', label: '고객 문자 관리' },
  { id: 'staff', label: '직원 문자 관리' },
]);

export const MENU_IDS = Object.freeze(CONSOLE_MENUS.map(menu => menu.id));
export const AUDIENCES = Object.freeze(['all', 'customer', 'staff', 'other']);
export const CHANNEL_KINDS = Object.freeze(['all', 'sms', 'kakao']);
export const TEMPLATE_MODES = Object.freeze(['new', 'edit']);
export const TEMPLATE_ID_RE = /^[\w-]{1,64}$/;

const SMS_TYPES = new Set(['SMS', 'LMS', 'MMS']);
const KAKAO_TYPES = new Set(['ATA', 'CTA', 'CTI']);

// 'sms' | 'kakao' | 'other'
export function kindOfType(type) {
  const text = String(type || '').trim().toUpperCase();
  if (SMS_TYPES.has(text)) return 'sms';
  if (KAKAO_TYPES.has(text) || text.startsWith('BMS_')) return 'kakao';
  return 'other';
}

export const TEMPLATE_STATUS = Object.freeze({
  APPROVED: { label: '승인', tone: 'ok' },
  INSPECTING: { label: '검수 중', tone: 'info' },
  PENDING: { label: '검수 전', tone: 'muted' },
  REJECTED: { label: '반려', tone: 'danger' },
});

export const TEMPLATE_LIMITS = Object.freeze({
  name: 100, content: 1000, extra: 500, emphasize: 50, buttonName: 14, buttons: 5, comment: 500, link: 500,
});

export const BUTTON_TYPES = Object.freeze({ WL: '웹링크', DS: '배송조회', BK: '봇키워드', MD: '메시지전달' });
export const SUPPORTED_EMPHASIZE = Object.freeze(['NONE', 'TEXT']);
export const SUPPORTED_MESSAGE = Object.freeze(['BA', 'EX']);
export const DEFAULT_CATEGORY = '999999';

const VARIABLE_RE = /#\{([^{}\s]{1,40})\}/g;
export const VARIABLE_NAME_RE = /^[가-힣A-Za-z0-9_]{1,20}$/;
const LINK_RE = /^(https?:\/\/\S+|#\{[^{}\s]{1,40}\}\S*)$/i;
const CATEGORY_RE = /^[0-9A-Za-z]{1,20}$/;

// '#{이름}' → ['이름', …] 중복 제거, 나온 순서 유지
export function extractVariables(content) {
  const out = [];
  for (const match of String(content || '').matchAll(VARIABLE_RE)) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function lengthOk(value, max, min = 1) {
  const n = [...value].length;
  return n >= min && n <= max;
}

// 입력: { target:{kind,id}, name, content, categoryCode, messageType, emphasizeType, emphasizeTitle,
//        emphasizeSubtitle, extra, securityFlag, buttons:[{type,name,linkMo,linkPc}] }
// 결과: { ok:true, value } | { ok:false, errors:{ 칸: 문구 } }
// value 는 허용 칸만 남긴 우리 모양(쏠라피 본문은 toSolapiTemplateBody 로 바꾼다).
// options.requireTarget=false 는 수정(update) 때 — 채널/그룹은 바꿀 수 없어 검사하지 않는다.
export function validateTemplateInput(input, { requireTarget = true } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const value = {};

  if (requireTarget) {
    const kind = src.target?.kind;
    const id = text(src.target?.id);
    if ((kind !== 'channel' && kind !== 'group') || !TEMPLATE_ID_RE.test(id)) {
      errors.target = '채널 또는 그룹을 고르세요.';
    } else {
      value.target = { kind, id };
    }
  }

  const name = text(src.name);
  if (!lengthOk(name, TEMPLATE_LIMITS.name)) errors.name = `템플릿 이름은 1~${TEMPLATE_LIMITS.name}자로 적어 주세요.`;
  else value.name = name;

  const content = src.content == null ? '' : String(src.content).replace(/\r\n?/g, '\n').trim();
  if (!lengthOk(content, TEMPLATE_LIMITS.content)) errors.content = `내용은 1~${TEMPLATE_LIMITS.content}자로 적어 주세요.`;
  else {
    const bad = extractVariables(content).find(v => !VARIABLE_NAME_RE.test(v));
    if (bad) errors.content = `변수 이름 '${bad}' 는 쓸 수 없습니다(한글·영문·숫자·밑줄 1~20자).`;
    else value.content = content;
  }

  const categoryCode = text(src.categoryCode) || DEFAULT_CATEGORY;
  if (!CATEGORY_RE.test(categoryCode)) errors.categoryCode = '카테고리를 다시 골라 주세요.';
  else value.categoryCode = categoryCode;

  const messageType = text(src.messageType) || 'BA';
  if (!SUPPORTED_MESSAGE.includes(messageType)) errors.messageType = '메시지 유형은 기본형·부가정보형만 쓸 수 있습니다.';
  else value.messageType = messageType;

  const emphasizeType = text(src.emphasizeType) || 'NONE';
  if (!SUPPORTED_EMPHASIZE.includes(emphasizeType)) errors.emphasizeType = '템플릿 유형은 기본형·강조표기형만 쓸 수 있습니다.';
  else value.emphasizeType = emphasizeType;

  if (emphasizeType === 'TEXT') {
    const title = text(src.emphasizeTitle);
    const subtitle = text(src.emphasizeSubtitle);
    if (!lengthOk(title, TEMPLATE_LIMITS.emphasize)) errors.emphasizeTitle = `강조 제목은 1~${TEMPLATE_LIMITS.emphasize}자로 적어 주세요.`;
    else value.emphasizeTitle = title;
    if (!lengthOk(subtitle, TEMPLATE_LIMITS.emphasize)) errors.emphasizeSubtitle = `보조 문구는 1~${TEMPLATE_LIMITS.emphasize}자로 적어 주세요.`;
    else value.emphasizeSubtitle = subtitle;
  }

  if (messageType === 'EX') {
    const extra = src.extra == null ? '' : String(src.extra).replace(/\r\n?/g, '\n').trim();
    if (!lengthOk(extra, TEMPLATE_LIMITS.extra)) errors.extra = `부가정보는 1~${TEMPLATE_LIMITS.extra}자로 적어 주세요.`;
    else if (/#\{/.test(extra) || /https?:\/\//i.test(extra)) errors.extra = '부가정보에는 변수와 링크를 넣을 수 없습니다.';
    else value.extra = extra;
  }

  value.securityFlag = src.securityFlag === true;

  const rawButtons = Array.isArray(src.buttons) ? src.buttons : [];
  if (rawButtons.length > TEMPLATE_LIMITS.buttons) {
    errors.buttons = `버튼은 ${TEMPLATE_LIMITS.buttons}개까지 넣을 수 있습니다.`;
  } else {
    const buttons = [];
    rawButtons.forEach((button, index) => {
      const type = text(button?.type);
      const label = text(button?.name);
      const key = `buttons.${index}`;
      if (!Object.hasOwn(BUTTON_TYPES, type)) { errors[key] = `${index + 1}번 버튼 유형을 골라 주세요.`; return; }
      if (!lengthOk(label, TEMPLATE_LIMITS.buttonName)) { errors[key] = `${index + 1}번 버튼 이름은 1~${TEMPLATE_LIMITS.buttonName}자로 적어 주세요.`; return; }
      const clean = { type, name: label };
      if (type === 'WL') {
        const linkMo = text(button?.linkMo);
        const linkPc = text(button?.linkPc);
        if (!linkMo || linkMo.length > TEMPLATE_LIMITS.link || !LINK_RE.test(linkMo)) {
          errors[key] = `${index + 1}번 버튼의 모바일 링크는 http:// 또는 https:// (또는 #{변수})로 시작해야 합니다.`; return;
        }
        if (linkPc && (linkPc.length > TEMPLATE_LIMITS.link || !LINK_RE.test(linkPc))) {
          errors[key] = `${index + 1}번 버튼의 PC 링크는 http:// 또는 https:// (또는 #{변수})로 시작해야 합니다.`; return;
        }
        clean.linkMo = linkMo;
        if (linkPc) clean.linkPc = linkPc;
      }
      buttons.push(clean);
    });
    value.buttons = buttons;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

// validateTemplateInput 의 value → 쏠라피 POST/PUT kakao/v2/templates 본문.
// 요청 칸 이름은 SDK createKakaoAlimtalkTemplateRequest 기준(emphasizeSubTitle 대문자 T, buttonType/buttonName).
// forUpdate=true 면 channelId/channelGroupId 를 넣지 않는다(수정 요청에는 그 칸이 없다).
export function toSolapiTemplateBody(value, { forUpdate = false } = {}) {
  const body = {
    name: value.name,
    content: value.content,
    categoryCode: value.categoryCode || DEFAULT_CATEGORY,
    messageType: value.messageType || 'BA',
    emphasizeType: value.emphasizeType || 'NONE',
    securityFlag: value.securityFlag === true,
    buttons: (value.buttons || []).map(button => {
      const out = { buttonType: button.type, buttonName: button.name };
      if (button.type === 'WL') {
        out.linkMo = button.linkMo;
        if (button.linkPc) out.linkPc = button.linkPc;
      }
      return out;
    }),
  };
  if (body.emphasizeType === 'TEXT') {
    body.emphasizeTitle = value.emphasizeTitle;
    body.emphasizeSubTitle = value.emphasizeSubtitle;
  }
  if (body.messageType === 'EX') body.extra = value.extra;
  if (!forUpdate && value.target) {
    if (value.target.kind === 'group') body.channelGroupId = value.target.id;
    else body.channelId = value.target.id;
  }
  return body;
}

function getParam(searchParams, key) {
  if (!searchParams) return '';
  if (typeof searchParams.get === 'function') return searchParams.get(key) || '';
  const raw = searchParams[key];
  return raw == null ? '' : String(raw);
}

// URLSearchParams(또는 평범한 객체) → { menu, aud, ch, tpl, mode }. 틀린 값은 기본값.
export function parseConsoleQuery(searchParams) {
  const menu = getParam(searchParams, 'menu');
  const aud = getParam(searchParams, 'aud');
  const ch = getParam(searchParams, 'ch');
  const tpl = getParam(searchParams, 'tpl');
  const mode = getParam(searchParams, 'mode');
  const state = {
    menu: MENU_IDS.includes(menu) ? menu : 'dashboard',
    aud: AUDIENCES.includes(aud) ? aud : 'all',
    // 템플릿 메뉴는 문자(sms) 아니면 알림톡(kakao)이 기본
    ch: menu === 'templates' ? (ch === 'sms' ? 'sms' : 'kakao') : (CHANNEL_KINDS.includes(ch) ? ch : 'all'),
    tpl: TEMPLATE_ID_RE.test(tpl) ? tpl : '',
    mode: TEMPLATE_MODES.includes(mode) ? mode : '',
  };
  if (state.mode === 'edit' && !state.tpl) state.mode = '';
  if (state.menu === 'templates' && state.mode === 'new') state.ch = 'kakao'; // 등록 화면은 알림톡
  return state;
}

// state → 'menu=log&aud=customer&ch=sms' (기본값·그 메뉴에서 안 쓰는 값은 뺀다)
export function buildConsoleQuery(state = {}) {
  const clean = parseConsoleQuery(state);
  const params = new URLSearchParams();
  if (clean.menu !== 'dashboard') params.set('menu', clean.menu);
  if (clean.menu === 'log') {
    if (clean.aud !== 'all') params.set('aud', clean.aud);
    if (clean.ch !== 'all') params.set('ch', clean.ch);
  }
  if (clean.menu === 'templates') {
    if (clean.ch === 'sms') params.set('ch', 'sms');
    if (clean.tpl) params.set('tpl', clean.tpl);
    if (clean.mode) params.set('mode', clean.mode);
  }
  return params.toString();
}

// 사이드바에서 선택으로 표시할 하위 메뉴 id 또는 null
export function activeSubId(state = {}) {
  const clean = parseConsoleQuery(state);
  if (clean.menu === 'log') {
    const sub = CONSOLE_MENUS.find(menu => menu.id === 'log').subs.find(item => item.aud === clean.aud && item.ch === clean.ch);
    return sub ? sub.id : null;
  }
  if (clean.menu === 'templates') return clean.mode === 'new' ? 'new' : (clean.ch === 'sms' ? 'sms' : 'kakao');
  return null;
}
