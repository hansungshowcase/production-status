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
  assert.match(page, /data-stage=\{stage\.key\}/);
  assert.match(page, /data-status=\{status\}/);
  assert.match(page, /segments\.map\(\(\[status, , count\]\) => \(/);
  assert.match(page, /aria-pressed=\{selected\}/);
  assert.match(page, /선택됨/);
  assert.match(page, /미완료 포함 업체 보기/);
  assert.doesNotMatch(page, /입고 기준일 = 납기 7일 전<\/span>/);
  assert.match(page, /summarizeArrivalCheckNeeds\(filteredOrders, dueAnchor\)/);
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
  assert.match(page, /className="materials-result__unit">\{summary\.total_companies\}개 업체/);
  assert.match(page, /className="materials-result__separator" aria-hidden="true"> · <\/span>/);
  assert.match(page, /className="materials-result__unit">대상 \{summary\.total_orders\}건/);
  assert.match(page, /className="materials-overview-total">\s*<strong className="materials-overview-total__number">\{incompleteCount\}<\/strong>\s*<span className="materials-overview-total__unit">건<\/span>/);
  assert.match(page, /aria-label="입고 일정 확인"/);
  assert.match(page, /aria-label="확인이 필요한 업체"/);
  assert.match(page, /확인할 수 없어 유지/);
  assert.match(page, /전체 완료/);
});

test('자재 화면은 44px 컨트롤과 모바일 카드, 상세 행, 줄바꿈 및 동작 감소 상태를 정의한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');
  const page = await read('../src/pages/MaterialsPage.jsx');

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
  assert.match(css, /\.materials-overview-button\s*\{[\s\S]*min-height:\s*116px/);
  assert.match(css, /\.materials-stage-segments\s*\{[\s\S]*transform-origin:\s*left/);
  assert.match(css, /\.materials-overview-bar \[data-status='needs_review'\][\s\S]*background:\s*var\(--blue\)/);
  assert.match(css, /\.materials-stage-count \.materials-stage-check-date,[\s\S]*\.materials-order-row \.materials-check-date\s*\{[^}]*font-size:\s*14px/);
  assert.match(css, /\.materials-result__exceptions\s*\{[^}]*display:\s*grid;[^}]*gap:\s*2px/);
  assert.match(css, /\.materials-result__unit\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.materials-result-row\s*\{[\s\S]*margin-bottom:\s*0;/);
  assert.match(css, /@media\s*\(max-width:\s*360px\)[\s\S]*\.materials-overview-button\s*\{[\s\S]*padding-right:\s*0;[\s\S]*padding-left:\s*0;/);
  assert.match(css, /\.materials-overview-total\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*align-items:\s*baseline;[\s\S]*gap:\s*0;[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /\.materials-overview-total__unit\s*\{[^}]*font-size:\s*14px/);
  assert.match(css, /\.materials-stage-overview\s*\{[^}]*margin-bottom:\s*var\(--space-1\);[^}]*padding:\s*var\(--space-1\);/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.materials-filters\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(180px, 1fr\)/);
  assert.match(page, /function stageCountTone\(\{ target_order_count: N, complete_count: C, unchecked_count: U, needs_review_count: R \}\)/);
  assert.match(page, /if \(N > 0 && C === N\) return 'complete';/);
  assert.match(page, /if \(R > 0\) return 'review';/);
  assert.match(page, /if \(C > 0 && U > 0\) return 'mixed';/);
  assert.match(page, /materials-stage-count--\$\{tone\}/);
  for (const token of [
    '--materials-complete-ink: #065F46',
    '--materials-complete-bg: #ECFDF5',
    '--materials-complete-accent: #047857',
    '--materials-unchecked-ink: #475569',
    '--materials-unchecked-bg: #F1F5F9',
    '--materials-unchecked-accent: #64748B',
    '--materials-review-ink: #1E40AF',
    '--materials-review-bg: #EFF6FF',
    '--materials-review-accent: #2563EB',
    '--materials-overdue-ink: #991B1B',
    '--materials-overdue-bg: #FEF2F2',
    '--materials-overdue-accent: #B91C1C',
    '--materials-today-ink: #9A3412',
    '--materials-today-bg: #FFF7ED',
    '--materials-today-accent: #C2410C',
    '--materials-selection-ink: #1E40AF',
    '--materials-selection-bg: #EFF6FF',
    '--materials-selection-accent: #1D4ED8',
    '--materials-cell-radius: 6px',
    '--materials-cell-padding: 4px',
  ]) assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(css, /@keyframes materials-stage-segments-reveal[\s\S]*scaleX\(0\)[\s\S]*scaleX\(1\)/);
  assert.match(css, /@keyframes materials-overview-selection[\s\S]*opacity: \.45[\s\S]*scale\(\.98\)[\s\S]*opacity: 1[\s\S]*scale\(1\)/);
  assert.doesNotMatch(css, /materials-overview-enter/);
  assert.match(css, /materials-overview-button:active\s*\{[^}]*transform: scale\(\.985\)/);
  assert.match(css, /\.materials-page,\s*\.materials-page \*,\s*\.materials-page \*::before,\s*\.materials-page \*::after\s*\{[\s\S]*animation: none !important;[\s\S]*transition: none !important;/);
  assert.match(css, /\.materials-overview-button:active\s*\{\s*transform: none;/);
});

test('자재 화면에서만 스크롤 조상을 복구하고 업체 요약 포커스 링을 카드 안에 표시한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');

  assert.match(css, /html:has\(\.materials-page\),\s*body:has\(\.materials-page\),\s*#root:has\(\.materials-page\)\s*\{[\s\S]*overflow-x:\s*clip;[\s\S]*overflow-y:\s*visible;/);
  assert.match(css, /\.materials-company-card > summary:focus-visible\s*\{[\s\S]*outline-offset:\s*-3px;/);
});

test('새 Materials urgency summary와 단계별 M 보드를 구조적으로 제공한다', async () => {
  const [page, css, design] = await Promise.all([
    read('../src/pages/MaterialsPage.jsx'),
    read('../src/pages/MaterialsPage.css'),
    read('../DESIGN.md'),
  ]);

  assert.match(page, /deriveMaterialsPresentation\(summary, arrivalCheckNeeds\)/);
  assert.match(page, /입고 기록 우선 확인/);
  assert.match(page, /기준일 지남/);
  assert.match(page, /오늘 기준일/);
  assert.match(page, /일정·원본 확인/);
  assert.match(page, /모든 단계 완료 기록 확인/);
  assert.match(page, /검색 또는 업체 상태를 변경해 주세요/);
  assert.match(page, /입고 미확인 업체 보기 →/);
  assert.match(page, /단계별 완료 미확인 · 업체 보기/);
  assert.match(page, /index: 1/);
  assert.match(page, /index: 2/);
  assert.match(page, /index: 3/);
  assert.match(page, /materials-overview-button--complete/);
  assert.match(page, /materials-overview-button--empty/);
  const urgencyIndex = page.indexOf('materials-urgency materials-urgency--');
  const stageIndex = page.indexOf('className="materials-stage-overview"');
  const filtersIndex = page.indexOf('className="materials-filters"');
  const disclosureIndex = page.indexOf('className="materials-scope-details"');
  const companiesIndex = page.indexOf('className="materials-company-groups"');
  assert.ok(urgencyIndex >= 0 && stageIndex > urgencyIndex && filtersIndex > stageIndex);
  assert.ok(disclosureIndex > filtersIndex && companiesIndex > disclosureIndex);
  assert.match(page, /incomplete_count/);
  assert.match(page, /미체크 \$\{counts\.unchecked_count\}/);
  assert.match(page, /확인필요 \$\{counts\.needs_review_count\}/);
  assert.match(page, /최다/);
  assert.match(page, /단계 간 중복 집계/);
  assert.match(page, /조회 범위·제외 내역/);
  assert.match(page, /onClick=\{\(\) => selectStage\('arrival'\)\}/);
  assert.doesNotMatch(page, /자재 단계별 확인 현황/);
  assert.doesNotMatch(page, /입고 체크 필요: 기준일 지난/);
  assert.match(css, /--materials-urgency-size:\s*32px/);
  assert.match(css, /--materials-stage-total-size:\s*28px/);
  assert.match(css, /--materials-motion-reveal:\s*560ms/);
  assert.match(css, /--materials-motion-status:\s*240ms/);
  assert.match(css, /scaleX\(0\)/);
  assert.match(css, /transform-origin:\s*left/);
  assert.match(css, /materials-stage-segments/);
  assert.match(css, /\.materials-overview-button--complete/);
  assert.match(css, /\.materials-urgency--complete/);
  assert.match(design, /입고 기록 우선 확인/);
  assert.match(design, /--materials-motion-reveal: 560ms/);
});
