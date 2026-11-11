// 조립작업·설비작업을 마치고 다음 공정(설비작업·포장 등)으로 넘기기 전에
// QC 담당자 도장 확인 알림을 띄운다. 확인을 눌러야 실제로 넘어간다(2026-11-11 요청).
export const QC_STAMP_STEPS = ['조립작업', '설비작업'];

export const QC_STAMP_TITLE = 'QC 검수 확인';
export const QC_STAMP_MESSAGE = 'QC 담당자 검수를 위해 최우석 이사님 도장을 받으신 후 다음 작업으로 넘겨주시기 바랍니다.';

export function needsQcStampNotice(fromStep) {
  return QC_STAMP_STEPS.includes(String(fromStep ?? '').trim());
}

// 공정 화면(station) 밖의 옛 화면(/worker, /worker/update, /tablet)에서 완료할 때 쓰는 확인 창.
// QC 대상 공정이 아니면 묻지 않고 true, 대상이면 [확인]을 눌러야 true.
export function confirmQcStamp(fromStep, confirmFn = globalThis.confirm) {
  if (!needsQcStampNotice(fromStep)) return true;
  return Boolean(confirmFn?.(`${QC_STAMP_TITLE}\n\n${QC_STAMP_MESSAGE}`));
}
