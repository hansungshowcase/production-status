export const PROCESS_STEPS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장'];

export const DEPARTMENTS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장'];

export const DEPARTMENT_STEP_MAP = {
  '도면설계': '도면설계',
  '레이저작업': '레이저작업',
  'V-커팅작업': 'V-커팅작업',
  '절곡작업': '절곡작업',
  '용접작업': '용접작업',
  '분체작업': '분체작업',
  '조립작업': '조립작업',
  '설비작업': '설비작업',
  '포장': '포장',
};

export const WORKERS = [
  '강종효', '이먼', '카우사르', '거니', '나타왓', '마카라',
  '사르월', '이정섭 부장', '백승정', '김채곤', '아크롤',
  '박상규 공장장', '박유생', '최우석 이사', '김보수', '강성윤',
];

export const STEP_ICONS = {
  '도면설계': '📐',
  '레이저작업': '⚡',
  'V-커팅작업': '✂️',
  '절곡작업': '🔧',
  '용접작업': '🔥',
  '분체작업': '🎨',
  '조립작업': '🔩',
  '설비작업': '🛠️',
  '포장': '📦',
};

export const DEPT_ICONS = STEP_ICONS;

// 작업자별 접근 가능한 부서 제한 (미등록 작업자는 전체 부서 접근 가능)
export const WORKER_DEPARTMENT_FILTER = {
  '이정섭 부장': ['도면설계', '레이저작업'],
  '거니': ['V-커팅작업'],
  '김보수': ['도면설계'],
  '백승정': ['용접작업', '분체작업', '조립작업'],
  '박유생': ['용접작업', '분체작업', '조립작업'],
  '강성윤': ['설비작업', '포장'],
  '사르월': ['설비작업', '포장'],
};

export const SALES_PERSONS = [
  { name: '신은철', role: '영업 담당', color: '#0ea5e9' },
  { name: '이시아', role: '영업 담당', color: '#0891b2' },
];

export const WORKER_STORAGE_KEY = 'selected_worker';
export const DEPARTMENT_STORAGE_KEY = 'selected_department';
export const LAST_STATION_KEY = 'worker_last_station';
