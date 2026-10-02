import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('홈의 기존 진입 순서를 보존하며 자재 현황 보조 진입점을 추가한다', async () => {
  const source = await read('../src/pages/HomePage.jsx');
  const workerIndex = source.indexOf("navigate('/worker/select'");
  const salesIndex = source.indexOf("navigate('/sales')");
  const materialsIndex = source.indexOf("navigate('/materials')");
  const smsIndex = source.indexOf("navigate('/sms-history')");

  assert.ok(workerIndex >= 0 && salesIndex > workerIndex);
  assert.ok(materialsIndex > salesIndex && smsIndex > materialsIndex);
  assert.match(source, /자재 발주·입고 현황/);
  assert.match(source, /<svg[\s\S]*aria-hidden="true"/);
});

test('자재 페이지는 lazy route와 고정 최근범위, 검색 및 업체 상태 select를 제공한다', async () => {
  const [app, page] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/pages/MaterialsPage.jsx'),
  ]);

  assert.match(app, /const MaterialsPage = lazy\(\(\) => import\('\.\/pages\/MaterialsPage'\)\)/);
  assert.match(app, /path="\/materials" element=\{<MaterialsPage \/>\}/);
  assert.match(page, /업체별 자재 현황/);
  for (const label of ['최근 3개월', '출고완료 제외', '전체 업체', '미완료 포함', '확인필요 포함', '발주서 미완료', '자재발주 미완료', '자재입고 미완료']) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /<select[\s\S]*aria-label="업체 찾기"/);
  assert.match(page, /입고 기준일 = 납기 7일 전 · 미체크 = 완료 여부 미확인/);
  assert.match(page, /체크일: 시트 기록 날짜 · 연도 없으면 월\/일/);
  assert.match(page, /제외:\s*\{scope\.unknown_date_count/);
  assert.match(page, /납기 5일 이상 경과 \{scope\.overdue_due_count\}건/);
  assert.match(page, /유지:/);
  assert.match(page, /앱 출고 대조 미확인 \{unverifiedShippingCount\}건/);
  assert.match(page, /summaryLabel: '발주서'/);
  assert.match(page, /자재 단계별 확인 현황/);
  assert.match(page, /data-stage=\{stage\.key\}/);
  assert.match(page, /data-status=\{status\}/);
  assert.match(page, /segments\.map\(\(\[status, label, count\], index\) => \(/);
  assert.match(page, /materials-overview-count-unit/);
  const overviewStart = page.indexOf('<section className="materials-stage-overview"');
  const overviewEnd = page.indexOf('</section>', overviewStart);
  const overview = page.slice(overviewStart, overviewEnd);
  assert.match(overview, /summary\.total_orders === 0 && \([\s\S]*?<p className="materials-overview-empty">표시할 대상 없음<\/p>/);
  assert.match(page, /aria-pressed=\{selected\}/);
  assert.match(page, /선택됨/);
  assert.match(page, /미완료 포함 업체 보기/);
  assert.doesNotMatch(page, /입고 기준일 = 납기 7일 전<\/span>/);
  assert.match(page, /summarizeArrivalCheckNeeds\(filteredOrders, dueAnchor\)/);
  assert.match(page, /입고 체크 필요: 기준일 지난/);
  assert.match(page, /placeholder="업체 검색"/);
  assert.match(page, /앱 출고 대조 미확인/);
  assert.match(page, /우선 확인 주문 기준/);
  assert.match(page, /전체 입고 확인/);
  for (const heading of ['업체 \/ 건수', '우선 확인', '입고 기준일', '납기', '발주서', '자재발주', '자재입고', '상세']) {
    assert.match(page, new RegExp(heading));
  }
  assert.doesNotMatch(page, /DueResultBadges|materials-legend/);
  assert.doesNotMatch(page, /SHIPPING_FILTERS/);
  assert.doesNotMatch(page, /전체 출고/);
  assert.match(page, /갱신 실패 · 이전 조회 결과/);
  assert.match(page, /시트 조회/);
  assert.match(page, /aria-label=\{refreshing \? '시트 조회 중' : '시트 새로고침'\}/);
  assert.match(page, /const COMPANY_PAGE_SIZE = 40/);
  assert.match(page, /groupedCompanies\.slice\(0, visibleCompanyCount\)/);
  assert.match(page, /더 보기/);
  assert.match(page, /납기 5일 이상 경과 \{scope\.overdue_due_count\}건/);
  assert.match(page, /summary\.deadline_counts\.review_count > 0/);
  assert.match(page, /납기 확인필요 \{summary\.deadline_counts\.review_count\}건\{unverifiedShippingCount > 0 && ' · '\}/);
  assert.match(page, /대상 \{summary\.total_orders\}건/);
  assert.match(page, /aria-label="입고 일정 확인"/);
  assert.match(page, /aria-label="확인이 필요한 업체"/);
  assert.match(page, /확인할 수 없어 유지/);
  assert.match(page, /전체 완료/);
});

test('자재 화면은 44px 컨트롤과 모바일 카드, 상세 행, 줄바꿈 및 동작 감소 상태를 정의한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');

  assert.match(css, /min-height:\s*var\(--control-min-height\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.materials-order-row/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /font-size:\s*(?:10|11)px/);
  assert.match(css, /--materials-summary-columns:\s*minmax\(148px,[\s\S]*repeat\(3,[\s\S]*64px/);
  assert.match(css, /min-height:\s*120px/);
  assert.match(css, /--materials-muted:\s*#5d6d82/);
  assert.match(css, /\.materials-company-columns\s*\{[\s\S]*grid-template-columns:\s*var\(--materials-summary-columns\)/);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*\.materials-company-columns\s*\{\s*display:\s*none;\s*\}[\s\S]*\.materials-company-card > summary/);
  assert.match(css, /\.materials-company-heading\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /\.materials-stage-count\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /--materials-company-name-size:\s*18px/);
  assert.match(css, /--materials-key-date-size:\s*18px/);
  assert.match(css, /\.materials-status > span\s*\{\s*font-size:\s*14px/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.materials-company-priority\s*\{[^}]*flex-direction:\s*row;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.materials-company-priority strong,[\s\S]*\.materials-company-priority small\s*\{\s*word-break:\s*keep-all;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.materials-company-disclosure\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /minmax\(160px,\s*1\.15fr\)/);
  assert.match(css, /\.materials-order-due__date,[\s\S]*\.materials-order-due__deadline\s*\{\s*white-space:\s*nowrap/);
  assert.match(css, /\.materials-overview-button\s*\{[\s\S]*min-height:\s*68px/);
  assert.match(css, /\.materials-overview-count-unit\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.materials-overview-bar \[data-status='needs_review'\][\s\S]*background:\s*var\(--blue\)/);
  assert.match(css, /\.materials-stage-count \.materials-stage-check-date,[\s\S]*\.materials-order-row \.materials-check-date\s*\{[^}]*font-size:\s*14px/);
  assert.match(css, /\.materials-result__exceptions\s*\{[^}]*display:\s*grid;[^}]*gap:\s*2px/);
  assert.match(css, /\.materials-stage-overview\s*\{[^}]*margin-bottom:\s*var\(--space-1\);[^}]*padding:\s*var\(--space-2\);/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.materials-filters\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(180px, 1fr\)/);
  assert.doesNotMatch(css, /materials-stage-count--unchecked|materials-stage-count--complete/);
});

test('자재 화면에서만 스크롤 조상을 복구하고 업체 요약 포커스 링을 카드 안에 표시한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');

  assert.match(css, /html:has\(\.materials-page\),\s*body:has\(\.materials-page\),\s*#root:has\(\.materials-page\)\s*\{[\s\S]*overflow-x:\s*clip;[\s\S]*overflow-y:\s*visible;/);
  assert.match(css, /\.materials-company-card > summary:focus-visible\s*\{[\s\S]*outline-offset:\s*-3px;/);
});
