import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/pages/WorkerSelectPage.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/pages/WorkerSelectPage.jsx', import.meta.url), 'utf8');
const rule = name => css.match(new RegExp(`\\.worker-select-page__work-order-${name}\\s*\\{([^}]+)\\}`))?.[1] || '';

test('work-order result cards retain their content height inside the scrolling list', () => {
  assert.match(rule('item'), /flex-shrink:\s*0\s*;/);
  assert.match(rule('results'), /box-sizing:\s*border-box\s*;/);
  assert.match(rule('results'), /max-height:\s*min\(340px,\s*var\(--work-order-results-available-height,\s*340px\)\)\s*;/);
  assert.match(rule('results'), /overflow-y:\s*auto\s*;/);
  assert.match(css, /@media\s*\(max-width:\s*480px\)[\s\S]*max-height:\s*min\(300px,\s*var\(--work-order-results-available-height,\s*300px\)\)\s*;/);
});

test('work-order badges share the client row instead of creating a clipped third row', () => {
  assert.match(rule('step'), /grid-column:\s*2\s*;/);
  assert.match(rule('step'), /grid-row:\s*1\s*;/);
  assert.match(rule('meta'), /grid-column:\s*1\s*\/\s*-1\s*;/);
  assert.match(rule('client'), /text-overflow:\s*ellipsis\s*;/);
  assert.match(rule('meta'), /text-overflow:\s*ellipsis\s*;/);
});

test('work-order result height follows the viewport and an overlapping install prompt', () => {
  assert.match(source, /useLayoutEffect\s*\(/);
  assert.match(source, /new ResizeObserver\(/);
  assert.match(source, /resizeObserver\.observe\(searchRegion\)/);
  assert.match(source, /resizeObserver\.observe\(resultsList\)/);
  assert.match(source, /resizeObserver\.observe\(banner\)/);
  assert.match(source, /new MutationObserver\(reconnectOverlays\)/);
  assert.match(source, /appRoot\.querySelector\('\.install-prompt'\)/);
  assert.match(source, /mutationObserver\.observe\(appRoot,\s*\{ childList: true, subtree: true \}\)/);
  assert.match(source, /visualViewport\?\.addEventListener\('resize', scheduleMeasurement\)/);
  assert.match(source, /visualViewport\?\.addEventListener\('scroll', scheduleMeasurement\)/);
  assert.match(source, /document\.addEventListener\('scroll', scheduleMeasurement, true\)/);
  assert.match(source, /banner\.addEventListener\('animationend', scheduleMeasurement\)/);
  assert.match(source, /requestAnimationFrame\(measureAvailableHeight\)/);
  assert.match(source, /Math\.min\(viewportBottom, bannerRect\.top - 8\)/);
  assert.doesNotMatch(source, /Math\.max\([^,]+,\s*64\)/);
});

test('work-order results open upward only when one rendered row cannot fit below', () => {
  assert.match(source, /const anchorRect = searchRegion\.getBoundingClientRect\(\)/);
  assert.match(source, /const belowStart = anchorRect\.bottom \+ 8/);
  assert.match(source, /const aboveEnd = anchorRect\.top - 8/);
  assert.match(source, /const minimumListHeight = Math\.max\(\.\.\.rowHeights\) \+ listChromeHeight/);
  assert.match(source, /belowAvailableHeight >= minimumListHeight/);
  assert.match(source, /aboveAvailableHeight >= minimumListHeight/);
  assert.match(source, /aboveAvailableHeight > belowAvailableHeight/);
  assert.match(source, /bannerRect\.top < aboveEnd && bannerRect\.bottom > aboveStart/);
  assert.match(source, /classList\.toggle\('worker-select-page__work-order-results--up', opensUpward\)/);
  assert.match(css, /\.worker-select-page__work-order-results--up\s*\{[^}]*top:\s*auto\s*;[^}]*bottom:\s*calc\(100% \+ 8px\)\s*;/s);
  assert.doesNotMatch(source, /scrollIntoView|window\.scroll|scrollTo\s*\(/);
});

test('upward results start below a visible overlapping mobile header', () => {
  assert.match(source, /appRoot\.querySelector\('\.mobile-header-bar'\)/);
  assert.match(source, /resizeObserver\.observe\(mobileHeader\)/);
  assert.match(source, /headerAttributeObserver\.observe\(mobileHeader,\s*\{[\s\S]*attributeFilter:\s*\['class', 'style', 'hidden'\]/);
  assert.match(source, /headerRect\.right > anchorRect\.left && headerRect\.left < anchorRect\.right/);
  assert.match(source, /headerRect\.top < aboveEnd && headerRect\.bottom > viewportTop/);
  assert.match(source, /Number\.parseFloat\(headerStyle\.opacity\) > 0/);
  assert.match(source, /aboveStart = Math\.max\(aboveStart, headerRect\.bottom \+ 8\)/);
  assert.match(source, /mobileHeader\.addEventListener\('transitionend', scheduleMeasurement\)/);
  assert.match(source, /mobileHeader\.addEventListener\('animationend', scheduleMeasurement\)/);
  assert.match(source, /headerAttributeObserver\.disconnect\(\)/);
  assert.match(source, /resizeObserver\.unobserve\(mobileHeader\)/);
  assert.doesNotMatch(source, /mutationObserver\.observe\(appRoot,\s*\{[^}]*attributes:/);
});
