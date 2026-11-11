// 알림톡 템플릿 등록·수정 양식의 순수 계산(화면 없음). 검증 규칙은 shared/smsConsole.js 것을 그대로 쓴다.
import {
  TEMPLATE_LIMITS,
  BUTTON_TYPES,
  DEFAULT_CATEGORY,
  VARIABLE_NAME_RE,
  SUPPORTED_EMPHASIZE,
  SUPPORTED_MESSAGE,
} from '../../../shared/smsConsole.js';

// 오류 칸 순서(첫 오류 칸 초점용). 화면 위에서 아래 순서와 같다.
export const FIELD_ORDER = [
  'target', 'categoryCode', 'emphasizeType', 'messageType', 'name',
  'emphasizeTitle', 'emphasizeSubtitle', 'content', 'extra', 'buttons',
  'buttons.0', 'buttons.1', 'buttons.2', 'buttons.3', 'buttons.4',
  'comment', 'confirmed',
];

export function targetKey(target) {
  return target && target.kind && target.id ? `${target.kind}:${target.id}` : '';
}

export function parseTargetKey(key) {
  const text = String(key || '');
  const at = text.indexOf(':');
  if (at < 1) return null;
  const kind = text.slice(0, at);
  const id = text.slice(at + 1);
  return (kind === 'channel' || kind === 'group') && id ? { kind, id } : null;
}

export function countChars(value) {
  return [...String(value == null ? '' : value)].length;
}

export function emptyButton(type = 'WL') {
  return { type, name: '', linkMo: '', linkPc: '' };
}

// 등록 양식의 빈 값. 채널/그룹이 1개뿐이면 자동 선택.
export function emptyFormValues(targets = []) {
  const list = Array.isArray(targets) ? targets : [];
  return {
    targetKey: list.length === 1 ? targetKey(list[0]) : '',
    name: '',
    categoryCode: DEFAULT_CATEGORY,
    emphasizeType: 'NONE',
    messageType: 'BA',
    emphasizeTitle: '',
    emphasizeSubtitle: '',
    content: '',
    extra: '',
    securityFlag: false,
    buttons: [],
    requestInspection: false,
    comment: '',
    confirmed: false,
  };
}

// 서버가 준 Template → 양식 값(수정 모드). 지원하지 않는 유형 값은 기본으로 돌린다.
export function formValuesFromTemplate(template) {
  if (!template || typeof template !== 'object') return emptyFormValues([]);
  const str = v => (v == null ? '' : String(v));
  return {
    targetKey: targetKey(template.target),
    name: str(template.name),
    categoryCode: str(template.categoryCode) || DEFAULT_CATEGORY,
    emphasizeType: SUPPORTED_EMPHASIZE.includes(template.emphasizeType) ? template.emphasizeType : 'NONE',
    messageType: SUPPORTED_MESSAGE.includes(template.messageType) ? template.messageType : 'BA',
    emphasizeTitle: str(template.emphasizeTitle),
    emphasizeSubtitle: str(template.emphasizeSubtitle),
    content: str(template.content),
    extra: str(template.extra),
    securityFlag: template.securityFlag === true,
    buttons: (Array.isArray(template.buttons) ? template.buttons : [])
      .slice(0, TEMPLATE_LIMITS.buttons)
      .map(b => ({
        type: Object.hasOwn(BUTTON_TYPES, b?.type) ? b.type : 'WL',
        name: str(b?.name),
        linkMo: str(b?.linkMo),
        linkPc: str(b?.linkPc),
      })),
    requestInspection: false,
    comment: '',
    confirmed: false,
  };
}

// 양식 값 → validateTemplateInput 입력. 숨겨진 칸(강조·부가정보·링크)은 비워서 보낸다.
export function toValidationInput(form) {
  const f = form || {};
  const isText = f.emphasizeType === 'TEXT';
  const isEx = f.messageType === 'EX';
  return {
    target: parseTargetKey(f.targetKey),
    name: f.name,
    content: f.content,
    categoryCode: f.categoryCode,
    messageType: f.messageType,
    emphasizeType: f.emphasizeType,
    emphasizeTitle: isText ? f.emphasizeTitle : '',
    emphasizeSubtitle: isText ? f.emphasizeSubtitle : '',
    extra: isEx ? f.extra : '',
    securityFlag: f.securityFlag === true,
    buttons: (f.buttons || []).map(b => (
      b.type === 'WL'
        ? { type: b.type, name: b.name, linkMo: b.linkMo, linkPc: b.linkPc }
        : { type: b.type, name: b.name }
    )),
  };
}

// 확인 체크·검수 의견까지 포함한 양식 자체의 추가 오류(공용 검증이 모르는 칸).
export function extraErrors(form) {
  const errors = {};
  if (!form?.confirmed) errors.confirmed = '정보성 메시지만 등록할 수 있음을 확인해 주세요.';
  if (form?.requestInspection && countChars(String(form.comment || '').trim()) > TEMPLATE_LIMITS.comment) {
    errors.comment = `검수 의견은 ${TEMPLATE_LIMITS.comment}자까지 적을 수 있습니다.`;
  }
  return errors;
}

export function firstErrorKey(errors) {
  const keys = Object.keys(errors || {});
  if (!keys.length) return null;
  const ranked = FIELD_ORDER.filter(k => keys.includes(k));
  return ranked[0] || keys[0];
}

// 변수 이름 검사. 통과하면 '' , 아니면 안내 문구.
export function variableNameError(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return '변수 이름을 적어 주세요.';
  return VARIABLE_NAME_RE.test(text) ? '' : '변수 이름은 한글·영문·숫자·밑줄 1~20자로 적어 주세요.';
}

// 커서 위치(문자 index, UTF-16)에 #{이름} 삽입. selectionEnd 가 있으면 선택 영역을 바꾼다.
// 반환 { text, cursor } — cursor 는 삽입한 글자 바로 뒤.
export function insertVariable(value, cursor, name, selectionEnd) {
  const source = String(value == null ? '' : value);
  const token = `#{${String(name).trim()}}`;
  const start = clamp(Number.isInteger(cursor) ? cursor : source.length, source.length);
  const end = clamp(Number.isInteger(selectionEnd) ? selectionEnd : start, source.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { text: source.slice(0, from) + token + source.slice(to), cursor: from + token.length };
}

function clamp(n, max) {
  return Math.max(0, Math.min(n, max));
}

export function canAddButton(buttons) {
  return (buttons || []).length < TEMPLATE_LIMITS.buttons;
}

export function addButton(buttons, type = 'WL') {
  const list = Array.isArray(buttons) ? buttons : [];
  if (!canAddButton(list)) return list;
  return [...list, emptyButton(Object.hasOwn(BUTTON_TYPES, type) ? type : 'WL')];
}

export function removeButton(buttons, index) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  return list.filter((_, i) => i !== index);
}

// dir: -1 위로, +1 아래로. 범위를 벗어나면 그대로.
export function moveButton(buttons, index, dir) {
  const list = Array.isArray(buttons) ? buttons : [];
  const to = index + dir;
  if (!Number.isInteger(index) || index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function updateButton(buttons, index, patch) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  return list.map((b, i) => (i === index ? { ...b, ...patch } : b));
}

// 미리보기용 템플릿 모양(S7 KakaoTemplatePreview props).
export function previewTemplate(form, targets = []) {
  const f = form || {};
  const picked = (targets || []).find(t => targetKey(t) === f.targetKey);
  const isText = f.emphasizeType === 'TEXT';
  return {
    name: f.name || '',
    content: f.content || '',
    emphasizeType: f.emphasizeType === 'TEXT' ? 'TEXT' : 'NONE',
    emphasizeTitle: isText ? f.emphasizeTitle || '' : '',
    emphasizeSubtitle: isText ? f.emphasizeSubtitle || '' : '',
    extra: f.messageType === 'EX' ? f.extra || '' : '',
    buttons: (f.buttons || []).map(b => ({ type: b.type, name: b.name || '' })),
    targetName: picked?.name || '',
  };
}
