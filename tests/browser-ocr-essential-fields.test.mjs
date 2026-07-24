import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractBrowserOcrEssentialFields } from '../src/pages/browserOcrEssentialFields.js';

test('browser OCR essential parser returns canonical assignee and current-year due date from labeled Korean text', () => {
  // Given: browser OCR text with the two required labels.
  const rawText = '\uB2F4\uB2F9\uC790: \uC774\uC900\uD615\n\uB0A9\uAE30\uC77C\uC790: 07\uC6D4 22\uC77C';

  // When: the essential values are extracted.
  const fields = extractBrowserOcrEssentialFields(rawText);

  // Then: the assignee and due date are safe for the order form.
  assert.deepEqual(fields, {
    sales_person: '\uC774\uC900\uD615',
    due_date: `${new Date().getFullYear()}-07-22`,
  });
});

test('browser OCR essential parser maps legacy manager aliases to canonical assignees', () => {
  // Given: legacy OCR spellings that appear in historical work orders.
  const aliases = [
    ['\uAE40\uBCF4\uC218', '\uC774\uC900\uD615'],
    ['\uC2E0\uC740\uC808', '\uC2E0\uC740\uCCA0'],
  ];

  // When / Then: each recognized alias resolves to its canonical assignee.
  for (const [rawAssignee, expectedAssignee] of aliases) {
    assert.equal(
      extractBrowserOcrEssentialFields(`\uB2F4\uB2F9\uC790: ${rawAssignee}`).sales_person,
      expectedAssignee,
    );
  }
});

test('browser OCR essential parser leaves an unrecognized assignee blank', () => {
  // Given: OCR text with a plausible but unsupported person name.
  const rawText = '\uB2F4\uB2F9\uC790: \uD64D\uAE38\uB3D9';

  // When: the essential values are extracted.
  const fields = extractBrowserOcrEssentialFields(rawText);

  // Then: no random substring is accepted as an assignee.
  assert.equal(fields.sales_person, '');
});

test('browser fallback uses the essential parser instead of retaining an arbitrary assignee substring', async () => {
  // Given: the order-entry browser fallback source.
  const source = await readFile(new URL('../src/pages/OrderEntryPage.jsx', import.meta.url), 'utf8');

  // When: its essential field integration is inspected.
  const usesEssentialParser = source.includes('extractBrowserOcrEssentialFields(normalized)');

  // Then: only a canonical parser result fills the sales-person field.
  assert.equal(usesEssentialParser, true);
  assert.match(source, /sales_person:\s*essentialFields\.sales_person,/);
});
