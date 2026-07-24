import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  repair,
  repairModuleUrl,
} from './repair-legacy-sales-person-aliases-helper.mjs';

const EXPECTED_EXPORTS = Object.freeze([
  'ALLOWED_SALES_PERSONS',
  'APPROVED_ALIAS_FINGERPRINTS',
  'COMPARE_AND_SET_SQL',
  'LOCKED_PREFLIGHT_SQL',
  'POST_COMMIT_VERIFY_SQL',
  'REPAIR_ORDER_IDS',
  'RepairGuardError',
  'assertConnectionTarget',
  'assertLocalProjectTarget',
  'assertServerIdentity',
  'buildRepairPlan',
  'buildRollbackManifest',
  'buildSanitizedSummary',
  'connectionFingerprint',
  'parseMode',
  'resolveCurrentSourceMapping',
  'runRepairTransaction',
  'writeRestrictedRollbackManifest',
]);

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const facadePath = fileURLToPath(repairModuleUrl);

function countNonCommentLines(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('//'))
    .length;
}

test('facade exposes exactly the original 18 named exports', () => {
  assert.deepEqual(Object.keys(repair).sort(), EXPECTED_EXPORTS);
});

test('importing the facade has no CLI output, exit mutation, or database side effect', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(repairModuleUrl.href)});`,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        POSTGRES_URL: 'not-a-database-url',
      },
    },
  );

  assert.equal(probe.status, 0);
  assert.equal(probe.signal, null);
  assert.equal(probe.stdout, '');
  assert.equal(probe.stderr, '');
});

test('direct CLI rejects invalid arguments before project, environment, or Pool work', () => {
  const probe = spawnSync(
    process.execPath,
    [facadePath, '--invalid'],
    {
      cwd: path.dirname(projectRoot),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
    },
  );

  assert.equal(probe.status, 1);
  assert.equal(probe.signal, null);
  assert.equal(probe.stdout, '');
  assert.equal(probe.stderr.trim(), '{"ok":false,"code":"CLI_ARGUMENTS_INVALID"}');
  assert.equal(probe.stderr.trim().split(/\r?\n/).length, 1);
});

test('every repair production and test module stays within 250 non-comment LOC', async () => {
  const scriptsDirectory = path.join(projectRoot, 'scripts');
  const testsDirectory = path.join(projectRoot, 'tests');
  const [scriptNames, testNames] = await Promise.all([
    readdir(scriptsDirectory),
    readdir(testsDirectory),
  ]);
  const inventory = [
    ...scriptNames
      .filter(name => /^repair-legacy-sales-person-aliases.*\.js$/.test(name))
      .map(name => path.join(scriptsDirectory, name)),
    ...testNames
      .filter(name => /^repair-legacy-sales-person-aliases.*\.mjs$/.test(name))
      .map(name => path.join(testsDirectory, name)),
  ];

  assert.equal(inventory.includes(facadePath), true);
  assert.equal(inventory.length >= 2, true);
  for (const filePath of inventory) {
    const source = await readFile(filePath, 'utf8');
    const lineCount = countNonCommentLines(source);
    assert.equal(
      lineCount <= 250,
      true,
      `${path.basename(filePath)} has ${lineCount} non-comment LOC`,
    );
  }
});

test('facade never uses export-star forwarding', async () => {
  const source = await readFile(facadePath, 'utf8');
  assert.doesNotMatch(source, /\bexport\s*\*/);
});
