import { WORKERS as SHARED_WORKERS, WORKER_DEPARTMENT_FILTER as SHARED_WORKER_DEPARTMENT_FILTER } from '../shared/workerAccess.js';

export const PROCESS_STEPS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장', '출고'];

export const DEPARTMENTS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장', '출고'];

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
  '출고': '출고',
};

export const WORKERS = SHARED_WORKERS;

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
  '출고': '🚚',
};

export const DEPT_ICONS = STEP_ICONS;

export const WORKER_DEPARTMENT_FILTER = SHARED_WORKER_DEPARTMENT_FILTER;

export const SALES_PERSONS = [
  { name: '신은철', role: '영업 담당', color: '#0ea5e9' },
  { name: '이준형', role: '영업 담당', color: '#0891b2' },
  { name: '황보민수', role: '영업 담당', color: '#0ea5e9' },
];

export const WORKER_STORAGE_KEY = 'selected_worker';
export const DEPARTMENT_STORAGE_KEY = 'selected_department';
// 공정 화면 진입 시 "본인이 맞는지" 한 번 확인받은 작업자 이름.
// 이름을 저장해 두므로 다른 작업자로 바뀌면 다시 물어본다.
export const WORKER_CONFIRMED_KEY = 'confirmed_worker';
export const LAST_STATION_KEY = 'worker_last_station';
