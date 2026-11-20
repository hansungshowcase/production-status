import { getKstToday, isCanonicalCalendarDate } from '../../utils/dateUtils.js';
import { parsePositiveIntegerQuantity } from '../../utils/quantity.js';
import { generateQrSvg } from '../../utils/qrSvg.js';
import {
  SHOWCASE_GUIDE_BRAND,
  DEFAULT_SHOWCASE_SETTING,
  LABEL_CORE_WARNINGS,
  GUIDE_SECTIONS,
  buildGuideUrl,
  calculateWarrantyEndDate,
  formatDotDate,
  formatOrderNo,
  formatPresetSummary,
  getGuidePresetByKey,
  resolveGuidePresetKey,
} from '../../../shared/showcaseGuide.js';

export const LABEL_SIZE_STORAGE_KEY = 'hs_shipping_label_size_v2';

export const DEFAULT_LABEL_SIZE_KEY = '180x100';

export const LABEL_SIZES = {
  '180x100': {
    key: '180x100',
    label: '180 × 100 mm (명함 4장)',
    widthMm: 180,
    heightMm: 100,
    qrMm: 30,
  },
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
 * 통합 출고 라벨 스티커 데이터 및 QR SVG를 구성한다.
 * 고객 노출 경계: 내부 분류가 담긴 원시 product_type은 절대 포함하지 않는다.
 */
export function buildShippingLabelData(order, options = {}) {
  const size = (options.sizeKey && Object.hasOwn(LABEL_SIZES, options.sizeKey))
    ? LABEL_SIZES[options.sizeKey]
    : LABEL_SIZES[DEFAULT_LABEL_SIZE_KEY];
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
    sections: GUIDE_SECTIONS,
    copies,
    token,
    guideUrl,
    qrSvg,
  };
}

function buildCompactThermalMarkup(data, isLast) {
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
              <li>수평조절 · 무상 A/S · 리뷰 최대 14만원 이벤트</li>
            </ul>
            <div class="label-guide-note">* 본 스티커 훼손 시 사후관리의 불이익이 있을 수 있습니다.</div>
          </div>
        </footer>
      </div>
    </section>
  `;
}

function buildCompactThermalPrintHtml(data) {
  const { widthMm, heightMm, qrMm } = data.size;
  const pages = Array.from({ length: data.copies }, (_, idx) => (
    buildCompactThermalMarkup(data, idx === data.copies - 1)
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
      fit.style.height = 'auto';
      fit.style.minHeight = '0';
      fit.style.transform = 'none';
      var style = window.getComputedStyle(sheet);
      var padTop = parseFloat(style.paddingTop) || 0;
      var padBottom = parseFloat(style.paddingBottom) || 0;
      var avail = sheet.clientHeight - padTop - padBottom;
      if (avail <= 0) continue;
      var contentH = fit.scrollHeight;
      if (contentH <= avail + 0.5) {
        fit.style.height = '100%';
        continue;
      }
      var scale = 1;
      for (var step = 0; step < 4; step += 1) {
        fit.style.width = (100 / scale) + '%';
        fit.style.height = 'auto';
        fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
        var natural = fit.scrollHeight;
        if (natural * scale <= avail + 0.5) break;
        var next = Math.max(0.75, (avail / natural) * 0.99);
        if (Math.abs(next - scale) < 0.005 || next >= scale) break;
        scale = next;
      }
      fit.style.width = (100 / scale) + '%';
      fit.style.height = (100 / scale) + '%';
      fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
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

function buildPremiumPlateMarkup(data, idx, isLast) {
  const g1Id = `g1-${idx}`;
  const g2Id = `g2-${idx}`;
  return `
    <section class="plate-sheet${isLast ? ' plate-sheet--last' : ''}">
      <div class="plate-frame">
        <svg class="plate-guilloche" viewBox="0 0 180 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <pattern id="${g1Id}" width="24" height="6" patternUnits="userSpaceOnUse">
              <path d="M0 3 C4 0 8 0 12 3 S20 6 24 3" fill="none" stroke="#0F172A" stroke-width="0.22" opacity="0.11" />
            </pattern>
            <pattern id="${g2Id}" width="28" height="7" patternUnits="userSpaceOnUse" patternTransform="translate(5 1.5) rotate(-3)">
              <path d="M0 3.5 C4.5 0 9 0 14 3.5 S23.5 7 28 3.5" fill="none" stroke="#C8102E" stroke-width="0.18" opacity="0.09" />
            </pattern>
          </defs>
          <rect width="180" height="100" fill="url(#${g1Id})" />
          <rect width="180" height="100" fill="url(#${g2Id})" />
        </svg>

        <div class="plate-fit">
          <!-- ① 상단 정품 보증 헤더 바 -->
          <header class="plate-head">
            <div class="plate-brand-wrap">
              <div class="plate-emblem" aria-hidden="true">HS</div>
              <div>
                <div class="plate-brand-title"><strong>${escapeHtml(data.brand.en)}</strong> <span>(주)${escapeHtml(data.brand.name)}</span></div>
                <div class="plate-brand-sub">정품 출고 보증 · 사용설명서 및 사후관리 통합 명판</div>
              </div>
            </div>
            <div class="plate-head-right">
              <span class="plate-seal-badge">절대 제거·훼손 금지</span>
              <span class="plate-as">A/S ${escapeHtml(data.brand.asPhone)}</span>
            </div>
          </header>

          <!-- ② 출고일자 · 무상 A/S · 사양 · 권장세팅 스트립 -->
          <div class="plate-meta-strip">
            <div class="plate-meta-cell plate-meta-cell--ship">
              <div class="plate-meta-k">출고일자</div>
              <div class="plate-meta-v plate-meta-v--ship mono">${escapeHtml(data.shipDateDisplay)}</div>
            </div>
            <div class="plate-meta-cell">
              <div class="plate-meta-k">무상 A/S 보증 (출고일 기준)</div>
              <div class="plate-meta-v mono">${escapeHtml(data.warrantyDisplay)}</div>
            </div>
            <div class="plate-meta-cell">
              <div class="plate-meta-k">주문번호 · 사양/규격 <span class="mono">${escapeHtml(data.orderNo)}</span></div>
              <div class="plate-meta-v">${escapeHtml(data.specText)}</div>
            </div>
            <div class="plate-meta-cell">
              <div class="plate-meta-k">출하 권장세팅</div>
              <div class="plate-meta-v"><strong>${escapeHtml(data.settingLabel)}</strong> · ${escapeHtml(data.settingSummary)}</div>
            </div>
          </div>

          <!-- ③ 단독 코드 필수 경고 스트립 -->
          <div class="plate-power-banner">
            <span class="plate-power-lead">※ 반드시 단독 코드(콘센트) 사용 권장 ※</span>
            <span class="plate-power-desc">멀티탭·문어발 연결 금지 · 불이행에 따른 문제는 당사가 책임을 지지 않습니다.</span>
          </div>

          <!-- ④ 본문 2단 그리드: 좌측 전체 안내 / 우측 통합 QR + 후기 6만원 이벤트 -->
          <div class="plate-main">
            <div class="plate-left">
              <section class="plate-card">
                <div class="plate-card-title">필수 설치 · 사용 수칙</div>
                <ol class="plate-rules">
                  <li><strong>설치 후 2~3시간 뒤 전원 연결</strong> (운반 후 냉매 안정화)</li>
                  <li><strong>${escapeHtml(data.settingLabel)}(${escapeHtml(data.settingSummary)}) 유지 · 매장 마감 시 매장 냉장고 별도 보관</strong> <span>(진열용 냉장고 · 보관 시 손상 책임 불가)</span></li>
                  <li><strong>통풍구(하부 옆·뒷면) 막힘 금지 · 앞문형은 뒷벽면 15~20cm 거리 확보 필수</strong></li>
                  <li><strong>냉장 전용 (냉동 사용 금지)</strong> · 과도한 저온 설정 시 결빙·콤프레샤 고장 원인</li>
                  <li><strong>물받이통 제자리·누수 확인 및 주기적 물 비우기</strong></li>
                </ol>
              </section>

              <div class="plate-subgrid">
                <section class="plate-card">
                  <div class="plate-card-title">온도조절기 조작 · def 안내</div>
                  <div class="plate-mini-list">
                    <div><strong>버튼</strong> 전원(OFF 시 냉각정지, 조명·결로팬 별도) · 조명(LED) · 결로팬(평소 OFF, 비·습한 날 ON)</div>
                    <div><strong>온도</strong> 잠금 3초 해제 → □온도표시 → ▼▲ 맞춤 → 손 떼면 자동 잠금</div>
                    <div><strong>제상</strong> 해제 후 설정 1회(제상주기)·2회(제상시간) → ▼▲ 조절</div>
                    <div class="plate-def-line"><strong>def 표시</strong> 정상 제상 중이므로 그대로 두면 자동 복구됩니다.</div>
                  </div>
                </section>

                <section class="plate-card plate-card--clean">
                  <div class="plate-card-title plate-card-title--red">라지에이터 청소 (월 1회 이상)</div>
                  <div class="plate-mini-list">
                    <div>① 청소 전 <strong>전원 반드시 차단</strong> · ② <strong>장갑 착용</strong> 필수</div>
                    <div>③ 부드러운 브러시로 <strong>위·아래</strong> 방향 먼지 제거 <span>(핀 변형 주의)</span></div>
                    <div class="plate-clean-warn">먼지 막힘 시 온도상승·소음 · <strong>청소 불이행 고장은 보증기간(12개월) 내에도 유상 처리</strong>됩니다.</div>
                  </div>
                </section>
              </div>
            </div>

            <aside class="plate-right">
              <div class="plate-qr-head">QR 스캔 · 통합 웹 안내</div>
              <div class="plate-qr-box">${data.qrSvg}</div>
              <ul class="plate-qr-list">
                <li>10종 품목별 온도·제상 기준표</li>
                <li>상세 설명서 · 수평조절 · 청소법</li>
                <li>무상 A/S 조회 · 카톡/전화 문의</li>
              </ul>
              <div class="plate-event-badge">
                <div class="plate-event-main">리뷰 남기고 최대 14만원 받자!</div>
                <div class="plate-event-sub">블로그 7만 · 인스타·쓰레드 4만 · 구글 3만 (QR)</div>
              </div>
            </aside>
          </div>

          <!-- ⑤ 하단 정품 보증 · 임의 제거 금지 봉인 바 -->
          <footer class="plate-seal-foot">
            <strong>[정품 보증 라벨 · 임의 제거 금지]</strong>
            <span>본 스티커는 출고일자 확인 및 무상 A/S(출고일로부터 12개월) 기준입니다. 무단 제거·훼손 시 사후관리의 불이익을 받을 수 있습니다.</span>
          </footer>
        </div>
      </div>
    </section>
  `;
}

function buildPremiumPlatePrintHtml(data) {
  const { widthMm, heightMm, qrMm } = data.size;
  const pages = Array.from({ length: data.copies }, (_, idx) => (
    buildPremiumPlateMarkup(data, idx, idx === data.copies - 1)
  )).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>한성쇼케이스 정품 보증 통합 라벨 (${escapeHtml(data.orderNo)})</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  :root {
    --ink: #0F172A;
    --ink-mid: #334155;
    --crimson: #C8102E;
    --crimson-soft: #FDECEE;
    --emerald: #047857;
    --gold: #FACC15;
    --line: #CBD5E1;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: var(--ink);
    font-family: 'Pretendard', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', sans-serif;
    word-break: keep-all;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .plate-sheet {
    width: ${widthMm}mm;
    height: ${(heightMm - 0.5).toFixed(1)}mm;
    padding: 1.8mm;
    overflow: hidden;
    background: #fff;
    page-break-after: always;
    break-after: page;
  }
  .plate-sheet--last {
    page-break-after: auto;
    break-after: auto;
  }
  .plate-frame {
    position: relative;
    width: 100%;
    height: 100%;
    border: 1mm solid var(--ink);
    border-radius: 2mm;
    background: #fff;
    overflow: hidden;
    padding: 1.7mm 2mm;
  }
  .plate-frame::after {
    content: "";
    position: absolute;
    inset: 0.65mm;
    border: 0.35mm solid var(--crimson);
    border-radius: 1.3mm;
    pointer-events: none;
    z-index: 4;
  }
  .plate-guilloche {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
  }
  .plate-fit {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 1.15mm;
    transform-origin: top left;
  }
  .plate-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2mm;
    background: var(--ink);
    color: #fff;
    padding: 1.25mm 2.2mm;
    border-radius: 1mm;
    flex: 0 0 auto;
  }
  .plate-brand-wrap {
    display: flex;
    align-items: center;
    gap: 2mm;
    min-width: 0;
  }
  .plate-emblem {
    width: 6mm;
    height: 6mm;
    border-radius: 50%;
    background: var(--crimson);
    border: 0.4mm solid #fff;
    color: #fff;
    font-size: 7.4pt;
    font-weight: 900;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    letter-spacing: -0.02em;
  }
  .plate-brand-title {
    font-size: 9.8pt;
    font-weight: 900;
    line-height: 1.1;
    letter-spacing: -0.02em;
  }
  .plate-brand-title strong {
    color: var(--gold);
  }
  .plate-brand-sub {
    font-size: 6.4pt;
    font-weight: 600;
    color: #CBD5E1;
    line-height: 1.15;
    margin-top: 0.3mm;
  }
  .plate-head-right {
    display: flex;
    align-items: center;
    gap: 2mm;
    flex: 0 0 auto;
  }
  .plate-seal-badge {
    background: var(--crimson);
    color: #fff;
    border: 0.3mm solid rgba(255, 255, 255, 0.75);
    border-radius: 0.8mm;
    padding: 0.7mm 1.8mm;
    font-size: 7pt;
    font-weight: 900;
    white-space: nowrap;
  }
  .plate-as {
    font-size: 8.6pt;
    font-weight: 900;
    color: #fff;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .plate-meta-strip {
    display: grid;
    grid-template-columns: 31mm 39mm 51mm 1fr;
    border: 0.4mm solid var(--ink);
    border-radius: 0.8mm;
    overflow: hidden;
    background: #fff;
    flex: 0 0 auto;
  }
  .plate-meta-cell {
    padding: 0.9mm 1.6mm;
    border-left: 0.3mm solid var(--line);
    min-width: 0;
  }
  .plate-meta-cell:first-child {
    border-left: 0;
  }
  .plate-meta-cell--ship {
    background: var(--crimson-soft);
    border-left: 1.2mm solid var(--crimson) !important;
  }
  .plate-meta-k {
    font-size: 6pt;
    font-weight: 700;
    color: var(--ink-mid);
    line-height: 1.15;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1mm;
  }
  .plate-meta-cell--ship .plate-meta-k {
    color: var(--crimson);
    font-weight: 900;
  }
  .plate-meta-v {
    font-size: 7pt;
    font-weight: 800;
    color: var(--ink);
    line-height: 1.2;
    margin-top: 0.35mm;
    overflow-wrap: break-word;
  }
  .plate-meta-v--ship {
    font-size: 9.8pt;
    font-weight: 900;
    color: #991B1B;
    letter-spacing: -0.02em;
  }
  .mono {
    font-variant-numeric: tabular-nums;
  }
  .plate-power-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1.5mm;
    background: var(--crimson);
    color: #fff;
    padding: 0.95mm 2.2mm;
    border-radius: 0.8mm;
    flex: 0 0 auto;
  }
  .plate-power-lead {
    font-size: 8.1pt;
    font-weight: 900;
    color: var(--gold);
    white-space: nowrap;
  }
  .plate-power-desc {
    font-size: 7pt;
    font-weight: 800;
    color: #fff;
  }
  .plate-main {
    display: grid;
    grid-template-columns: 1fr 48mm;
    gap: 1.4mm;
    flex: 1 1 auto;
    min-height: 0;
  }
  .plate-left {
    display: flex;
    flex-direction: column;
    gap: 1.15mm;
    min-width: 0;
  }
  .plate-card {
    background: rgba(255, 255, 255, 0.94);
    border: 0.35mm solid var(--ink);
    border-radius: 0.9mm;
    padding: 1.1mm 1.7mm;
  }
  .plate-card--clean {
    border-color: var(--crimson);
  }
  .plate-card-title {
    font-size: 7pt;
    font-weight: 900;
    color: var(--ink);
    border-bottom: 0.28mm solid var(--line);
    padding-bottom: 0.45mm;
    margin-bottom: 0.65mm;
    letter-spacing: -0.02em;
  }
  .plate-card-title--red {
    color: var(--crimson);
  }
  .plate-rules {
    margin: 0;
    padding-left: 3.1mm;
    font-size: 6.35pt;
    line-height: 1.3;
    color: var(--ink);
  }
  .plate-rules li + li {
    margin-top: 0.28mm;
  }
  .plate-rules li span {
    color: var(--ink-mid);
    font-weight: 600;
  }
  .plate-subgrid {
    display: grid;
    grid-template-columns: 1.15fr 0.85fr;
    gap: 1.15mm;
    flex: 1 1 auto;
    min-height: 0;
  }
  .plate-mini-list {
    font-size: 6.1pt;
    line-height: 1.28;
    color: var(--ink);
    display: flex;
    flex-direction: column;
    gap: 0.42mm;
  }
  .plate-mini-list span {
    color: var(--ink-mid);
  }
  .plate-def-line {
    background: #EFF6FF;
    border-left: 0.7mm solid #1D4ED8;
    padding: 0.35mm 0.9mm;
    font-weight: 700;
    color: #1E3A8A;
  }
  .plate-clean-warn {
    background: var(--crimson-soft);
    border-left: 0.7mm solid var(--crimson);
    padding: 0.4mm 0.9mm;
    color: #7F1D1D;
  }
  .plate-right {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    gap: 0.8mm;
    border: 0.45mm solid var(--ink);
    border-radius: 0.9mm;
    background: rgba(255, 255, 255, 0.96);
    padding: 1.2mm 1.5mm;
    min-height: 0;
  }
  .plate-qr-head {
    font-size: 7.8pt;
    font-weight: 900;
    color: var(--ink);
    letter-spacing: -0.02em;
    text-align: center;
  }
  .plate-qr-box {
    width: ${qrMm}mm;
    height: ${qrMm}mm;
    padding: 0.5mm;
    border: 0.3mm solid var(--ink);
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }
  .plate-qr-box svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .plate-qr-list {
    margin: 0;
    padding-left: 2.8mm;
    font-size: 6.1pt;
    font-weight: 700;
    line-height: 1.28;
    color: var(--ink);
    align-self: stretch;
  }
  .plate-event-badge {
    width: 100%;
    background: var(--emerald);
    color: #fff;
    border-radius: 0.8mm;
    padding: 0.9mm 1.2mm;
    text-align: center;
  }
  .plate-event-main {
    font-size: 6.6pt;
    font-weight: 900;
    line-height: 1.15;
    letter-spacing: -0.02em;
  }
  .plate-event-sub {
    font-size: 5.7pt;
    font-weight: 700;
    opacity: 0.92;
    margin-top: 0.25mm;
  }
  .plate-seal-foot {
    display: flex;
    align-items: center;
    gap: 1.6mm;
    background: var(--crimson-soft);
    border: 0.35mm solid #FCA5A5;
    border-left: 1.4mm solid var(--crimson);
    border-radius: 0.7mm;
    padding: 0.75mm 1.8mm;
    font-size: 6.35pt;
    line-height: 1.2;
    color: var(--ink);
    flex: 0 0 auto;
  }
  .plate-seal-foot strong {
    color: var(--crimson);
    font-weight: 900;
    white-space: nowrap;
  }
  .plate-seal-foot span {
    font-weight: 700;
  }
  @media screen {
    body {
      background: #e2e8f0;
      padding: 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .plate-sheet {
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
    }
  }
</style>
</head>
<body>
${pages}
<script>
(function () {
  function fitAll() {
    var sheets = document.querySelectorAll('.plate-sheet');
    for (var i = 0; i < sheets.length; i += 1) {
      var sheet = sheets[i];
      var frame = sheet.querySelector('.plate-frame');
      var fit = sheet.querySelector('.plate-fit');
      if (!frame || !fit) continue;
      fit.style.width = '100%';
      fit.style.height = 'auto';
      fit.style.minHeight = '0';
      fit.style.transform = 'none';
      var style = window.getComputedStyle(frame);
      var padTop = parseFloat(style.paddingTop) || 0;
      var padBottom = parseFloat(style.paddingBottom) || 0;
      var avail = frame.clientHeight - padTop - padBottom;
      if (avail <= 0) continue;
      var contentH = fit.scrollHeight;
      if (contentH <= avail + 0.5) {
        fit.style.height = '100%';
        continue;
      }
      var scale = 1;
      for (var step = 0; step < 4; step += 1) {
        fit.style.width = (100 / scale) + '%';
        fit.style.height = 'auto';
        fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
        var natural = fit.scrollHeight;
        if (natural * scale <= avail + 0.5) break;
        var next = Math.max(0.78, (avail / natural) * 0.99);
        if (Math.abs(next - scale) < 0.005 || next >= scale) break;
        scale = next;
      }
      fit.style.width = (100 / scale) + '%';
      fit.style.height = (100 / scale) + '%';
      fit.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
    }
  }
  if (document.readyState === 'complete') fitAll();
  else window.addEventListener('load', fitAll);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitAll);
  }
  window.addEventListener('beforeprint', fitAll);
})();
</script>
</body>
</html>`;
}

/**
 * 선택된 라벨 규격에 맞춰 인쇄용 HTML을 생성한다.
 * - 180x100 (명함 4장 크기): 정품 출고 보증 프리미엄 통합 명판
 * - 100x100 / 100x80: 203 dpi 흑백 감열 라벨 프린터용 고대비 라벨
 */
export function buildShippingLabelPrintHtml(data) {
  if (data?.size?.key === '180x100') {
    return buildPremiumPlatePrintHtml(data);
  }
  return buildCompactThermalPrintHtml(data);
}
