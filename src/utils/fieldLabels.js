// 화면·활동로그·에러 메시지에 DB 컬럼명이 그대로 새어나가지 않도록 하는 단일 매핑.
// 백엔드(api/**)와 프론트(src/**) 양쪽에서 재사용한다.

export const FIELD_LABELS = {
  // orders
  id: '주문번호',
  order_date: '발주일',
  due_date: '납기일',
  sales_person: '담당자',
  client_name: '거래처',
  ship_date: '출고일',
  ship_scheduled_date: '출고예정일',
  sale_amount: '판매금액',
  lead_source: '유입경로',
  balance: '잔금',
  phone: '전화번호',
  delivery_address: '배송지',
  freight_payment: '운임',
  product_type: '사양',
  door_type: '디자인',
  design: '도면',
  width: '가로',
  depth: '세로',
  height: '높이',
  quantity: '수량',
  color: '색상',
  notes: '비고',
  remarks: '특이사항',
  etc_notes: '기타메모',
  sms_sent: '문자발송',
  safe_delivery: '안전배송',
  work_order_image_url: '작업지시서',
  status: '진행상태',
  track_token: '고객조회링크',

  // pre_production
  instruction_check: '지시서 확인',
  material_drawing: '자재 도면',
  laser_drawing: '레이저 도면',
  material_order_received: '자재 발주 접수',
  material_order_completed: '자재 발주 완료',
  material_received: '자재 입고',

  // processes
  process_id: '공정',
  order_id: '주문 번호',
  step_name: '공정',
  assigned_worker: '담당 작업자',
  assigned_team: '담당 팀',
  started_by: '시작 담당자',
  completed_by: '완료 담당자',
  work_date: '작업일',
  actor: '담당자',

  // issues
  issue_type: '이슈 유형',
  description: '내용',
  reported_by: '등록자',

  // workers
  name: '이름',
  department: '부서',
};

// 화면 진단용 테이블 라벨 (테이블.컬럼 → 사람말)
export const TABLE_LABELS = {
  activity_feed: '활동 로그',
  orders: '주문',
  issues: '이슈',
  photos: '사진',
  processes: '공정',
  pre_production: '사전생산',
  workers: '작업자',
};

// 컬럼명 → 한국어 라벨. 매핑이 없으면 원문 대신에도 코드가 새지 않도록 그대로 두되,
// 호출부는 알려진 필드만 넘기는 것을 원칙으로 한다.
export function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

export function fieldLabels(fields) {
  return (fields || []).map(fieldLabel);
}

// 'activity_feed.description' → '활동 로그 · 내용'
export function describeTableColumn(key) {
  const [table, column] = String(key || '').split('.');
  if (!column) return fieldLabel(table);
  const tableLabel = TABLE_LABELS[table] || table;
  return `${tableLabel} · ${fieldLabel(column)}`;
}

function comparableValue(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value).trim();
}

// 저장 전/후 행을 비교해 "실제로 값이 바뀐" 필드만 골라낸다.
// 값이 그대로인 필드는 활동로그에 남기지 않는다.
export function changedFieldKeys(before, after, fields) {
  const beforeRow = before || {};
  const afterRow = after || {};
  return (fields || []).filter((field) => {
    const prev = comparableValue(beforeRow[field]);
    const next = comparableValue(afterRow[field]);
    if (prev === next) return false;

    // 숫자 컬럼은 표기 차이('1' vs 1, '100.00' vs 100)를 변경으로 보지 않는다.
    const prevNumber = Number(prev);
    const nextNumber = Number(next);
    if (prev !== '' && next !== '' && Number.isFinite(prevNumber) && Number.isFinite(nextNumber)) {
      return prevNumber !== nextNumber;
    }
    return true;
  });
}

// 활동로그 문구를 만든다. 바뀐 필드가 없으면 필드 나열을 아예 붙이지 않는다.
export function describeFieldChanges(prefix, changedFields) {
  const labels = fieldLabels(changedFields);
  if (labels.length === 0) return `${prefix}`;
  return `${prefix} (${labels.join(', ')})`;
}
