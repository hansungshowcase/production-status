import { checkPassword, verifyDatabaseLogin } from './auth.js';
import { getDb } from './db.js';

// 문자 관리 콘솔 쓰기 보호: 쓰기 켜짐 판정, 관리자 비밀번호 확인, 무차별 대입 잠금.
const DB_CACHE_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
// IP 를 바꿔 가며 시도하는 경우를 막는 전체 상한: 10분 동안 모든 IP 합쳐 30회 틀리면 쓰기 전체를 10분 잠금
const MAX_GLOBAL_FAILS = 30;
let globalTimes = [];
let globalLockedUntil = 0;
const MAX_PASSWORD_LENGTH = 200;

let adminCache = null; // { at, has }
const failures = new Map(); // ip -> { times:number[], lockedUntil:number }

export function _resetGuardForTest() {
  adminCache = null;
  failures.clear();
  globalTimes = [];
  globalLockedUntil = 0;
}

async function dbHasAdmin({ db, nowMs }) {
  if (adminCache && nowMs - adminCache.at >= 0 && nowMs - adminCache.at < DB_CACHE_MS) return adminCache.has;
  let has = false;
  try {
    const handle = db || getDb();
    const result = await handle.execute({
      sql: "SELECT 1 AS ok FROM auth_credentials WHERE role = 'admin' AND actor = '관리자' AND active = true LIMIT 1",
      args: [],
    });
    has = Boolean(result?.rows?.length);
  } catch { has = false; }
  adminCache = { at: nowMs, has };
  return has;
}

export async function writeStatus({ db, nowMs = Date.now() } = {}) {
  if (process.env.SMS_CONSOLE_WRITE === 'off') return { enabled: false, reason: 'disabled' };
  if (process.env.ADMIN_PASSWORD) return { enabled: true, reason: null };
  if (await dbHasAdmin({ db, nowMs })) return { enabled: true, reason: null };
  return { enabled: false, reason: 'no_admin_password' };
}

export async function verifyAdminPassword(password, { db } = {}) {
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  if (checkPassword(password, process.env.ADMIN_PASSWORD)) return true;
  try {
    return Boolean(await verifyDatabaseLogin('admin', '관리자', password, { db: db || getDb() }));
  } catch { return false; }
}

export function noteFailure(ip, nowMs = Date.now()) {
  const key = String(ip || 'unknown');
  const entry = failures.get(key) || { times: [], lockedUntil: 0 };
  entry.times = entry.times.filter(t => nowMs - t < FAIL_WINDOW_MS);
  entry.times.push(nowMs);
  if (entry.times.length >= MAX_FAILS) {
    entry.lockedUntil = nowMs + LOCK_MS;
    entry.times = [];
  }
  failures.set(key, entry);
  globalTimes = globalTimes.filter(t => nowMs - t < FAIL_WINDOW_MS);
  globalTimes.push(nowMs);
  if (globalTimes.length >= MAX_GLOBAL_FAILS) {
    globalLockedUntil = nowMs + LOCK_MS;
    globalTimes = [];
  }
  if (failures.size > 5000) {
    for (const [k, v] of failures) {
      if (v.lockedUntil <= nowMs && !v.times.some(t => nowMs - t < FAIL_WINDOW_MS)) failures.delete(k);
    }
  }
}

export function isLocked(ip, nowMs = Date.now()) {
  if (globalLockedUntil > nowMs) return true;
  const entry = failures.get(String(ip || 'unknown'));
  return Boolean(entry && entry.lockedUntil > nowMs);
}
