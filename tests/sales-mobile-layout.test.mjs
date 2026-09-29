import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/pages/SalesMyPage.css', import.meta.url), 'utf8');
const summaryCss = readFileSync(new URL('../src/components/sales/SalesSummaryCards.css', import.meta.url), 'utf8');
const mobileSection = css
  .split('/* ─── Mobile (< 768px) ───────────────────────────────── */')[1]
  ?.split('/* ─── Tiny phones (< 480px) ──────────────────────────── */')[0] || '';

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return mobileSection.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

test('mobile status filters keep the first tab reachable when the row overflows', () => {
  const rule = ruleBody('.sales-my-page__filter-bar');
  assert.match(rule, /justify-content:\s*flex-start\s*;/);
});

test('mobile viewing controls stay within the header and wrap instead of clipping', () => {
  const rule = ruleBody('.sales-my-page__header-right');
  assert.match(rule, /width:\s*100%\s*;/);
  assert.match(rule, /min-width:\s*0\s*;/);
  assert.match(rule, /flex:\s*1\s+1\s+100%\s*;/);
  assert.match(rule, /justify-content:\s*flex-start\s*;/);
});

test('mobile fixes preserve touch targets and desktop filter centering', () => {
  assert.match(css, /\.sales-my-page__filter-btn\s*\{[\s\S]*?min-height:\s*44px\s*;/);
  assert.match(css, /\.sales-my-page__filter-bar\s*\{[\s\S]*?justify-content:\s*center\s*;/);
});

test('tablet summary cards avoid forced Korean syllable wrapping', () => {
  assert.match(summaryCss, /\.sales-summary-card__label\s*\{[\s\S]*?white-space:\s*nowrap\s*;/);
  assert.match(
    summaryCss,
    /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.sales-summary-cards\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*;/,
  );
});
