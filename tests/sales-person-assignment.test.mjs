import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const filesToCheck = [
  'src/constants.js',
  'src/pages/SalesMyPage.jsx',
  'src/pages/ocrConfirmationValidation.js',
];

test('sales management people are Shin Euncheol and Lee Junhyeong only', () => {
  for (const file of filesToCheck) {
    const source = readFileSync(file, 'utf8');

    assert.match(source, /신은철/, `${file} should include 신은철`);
    assert.match(source, /이준형/, `${file} should include 이준형`);
    assert.doesNotMatch(source, /이시아/, `${file} should not include 이시아`);
  }
});

test('Lee Junhyeong sales view includes existing Kim Bosu orders', () => {
  const source = readFileSync('src/pages/SalesMyPage.jsx', 'utf8');

  assert.match(source, /activePerson === '이준형'/, 'SalesMyPage should branch for 이준형');
  assert.match(source, /sales_person: '이준형'/, '이준형 view should include new 이준형 orders');
  assert.match(source, /sales_person: '김보수'/, '이준형 view should include existing 김보수 orders');
});
