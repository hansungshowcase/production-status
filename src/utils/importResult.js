// CSV 가져오기 응답(api/import/csv.js)을 화면 배너로 바꾼다.
// 서버는 실패해도 200 + { imported, errors, errorDetails } 로 답한다.
// 실패 건수를 읽지 않으면 100행 전부 실패해도 "0건 등록 완료" 초록 배너가 뜬다.
export function summarizeCsvImportResult(result) {
  const payload = result || {};

  const toCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  };

  const imported = toCount(payload.imported ?? payload.inserted);
  const skipped = toCount(payload.skipped);

  // errors 는 개수(number)로 오지만, 배열로 오는 경우도 방어한다.
  const detailList = Array.isArray(payload.errorDetails)
    ? payload.errorDetails
    : Array.isArray(payload.errors)
      ? payload.errors
      : [];
  const failed = Array.isArray(payload.errors)
    ? payload.errors.length
    : Math.max(toCount(payload.errors), detailList.length);

  const details = detailList.map((detail) => String(detail));

  if (failed > 0 && imported === 0) {
    return {
      type: 'error',
      message: `등록된 주문이 없습니다. ${failed}건 실패`,
      imported,
      skipped,
      failed,
      details,
    };
  }

  if (failed > 0) {
    return {
      type: 'warning',
      message: `${imported}건 등록, ${failed}건 실패`,
      imported,
      skipped,
      failed,
      details,
    };
  }

  const skippedNote = skipped > 0 ? ` (중복 ${skipped}건 건너뜀)` : '';
  return {
    type: 'success',
    message: `${imported}건 등록 완료${skippedNote}`,
    imported,
    skipped,
    failed,
    details,
  };
}
