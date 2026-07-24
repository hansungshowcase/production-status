import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  makeRows,
  requiredFunction,
} from './repair-legacy-sales-person-aliases-helper.mjs';

const SYNTHETIC_WINDOWS_ENV = Object.freeze({
  USERDOMAIN: 'TESTDOMAIN',
  USERNAME: 'test-owner',
});
const SYNTHETIC_WINDOWS_PRINCIPAL = 'TESTDOMAIN\\test-owner';

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'production-status-alias-repair-'));
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(tmpdir());
  assert.equal(
    resolvedRoot === resolvedTemp
      || resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`),
    true,
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function syntheticManifest() {
  return {
    version: 1,
    createdAt: '2026-07-24T00:00:00.000Z',
    target: { id: 'synthetic', name: 'synthetic' },
    rows: [{
      id: 203,
      originalSalesPerson: 'synthetic-preimage',
      replacementSalesPerson: 'synthetic-replacement',
    }],
  };
}

function fakeWindowsAclRunner({
  principal,
  broadDirectory = false,
  rejectEmptyFileAcl = false,
  rejectCompletedFileAcl = false,
  fileAclEvents = [],
}) {
  return async (_executable, args) => {
    const targetPath = args[0];
    const isManifest = targetPath.endsWith('.json');
    let fileSize = null;
    if (isManifest) {
      fileSize = (await stat(targetPath)).size;
      fileAclEvents.push({
        args: [...args],
        size: fileSize,
      });
    }
    if (args.length !== 1) return { stdout: '', stderr: '' };

    const rights = isManifest ? '(F)' : '(OI)(CI)(F)';
    const fileAclRejected = isManifest && (
      (rejectEmptyFileAcl && fileSize === 0)
      || (rejectCompletedFileAcl && fileSize > 0)
    );
    const extraAce = (broadDirectory && !isManifest) || fileAclRejected
      ? '\r\n  BUILTIN\\Administrators:(RX)'
      : '';
    return {
      stdout: `${targetPath} ${principal}:${rights}${extraAce}\r\n`
        + 'Successfully processed 1 files; Failed processing 0 files\r\n',
      stderr: '',
    };
  };
}

test('rollback manifest stays outside the repository with restrictive permissions', async (t) => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const buildRollbackManifest = requiredFunction('buildRollbackManifest');
  const writeManifest = requiredFunction('writeRestrictedRollbackManifest');
  const root = await temporaryRoot(t);
  const rollbackDirectory = path.join(root, 'restricted');
  const manifest = buildRollbackManifest(buildRepairPlan(makeRows()));
  const manifestPath = await writeManifest(manifest, {
    repositoryRoot: process.cwd(),
    directory: rollbackDirectory,
    windowsPrivateRoot: root,
  });
  const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
  const metadata = await stat(manifestPath);

  assert.equal(path.dirname(manifestPath), rollbackDirectory);
  assert.deepEqual(saved.rows.map(row => row.id), [203, 204, 205, 206, 207, 208]);
  assert.equal(
    saved.rows.every(row => typeof row.originalSalesPerson === 'string'),
    true,
  );
  if (process.platform !== 'win32') {
    assert.equal(metadata.mode & 0o077, 0);
  }
  await assert.rejects(
    writeManifest(manifest, {
      repositoryRoot: process.cwd(),
      directory: path.join(process.cwd(), '.repair-manifests'),
      windowsPrivateRoot: root,
    }),
    error => error?.code === 'ROLLBACK_PATH_NOT_RESTRICTED',
  );
  if (process.platform === 'win32') {
    await assert.rejects(
      writeManifest(manifest, {
        repositoryRoot: process.cwd(),
        directory: path.join(tmpdir(), 'outside-private-repair-root'),
        windowsPrivateRoot: root,
      }),
      error => error?.code === 'ROLLBACK_PATH_NOT_RESTRICTED',
    );
  }
});

test('Windows directory and file ACLs are verified before raw bytes are written', async (t) => {
  const writeManifest = requiredFunction('writeRestrictedRollbackManifest');
  const root = await temporaryRoot(t);
  const directory = path.join(root, 'restricted');
  const fileAclEvents = [];
  const manifestPath = await writeManifest(syntheticManifest(), {
    repositoryRoot: process.cwd(),
    directory,
    env: SYNTHETIC_WINDOWS_ENV,
    platform: 'win32',
    windowsPrivateRoot: root,
    runIcacls: fakeWindowsAclRunner({
      principal: SYNTHETIC_WINDOWS_PRINCIPAL,
      fileAclEvents,
    }),
  });
  const saved = JSON.parse(await readFile(manifestPath, 'utf8'));

  const prewriteEvents = fileAclEvents.filter(event => event.size === 0);
  const completedReadbacks = fileAclEvents.filter(event => (
    event.size > 0 && event.args.length === 1
  ));
  assert.equal(prewriteEvents.length >= 3, true);
  assert.equal(completedReadbacks.length, 1);
  assert.equal(saved.rows[0].id, 203);
});

test('Windows broad explicit ACEs fail closed before any manifest is created', async (t) => {
  const writeManifest = requiredFunction('writeRestrictedRollbackManifest');
  const root = await temporaryRoot(t);
  const directory = path.join(root, 'restricted');
  await assert.rejects(
    writeManifest(syntheticManifest(), {
      repositoryRoot: process.cwd(),
      directory,
      env: SYNTHETIC_WINDOWS_ENV,
      platform: 'win32',
      windowsPrivateRoot: root,
      runIcacls: fakeWindowsAclRunner({
        principal: SYNTHETIC_WINDOWS_PRINCIPAL,
        broadDirectory: true,
      }),
    }),
    error => error?.code === 'ROLLBACK_PERMISSIONS_UNVERIFIED',
  );
  const files = await readdir(directory);
  assert.deepEqual(files.filter(name => name.endsWith('.json')), []);
});

test('failed empty-file ACL verification removes the exclusive-created artifact', async (t) => {
  const writeManifest = requiredFunction('writeRestrictedRollbackManifest');
  const root = await temporaryRoot(t);
  const directory = path.join(root, 'restricted');
  await assert.rejects(
    writeManifest(syntheticManifest(), {
      repositoryRoot: process.cwd(),
      directory,
      env: SYNTHETIC_WINDOWS_ENV,
      platform: 'win32',
      windowsPrivateRoot: root,
      runIcacls: fakeWindowsAclRunner({
        principal: SYNTHETIC_WINDOWS_PRINCIPAL,
        rejectEmptyFileAcl: true,
      }),
    }),
    error => error?.code === 'ROLLBACK_PERMISSIONS_UNVERIFIED',
  );
  const files = await readdir(directory);
  assert.deepEqual(files.filter(name => name.endsWith('.json')), []);
});

test('failed completed-file ACL verification removes the written artifact', async (t) => {
  const writeManifest = requiredFunction('writeRestrictedRollbackManifest');
  const root = await temporaryRoot(t);
  const directory = path.join(root, 'restricted');
  await assert.rejects(
    writeManifest(syntheticManifest(), {
      repositoryRoot: process.cwd(),
      directory,
      env: SYNTHETIC_WINDOWS_ENV,
      platform: 'win32',
      windowsPrivateRoot: root,
      runIcacls: fakeWindowsAclRunner({
        principal: SYNTHETIC_WINDOWS_PRINCIPAL,
        rejectCompletedFileAcl: true,
      }),
    }),
    error => error?.code === 'ROLLBACK_PERMISSIONS_UNVERIFIED',
  );
  const files = await readdir(directory);
  assert.deepEqual(files.filter(name => name.endsWith('.json')), []);
});
