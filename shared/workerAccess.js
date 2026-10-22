export const WORKERS = Object.freeze([
  '이먼', '카우사르', '거니', '나타왓', '마카라', '사르월', '까지', '이정섭 부장',
  '백승정', '아크롤', '박상규 공장장', '박유생 팀장', '최우석 이사', '김보수 팀장', '정영호 팀장', '신은철 부장',
]);

export const WORKER_DEPARTMENT_FILTER = Object.freeze({
  '이먼': ['절곡작업', '조립작업', '포장', '출고'], '이정섭 부장': ['도면설계', '레이저작업'], '거니': ['V-커팅작업', '포장', '출고'],
  '김보수 팀장': ['도면설계', '포장', '출고'], '백승정': ['용접작업', '분체작업', '조립작업', '포장', '출고'],
  '박유생 팀장': ['용접작업', '분체작업', '조립작업', '포장', '출고'], '정영호 팀장': ['설비작업', '포장', '출고'],
  '아크롤': ['절곡작업', '포장', '출고'], '사르월': ['설비작업', '포장', '출고'], '까지': ['용접작업', '분체작업', '조립작업', '포장', '출고'],
  '카우사르': ['용접작업', '분체작업', '조립작업', '포장', '출고'], '나타왓': ['절곡작업', '분체작업', '조립작업', '포장', '출고'],
  '마카라': ['절곡작업', '분체작업', '조립작업', '포장', '출고'], '최우석 이사': ['절곡작업', '용접작업', '분체작업', '조립작업', '포장', '출고'],
});

export function canWorkerAccessDepartment(actor, stepName) {
  const allowedSteps = WORKER_DEPARTMENT_FILTER[String(actor || '').trim()];
  if (!allowedSteps) return true;
  return allowedSteps.includes(String(stepName || '').trim());
}
export const SALES_PERSON_NAMES = Object.freeze(['신은철', '이준형', '황보민수']);
