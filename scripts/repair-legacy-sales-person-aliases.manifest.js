import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  EXPECTED_VERCEL_PROJECT,
} from './repair-legacy-sales-person-aliases.constants.js';
import {
  RepairGuardError,
  guard,
} from './repair-legacy-sales-person-aliases.guards.js';

const execFileAsync = promisify(execFile);

export function buildRollbackManifest(plan) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    target: EXPECTED_VERCEL_PROJECT,
    rows: plan.map(({
      id,
      fingerprint,
      originalSalesPerson,
      replacementSalesPerson,
    }) => ({
      id,
      fingerprint,
      originalSalesPerson,
      replacementSalesPerson,
    })),
  };
}

function isOutsideRepository(repositoryRoot, candidatePath) {
  const relative = path.relative(repositoryRoot, candidatePath);
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function isWithinDirectory(parentDirectory, candidatePath) {
  const relative = path.relative(parentDirectory, candidatePath);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function windowsPrivateManifestRoot(env) {
  guard(Boolean(env.LOCALAPPDATA), 'ROLLBACK_PRIVATE_ROOT_UNAVAILABLE');
  return path.join(
    env.LOCALAPPDATA,
    'production-status',
    'restricted-repair-manifests',
  );
}

function parseWindowsAclEntries(stdout, targetPath) {
  const normalizedTarget = targetPath.toLowerCase();
  const entries = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.toLowerCase().startsWith(normalizedTarget)) {
      line = line.slice(targetPath.length).trimStart();
    }
    const match = line.match(/^(.+?):((?:\([^)]+\))+)\s*$/);
    if (match) {
      entries.push({
        principal: match[1].trim().toLowerCase(),
        rights: match[2].toUpperCase(),
      });
    }
  }
  return entries;
}

function assertWindowsAcl(stdout, {
  targetPath,
  principal,
  directory,
}) {
  const entries = parseWindowsAclEntries(stdout, targetPath);
  const expectedPrincipal = principal.toLowerCase();
  guard(
    entries.length === 1
      && entries[0].principal === expectedPrincipal
      && entries[0].rights.includes('(F)')
      && !entries[0].rights.includes('(I)')
      && (!directory
        || (entries[0].rights.includes('(OI)')
          && entries[0].rights.includes('(CI)'))),
    'ROLLBACK_PERMISSIONS_UNVERIFIED',
  );
}

async function verifyWindowsAcl(
  targetPath,
  {
    directory,
    principal,
    runIcacls,
  },
) {
  const { stdout } = await runIcacls(
    'icacls.exe',
    [targetPath],
    { windowsHide: true },
  );
  assertWindowsAcl(stdout, { targetPath, principal, directory });
}

async function restrictWindowsAcl(
  targetPath,
  {
    directory,
    env,
    runIcacls,
  },
) {
  guard(
    Boolean(env.USERDOMAIN) && Boolean(env.USERNAME),
    'ROLLBACK_OWNER_UNAVAILABLE',
  );
  const principal = `${env.USERDOMAIN}\\${env.USERNAME}`;
  const grant = directory ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  try {
    await runIcacls(
      'icacls.exe',
      [targetPath, '/inheritance:r', '/grant:r', grant],
      { windowsHide: true },
    );
    await runIcacls(
      'icacls.exe',
      [targetPath, '/setowner', principal],
      { windowsHide: true },
    );
    await verifyWindowsAcl(targetPath, {
      directory,
      principal,
      runIcacls,
    });
  } catch (error) {
    if (error instanceof RepairGuardError) throw error;
    throw new RepairGuardError('ROLLBACK_PERMISSIONS_UNVERIFIED');
  }
  return principal;
}

export async function writeRestrictedRollbackManifest(
  manifest,
  {
    repositoryRoot,
    directory,
    env = process.env,
    platform = process.platform,
    windowsPrivateRoot = platform === 'win32'
      ? windowsPrivateManifestRoot(env)
      : null,
    runIcacls = execFileAsync,
  },
) {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedDirectory = path.resolve(
    directory
      ?? (platform === 'win32'
        ? windowsPrivateRoot
        : path.join(homedir(), '.production-status-repair-manifests')),
  );
  guard(
    isOutsideRepository(resolvedRepository, resolvedDirectory),
    'ROLLBACK_PATH_NOT_RESTRICTED',
  );
  if (platform === 'win32') {
    guard(
      isWithinDirectory(path.resolve(windowsPrivateRoot), resolvedDirectory),
      'ROLLBACK_PATH_NOT_RESTRICTED',
    );
  }

  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  const [realRepository, realDirectory] = await Promise.all([
    realpath(resolvedRepository),
    realpath(resolvedDirectory),
  ]);
  guard(
    isOutsideRepository(realRepository, realDirectory),
    'ROLLBACK_PATH_NOT_RESTRICTED',
  );

  let windowsPrincipal = null;
  if (platform === 'win32') {
    guard(
      isWithinDirectory(await realpath(windowsPrivateRoot), realDirectory),
      'ROLLBACK_PATH_NOT_RESTRICTED',
    );
    windowsPrincipal = await restrictWindowsAcl(realDirectory, {
      directory: true,
      env,
      runIcacls,
    });
  } else {
    await chmod(realDirectory, 0o700);
  }

  const timestamp = manifest.createdAt.replace(/[:.]/g, '-');
  const manifestPath = path.join(
    realDirectory,
    `legacy-sales-aliases-${timestamp}-${randomUUID()}.json`,
  );
  const handle = await open(manifestPath, 'wx', 0o600);
  try {
    if (platform === 'win32') {
      await restrictWindowsAcl(manifestPath, {
        directory: false,
        env,
        runIcacls,
      });
    } else {
      await chmod(manifestPath, 0o600);
    }
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    if (platform === 'win32') {
      await verifyWindowsAcl(manifestPath, {
        directory: false,
        principal: windowsPrincipal,
        runIcacls,
      });
    }
    await handle.close();
  } catch (error) {
    try {
      await handle.truncate(0);
      await handle.sync();
    } catch {
      // Best effort; unlink below removes the failed artifact.
    }
    try {
      await handle.close();
    } catch {
      // Preserve the original sanitized failure.
    }
    try {
      await unlink(manifestPath);
    } catch {
      // Preserve the original sanitized failure after the scrub attempt.
    }
    throw error;
  }
  return manifestPath;
}
