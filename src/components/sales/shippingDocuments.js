import { getVisibleOrderMemo } from '../../utils/orderText.js';
import { formatMoney, balanceState } from '../../utils/money.js';

const COMPANY = {
  businessNumber: '634-81-02042',
  name: '주식회사 한성쇼케이스그룹 / 이준형',
  phone: '031-986-2480',
  address: '경기도 김포시 대곶면 대명로 484번길 190',
};

function text(value, fallback = '-') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function formatDateShort(value) {
  if (!value) return '-';
  const raw = String(value).slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[2]}/${match[3]}`;
  const shortMatch = raw.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (shortMatch) return `${shortMatch[2]}/${shortMatch[3]}`;
  return raw;
}

function formatDateCompact(value) {
  if (!value) return '-';
  const raw = String(value).slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1].slice(2)}-${match[2]}-${match[3]}`;
  return raw;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildSpec(order) {
  return [order.width, order.depth, order.height].filter(Boolean).join(' x ');
}

// 납품내역서는 고객이 받아 서명하는 서류다. 품명(product_type)에는 '알앤에프냉동덧방'
// 처럼 거래처·내부 분류 표기가 들어가 있어 고객에게 보이면 안 된다(2026-08-19 요청).
// 고객 문자·조회 페이지에서 품명을 뺀 것과 같은 이유다.
// 출하지시서는 기사님과 공장이 보는 내부 서류라 품명을 그대로 둔다.
function buildItemName(order, type) {
  const parts = type === 'delivery'
    ? [order.door_type, order.color]
    : [order.product_type, order.door_type, order.color];
  return parts.filter(Boolean).join(' / ') || '-';
}

function buildDeliveryAddress(order) {
  return text(
    order.delivery_address
      || order.address
      || order.client_address
      || order.deliveryAddress
      || order.clientAddress
      || ''
  );
}

function buildFreightPayment(order) {
  return text(
    order.freight_payment
      || order.freightPayment
      || order.shipping_fee_payer
      || order.shippingFeePayer
      || order.delivery_fee_payer
      || order.deliveryFeePayer
      || order.transport_payment
      || order.transportPayment
      || order.freight
      || order['운임여부']
      || '',
    ''
  );
}

function buildLevelingGuide(type) {
  if (type === 'delivery') {
    return {
      title: '★★쇼케이스 수평 맞추는 방법★★',
      steps: [
        '1. 쇼케이스를 사용 하시고자 하는 위치에 놓으신 뒤\n쇼케이스 각 바퀴 옆에 위치한 조절좌볼트 4개를 아래쪽으로 최대한 내려\n흔들리지 않는지 확인합니다.\n(볼트는 왼쪽 방향으로 돌리면 내려옵니다)',
        '2. 휴대폰 수평계 어플을 사용하여 수평을 맞춰 줍니다.',
        '3. 그릴에 물을 부어 물통으로 잘 빠져 나오는지 확인 합니다.',
      ],
      showWarning: true,
      warning: '◎ 만약 물이 잘 빠져나오지 않는다면, 물통 반대쪽 조절좌 볼트 2개를 3mm 더 내려\n   쇼케이스가 물통쪽 보다 조금 올라가게하여 배수 되도록 합니다.\n   (볼트를 내릴수록 쇼케이스는 위로 올라갑니다)',
    };
  }

  return {
    title: '[ 운임 기사님 정보확인 ]',
    steps: [],
    showWarning: false,
    compact: true,
    driverInfo: '- 차량번호 :\n\n- 전화번호 :\n\n- 성함 :',
  };
}

export function buildShippingDocumentData(order, type, options = {}) {
  const baseDate = options.today || todayIso();
  const shipDate = order.ship_date || order.ship_scheduled_date || baseDate;
  const orderDate = order.order_date || baseDate;
  const quantity = order.quantity ?? 1;
  const visibleNote = getVisibleOrderMemo(order.notes)
    || getVisibleOrderMemo(order.remarks)
    || getVisibleOrderMemo(order.etc_notes);
  // 배송 서류의 잔금 줄은 항상 인쇄한다. 줄이 아예 없으면 기사님이 "받을 돈이 없는 것"인지
  // "적지 않은 것"인지 구분할 수 없다. 0원·완납은 '없음', 미기록은 '미기재'로 명시한다.
  const balance = balanceState(order.balance);
  const balanceText = balance.kind === 'unknown'
    ? '미기재'
    : (balance.kind === 'none' ? '없음' : balance.text);
  const balanceDue = balance.kind === 'due';
  const freightText = buildFreightPayment(order);

  return {
    type,
    title: type === 'delivery' ? '납 품 내 역 서' : '출 하 지 시 서',
    orderDate: formatDateCompact(orderDate),
    shipDate: formatDateCompact(shipDate),
    customerName: text(order.client_name),
    customerAddress: buildDeliveryAddress(order),
    customerPhone: text(order.phone),
    balanceText,
    balanceDue,
    freightText,
    company: COMPANY,
    rows: [
      {
        date: formatDateShort(shipDate),
        itemName: buildItemName(order, type),
        spec: buildSpec(order),
        quantity: text(quantity),
        note: text(visibleNote, ''),
        warehouse: type === 'shipping' ? '본사공장' : '',
      },
    ],
    levelingGuide: buildLevelingGuide(type),
    notice: type === 'delivery'
      ? [
          '본사에서 출고 되는 전 제품은 1인 기사 배송 기준이며 제품의 설치는 별도 입니다.',
          '설치에 대한 사전협의 없이 발생하는 배송상의 사고는 본사에서 절대 책임지지 않습니다.',
          '설치시 수평조절은 반드시 해주셔야 합니다. 수평조절 및 제품 배송이 끝난후에 발생되는 AS는 유상으로 처리 됩니다.',
        ]
      : [
          '배송중 유리 및 제품 파손시 손해배상을 청구 할 수 있으니 안전한 배송 부탁 드립니다.',
        ],
  };
}

function nl2br(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line || '&nbsp;')
    .join('<br />');
}

function buildGuideHtml(guide) {
  if (!guide) return '';
  const className = guide.compact ? 'guide guide--shipping' : 'guide';

  return `
    <div class="${className}">
      ${guide.intro ? `<div class="guide-intro">${nl2br(guide.intro)}</div>` : ''}
      <div class="guide-title">${guide.title}</div>
      ${(guide.steps || []).map((step) => `<div class="guide-step">${nl2br(step)}</div>`).join('')}
      ${guide.warning && guide.showWarning !== false ? `<div class="guide-warning">${nl2br(guide.warning)}</div>` : ''}
      ${guide.driverInfo ? `<div class="guide-driver">${nl2br(guide.driverInfo)}</div>` : ''}
    </div>
  `;
}

export function buildShippingDocumentPrintHtml(data) {
  // 실제로 채워지는 줄은 항상 1줄이고 나머지는 손으로 적는 빈 칸이다.
  // 출하지시서는 적요에 특이사항이 길게 들어가면 그 한 줄이 10줄 넘게 늘어나,
  // 빈 칸 8개까지 더해지면 2페이지로 넘어갔다. 빈 칸을 4개 줄여 한 장에 맞춘다.
  // (2026-08-18 요청)
  const rowCount = data.type === 'shipping' ? 5 : 7;
  const rows = Array.from({ length: rowCount }, (_, index) => data.rows[index] || {});
  const headers = data.type === 'shipping'
    ? ['월/일', '품목명', '규격', '수량', '적요', '창고명']
    : ['월/일', '품목명', '규격', '수량', '적요'];

  const bodyRows = rows.map((row) => `
    <tr>
      <td>${text(row.date, '')}</td>
      <td>${text(row.itemName, '')}</td>
      <td>${text(row.spec, '')}</td>
      <td>${text(row.quantity, '')}</td>
      <td>${text(row.note, '')}</td>
      ${data.type === 'shipping' ? `<td class="red">${text(row.warehouse, '')}</td>` : ''}
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${data.title}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; font-family: Arial, "Malgun Gothic", sans-serif; color: #000; }
  .doc { width: 190mm; height: 277mm; margin: 0 auto; padding: 0; background: #fff; display: flex; flex-direction: column; }
  .top { display: grid; grid-template-columns: 1fr 370px; gap: 16px; align-items: start; }
  h1 { margin: 6px 0 6px; text-align: center; letter-spacing: 10px; font-size: 28px; }
  .receiver, .supplier, table, .notice, .sign { border-collapse: collapse; width: 100%; }
  .receiver { border: 1px solid #111; margin-top: 8px; text-align: center; font-size: 13px; }
  .receiver td { padding: 5px 8px; }
  .supplier { border: 1px solid #111; font-size: 12px; }
  .supplier th, .supplier td { border: 1px solid #111; padding: 4px 6px; }
  .supplier .vertical { width: 22px; text-align: center; font-weight: 700; font-size: 13px; }
  .stamp { position: absolute; right: 12px; top: 26px; width: 70px; height: 70px; border: 3px solid #e11d48; border-radius: 50%; color: #e11d48; display: flex; align-items: center; justify-content: center; text-align: center; font-weight: 900; font-size: 13px; line-height: 1.05; transform: rotate(-14deg); }
  .supplier-wrap { position: relative; padding-top: 8px; }
  .items { margin-top: 24px; font-size: 14px; }
  .items th, .items td { border: 1px solid #999; height: 32px; text-align: center; padding: 3px 5px; }
  .items th { background: #f1f1f1; font-size: 14px; }
  .doc--shipping .items { margin-top: 18px; font-size: 15px; flex: 0 0 auto; }
  .doc--shipping .items th, .doc--shipping .items td { height: 36px; font-size: 15px; padding: 4px 6px; }
  .doc--shipping .items th:nth-child(3), .doc--shipping .items td:nth-child(3) { width: 24%; white-space: nowrap; }
  /* 적요 칸이 좁으면 특이사항 한 줄이 11줄로 접혀 그 행 하나가 페이지를 밀어낸다.
     품목명('진열 / 앞문 / 올스텐')은 짧으니 폭을 넘겨받아 적요를 넓히고, 글씨를
     한 단계 줄여 줄 수를 더 낮춘다. 내용을 자르는 게 아니라 접히는 횟수를 줄이는 것이다. */
  .doc--shipping .items th:nth-child(2), .doc--shipping .items td:nth-child(2) { width: 16%; }
  .doc--shipping .items th:nth-child(5), .doc--shipping .items td:nth-child(5) { width: 32%; }
  .doc--shipping .items td:nth-child(5) { font-size: 13px; line-height: 1.35; }
  .doc--shipping .items th:nth-child(4), .doc--shipping .items td:nth-child(4), .doc--shipping .items th:nth-child(6), .doc--shipping .items td:nth-child(6) { white-space: nowrap; }
  .items td:nth-child(5) { text-align: left; }
  .red { color: #ef4444; font-weight: 700; }
  .notice { margin-top: 6px; border: 1px solid #999; font-size: 13px; }
  .notice td { padding: 8px 10px; line-height: 1.75; }
  .balance { margin-top: 6px; border: 1px solid #999; font-size: 14px; font-weight: 800; }
  .balance th, .balance td { border: 1px solid #999; padding: 7px 10px; text-align: left; }
  .balance th { width: 28mm; background: #f8fafc; text-align: center; }
  .balance td.balance-due { color: #b91c1c; font-size: 16px; }
  .sign { margin-top: 6px; font-size: 13px; font-weight: 700; }
  .sign th, .sign td { border: 1px solid #999; height: 38px; }
  .sign th { width: 22mm; }
  .signature-cell { min-width: 42mm; }
  .guide { margin-top: 8px; border: 1px solid #999; padding: 14px 16px; font-size: 16px; line-height: 1.55; page-break-inside: avoid; break-inside: avoid; flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; }
  /* min-height 는 바닥값일 뿐이고 flex:1 이라 평소에는 남는 공간만큼 알아서 커진다.
     이 값이 실제로 걸리는 건 적요가 아주 길어 표가 페이지를 밀어낼 때뿐인데,
     그때 64mm 를 고집하면 문서가 2페이지로 넘어간다. 바닥을 낮춰 한 장을 지킨다. */
  .doc--shipping .guide--shipping { flex: 1 1 auto; min-height: 40mm; padding: 10px 14px; font-size: 14px; justify-content: flex-start; }
  .guide-title { margin: 2px 0 16px; font-size: 20px; font-weight: 900; }
  .guide-intro { margin-bottom: 18px; font-size: 18px; font-weight: 800; }
  .guide-step { margin: 0 0 16px; }
  .guide-warning { margin-top: 14px; font-weight: 700; }
  .guide-driver { margin-top: 18px; font-size: 15px; line-height: 1.75; }
  .doc--shipping .guide--shipping .guide-title { margin: 0 0 8px; font-size: 16px; }
  .doc--shipping .guide--shipping .guide-driver { margin-top: 6px; font-size: 13px; line-height: 1.45; }
  @media print { .doc { margin: 0 auto; } }
  /* 한 장 보장용 축소 장치. .fit 이 실제 내용을 담고, 넘칠 때만 통째로 줄여 A4 한 장에 맞춘다.
     .doc 의 overflow:hidden 은 마지막 안전판일 뿐이다 — 아래 스크립트가 먼저 맞추므로
     정상 경로에서는 잘려나가는 내용이 없다. */
  .doc { overflow: hidden; }
  .fit { display: flex; flex-direction: column; width: 100%; height: 100%; transform-origin: top left; }
</style>
</head>
<body>
  <div class="doc${data.type === 'shipping' ? ' doc--shipping' : ''}">
    <div class="fit">
    <div class="top">
      <div>
        <h1>${data.title}</h1>
        <table class="receiver">
          <tr><td><strong>${data.customerName}</strong></td></tr>
          <tr><td>연락처 ${data.customerPhone}</td></tr>
          <tr><td>납품주소 ${data.customerAddress}</td></tr>
        </table>
      </div>
      <div class="supplier-wrap">
        <div class="stamp">한성<br />쇼케이스<br />그룹</div>
        <table class="supplier">
          <tr>
            <th class="vertical" rowspan="4">공<br />급<br />자</th>
            <th>주문일</th><td>${data.orderDate}</td><th>출고일</th><td>${data.shipDate}</td>
          </tr>
          <tr><th>사업자번호</th><td>${data.company.businessNumber}</td><th>전화</th><td>${data.company.phone}</td></tr>
          <tr><th>상호/성명</th><td colspan="3">${data.company.name}</td></tr>
          <tr><th>주소</th><td colspan="3">${data.company.address}</td></tr>
        </table>
      </div>
    </div>
    <table class="items">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <table class="notice"><tr><td>${data.notice.map((line) => `※ ${line}`).join('<br />')}</td></tr></table>
    <table class="balance">
      <tr><th>잔금내역</th><td${data.balanceDue ? ' class="balance-due"' : ''}>${data.balanceText}</td></tr>
      ${data.freightText ? `<tr><th>운임여부</th><td>${data.freightText}</td></tr>` : ''}
    </table>
    ${data.type === 'shipping'
      ? '<table class="sign"><tr><th>배송담당자</th><td class="signature-cell"></td></tr></table>'
      : '<table class="sign"><tr><th>배송담당자</th><td class="signature-cell"></td><th>수취인</th><td class="signature-cell"></td><th>수평확인완료</th><td class="signature-cell"></td></tr></table>'}
    ${buildGuideHtml(data.levelingGuide)}
    </div>
  </div>
<script>
// 항상 A4 한 장으로 인쇄되게 한다.
// 칸 수를 줄이고 적요 폭을 넓혀도, 글꼴이나 프린터 여백이 조금만 달라지면 기사 안내문
// 블록이 통째로 2페이지로 밀려났다(page-break-inside: avoid 라 쪼개지지 않는다).
// 그래서 남는 높이를 재서, 넘칠 때만 문서 전체를 줄인다. 내용은 그대로 두고 크기만 줄인다.
// 폭도 함께 넓혀 두면 축소 후 글씨가 페이지를 꽉 채우고, 적요가 접히는 줄 수도 줄어든다.
(function () {
  var doc = document.querySelector('.doc');
  var fit = document.querySelector('.fit');
  if (!doc || !fit) return;

  function apply() {
    var limit = doc.clientHeight;
    if (!limit) return;
    var scale = 1;
    // 폭을 넓히면 줄바꿈이 줄어 높이가 다시 바뀐다. 몇 번 반복해 수렴시킨다.
    for (var i = 0; i < 8; i += 1) {
      fit.style.width = (100 / scale) + '%';
      fit.style.height = (100 / scale) + '%';
      fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
      var natural = fit.scrollHeight; // transform 은 레이아웃에 영향을 주지 않는다
      if (natural * scale <= limit + 1) return;
      // 0.6 미만으로는 줄이지 않는다. 그보다 작아지면 기사님이 읽지 못한다.
      var next = Math.max(0.6, (limit / natural) * 0.995);
      if (next >= scale) break;
      scale = next;
    }
  }

  if (document.readyState === 'complete') apply();
  else window.addEventListener('load', apply);
  // 인쇄 직전에 한 번 더. 인쇄 대화상자의 용지·여백 설정이 높이를 바꾼다.
  window.addEventListener('beforeprint', apply);
})();
</script>
</body>
</html>`;
}
