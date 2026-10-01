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

test('자재 페이지는 lazy route와 기본 출고 제외, 검색 및 모든 자재 필터를 제공한다', async () => {
  const [app, page] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/pages/MaterialsPage.jsx'),
  ]);

  assert.match(app, /const MaterialsPage = lazy\(\(\) => import\('\.\/pages\/MaterialsPage'\)\)/);
  assert.match(app, /path="\/materials" element=\{<MaterialsPage \/>\}/);
  assert.match(page, /업체별 자재 현황/);
  assert.match(page, /useState\('exclude_shipped'\)/);
  for (const label of ['출고완료 제외', '전체 출고', '출고완료', '전체', '미완료 포함', '확인필요', '발주서 수취 미완료', '자재 발주 미완료', '자재 입고 미완료']) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /갱신 실패 · 이전 조회 결과/);
  assert.match(page, /시트 조회/);
  assert.match(page, /aria-label=\{refreshing \? '시트 조회 중' : '시트 새로고침'\}/);
  assert.match(page, /const COMPANY_PAGE_SIZE = 40/);
  assert.match(page, /summary\.companies\.slice\(0, visibleCompanyCount\)/);
  assert.match(page, /더 보기/);
});

test('자재 화면은 44px 컨트롤과 모바일 카드, 상세 행, 줄바꿈 및 동작 감소 상태를 정의한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');

  assert.match(css, /min-height:\s*var\(--control-min-height\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.materials-order-row/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /font-size:\s*(?:10|11)px/);
});

test('자재 화면에서만 스크롤 조상을 복구하고 업체 요약 포커스 링을 카드 안에 표시한다', async () => {
  const css = await read('../src/pages/MaterialsPage.css');

  assert.match(css, /html:has\(\.materials-page\),\s*body:has\(\.materials-page\),\s*#root:has\(\.materials-page\)\s*\{[\s\S]*overflow-x:\s*clip;[\s\S]*overflow-y:\s*visible;/);
  assert.match(css, /\.materials-company-card > summary:focus-visible\s*\{[\s\S]*outline-offset:\s*-3px;/);
});
