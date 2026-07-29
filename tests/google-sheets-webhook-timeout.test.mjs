import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../api/_lib/googleSheets.js', import.meta.url);

test('Google Sheets webhook waits through Apps Script cold-start latency', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /const WEBHOOK_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /async function appendViaWebhook[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), WEBHOOK_TIMEOUT_MS\)/,
  );
});
