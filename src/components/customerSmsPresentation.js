const KST_DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const EMPTY_CUSTOMER_COUNTS = Object.freeze({
  total: 0,
  success: 0,
  failed: 0,
  queued: 0,
  sending: 0,
  uncertain: 0,
  skipped: 0,
  dry_run: 0,
  delivery: Object.freeze({ received: 0, failed: 0, pending: 0, unknown: 0, not_sent: 0, uncertain: 0 }),
});

export const EMPTY_PAGINATION = Object.freeze({ page: 1, page_size: 10, total_items: 0, total_pages: 0 });

export function todayInKst(value = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatCustomerSmsTime(value) {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '시간 정보 없음' : KST_DATE_TIME.format(date);
}

export function customerRequestTone(status) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'queued' || status === 'sending') return 'pending';
  if (status === 'skipped' || status === 'dry_run') return 'muted';
  return 'uncertain';
}

export function customerRequestLabel(status) {
  return ({
    success: '발송 요청 완료',
    failed: '발송 요청 실패',
    queued: '발송 대기',
    sending: '발송 처리 중',
    uncertain: '처리 결과 미확인',
    skipped: '발송 제외',
    dry_run: '시험 기록',
  })[status] || '요청 상태 미확인';
}

export function customerDeliveryTone(state) {
  if (state === 'received') return 'success';
  if (state === 'failed') return 'failed';
  if (state === 'pending') return 'pending';
  if (state === 'not_sent') return 'muted';
  return 'uncertain';
}

export function canSelectReviewCustomer(item, connection) {
  return item?.eligibility === 'ready' && connection?.canSend === true;
}
