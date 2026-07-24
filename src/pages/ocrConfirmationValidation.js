import { isCanonicalCalendarDate } from '../utils/dateUtils.js';

export const PRODUCT_TYPE_OPTIONS = ['제과', '정육', '반찬', '꽃', '대면', '오픈', '진열', '마카롱', '샌드위치', '쇼케이스', '버티칼', '냉장고', '냉동고'];
export const DOOR_TYPE_OPTIONS = ['앞문', '뒷문', '양문', '여닫이', '오픈', '라운드앞문', '라운드뒷문', '평대'];
export const COLOR_OPTIONS = ['화이트', '올백색', '올스텐', '올검정', '블랙', '골드스텐', '골드미러'];
export const CANONICAL_SALES_PERSONS = ['신은철', '이준형'];

export const OCR_CONFIRMATION_FIELD_DEFINITIONS = [
  { key: 'client_name', label: '거래처', required: true },
  { key: 'order_date', label: '발주일', required: true, type: 'date' },
  { key: 'due_date', label: '납기일', required: true, type: 'date' },
  { key: 'phone', label: '연락처' },
  { key: 'delivery_address', label: '납품주소' },
  { key: 'freight_payment', label: '운임여부' },
  { key: 'sales_person', label: '담당자', required: true, dropdown: CANONICAL_SALES_PERSONS },
  { key: 'product_type', label: '품명/사양', required: true, dropdown: PRODUCT_TYPE_OPTIONS },
  { key: 'door_type', label: '문짝/디자인', dropdown: DOOR_TYPE_OPTIONS },
  { key: 'width', label: '가로(mm)', type: 'number' },
  { key: 'depth', label: '세로(mm)', type: 'number' },
  { key: 'height', label: '높이(mm)', type: 'number' },
  { key: 'quantity', label: '수량', required: true, type: 'number' },
  { key: 'color', label: '색상', dropdown: COLOR_OPTIONS },
  { key: 'notes', label: '비고', textarea: true },
];

const OCR_CORE_FIELD_RULES = [
  { key: 'client_name', label: '거래처', message: '거래처를 입력해주세요', isValid: (value) => Boolean(String(value ?? '').trim()) },
  { key: 'order_date', label: '발주일', message: '올바른 발주일을 입력해주세요', isValid: (value) => isCanonicalCalendarDate(value) },
  { key: 'due_date', label: '납기일', message: '올바른 납기일을 입력해주세요', isValid: (value) => isCanonicalCalendarDate(value) },
  {
    key: 'sales_person',
    label: '담당자',
    message: '담당자를 선택해주세요',
    isValid: (value) => CANONICAL_SALES_PERSONS.includes(String(value ?? '').trim()),
  },
  {
    key: 'product_type',
    label: '품명/사양',
    message: '품명/사양을 선택해주세요',
    isValid: (value) => Boolean(String(value ?? '').trim()),
  },
  {
    key: 'quantity',
    label: '수량',
    message: '수량을 1 이상 입력해주세요',
    isValid: (value) => {
      if (value === null || value === undefined || String(value).trim() === '') return false;
      const numeric = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
      return Number.isFinite(numeric) && numeric > 0;
    },
  },
];

const OCR_OPTIONAL_FIELD_DEFINITIONS = OCR_CONFIRMATION_FIELD_DEFINITIONS
  .filter(({ key }) => !OCR_CORE_FIELD_RULES.some((rule) => rule.key === key));

export function getOcrConfirmationValidation(data) {
  const source = data || {};
  const invalidCoreFields = OCR_CORE_FIELD_RULES
    .filter(({ key, isValid }) => !isValid(source[key]))
    .map(({ key, label, message }) => ({ key, label, message }));
  const blankOptionalFields = OCR_OPTIONAL_FIELD_DEFINITIONS
    .filter(({ key }) => String(source[key] ?? '').trim() === '')
    .map(({ key, label }) => ({ key, label }));

  return {
    invalidCoreFields,
    blankOptionalFields,
    isValid: invalidCoreFields.length === 0,
  };
}
