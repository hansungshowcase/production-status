// 금액 표시 공용 유틸. SalesOrderCard / shippingDocuments 에 같은 구현이 흩어져 있던 것을 모았다.
// 숫자면 천단위 구분 + '원', 이미 사람이 적어둔 문자열('현금 완납' 등)은 그대로 살린다.
export function formatMoney(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${Math.round(value).toLocaleString('ko-KR')}원`;
  }
  const raw = String(value).trim();
  if (!raw || raw === '-') return '';
  const number = Number(raw.replace(/,/g, '').replace(/[^\d.]/g, ''));
  if (Number.isFinite(number) && number > 0) {
    return `${Math.round(number).toLocaleString('ko-KR')}원`;
  }
  return raw;
}

// 잔금이 '없음(0원 또는 완납)'인지, '남아있음'인지, '기록 없음'인지 구분한다.
// balance 는 사람이 자유롭게 적는 칸이라 숫자가 아닐 수 있다.
export function balanceState(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { kind: 'unknown', text: '' };
  }
  const raw = String(value).trim();
  const digits = raw.replace(/,/g, '').replace(/[^\d.]/g, '');
  const number = digits === '' ? NaN : Number(digits);

  if (Number.isFinite(number)) {
    if (number <= 0) return { kind: 'none', text: '없음' };
    return { kind: 'due', text: formatMoney(number) };
  }
  // 숫자가 없는 메모: '완납', '결제완료' 처럼 정산이 끝났다는 표현이면 없음으로 본다.
  if (/완납|완료|없음|정산\s*끝/.test(raw)) return { kind: 'none', text: raw };
  return { kind: 'due', text: raw };
}
