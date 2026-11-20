import { getKstToday, isCanonicalCalendarDate } from '../../utils/dateUtils.js';
import { parsePositiveIntegerQuantity } from '../../utils/quantity.js';
import { generateQrSvg } from '../../utils/qrSvg.js';
import {
  SHOWCASE_GUIDE_BRAND,
  DEFAULT_SHOWCASE_SETTING,
  LABEL_CORE_WARNINGS,
  buildGuideUrl,
  calculateWarrantyEndDate,
  formatDotDate,
  formatOrderNo,
  formatPresetSummary,
  getGuidePresetByKey,
  resolveGuidePresetKey,
} from '../../../shared/showcaseGuide.js';

export const LABEL_SIZE_STORAGE_KEY = 'hs_shipping_label_size_v1';

export const LABEL_SIZES = {
  '100x100': {
    key: '100x100',
    label: '100 × 100 mm',
    widthMm: 100,
    heightMm: 100,
    qrMm: 25,
  },
  '100x80': {
    key: '100x80',
    label: '100 × 80 mm',
    widthMm: 100,
    heightMm: 80,
    qrMm: 21,
  },
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeIsoDate(value) {
  if (!value) return null;
  const candidate = String(value).trim().slice(0, 10);
  return isCanonicalCalendarDate(candidate) ? candidate : null;
}

function clampCopies(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.min(20, Math.trunc(num)));
}

function buildCustomerSpecText(order) {
  const dimensions = [order?.width, order?.depth, order?.height].filter(Boolean).join('×');
  const sizeLabel = dimensions ? `${dimensions}mm` : '';
  const parts = [order?.door_type, sizeLabel, order?.color]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return parts.join(' · ') || '-';
}

export function getDefaultLabelCopies(order) {
  const qty = parsePositiveIntegerQuantity(order?.quantity);
  if (qty === null) return 1;
  return Math.max(1, Math.min(10, qty));
}

/**
 * 감열식 라벨 스티커 데이터 및 QR SVG를 구성한다.
 * 고객 노출 경계: 내부 분류가 담긴 원시 product_type은 절대 포함하지 않는다.
 */
export function buildShippingLabelData(order, options = {}) {
  const size = LABEL_SIZES[options.sizeKey] || LABEL_SIZES['100x100'];
  const allowGenericGuide = Boolean(options.allowGenericGuide);
  const token = String(options.token ?? order?.track_token ?? '').trim();
  if (!token && !allowGenericGuide) {
    throw new Error('라벨 QR 생성을 위한 주문 조회 토큰이 필요합니다.');
  }

  const rawPresetKey = options.presetKey !== undefined
    ? options.presetKey
    : (resolveGuidePresetKey(order?.product_type, order?.door_type) || '');
  const isExplicitDefault = String(rawPresetKey ?? '').trim() === DEFAULT_SHOWCASE_SETTING.key;
  const preset = isExplicitDefault ? null : getGuidePresetByKey(rawPresetKey);
  const presetKey = isExplicitDefault
    ? DEFAULT_SHOWCASE_SETTING.key
    : (preset ? preset.key : '');

  const shipDate = options.shipDate !== undefined
    ? normalizeIsoDate(options.shipDate)
    : (normalizeIsoDate(order?.ship_date)
      || normalizeIsoDate(order?.ship_scheduled_date)
      || getKstToday());

  const warrantyEndDate = calculateWarrantyEndDate(shipDate);
  const baseOrigin = options.baseOrigin || 'https://production-status.vercel.app';
  const guideUrl = buildGuideUrl(baseOrigin, token, presetKey);
  const qrSvg = generateQrSvg(guideUrl, {
    margin: 2,
    size: `${size.qrMm}mm`,
    ariaLabel: '한성쇼케이스 사용설명서 및 관리안내 QR 코드',
  });

  const copies = clampCopies(
    options.copies !== undefined ? options.copies : getDefaultLabelCopies(order),
  );

  return {
    size,
    orderNo: formatOrderNo(order) || '-',
    shipDate: shipDate || '',
    shipDateDisplay: shipDate ? formatDotDate(shipDate) : '-',
    warrantyEndDate: warrantyEndDate || '',
    warrantyDisplay: warrantyEndDate
      ? `${SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월 (~${formatDotDate(warrantyEndDate)})`
      : `출고일로부터 ${SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월`,
    specText: buildCustomerSpecText(order),
    presetKey,
    settingLabel: preset ? preset.label : DEFAULT_SHOWCASE_SETTING.label,
    settingSummary: formatPresetSummary(preset),
    brand: SHOWCASE_GUIDE_BRAND,
    warnings: LABEL_CORE_WARNINGS,
    copies,
    token,
    guideUrl,
    qrSvg,
  };
}

function buildSingleLabelMarkup(data, isLast) {
  const isCompact = data.size.key === '100x80';
  const warningRows = data.warnings
    .map((item) => {
      if (item.highlight) {
        return `<div class="warn-alert">${escapeHtml(item.labelText)}</div>`;
      }
      return `<div class="warn-line">${escapeHtml(item.labelText)}</div>`;
    })
    .join('');

  return `
    <section class="label-sheet${isCompact ? ' label-sheet--compact' : ''}${isLast ? ' label-sheet--last' : ''}">
      <div class="label-fit">
        <header class="label-head">
          <div class="label-brand"><strong>${escapeHtml(data.brand.en)}</strong> <span>${escapeHtml(data.brand.name)}</span></div>
          <div class="label-as">A/S ${escapeHtml(data.brand.asPhone)}</div>
        </header>

        <table class="label-meta">
          <colgroup>
            <col class="col-k1" />
            <col class="col-v1" />
            <col class="col-k2" />
            <col class="col-v2" />
          </colgroup>
          <tbody>
            <tr>
              <th>주문번호</th>
              <td class="mono">${escapeHtml(data.orderNo)}</td>
              <th class="ship-date-head">출고일자</th>
              <td class="mono ship-date-val">${escapeHtml(data.shipDateDisplay)}</td>
            </tr>
            <tr>
              <th>사양·규격</th>
              <td>${escapeHtml(data.specText)}</td>
              <th>무상 A/S</th>
              <td class="mono">${escapeHtml(data.warrantyDisplay)}</td>
            </tr>
            <tr>
              <th>권장세팅</th>
              <td colspan="3"><strong>${escapeHtml(data.settingLabel)}</strong> · ${escapeHtml(data.settingSummary)}</td>
            </tr>
          </tbody>
        </table>

        <div class="label-warns">
          ${warningRows}
        </div>

        <footer class="label-foot">
          <div class="label-qr">${data.qrSvg}</div>
          <div class="label-guide">
            <div class="label-guide-title">QR 스캔 · 사용설명서 &amp; 관리안내</div>
            <ul>
              <li>온도·제상 설정법 · 라지에이터 청소</li>
              <li>수평조절 · 무상 A/S · 후기 6만원 이벤트</li>
            </ul>
            <div class="label-guide-note">* 본 스티커 훼손 시 사후관리의 불이익이 있을 수 있습니다.</div>
          </div>
        </footer>
      </div>
    </section>
  `;
}

/**
 * 203 dpi 흑백 감열 라벨 프린터 전용 인쇄 HTML을 생성한다.
 */
export function buildShippingLabelPrintHtml(data) {
  const { widthMm, heightMm, qrMm } = data.size;
  const pages = Array.from({ length: data.copies }, (_, idx) => (
    buildSingleLabelMarkup(data, idx === data.copies - 1)
  )).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>한성쇼케이스 출고 라벨 (${escapeHtml(data.orderNo)})</title>
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label-sheet {
    width: ${widthMm}mm;
    height: ${(heightMm - 0.5).toFixed(1)}mm;
    padding: 2.5mm;
    overflow: hidden;
    background: #fff;
    page-break-after: always;
    break-after: page;
  }
  .label-sheet--compact {
    padding: 2mm 2.5mm;
  }
  .label-sheet--last {
    page-break-after: auto;
    break-after: auto;
  }
  .label-fit {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 1.4mm;
    transform-origin: top left;
    border: 1.5px solid #000;
    padding: 1.8mm;
  }
  .label-sheet--compact .label-fit {
    gap: 1mm;
    padding: 1.4mm;
  }
  .label-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2mm;
    background: #000;
    color: #fff;
    padding: 1.4mm 2.2mm;
    flex: 0 0 auto;
  }
  .label-sheet--compact .label-head {
    padding: 1mm 2mm;
  }
  .label-brand {
    font-size: 10.5pt;
    font-weight: 900;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .label-sheet--compact .label-brand {
    font-size: 9.5pt;
  }
  .label-as {
    font-size: 8.5pt;
    font-weight: 800;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .label-sheet--compact .label-as {
    font-size: 7.8pt;
  }
  .label-meta {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 7.7pt;
    line-height: 1.25;
    flex: 0 0 auto;
  }
  .label-sheet--compact .label-meta {
    font-size: 7.1pt;
    line-height: 1.2;
  }
  .label-meta col.col-k1 { width: 16mm; }
  .label-meta col.col-v1 { width: 30mm; }
  .label-meta col.col-k2 { width: 15.5mm; }
  .label-meta col.col-v2 { width: auto; }
  .label-sheet--compact .label-meta col.col-k1 { width: 15mm; }
  .label-sheet--compact .label-meta col.col-v1 { width: 33mm; }
  .label-sheet--compact .label-meta col.col-k2 { width: 15mm; }
  .label-meta th,
  .label-meta td {
    border: 1px solid #000;
    padding: 0.9mm 1.3mm;
    text-align: left;
    vertical-align: middle;
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  .label-sheet--compact .label-meta th,
  .label-sheet--compact .label-meta td {
    padding: 0.65mm 1.1mm;
  }
  .label-meta th {
    font-weight: 900;
    white-space: nowrap;
  }
  .label-meta td.mono {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .label-meta th.ship-date-head {
    background: #000;
    color: #fff;
  }
  .label-meta td.ship-date-val {
    font-size: 8.6pt;
    font-weight: 900;
    border-width: 1.5px;
    letter-spacing: -0.01em;
  }
  .label-sheet--compact .label-meta td.ship-date-val {
    font-size: 7.8pt;
  }
  .label-warns {
    border: 1.2px solid #000;
    flex: 0 0 auto;
  }
  .warn-alert {
    background: #000;
    color: #fff;
    font-size: 8.2pt;
    font-weight: 900;
    line-height: 1.25;
    padding: 1.1mm 1.5mm;
    letter-spacing: -0.02em;
  }
  .label-sheet--compact .warn-alert {
    font-size: 7.4pt;
    padding: 0.85mm 1.3mm;
  }
  .warn-line {
    font-size: 7.7pt;
    font-weight: 700;
    line-height: 1.3;
    padding: 0.85mm 1.5mm;
    border-top: 1px solid #000;
    letter-spacing: -0.02em;
  }
  .label-sheet--compact .warn-line {
    font-size: 6.9pt;
    line-height: 1.22;
    padding: 0.6mm 1.3mm;
  }
  .label-foot {
    display: flex;
    align-items: center;
    gap: 2.4mm;
    border: 1px solid #000;
    padding: 1.3mm 1.6mm;
    flex: 1 0 auto;
    min-height: ${qrMm + 3}mm;
  }
  .label-sheet--compact .label-foot {
    gap: 2mm;
    padding: 1mm 1.4mm;
  }
  .label-qr {
    flex: 0 0 ${qrMm}mm;
    width: ${qrMm}mm;
    height: ${qrMm}mm;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
  }
  .label-qr svg {
    display: block;
    width: ${qrMm}mm;
    height: ${qrMm}mm;
  }
  .label-guide {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1mm;
  }
  .label-guide-title {
    font-size: 9pt;
    font-weight: 900;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }
  .label-sheet--compact .label-guide-title {
    font-size: 8.2pt;
  }
  .label-guide ul {
    margin: 0;
    padding-left: 3.5mm;
    font-size: 7.4pt;
    font-weight: 700;
    line-height: 1.32;
  }
  .label-sheet--compact .label-guide ul {
    font-size: 6.8pt;
    line-height: 1.24;
  }
  .label-guide-note {
    font-size: 6.4pt;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.03em;
    word-break: keep-all;
  }
  .label-sheet--compact .label-guide-note {
    font-size: 6pt;
  }
  @media screen {
    body {
      background: #e2e8f0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .label-sheet {
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
    }
  }
</style>
</head>
<body>
${pages}
<script>
(function () {
  function fitAll() {
    var sheets = document.querySelectorAll('.label-sheet');
    for (var i = 0; i < sheets.length; i += 1) {
      var sheet = sheets[i];
      var fit = sheet.querySelector('.label-fit');
      if (!fit) continue;
      fit.style.width = '100%';
      fit.style.height = '100%';
      fit.style.transform = 'none';
      var style = window.getComputedStyle(sheet);
      var padTop = parseFloat(style.paddingTop) || 0;
      var padBottom = parseFloat(style.paddingBottom) || 0;
      var avail = sheet.clientHeight - padTop - padBottom - 1;
      var scale = 1;
      for (var step = 0; step < 4; step += 1) {
        fit.style.width = (100 / scale) + '%';
        fit.style.height = (100 / scale) + '%';
        fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
        var natural = fit.scrollHeight;
        if (avail <= 0 || natural * scale <= avail) break;
        var next = Math.max(0.75, (avail / natural) * 0.99);
        if (next >= scale) break;
        scale = next;
      }
    }
  }
  if (document.readyState === 'complete') fitAll();
  else window.addEventListener('load', fitAll);
  window.addEventListener('beforeprint', fitAll);
})();
</script>
</body>
</html>`;
}
