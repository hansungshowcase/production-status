// 공정 화면 진입 시 "작업자 OOO 님이 맞으실까요?" 를 물어야 하는지 판단한다.
// 다른 사람 이름으로 공정 시작·완료가 기록되는 것을 막기 위한 확인이다.

// 작업자를 고르지 않고 들어온 경우 sessionStorage 에 이름이 없어 이 값이 쓰인다.
// 특정 개인이 아니므로 확인 대상이 아니다.
export const DEFAULT_WORKER_NAME = '현장작업자';

export function shouldAskWorkerIdentity(workerName, confirmedName) {
  const worker = String(workerName ?? '').trim();
  if (!worker || worker === DEFAULT_WORKER_NAME) return false;
  // 확인된 이름을 저장해 두므로, 같은 작업자가 공정 사이를 오갈 때는 다시 묻지 않는다.
  // 이름이 바뀌면 저장값과 어긋나므로 다시 묻는다.
  return String(confirmedName ?? '').trim() !== worker;
}
