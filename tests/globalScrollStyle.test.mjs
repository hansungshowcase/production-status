import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const globalCss = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

test('desktop pages allow normal wheel scrolling on the document', () => {
  const desktopOverride = /@media\s*\(\s*min-width:\s*768px\s*\)\s*{[\s\S]*?html,\s*body\s*{[\s\S]*?overscroll-behavior-y:\s*auto;[\s\S]*?}/;

  assert.equal(desktopOverride.test(globalCss), true);
});
