import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homeSource = readFileSync(new URL('../src/pages/HomePage.jsx', import.meta.url), 'utf8');
const homeCss = readFileSync(new URL('../src/pages/HomePage.css', import.meta.url), 'utf8');

test('home page keeps existing entry actions while matching the wide dashboard layout', () => {
  assert.match(homeSource, /navigate\('\/orders\/new'\)/);
  assert.match(homeSource, /window\.open\(GOOGLE_SHEET_URL,\s*'_blank'/);
  assert.match(homeSource, /navigate\('\/worker\/select',\s*\{\s*state:\s*\{\s*redirectTo:\s*'\/worker\/station'/);
  assert.match(homeSource, /navigate\('\/sales'\)/);
  assert.match(homeSource, /home-card-copy/);
  assert.match(homeSource, /home-card-divider/);
});

test('home page visual layout uses the provided wide hero and horizontal role cards', () => {
  assert.match(homeCss, /\.home-header\s*\{[\s\S]*padding:\s*18px 44px 16px;/);
  assert.match(homeCss, /\.home-logo\s*\{[\s\S]*justify-content:\s*flex-start;/);
  assert.match(homeCss, /\.home-content\s*\{[\s\S]*flex:\s*1 1 auto;/);
  assert.match(homeCss, /\.home-content\s*\{[\s\S]*padding:\s*clamp\(10px,\s*1\.8dvh,\s*18px\)\s+clamp\(16px,\s*2\.2vw,\s*42px\)\s+clamp\(8px,\s*1\.2dvh,\s*12px\);/);
  assert.match(homeCss, /\.home-hero-order\s*\{[\s\S]*max-width:\s*1280px;/);
  assert.match(homeCss, /\.home-hero-order\s*\{[\s\S]*min-height:\s*clamp\(176px,\s*24dvh,\s*235px\);/);
  assert.match(homeCss, /\.home-sheet-link\s*\{[\s\S]*max-width:\s*1280px;/);
  assert.match(homeCss, /\.home-cards\s*\{[\s\S]*max-width:\s*1280px;/);
  assert.match(homeCss, /\.home-cards\s*\{[\s\S]*flex:\s*1 1 auto;/);
  assert.match(homeCss, /\.home-cards--row\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(homeCss, /\.home-card\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(homeCss, /\.home-card\s*\{[\s\S]*aspect-ratio:\s*1\s*\/\s*1;/);
  assert.match(homeCss, /\.home-card\s*\{[\s\S]*justify-content:\s*center;/);
  assert.match(homeCss, /\.home-card-divider\s*\{[\s\S]*display:\s*none;/);
  assert.match(homeCss, /\.home-footer\s*\{[\s\S]*display:\s*none;/);
});

test('home page fits role buttons on common mobile widths without cramped columns', () => {
  assert.match(homeCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.home-cards--row\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.match(homeCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*min-height:\s*104px;/);
  assert.match(homeCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*aspect-ratio:\s*auto;/);
  assert.match(homeCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*flex-direction:\s*row;/);
  assert.match(homeCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.home-hero-order\s*\{[\s\S]*min-height:\s*154px;/);
});

test('home page uses larger PC role buttons and removes bottom slack', () => {
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-content\s*\{[\s\S]*padding:\s*clamp\(10px,\s*1\.8dvh,\s*18px\)\s+clamp\(16px,\s*2\.2vw,\s*42px\)\s+0;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*min-height:\s*0;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*padding:\s*clamp\(22px,\s*2\.6dvh,\s*34px\);/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card-icon\s*\{[\s\S]*width:\s*128px;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card-icon\s*\{[\s\S]*height:\s*128px;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card-icon\s*\{[\s\S]*font-size:\s*72px;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.home-card-title\s*\{[\s\S]*font-size:\s*32px;/);
  assert.match(homeCss, /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*\.home-card\s*\{[\s\S]*min-height:\s*0;/);
});
